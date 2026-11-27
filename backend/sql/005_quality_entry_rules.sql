-- Quality entry rules (2026-11-27): the extra FMP inputs GET /api/quality
-- caches per ticker (backend/quality.py), and moat retirement.
--
--   pe_ttm               P/E TTM, refreshed with the statistics (24h).
--   pe_5y_avg            mean annual P/E over 5 fiscal years (loss years skipped).
--   capex_to_revenue_3y  mean yearly CapEx/Revenue over 3 fiscal years, PERCENT.
--   capex_to_ocf_3y      mean yearly CapEx/OCF over 3 fiscal years, PERCENT.
--
-- Moat is no longer computed by the backend: it is a manual, per-ticker
-- field kept by the app. The old `moat` column is left in place (nullable,
-- never written again) so this migration is non-destructive.
--
--   audit_close, audit_close_date, high_52w_close, close_drawdown_pct:
--     FUNDAMENTAL AUDIT inputs (last completed daily close vs. the 52-week
--     high of daily closes), refreshed with the statistics.
--
-- Requires 004_quality_metrics_cache.sql. Run before deploying the backend
-- that writes these columns, or Supabase upserts fail (the backend then
-- falls back to its in-memory cache and logs the error).
BEGIN;

ALTER TABLE quality_metrics
    ADD COLUMN IF NOT EXISTS pe_ttm NUMERIC,
    ADD COLUMN IF NOT EXISTS pe_5y_avg NUMERIC,
    ADD COLUMN IF NOT EXISTS capex_to_revenue_3y NUMERIC,
    ADD COLUMN IF NOT EXISTS capex_to_ocf_3y NUMERIC,
    ADD COLUMN IF NOT EXISTS audit_close NUMERIC,
    ADD COLUMN IF NOT EXISTS audit_close_date DATE,
    ADD COLUMN IF NOT EXISTS high_52w_close NUMERIC,
    ADD COLUMN IF NOT EXISTS close_drawdown_pct NUMERIC;

-- Force a fundamentals refresh for every cached ticker, so the new columns
-- are filled on the next request instead of after the old 30-day TTL.
UPDATE quality_metrics SET last_updated_fundamentals = NULL, last_updated_stats = NULL;

COMMIT;
