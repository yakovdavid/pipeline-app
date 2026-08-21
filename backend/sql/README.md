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
