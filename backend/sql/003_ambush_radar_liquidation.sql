-- Closed-loop watchlist: when a Satellite or Quality position is fully
-- liquidated from the portfolio, its ticker moves to the Ambush Radar so
-- it is watched for re-entry.
--
-- PREREQUISITE: run after 001 and 002 (assumes portfolio_assets exists
-- with ticker and asset_layer columns).
--
-- STATUS: NOT YET APPLIED, same as 001/002 — there is still no Supabase
-- project connected (see backend/sql/README.md). backend/main.py's
-- DELETE /api/portfolio/{ticker} calls liquidate_portfolio_asset() below
-- whenever SUPABASE_URL/SUPABASE_SERVICE_KEY are set, and returns 503
-- until then.
BEGIN;

-- One row per watched ticker. The PRIMARY KEY on ticker is the duplicate
-- guard: liquidating a ticker that is already on the radar is a no-op
-- (ON CONFLICT DO NOTHING below), never a constraint violation.
CREATE TABLE IF NOT EXISTS ambush_radar (
    ticker VARCHAR(32) PRIMARY KEY,
    asset_type VARCHAR(10) NOT NULL DEFAULT 'Stock' CHECK (asset_type IN ('Stock', 'ETF')),
    -- The portfolio layer the ticker was liquidated from ('satellite' or
    -- 'quality'), kept for context. NULL for tickers added to the radar
    -- some other way.
    source_layer VARCHAR(20),
    added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Liquidates one ticker in a single transaction:
--   1. Locks and reads the position's layer (FOR UPDATE, so two
--      concurrent liquidations of the same ticker can't interleave).
--   2. If the layer is Satellite or Quality, inserts the ticker into
--      ambush_radar, doing nothing if it is already tracked.
--   3. Deletes the position.
-- A plpgsql function body runs as one transaction, so if step 2 raises
-- (for example the asset_type CHECK), step 3 never happens and the
-- position is kept. A failed migration can never lose the position.
--
-- Returns NULL if the ticker isn't in portfolio_assets, otherwise a JSON
-- object: {"ticker", "layer", "moved_to_ambush", "already_tracked"}.
-- Returns JSONB rather than a RETURNS TABLE row on purpose: TABLE output
-- columns named ticker/asset_layer would collide with the table columns
-- inside the function body ("column reference is ambiguous").
CREATE OR REPLACE FUNCTION liquidate_portfolio_asset(p_ticker TEXT, p_asset_type TEXT DEFAULT 'Stock')
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_ticker TEXT := upper(trim(p_ticker));
    v_layer TEXT;
    v_migrates BOOLEAN;
    v_inserted_count INTEGER := 0;
BEGIN
    SELECT pa.asset_layer
    INTO v_layer
    FROM portfolio_assets pa
    WHERE upper(pa.ticker) = v_ticker
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Case-insensitive: 001's view stores layers lowercase ('satellite'),
    -- while the app itself uses 'Satellite'.
    v_migrates := lower(v_layer) IN ('satellite', 'quality');

    IF v_migrates THEN
        INSERT INTO ambush_radar (ticker, asset_type, source_layer)
        VALUES (v_ticker, p_asset_type, lower(v_layer))
        ON CONFLICT (ticker) DO NOTHING;
        GET DIAGNOSTICS v_inserted_count = ROW_COUNT;
    END IF;

    -- Full liquidation: every row for this ticker goes.
    DELETE FROM portfolio_assets WHERE upper(ticker) = v_ticker;

    RETURN jsonb_build_object(
        'ticker', v_ticker,
        'layer', v_layer,
        'moved_to_ambush', v_migrates,
        'already_tracked', v_migrates AND v_inserted_count = 0
    );
END;
$$;

COMMIT;
