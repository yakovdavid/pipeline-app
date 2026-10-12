-- Quality pipeline cache: Financial Modeling Prep (FMP) results per ticker,
-- so the backend's GET /api/quality/{ticker} (backend/quality.py) only calls
-- FMP when cached data has expired:
--   statistics (Z-Score inputs) after 24 hours, tracked by last_updated_stats
--   fundamentals (ROIC, Moat)   after 30 days,  tracked by last_updated_fundamentals
-- The two halves expire independently, so a daily price refresh never
-- refetches five years of financial statements.
--
-- Independent of 001-003 (no foreign keys), so it can run in any order.
--
-- STATUS: NOT YET APPLIED. No Supabase project is connected (see
-- backend/sql/README.md). Until one is, backend/quality.py caches in
-- memory instead (same lifetimes, lost on restart).
BEGIN;

CREATE TABLE IF NOT EXISTS quality_metrics (
    ticker VARCHAR(32) PRIMARY KEY,

    -- Statistics, from the last 2 years of daily closes.
    -- current_price is the most recent close in that series.
    current_price NUMERIC,
    mean_price NUMERIC,
    std_dev NUMERIC CHECK (std_dev IS NULL OR std_dev >= 0),
    -- (current_price - mean_price) / std_dev. NULL when std_dev is 0 (a
    -- flat series) or there were fewer than 2 closes.
    z_score NUMERIC,

    -- Fundamentals, from up to 5 years of annual key metrics.
    -- roic is the most recent fiscal year's ROIC as a PERCENT (28 = 28%),
    -- the unit the app uses everywhere. NULL when no year was available.
    roic NUMERIC,
    -- NULL only before fundamentals have ever been fetched for this ticker.
    moat VARCHAR(10) CHECK (moat IS NULL OR moat IN ('Wide', 'Narrow', 'None')),

    last_updated_stats TIMESTAMPTZ,
    last_updated_fundamentals TIMESTAMPTZ
);

-- Row Level Security with no policies: the anon/public key can neither read
-- nor write this table. The backend connects with the service key
-- (SUPABASE_SERVICE_KEY), which bypasses RLS.
ALTER TABLE quality_metrics ENABLE ROW LEVEL SECURITY;

COMMIT;
