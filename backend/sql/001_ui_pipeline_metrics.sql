-- "The Fortress 2.0" architectural overhaul: moves portfolio-allocation
-- and defense-trigger calculations that currently live in the React
-- Native frontend (index.tsx's buildSectionTitle/allSections, and
-- PortfolioStockRow's trailing-stop/drawdown-review logic) into a single
-- Postgres view, so a future Supabase-backed client (or any other
-- consumer) reads one already-computed row per asset instead of
-- re-deriving allocation %/drawdown/status client-side.
--
-- STATUS: NOT YET APPLIED. There is no Supabase project (or any database
-- at all) connected to this repository as of this migration being
-- authored — backend/main.py is a stateless yfinance proxy with zero
-- persistence, backend/requirements.txt has no DB driver, and there was
-- no portfolio_assets table, migrations folder, or Supabase client
-- anywhere in the codebase before this file. This is written as a
-- ready-to-run migration for whenever a Supabase project is actually
-- connected — run it via the Supabase SQL Editor or `psql`/`supabase db
-- push` at that point. It assumes a pre-existing `portfolio_assets` table
-- with (at minimum) columns: id, ticker, asset_layer, quantity,
-- current_price, high_52_week, trailing_stop_price.
--
-- KNOWN LIMITATION (flagging, not silently "fixing", since the exact SQL
-- structure below was specified explicitly): normalized_usd_price only
-- applies the Agorot/100 correction for ILA/ILX/".TA" tickers — it does
-- NOT convert ILS to USD via a live FX rate the way backend/main.py's
-- Multi-Currency engine does (_fetch_usd_ils_rate, refreshed from Yahoo's
-- "ILS=X" every 15 minutes). A plain SQL view has no way to call out to
-- Yahoo Finance for a live rate, and no fx_rates table exists yet to join
-- against. Practically: for a ".TA"/ILA/ILX row, this column ends up in
-- whole ILS (Shekels), not true USD — global_portfolio_value/
-- layer_market_value/current_weight_pct would silently mix ILS and USD
-- amounts for a mixed-currency portfolio. Wiring a real fx_rates table +
-- join is a follow-up, not included here since it wasn't part of the
-- specified structure.
BEGIN;

-- Update Assets Table
ALTER TABLE portfolio_assets
ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'USD',
ADD COLUMN IF NOT EXISTS calibration_factor NUMERIC DEFAULT 1.0;

-- Drop and Recreate the View
DROP VIEW IF EXISTS ui_pipeline_metrics;
CREATE VIEW ui_pipeline_metrics AS
WITH normalized_assets AS (
    SELECT
        id, ticker, asset_layer, quantity, current_price, high_52_week, trailing_stop_price, currency, calibration_factor,
        -- Normalize price: apply calibration factor and handle Israeli Agorot (TASE)
        CASE
            WHEN currency IN ('ILA', 'ILX') OR ticker LIKE '%.TA' THEN (current_price * calibration_factor) / 100.0
            ELSE (current_price * calibration_factor)
        END AS normalized_usd_price
    FROM portfolio_assets
),
portfolio_totals AS (
    SELECT
        *,
        (quantity * normalized_usd_price) AS total_market_value,
        SUM(quantity * normalized_usd_price) OVER () AS global_portfolio_value,
        SUM(quantity * normalized_usd_price) OVER (PARTITION BY asset_layer) AS layer_market_value
    FROM normalized_assets
)
SELECT
    ticker,
    asset_layer,
    quantity,
    normalized_usd_price AS current_price,
    total_market_value,
    -- Allocation Deviation (Window Function calculation)
    ROUND((layer_market_value / NULLIF(global_portfolio_value, 0)) * 100, 2) AS current_weight_pct,

    CASE
        WHEN high_52_week > 0 THEN ROUND(((normalized_usd_price - high_52_week) / high_52_week) * 100, 2)
        ELSE 0
    END AS drawdown_percentage,

    -- UNIFIED DEFENSE PROTOCOLS: Satellite's status here is a trailing-stop
    -- check (price vs. trailing_stop_price), a DIFFERENT, complementary
    -- mechanism from the -7% Mean Reversion drawdown trigger implemented
    -- in backend/main.py's BEARISH_ANOMALY_RULES (see that file's own
    -- comments) — the two are not meant to collapse into one signal, a
    -- Satellite position can show ACTIVE_DEFENSE here while still tripping
    -- (or not) the backend's separate Ambush drawdown trigger.
    CASE
        WHEN asset_layer = 'satellite' AND normalized_usd_price <= trailing_stop_price THEN 'SELL_TRIGGERED'
        WHEN asset_layer = 'satellite' THEN 'ACTIVE_DEFENSE'
        ELSE NULL
    END AS satellite_status,

    -- Matches backend/main.py's Quality Kill Switch threshold exactly
    -- (-15%, BEARISH_ANOMALY_RULES['Quality']['drawdown_pct']) — kept in
    -- sync deliberately: if that threshold ever changes, this literal
    -- -15.0 must change with it.
    CASE
        WHEN asset_layer = 'quality' AND (((normalized_usd_price - high_52_week) / high_52_week) * 100) <= -15.0 THEN 'FUNDAMENTAL_AUDIT_REQUIRED'
        WHEN asset_layer = 'quality' THEN 'HOLD'
        ELSE NULL
    END AS quality_status,

    trailing_stop_price
FROM portfolio_totals;

COMMIT;
