-- "The Fortress 2.0" Trailing Stop Engine + Quality Z-Score Module: adds
-- the two new portfolio_assets columns these features need and extends
-- ui_pipeline_metrics so the Trailing Stop Engine's 12%-off-watermark
-- trigger price is computed dynamically, per the PRD's own wording:
-- "Add a high_water_mark (NUMERIC) column ... Update the
-- ui_pipeline_metrics view to calculate the 12% drop dynamically:
-- high_water_mark * 0.88" and "Quality Z-Score Module: Add a roic
-- (NUMERIC) column."
--
-- PREREQUISITE: run AFTER 001_ui_pipeline_metrics.sql — this migration
-- assumes portfolio_assets already has currency/calibration_factor and
-- that the ui_pipeline_metrics view already exists (this file drops and
-- recreates it with the additions below).
--
-- STATUS: NOT YET APPLIED — same status as 001_ui_pipeline_metrics.sql
-- (see that file's own header and backend/sql/README.md): there is still
-- no Supabase project connected to this repository as of this migration
-- being authored. backend/main.py DOES now have a real, working sync path
-- for high_water_mark/roic (_sync_high_water_mark_to_supabase, called from
-- get_stock) — but it's env-var-gated (SUPABASE_URL/SUPABASE_SERVICE_KEY)
-- and therefore a guaranteed no-op until a real project's credentials are
-- actually set in the deployed backend's environment. This file is ready
-- to run the moment that happens, same as 001.
--
-- KNOWN LIMITATION (flagging, not silently working around — same
-- precedent as 001's own FX-rate limitation note): the Quality Z-Score
-- Module's "standard deviation of price relative to SMA50" calculation
-- (see backend/main.py's _calculate_quality_zscore) is NOT reproduced
-- here as a view column. Doing that in plain SQL would need a rolling
-- SMA50 computed for each of many historical days and then a std dev
-- across THOSE, which requires a full daily price-history table this
-- schema doesn't have and which wasn't part of the specified
-- portfolio_assets structure — so the Z-Score itself stays backend-only,
-- computed fresh from Yahoo history on every request. What this view DOES
-- already provide, unchanged, is the OTHER half of the backend's Z-Score
-- alert gate: current_weight_pct below, partitioned by asset_layer, is
-- exactly the "Quality layer's current weight in the overall portfolio"
-- figure backend/main.py's QUALITY_MAX_LAYER_WEIGHT_PCT check needs — a
-- future integration could read a Quality row's current_weight_pct from
-- here instead of the client-supplied `quality_weight_pct` query param
-- the backend accepts today.
BEGIN;

ALTER TABLE portfolio_assets
ADD COLUMN IF NOT EXISTS high_water_mark NUMERIC,
ADD COLUMN IF NOT EXISTS roic NUMERIC;

-- Trailing Stop Engine sync rule, seed case: a row with no watermark yet
-- (every pre-existing row, before this column existed) gets one seeded
-- from its own current_price — matching both backend/main.py's
-- _update_high_water_mark and the frontend's computeHighestWatermark,
-- which both seed a position's very first watermark from its current
-- price rather than leaving it NULL/unset.
UPDATE portfolio_assets
SET high_water_mark = current_price
WHERE high_water_mark IS NULL;

DROP VIEW IF EXISTS ui_pipeline_metrics;
CREATE VIEW ui_pipeline_metrics AS
WITH normalized_assets AS (
    SELECT
        id, ticker, asset_layer, quantity, current_price, high_52_week, trailing_stop_price,
        high_water_mark, roic, currency, calibration_factor,
        -- Normalize price: apply calibration factor and handle Israeli Agorot (TASE)
        CASE
            WHEN currency IN ('ILA', 'ILX') OR ticker LIKE '%.TA' THEN (current_price * calibration_factor) / 100.0
            ELSE (current_price * calibration_factor)
        END AS normalized_usd_price,
        -- TRAILING STOP ENGINE: high_water_mark normalized on the exact
        -- same basis as current_price above (same calibration factor,
        -- same Agorot/100 handling) BEFORE the 12% drop is applied — the
        -- watermark is stored in the same raw units as current_price, so
        -- it needs the identical correction before the two are ever
        -- compared or combined.
        CASE
            WHEN currency IN ('ILA', 'ILX') OR ticker LIKE '%.TA' THEN (high_water_mark * calibration_factor) / 100.0
            ELSE (high_water_mark * calibration_factor)
        END AS normalized_high_water_mark
    FROM portfolio_assets
),
portfolio_totals AS (
    SELECT
        *,
        (quantity * normalized_usd_price) AS total_market_value,
        SUM(quantity * normalized_usd_price) OVER () AS global_portfolio_value,
        SUM(quantity * normalized_usd_price) OVER (PARTITION BY asset_layer) AS layer_market_value,
        -- TRAILING STOP ENGINE: "calculate the 12% drop dynamically:
        -- high_water_mark * 0.88" — computed here, once, off the
        -- normalized watermark above, and reused by both the
        -- trailing_stop_trigger_price output column and satellite_status
        -- below so the two can never disagree with each other.
        normalized_high_water_mark * 0.88 AS trailing_stop_trigger_price
    FROM normalized_assets
)
SELECT
    ticker,
    asset_layer,
    quantity,
    normalized_usd_price AS current_price,
    total_market_value,
    -- Allocation Deviation (Window Function calculation). For a 'quality'
    -- row, this IS the "current weight of the Quality layer in the
    -- overall portfolio" figure backend/main.py's Z-Score alert gate
    -- needs (QUALITY_MAX_LAYER_WEIGHT_PCT) — see this file's own header
    -- comment.
    ROUND((layer_market_value / NULLIF(global_portfolio_value, 0)) * 100, 2) AS current_weight_pct,

    CASE
        WHEN high_52_week > 0 THEN ROUND(((normalized_usd_price - high_52_week) / high_52_week) * 100, 2)
        ELSE 0
    END AS drawdown_percentage,

    -- TRAILING STOP DEFENSE CONSTRAINTS: a hardcoded architectural block,
    -- not an incidental side effect of the CASE order — 'satellite' is the
    -- ONLY asset_layer value either branch below matches; 'quality' and
    -- 'core' rows always fall through to the final ELSE NULL, regardless
    -- of what high_water_mark/trailing_stop_trigger_price they carry.
    -- Mirrors the identical hardcoded guard in backend/main.py
    -- (_with_request_scoped_fields) and the frontend
    -- (computeSatelliteTrailingStopPrice in src/app/(tabs)/index.tsx) —
    -- three independent layers all enforcing the same rule. This is a
    -- DIFFERENT, complementary mechanism from the -7% Mean Reversion
    -- drawdown trigger implemented in backend/main.py's
    -- BEARISH_ANOMALY_RULES (see that file's own comments) — the two are
    -- not meant to collapse into one signal; a Satellite position can show
    -- ACTIVE_DEFENSE here while still tripping (or not) the backend's
    -- separate Ambush drawdown trigger.
    CASE
        WHEN asset_layer = 'satellite' AND normalized_usd_price <= trailing_stop_trigger_price THEN 'SELL_TRIGGERED'
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

    -- Quality Z-Score Module: passed through as-is for any consumer that
    -- wants it alongside the rest of this row (e.g. the roic >= 15 half of
    -- backend/main.py's Z-Score alert gate) — the score itself is NOT
    -- computed here, see this file's own KNOWN LIMITATION note above.
    roic,

    -- Legacy static column, kept unmodified for any existing reader of
    -- this view — new consumers should prefer trailing_stop_trigger_price
    -- below, which is the PRD's literal "high_water_mark * 0.88" formula.
    trailing_stop_price,
    high_water_mark,
    ROUND(trailing_stop_trigger_price, 2) AS trailing_stop_trigger_price
FROM portfolio_totals;

COMMIT;
