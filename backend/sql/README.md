# backend/sql

SQL migrations for a **future** Supabase/Postgres-backed version of "The
Fortress 2.0" portfolio engine.

**Nothing here has been executed.** As of writing, this repository has no
Supabase project, no database of any kind, and no DB client dependency
(`backend/requirements.txt` is `fastapi`, `uvicorn`, `yfinance`, `pandas`,
`curl_cffi` — no `supabase`/`psycopg2`/`asyncpg`/`sqlalchemy`). The
production backend (`backend/main.py`) is a stateless proxy in front of
Yahoo Finance; all app state today lives in the React Native client's
AsyncStorage. These files exist so the migration is ready to run the
moment a real Supabase project is connected.

## Applying a migration

Once a Supabase project exists and you have its connection details:

- **Supabase SQL Editor** (simplest): paste the file's contents into the
  project's SQL Editor and run it.
- **Supabase CLI**: `supabase db push` after placing the file under your
  project's `supabase/migrations/` directory (Supabase's CLI expects its
  own naming convention there; these files aren't in that directory today
  since no `supabase/` project scaffold exists in this repo yet).
- **`psql`**: `psql "$DATABASE_URL" -f backend/sql/001_ui_pipeline_metrics.sql`

## Files

- `001_ui_pipeline_metrics.sql` — adds `currency`/`calibration_factor` to
  `portfolio_assets` and (re)creates the `ui_pipeline_metrics` view
  (allocation %, drawdown %, Satellite trailing-stop status, Quality Kill
  Switch status) via window functions. Assumes a pre-existing
  `portfolio_assets` table — see the file's own header comment for the
  expected columns and a known limitation (no live FX-rate join, so
  ILS/Agorot tickers normalize to Shekels, not true USD).
- `002_trailing_stop_and_quality_zscore.sql` — run after 001. Adds
  `high_water_mark`/`roic` to `portfolio_assets` and updates
  `ui_pipeline_metrics` to compute the Trailing Stop Engine's trigger
  price dynamically (`high_water_mark * 0.88`, normalized the same way as
  `current_price`), still hardcoded to `asset_layer = 'satellite'` only.
  Unlike 001, the backend side of this one is NOT purely theoretical:
  `backend/main.py`'s `_sync_high_water_mark_to_supabase` already writes
  to `portfolio_assets` via the `supabase` client whenever
  `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` are set — still a no-op today
  since neither is, but no further code change is needed once they are.
  See the file's own header for its Quality Z-Score known limitation (the
  score itself stays backend-only; this view only supplies the layer-
  weight half of that feature's alert gate).
