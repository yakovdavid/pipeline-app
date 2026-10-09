"""FastAPI backend for the Pipeline app.

Serves the current price plus the 50-day and 200-day Simple Moving Averages
(SMA 50 / SMA 200) for a given ticker, sourced from Yahoo Finance via
yfinance, plus a ticker search/autocomplete endpoint backed by Yahoo
Finance's search API.

Includes a resilience layer around every outbound Yahoo Finance call
(browser header/TLS spoofing, request throttling, retry with backoff, and
in-memory caching) since cloud IPs like Render's are otherwise bot-detected
and rate-limited (HTTP 429) almost immediately. Two further architecture
decisions specifically target that: (1) a 15-minute TICKER_CACHE in front of
every outbound ticker fetch, so N concurrent requests for the same ticker
(e.g. every screen refreshing the same watchlist at once — the "thundering
herd") collapse into at most one real Yahoo call; (2) the primary fetch path
never calls yf.Ticker(t).info — the heaviest, most rate-limit-prone
quoteSummary endpoint yfinance exposes — in favor of the much lighter
yf.Ticker(t).fast_info plus one history(period="1y") call, from which price,
52-week high, SMA50/SMA200, and the daily closes both anomaly checks need
are all derived.

Also includes a Multi-Currency engine (see _resolve_currency_converters):
every price-like field is normalized into USD. For every OTHER exchange
this is based on the instrument's actual currency as reported by Yahoo
(fast_info.currency / the chart API's meta.currency). For Tel Aviv Stock
Exchange (".TA") tickers specifically, Yahoo's reported currency has been
observed to be unreliable — some ".TA" instruments come back as 'ILS',
others as 'ILA'/'ILX', with no consistent signal — so those are instead
keyed unconditionally off the ".TA" suffix itself: any ".TA" ticker is
always treated as Agorot-quoted (divide by 100 for ILS, then again by the
USD/ILS rate for USD), regardless of what currency Yahoo reports for it.

Every /api/stock/{ticker} response (Portfolio and Ambush Radar alike — both
screens hit this same endpoint) also carries two independent trend
indicators (see _classify_trend): macro_trend (price vs. SMA200, the
"is this still in a long-term uptrend" question) and tactical_momentum
(price vs. SMA50, the finer-grained "is short-term momentum still intact"
question) — deliberately kept separate rather than collapsed into one
asset-type-dependent Bullish/Bearish verdict, since an ETF holding its
200-day trend while breaking its 50-day one (or vice versa) is a real,
distinct signal either indicator alone would hide.

/api/health is a separate, deliberately trivial liveness endpoint (see
health_check) — it exists purely so an external uptime ping (a cron job)
can keep a free-tier host warm without ever touching yfinance/Yahoo, so
pinging it can never itself contribute to Yahoo rate-limiting.

"The Fortress 2.0" additions — Trailing Stop Engine and Quality Z-Score
Module (see get_stock's high_water_mark/roic/quality_weight_pct params and
_with_request_scoped_fields): pullback_depth and, for Quality assets only,
quality_z_score are computed fresh on every request from already-fetched
Yahoo data (no new outbound calls). trailing_stop_price/high_water_mark
and the quality_z_score_alert gate are deliberately kept OUT of the
formatted-response cache (stock_cache) since they depend on per-request,
caller-supplied portfolio context (a position's own watermark, its roic,
the Quality layer's current weight) rather than Yahoo data — see
_with_request_scoped_fields for why caching them would risk a stale Sell
Alert. An optional, env-var-gated Supabase sync
(_sync_high_water_mark_to_supabase) persists high_water_mark/roic to a
`portfolio_assets` table when a real Supabase project is configured (see
backend/sql/) — a guaranteed no-op today, since none is.
"""

import os
import random
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, TypeVar
from urllib.parse import urlparse

import requests as _plain_requests
import yfinance as yf
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# yfinance itself prefers curl_cffi (TLS/JA3 fingerprint impersonation) over
# plain `requests`, since header spoofing alone is not enough to pass
# Yahoo's bot detection — the TLS handshake fingerprint of a plain Python
# `requests`/`httpx` client is trivially distinguishable from a real
# browser's. curl_cffi is a required dependency of yfinance, but we still
# guard the import in case a given host environment can't build/load its
# compiled extension, matching yfinance's own fallback behavior.
try:
    from curl_cffi import requests as _http_backend

    _HAS_CURL_CFFI = True
except ImportError:  # pragma: no cover - depends on host platform
    import requests as _http_backend  # type: ignore[no-redef]

    _HAS_CURL_CFFI = False

# --- Optional Supabase sync (Trailing Stop Engine / Quality Z-Score) -----
# "The Fortress 2.0" high_water_mark sync: best-effort, env-var-gated, and
# a guaranteed no-op today. As documented extensively in backend/sql/
# README.md and backend/sql/001_ui_pipeline_metrics.sql, this repository
# has NO Supabase project connected as of this feature being written —
# there is no SUPABASE_URL/SUPABASE_SERVICE_KEY in any deployed
# environment yet. Rather than block the Trailing Stop Engine's backend
# logic on "wait for a database to exist," this guards the import (same
# pattern as the curl_cffi fallback above) and the client construction
# behind both env vars being present, so:
#   - With no Supabase project configured (today): _supabase_client is
#     None, _sync_high_water_mark_to_supabase is a no-op, and every other
#     line in this file behaves exactly as it did before this feature.
#   - Once a real Supabase project exists and its URL/service key are set
#     as environment variables: the exact same code starts actually
#     persisting high_water_mark/roic to portfolio_assets (see
#     backend/sql/002_trailing_stop_and_quality_zscore.sql), with no
#     further code change required.
try:
    from supabase import Client, create_client

    _SUPABASE_URL = os.environ.get("SUPABASE_URL")
    _SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_KEY")
    _supabase_client: "Client | None" = (
        create_client(_SUPABASE_URL, _SUPABASE_KEY) if _SUPABASE_URL and _SUPABASE_KEY else None
    )
except ImportError:  # pragma: no cover - `supabase` may not be installed in every environment
    _supabase_client = None

PORTFOLIO_ASSETS_TABLE = "portfolio_assets"


def _sync_high_water_mark_to_supabase(symbol: str, updated_high_water_mark: float, roic: float | None) -> None:
    """Trailing Stop Engine / Quality Z-Score Module: best-effort
    persistence of high_water_mark (and roic, when supplied) to Supabase's
    portfolio_assets table for `symbol` — see backend/sql/
    002_trailing_stop_and_quality_zscore.sql for the column definitions.

    A no-op whenever Supabase isn't configured (_supabase_client is None —
    see above) or the `supabase` package isn't installed. Any failure here
    is caught and logged, never raised: this is a side effect of the
    primary price/SMA response, and a Supabase hiccup must never be
    allowed to break that response the way a Yahoo failure could (same
    resilience philosophy as fetch_anomaly_news elsewhere in this file).
    """
    if _supabase_client is None:
        return

    update_payload: dict[str, float] = {"high_water_mark": updated_high_water_mark}
    if roic is not None:
        update_payload["roic"] = roic

    try:
        _supabase_client.table(PORTFOLIO_ASSETS_TABLE).update(update_payload).eq("ticker", symbol).execute()
    except Exception as error:  # noqa: BLE001 - best-effort sync; never fail the main response over this
        print(f"[resilience] Supabase high_water_mark sync failed for '{symbol}': {error}")


MAX_SEARCH_RESULTS = 6

# Tel Aviv Stock Exchange tickers (symbol suffix ".TA") drive BOTH which
# symbol gets queried (_normalize_ticker_symbol) AND, unconditionally, how
# its price is interpreted (_resolve_currency_converters): Israeli
# brokerages base their unit quantities on Nominal Value (Erech Nakuv) in
# Agorot, but Yahoo Finance inconsistently self-reports the currency for
# ".TA" instruments — sometimes already-divided 'ILS', sometimes raw
# 'ILA'/'ILX' Agorot, with no reliable pattern. Trusting that reported
# currency string therefore under-converts a meaningful fraction of TASE
# tickers, inflating their USD-normalized price (and portfolio totals) by
# roughly 100x. The fix: ANY symbol ending in TASE_TICKER_SUFFIX is always
# treated as Agorot-quoted, regardless of what Yahoo's currency field says.
TASE_TICKER_SUFFIX = ".TA"
USD_ILS_FX_SYMBOL = "ILS=X"
AGOROT_PER_SHEKEL = 100

# --- Multi-Currency engine -----------------------------------------------
# Every price-like field this file returns (price, sma50, sma200, high_52)
# gets normalized into USD. ".TA"-suffixed symbols are always treated as
# Agorot-quoted (see the TASE_TICKER_SUFFIX comment above for why this is
# keyed off the symbol, not Yahoo's self-reported currency); every other
# symbol still uses Yahoo's own reported currency for the instrument.
DEFAULT_CURRENCY = "USD"
# Israeli Agorot: both codes have been observed live from Yahoo for
# different TASE instruments.
AGOROT_CURRENCY_CODES = {"ILA", "ILX"}
CURRENCY_SYMBOL_USD = "$"
CURRENCY_SYMBOL_ILS = "₪"

# Fallback data source: Yahoo's lighter /v8/finance/chart endpoint, used
# when yfinance's own history()/fast_info calls fail outright (observed:
# yfinance's session handling gets blocked on Render's shared IPs even when
# a hand-rolled request through this file's own resilient session doesn't).
# Same 1-year daily-close history as the primary path, so SMA50/SMA200/
# 52-week-high are computed identically regardless of which path succeeded.
CHART_API_BASE_URL = "https://query2.finance.yahoo.com/v8/finance/chart"
CHART_HISTORY_RANGE = "1y"
CHART_HISTORY_INTERVAL = "1d"
SMA_50_WINDOW = 50
SMA_200_WINDOW = 200

# AMBUSH RADAR MOVING-AVERAGE FIX: a distinct, LONGER fallback range/period
# tried only as a last resort (see _fetch_ticker_snapshot_with_fallback)
# when NEITHER the default-range yfinance history nor the default-range
# chart API returned enough daily closes to compute SMA200 (>=
# SMA_200_WINDOW). Observed live: yfinance's history(period="1y") can come
# back truncated under load/rate-limiting WITHOUT ever raising an
# exception — it just silently returns however many rows it managed to
# fetch — which the old code accepted as final and cached for 15 minutes,
# permanently showing "Not enough moving-average data" for a ticker that
# actually has plenty of trading history. Asking for a 2-year window
# instead of 1-year gives a transient truncation real room to still land
# >= 200 closes even if it drops some of the most recent ones, while a
# genuinely short-history ticker (a recent IPO) will still legitimately
# come up short here too — see _fetch_ticker_snapshot_with_fallback's own
# comment for how that case is told apart from a bug.
EXTENDED_HISTORY_PERIOD = "2y"
EXTENDED_CHART_HISTORY_RANGE = "2y"


def _normalize_ticker_symbol(raw_ticker: str) -> str:
    """TASE ticker interceptor: normalizes a raw user-supplied ticker and,
    when applicable, appends the Tel Aviv Stock Exchange suffix — without
    ever having to change data providers, since yfinance already
    understands '<security number>.TA' as an ordinary symbol.

    Yahoo Finance identifies TASE securities by their raw numeric security
    number plus a '.TA' suffix (e.g. '1081124.TA'), not the bare number a
    user would naturally type or paste from a TASE listing (e.g.
    '1081124'). A symbol that, after trimming, consists entirely of digits
    is unambiguously a TASE security number — there's no such thing as an
    all-numeric ticker on any other exchange this app supports — so it's
    auto-suffixed here. Anything containing a letter ('AAPL', 'BRK-B', ...)
    is left exactly as-is.

    Called once, centrally, from every endpoint that accepts a raw ticker
    (get_stock, which backs both Portfolio and Ambush Radar fetching, and
    get_intel) rather than requiring each to special-case it — from that
    point on the rest of the pipeline treats it as a standard Yahoo Finance
    symbol. This decides which SYMBOL gets queried; get_stock's
    Multi-Currency engine (_resolve_currency_converters) separately decides
    how to interpret the PRICE Yahoo returns for that symbol — and, for any
    symbol ending in TASE_TICKER_SUFFIX, that decision is now ALSO keyed off
    this same suffix (unconditionally Agorot-quoted), not Yahoo's reported
    currency.
    """
    symbol = raw_ticker.strip().upper()
    if symbol.isdigit():
        return f"{symbol}{TASE_TICKER_SUFFIX}"
    return symbol


class TickerNotFoundError(Exception):
    """Raised when Yahoo explicitly reports no data for a ticker, as
    opposed to a transient network/rate-limit failure — lets callers map
    this to a 404 instead of a 502."""


# Anomaly News Fetcher: flags same-day moves of ANOMALY_THRESHOLD_DEFAULT
# (4%) or more and surfaces recent headlines to help explain the move.
# This is supplementary/optional data (opted into via a query param on
# /api/stock/{ticker}, not fetched by default — see get_stock). The
# day-over-day move itself is now derived from the already-fetched
# TickerSnapshot's closes (see fetch_anomaly_news), so the only Yahoo call
# this can still make is the news fetch itself, gated behind the threshold
# actually being crossed — it keeps its own small, fast-failing retry
# budget for that call regardless, since it should never hold up the
# primary price/SMA response.
ANOMALY_THRESHOLD_DEFAULT = 0.04
ANOMALY_NEWS_COUNT = 3
ANOMALY_FETCH_MAX_RETRIES = 1
ANOMALY_FETCH_BASE_BACKOFF_SECONDS = 1.0

# Bifurcated Mean Reversion (Ambush) anomaly thresholds — UNIFIED DEFENSE
# PROTOCOLS: previously keyed by asset_type (Stock 15% / ETF 7%), now keyed
# by the Fortress 2.0 portfolio LAYER (Satellite / Quality) instead, per
# "The Fortress 2.0" architectural overhaul. This is a real behavior change,
# not just a rename: a Satellite position is now judged the same way
# whether it's a Stock or an ETF (one unified -7% trigger), and the old
# -15% threshold is no longer a "large-cap stock" allowance — it's
# exclusively the Quality layer's slower-moving "Kill Switch" for a
# fundamental (not tactical) review. 'Core' positions get NO trigger at all
# (see check_mean_reversion_anomaly): Core is held through drawdowns by
# design, matching the frontend's own Core philosophy (no trailing stop
# either — see SATELLITE_STOCK_TS_PCT/SATELLITE_ETF_TS_PCT client-side).
#
# NOTE on a pre-existing gap this also fixes: the frontend never actually
# sent the old `asset_type` query param on any request (fetchStockData(t)
# never appended it), so in production this bifurcation always silently
# resolved to the "Stock" branch regardless of the real asset type — every
# request got the 15% threshold. The new `category` param is now actually
# sent by the Portfolio screen (see index.tsx), so this fix also closes
# that gap, not just the rename.
#
# Two independent triggers per layer — either one fires the alert:
#   - Drawdown: price is >= drawdown_pct below the 52-week high.
#   - Structural support break: price < SMA50 - (std_dev_multiplier * the
#     20-day close std dev).
ANOMALY_STD_DEV_WINDOW = 20
# Ambush Radar has no portfolio-layer concept of its own (its watchlist
# entries only ever carry a ticker + Stock/ETF asset type, never a
# Core/Satellite/Quality category) — its requests never send `category` at
# all, so they fall back to this default. Satellite (the tactical,
# opportunistic layer) is the closer conceptual match for a mean-reversion
# watchlist than Quality (a slow-moving, manually-reviewed layer), and its
# tighter 7% threshold also errs toward actually firing rather than
# under-alerting, consistent with this endpoint's other thresholds
# (ANOMALY_THRESHOLD_DEFAULT, the structural-support trigger) which
# likewise default to "surface it" over "stay silent."
DEFAULT_ANOMALY_CATEGORY = "Satellite"
# 'Core' is deliberately NOT a key here — see check_mean_reversion_anomaly,
# which returns None immediately for it rather than falling back to either
# bucket below.
BEARISH_ANOMALY_RULES: dict[str, dict[str, float]] = {
    "Satellite": {"drawdown_pct": 7.0, "std_dev_multiplier": 2.0},
    "Quality": {"drawdown_pct": 15.0, "std_dev_multiplier": 2.0},
}

# --- Trailing Stop Engine (Satellite only) -------------------------------
# A single hard 12% drop from a position's own high_water_mark — the exact
# same figure the frontend has computed client-side for a while now (see
# SATELLITE_TS_PCT in src/constants/thresholds.ts: highestWatermark * (1 -
# 0.12), i.e. * 0.88); this constant is the backend's own copy of that same
# rule, kept in sync deliberately, now also driving backend/sql/
# 002_trailing_stop_and_quality_zscore.sql's view. TRAILING STOP DEFENSE
# CONSTRAINTS: this is a Satellite-ONLY mechanism — see the hardcoded
# `normalized_category == "Satellite"` guard around every use of this
# constant in get_stock below. Core is held through drawdowns by design;
# Quality gets its own Fundamental Audit Kill Switch (BEARISH_ANOMALY_RULES
# above) instead. Neither Core nor Quality may ever compute a trailing-stop
# trigger price, regardless of what high_water_mark a caller supplies.
SATELLITE_TRAILING_STOP_PCT = 0.12

# --- Quality Z-Score Module (Quality only) -------------------------------
# Rolling-window lookback for the "standard deviation of price relative to
# SMA50" calculation (see _calculate_quality_zscore) — 20 trading days,
# matching this file's existing ANOMALY_STD_DEV_WINDOW convention for a
# short-term structural std dev elsewhere in this same file. Needs at
# least SMA_50_WINDOW additional closes before the lookback window even
# starts (each of the WINDOW historical days needs its own trailing 50-day
# SMA), hence QUALITY_ZSCORE_MIN_HISTORY below.
QUALITY_ZSCORE_WINDOW = 20
QUALITY_ZSCORE_MIN_HISTORY = SMA_50_WINDOW + QUALITY_ZSCORE_WINDOW

# Z-SCORE CONSTRAINTS: the alert (not the raw z_score value, which is
# always returned for a Quality asset whenever there's enough history to
# compute one) MUST ONLY be evaluated as active when ALL THREE hold:
#   1. the z_score itself falls in [-2.0, -1.5] (a moderate-to-strong
#      mean-reversion-below-SMA50 reading);
#   2. the asset's own roic (Return on Invested Capital) is >= 15 — a
#      quality-screen gate: don't flag a statistical dip on a
#      fundamentally weak business as a buying opportunity;
#   3. the Quality layer's OWN current share of the whole portfolio is
#      <= 10% — the Fortress 2.0 Model's target Quality allocation (see
#      CATEGORY_TARGET_PCT.Quality in src/constants/labels.ts) — so the
#      alert never encourages adding to Quality once it's already at (or
#      past) its intended weight.
# See _quality_zscore_alert_active for the actual gate.
QUALITY_ZSCORE_ALERT_LOWER = -2.0
QUALITY_ZSCORE_ALERT_UPPER = -1.5
QUALITY_ZSCORE_MIN_ROIC = 15.0
QUALITY_MAX_LAYER_WEIGHT_PCT = 10.0

# On-Demand Intel: a user-triggered (not automatic/high-frequency) request
# for a ticker's latest headlines regardless of price movement. Since it's
# a deliberate single action rather than something fired on every list
# load/refresh, it gets the full default retry budget (see fetch_with_retry)
# rather than the anomaly fetcher's fail-fast one.
INTEL_NEWS_COUNT = 5

# On-Demand Intel V3.1: batch requests, article timestamps/deep links, and
# keyword flagging.
#
# A batch request makes one Yahoo call per ticker, each spaced >= 1s apart
# by yahoo_rate_limiter, so an unbounded batch could make a single HTTP
# request take a very long time (and risk timing out the client or the
# Render proxy). Capped to a sane size for that reason.
MAX_BATCH_TICKERS = 10

# Jitter added between tickers in the batch Intel loop (get_intel), on top
# of — not a replacement for — yahoo_rate_limiter's own >= 1s spacing
# between individual outbound HTTP calls: a small randomized pause between
# tickers means a multi-ticker batch doesn't itself read as a mechanical,
# fixed-interval burst to Yahoo's bot detection.
TICKER_LOOP_JITTER_MIN_SECONDS = 0.5
TICKER_LOOP_JITTER_MAX_SECONDS = 1.5

CRITICAL_ALERT_TAG = "[CRITICAL ALERT]"
CRITICAL_KEYWORDS = {
    "earnings", "miss", "beat", "downgrade", "upgrade", "sec", "fraud",
    "acquisition", "merger", "investigation", "subpoena", "lawsuit",
    "bankruptcy", "guidance", "cut", "slashing", "probe",
}

# Standard browser headers layered on top of curl_cffi's TLS impersonation.
# Yahoo Finance rejects requests without something resembling this, whether
# hit via yfinance or the raw search endpoint. User-Agent is deliberately
# NOT included here — it's rotated per-attempt from USER_AGENTS below (see
# _rotate_user_agent) rather than fixed.
YAHOO_BROWSER_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive",
}

# Rotated per-attempt (see _rotate_user_agent, called from fetch_with_retry
# before every attempt — the initial one and every retry) so consecutive
# requests, including retries of the exact same call, never repeat an
# identical fingerprint for Yahoo's bot detection to key on. Deliberately
# spans multiple OSes/browser engines: desktop (Windows, macOS) and mobile
# (iOS, Android).
USER_AGENTS: list[str] = [
    # Windows / Chrome
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    # Windows / Edge
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    # macOS / Safari
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    # macOS / Chrome
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    # iOS / Safari
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    # Android / Chrome
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
]

# --- Request throttling ------------------------------------------------
# Yahoo bot-detects near-instantly on repeated bursts from the same IP, so
# every outbound call (stock info, FX rate, search) is funneled through one
# shared, process-wide limiter: it fully serializes calls (no two in
# flight at once) and enforces a minimum gap between them.
MIN_REQUEST_INTERVAL_SECONDS = 1.0


class YahooRateLimiter:
    def __init__(self, min_interval_seconds: float) -> None:
        self._min_interval = min_interval_seconds
        self._lock = threading.Lock()
        self._last_call_finished_at: float | None = None

    def __enter__(self) -> "YahooRateLimiter":
        self._lock.acquire()
        if self._last_call_finished_at is not None:
            elapsed = time.monotonic() - self._last_call_finished_at
            remaining = self._min_interval - elapsed
            if remaining > 0:
                time.sleep(remaining)
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self._last_call_finished_at = time.monotonic()
        self._lock.release()


yahoo_rate_limiter = YahooRateLimiter(MIN_REQUEST_INTERVAL_SECONDS)

# --- Retry with exponential backoff -------------------------------------
# Anti-rate-limit default: up to 3 total attempts (1 initial + 2 retries),
# backing off 2s then 4s between them (base_backoff_seconds * 2**attempt) —
# this is what stands between a single transient 429 and a completely
# failed ticker fetch (observed live on tickers like DTCR under the old,
# thinner retry budget).
MAX_RETRIES = 2
BASE_BACKOFF_SECONDS = 2.0
RETRYABLE_STATUS_CODES = {429, 503}

# RATE LIMIT HANDLING (429): a hard ceiling on how long a single
# Retry-After-driven wait is allowed to be — Yahoo (or any CDN/proxy in
# front of it) telling us to wait is worth honoring (see
# _extract_retry_after_seconds), but a malformed, malicious, or just
# unreasonably large header value must never be allowed to stall a request
# far longer than this app's own exponential backoff ever would.
MAX_RETRY_AFTER_SECONDS = 30.0

T = TypeVar("T")


def _is_retryable_error(error: Exception) -> bool:
    """True for a 429/503 HTTP status, or any generic network-level failure
    (connection refused, DNS failure, read/connect timeout — no response
    was ever received) — both are transient conditions worth retrying with
    backoff rather than failing the request outright."""
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    if status_code in RETRYABLE_STATUS_CODES:
        return True

    # curl_cffi's requests-compatible exception hierarchy mirrors
    # `requests`' own — this is the "generic network error" case (a
    # ConnectionError, Timeout, etc. that never got as far as a response).
    # Plain `requests` exceptions are checked too: the Bizportal mutual-fund
    # scraper (see _fetch_mutual_fund_snapshot_via_bizportal) deliberately
    # uses plain `requests`, not the curl_cffi session, and its network
    # errors are not curl_cffi exception instances.
    if isinstance(error, (_http_backend.exceptions.RequestException, _plain_requests.exceptions.RequestException)):
        return True

    # Some yfinance failure paths re-raise as a plain Exception that loses
    # the original exception type/`.response`; fall back to sniffing the
    # message for a retryable status code.
    message = str(error)
    return any(str(code) in message for code in RETRYABLE_STATUS_CODES)


def _extract_retry_after_seconds(error: Exception) -> float | None:
    """RATE LIMIT HANDLING (429): reads the Retry-After header off a
    429/503 response, if present — Yahoo (or a CDN/proxy in front of it)
    explicitly telling the client how long to wait before retrying is more
    correct than this file's own blind exponential guess, and honoring it
    can go either way in practice: sometimes shorter (recovering faster
    than our schedule would have retried), more often LONGER (in which
    case respecting it actually avoids hammering an already-rate-limited
    endpoint with another too-early retry that just burns the remaining
    retry budget for nothing).

    Returns None (the caller then falls back to exponential backoff)
    whenever the header is missing, non-numeric, negative, or the
    response/headers object isn't present at all — deliberately broad
    `getattr(..., None)` chains rather than assuming every raised
    exception (yfinance/curl_cffi/httpx all raise different types) exposes
    the same `.response.headers` shape.
    """
    response = getattr(error, "response", None)
    headers = getattr(response, "headers", None)
    if not headers:
        return None
    try:
        raw_value = headers.get("Retry-After")
    except Exception:  # noqa: BLE001 - headers may not even be dict-like on every error type
        return None
    if not raw_value:
        return None
    try:
        seconds = float(raw_value)
    except (TypeError, ValueError):
        # Retry-After can also be an HTTP-date string per RFC 7231, not
        # just a delay in seconds — Yahoo has only ever been observed to
        # send the numeric-seconds form, so a date string here is treated
        # as "unusable" and falls back to exponential backoff rather than
        # this file taking on a date-parsing dependency for a format that
        # doesn't occur in practice against this specific upstream.
        return None
    if seconds < 0:
        return None
    return min(seconds, MAX_RETRY_AFTER_SECONDS)


def _rotate_user_agent() -> None:
    """Randomly picks a User-Agent from USER_AGENTS and applies it to the
    shared Yahoo session. Called from fetch_with_retry before every single
    attempt — the first one and every retry — not just on retries, so no
    two outbound requests (even a retry of the exact same call) ever carry
    an identical fingerprint."""
    _yahoo_session.headers["User-Agent"] = random.choice(USER_AGENTS)


def fetch_with_retry(
    fetch_fn: Callable[[], T],
    description: str,
    max_retries: int = MAX_RETRIES,
    base_backoff_seconds: float = BASE_BACKOFF_SECONDS,
) -> T:
    """Runs fetch_fn under the shared rate limiter, retrying on a 429/503 or
    a generic network error up to max_retries times. A freshly randomized
    User-Agent (see _rotate_user_agent) is applied to the shared session
    before every attempt. Callers with a known-good fallback can pass a
    smaller max_retries to fail fast instead of burning the full backoff
    budget.

    RATE LIMIT HANDLING (429): the actual wait between attempts prefers
    the failing response's own Retry-After header (see
    _extract_retry_after_seconds) whenever one is present — Yahoo
    explicitly telling us how long to back off is more correct than a
    blind guess — and only falls back to exponential backoff (base,
    base*2, base*4, ...) when there isn't one (a 503, a generic network
    error, or a 429 with no Retry-After header at all).
    """
    last_error: Exception | None = None

    for attempt in range(max_retries + 1):
        _rotate_user_agent()
        try:
            with yahoo_rate_limiter:
                return fetch_fn()
        except Exception as error:  # noqa: BLE001 - yfinance/curl_cffi/httpx all raise different types
            last_error = error
            if attempt >= max_retries or not _is_retryable_error(error):
                raise
            retry_after_seconds = _extract_retry_after_seconds(error)
            if retry_after_seconds is not None:
                backoff_seconds = retry_after_seconds
                backoff_source = "Retry-After header"
            else:
                backoff_seconds = base_backoff_seconds * (2**attempt)
                backoff_source = "exponential backoff"
            print(
                f"[resilience] {description} failed on attempt {attempt + 1}/"
                f"{max_retries + 1} ({error}); retrying in {backoff_seconds:.0f}s "
                f"({backoff_source}) with a new User-Agent."
            )
            time.sleep(backoff_seconds)

    # Unreachable: the loop above always either returns or raises.
    assert last_error is not None
    raise last_error


# --- Short-lived in-memory cache (formatted responses / FX / news) ------
CACHE_TTL_SECONDS = 900.0  # 15 minutes — aligned with TICKER_CACHE below.


class TTLCache:
    def __init__(self, ttl_seconds: float) -> None:
        self._ttl = ttl_seconds
        self._lock = threading.Lock()
        self._store: dict[str, tuple[float, object]] = {}

    def get(self, key: str):
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            cached_at, value = entry
            if time.monotonic() - cached_at > self._ttl:
                del self._store[key]
                return None
            return value

    def set(self, key: str, value: object) -> None:
        with self._lock:
            self._store[key] = (time.monotonic(), value)


stock_cache = TTLCache(CACHE_TTL_SECONDS)
fx_rate_cache = TTLCache(CACHE_TTL_SECONDS)
intel_cache = TTLCache(CACHE_TTL_SECONDS)


@dataclass
class TickerSnapshot:
    """The minimal, cacheable slice of Yahoo data needed for everything
    this file computes about a ticker: the primary price/SMA/drawdown
    response AND both anomaly checks (day-over-day move, 20-day std dev) —
    all derived from ONE 1-year history fetch (+ one fast_info call for a
    real-time current price), never from the heavy, rate-limit-prone
    `.info`/quoteSummary endpoint.
    """

    price: float
    sma50: float | None
    sma200: float | None
    high_52: float | None
    # Ascending-date daily closes from the same 1-year history fetch used
    # to compute sma50/sma200/high_52 above, in the ticker's raw/native
    # currency (unconverted for TASE tickers). Reused directly by both
    # fetch_anomaly_news (day-over-day % change — scale-invariant, so raw
    # currency is fine as-is) and check_mean_reversion_anomaly (20-day std
    # dev, currency-converted by the caller when needed) — neither makes
    # its own separate Yahoo history call any more.
    closes: list[float]
    # Yahoo's own currency code for this instrument (e.g. 'USD', 'ILS',
    # 'ILA') — read from fast_info.currency on the primary path, or the
    # chart API's meta.currency on the fallback path. None if neither
    # source reported one; get_stock's Multi-Currency engine
    # (_resolve_currency_converters) then falls back to USD. NOTE: for
    # ".TA" symbols this field is effectively advisory only — it's still
    # recorded here, but _resolve_currency_converters ignores it in favor
    # of the ".TA" suffix itself (see TASE_TICKER_SUFFIX), since Yahoo's
    # reported currency has been observed to be unreliable for TASE.
    currency: str | None


# --- In-memory ticker snapshot cache (THE SPEED FIX) ---------------------
# A plain, global dict — not hidden behind another abstraction — keyed by
# normalized ticker symbol, storing (cached_at, TickerSnapshot) pairs.
# Checked before ANY outbound Yahoo call for that ticker (see get_stock): a
# cache hit returns instantly with zero network activity, which is what
# actually solves the "thundering herd" problem — many concurrent requests
# for the same handful of tickers (every screen refreshing its watchlist at
# once) collapsing into at most one real Yahoo fetch every 15 minutes,
# instead of one Yahoo fetch per request.
TICKER_CACHE: dict[str, tuple[float, TickerSnapshot]] = {}
TICKER_CACHE_TTL_SECONDS = 900.0  # 15 minutes
_ticker_cache_lock = threading.Lock()


def _get_cached_ticker_snapshot(symbol: str) -> TickerSnapshot | None:
    """Returns the cached snapshot for symbol if one exists and hasn't
    expired, else None. time.monotonic() (not time.time()) so this is
    immune to wall-clock adjustments, matching the TTLCache class above."""
    with _ticker_cache_lock:
        entry = TICKER_CACHE.get(symbol)
        if entry is None:
            return None
        cached_at, snapshot = entry
        if time.monotonic() - cached_at > TICKER_CACHE_TTL_SECONDS:
            del TICKER_CACHE[symbol]
            return None
        return snapshot


def _set_cached_ticker_snapshot(symbol: str, snapshot: TickerSnapshot) -> None:
    with _ticker_cache_lock:
        TICKER_CACHE[symbol] = (time.monotonic(), snapshot)


# One shared, browser-like session reused across every yfinance call. Safe
# to share across FastAPI's threadpool workers because yahoo_rate_limiter
# already guarantees only one outbound call using it runs at a time.
if _HAS_CURL_CFFI:
    _yahoo_session = _http_backend.Session(impersonate="chrome")
else:  # pragma: no cover - depends on host platform
    _yahoo_session = _http_backend.Session()
_yahoo_session.headers.update(YAHOO_BROWSER_HEADERS)
_yahoo_session.headers["User-Agent"] = random.choice(USER_AGENTS)

app = FastAPI(title="Pipeline Stock API")

# Allow all origins so the Expo app (running on a phone, simulator, or web)
# can reach this API regardless of which host/port it is served from.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# PERFORMANCE OPTIMIZATION (ANTI-COLD-START): a deliberately trivial
# liveness endpoint for an external uptime pinger (a cron job) to hit on an
# interval, so a free-tier host (e.g. Render) never fully spins down and
# every REAL user request pays a cold-start penalty. This MUST stay cheap
# and self-contained forever — no yfinance call, no TICKER_CACHE/stock_cache
# lookup, no yahoo_rate_limiter involvement of any kind — so pinging it as
# often as the uptime job likes can never itself contribute to Yahoo
# rate-limiting or contend with a real request for the rate limiter's single
# in-flight slot. Deliberately declared before every other route, as the
# simplest one in the file.
@app.get("/api/health")
def health_check() -> dict[str, str]:
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}


# Anti-rate-limit architecture: the primary (yfinance) path gets a full,
# genuine retry budget — up to 4 attempts total (1 initial + 3 retries) —
# before this file gives up on it and tries the chart API fallback, which
# gets its own equally full budget. AMBUSH RADAR MOVING-AVERAGE FIX: bumped
# from 2 retries (3 attempts) to 3 (4 attempts) specifically for these
# history-driving calls — SMA50/SMA200 depend on a full, uninterrupted
# history fetch succeeding, unlike a one-off price check, so a little more
# retry budget here specifically is worth the extra latency on the rare
# request that actually needs it.
PRIMARY_FETCH_MAX_RETRIES = 3
PRIMARY_FETCH_BASE_BACKOFF_SECONDS = 2.0
FALLBACK_FETCH_MAX_RETRIES = 3
TICKER_HISTORY_PERIOD = "1y"


def _fetch_ticker_snapshot_via_yfinance(
    symbol: str, history_period: str = TICKER_HISTORY_PERIOD
) -> TickerSnapshot:
    """Primary data source: yf.Ticker(symbol).fast_info for a real-time
    current price, plus ONE yf.Ticker(symbol).history(period=history_period)
    call for everything else (SMA50/SMA200, 52-week high, and the daily
    closes the anomaly checks reuse) — deliberately never
    yf.Ticker(symbol).info, which pulls the full quoteSummary payload and
    is by far the most rate-limit-prone endpoint yfinance exposes.
    SMA50/SMA200 are always computed here from the closes ourselves (not
    read from fast_info's own fifty_day_average/two_hundred_day_average
    fields), so the calculation is identical regardless of whether this
    path or the chart API fallback below ends up serving the request.

    history_period defaults to TICKER_HISTORY_PERIOD ("1y") but can be
    overridden to EXTENDED_HISTORY_PERIOD ("2y") — see
    _fetch_ticker_snapshot_with_fallback's own comment for why a caller
    would ask for a longer window.
    """
    ticker = yf.Ticker(symbol, session=_yahoo_session)

    history = fetch_with_retry(
        lambda: ticker.history(period=history_period),
        description=f"yfinance {history_period} history fetch for '{symbol}'",
        max_retries=PRIMARY_FETCH_MAX_RETRIES,
        base_backoff_seconds=PRIMARY_FETCH_BASE_BACKOFF_SECONDS,
    )
    if history.empty:
        raise TickerNotFoundError(f"yfinance returned no price history for '{symbol}'")

    closes = [float(close) for close in history["Close"].tolist() if close is not None]
    highs = [float(high) for high in history["High"].tolist() if high is not None]
    if not closes:
        raise TickerNotFoundError(f"yfinance returned no usable closes for '{symbol}'")

    # fast_info gives a real-time current price (today's row in `history`
    # can lag/be incomplete mid-session) AND this instrument's currency
    # code (see the Multi-Currency engine, _resolve_currency_converters);
    # fall back to the last close / no currency if fast_info is unavailable
    # or raises, so a fast_info hiccup alone never fails the whole request
    # when history already succeeded.
    price = closes[-1]
    high_52: float | None = None
    currency: str | None = None
    try:
        fast_info = fetch_with_retry(
            lambda: ticker.fast_info,
            description=f"yfinance fast_info fetch for '{symbol}'",
            max_retries=PRIMARY_FETCH_MAX_RETRIES,
            base_backoff_seconds=PRIMARY_FETCH_BASE_BACKOFF_SECONDS,
        )
        raw_price = getattr(fast_info, "last_price", None)
        if raw_price is not None:
            price = float(raw_price)
        raw_year_high = getattr(fast_info, "year_high", None)
        if raw_year_high is not None:
            high_52 = float(raw_year_high)
        currency = getattr(fast_info, "currency", None)
    except Exception as fast_info_error:  # noqa: BLE001 - best-effort; history's last close/high already cover us
        print(f"[resilience] fast_info fetch failed for '{symbol}' ({fast_info_error}); using history instead.")

    if high_52 is None and highs:
        high_52 = max(highs)

    sma50 = sum(closes[-SMA_50_WINDOW:]) / SMA_50_WINDOW if len(closes) >= SMA_50_WINDOW else None
    sma200 = sum(closes[-SMA_200_WINDOW:]) / SMA_200_WINDOW if len(closes) >= SMA_200_WINDOW else None

    return TickerSnapshot(
        price=price, sma50=sma50, sma200=sma200, high_52=high_52, closes=closes, currency=currency
    )


def _fetch_ticker_snapshot_via_chart_fallback(
    symbol: str, history_range: str = CHART_HISTORY_RANGE
) -> TickerSnapshot:
    """Fallback data source: a direct request to Yahoo's chart endpoint,
    bypassing yfinance entirely (not just .info) — used when
    _fetch_ticker_snapshot_via_yfinance's history/fast_info calls fail
    outright, OR (see _fetch_ticker_snapshot_with_fallback) when they
    technically succeeded but didn't return enough closes to compute
    SMA200. SMA50/SMA200 are computed from the returned daily close
    history the same way as the primary path; 52-week high prefers Yahoo's
    own "fiftyTwoWeekHigh" meta field (accounts for intraday highs) and
    falls back to the max of the returned daily highs.

    history_range defaults to CHART_HISTORY_RANGE ("1y") but can be
    overridden to EXTENDED_CHART_HISTORY_RANGE ("2y") — see
    _fetch_ticker_snapshot_with_fallback's own comment for why a caller
    would ask for a longer window.

    Routed through fetch_with_retry just like the primary path, so it gets
    the exact same anti-rate-limit treatment (see FALLBACK_FETCH_MAX_
    RETRIES) — up to 4 attempts, honoring a 429's own Retry-After header
    when present (see fetch_with_retry), and a freshly randomized
    User-Agent applied to the shared session before each one."""

    def do_fetch():
        response = _yahoo_session.get(
            f"{CHART_API_BASE_URL}/{symbol}",
            params={"interval": CHART_HISTORY_INTERVAL, "range": history_range},
            timeout=10.0,
        )
        # Confirmed by testing: Yahoo returns HTTP 404 (with a well-formed
        # {"chart": {"result": null, "error": {...}}} body) for an invalid
        # ticker — that body is parsed below into a clean TickerNotFoundError,
        # so we deliberately don't raise here for a 404. Any other error
        # status (429/503/5xx) has no useful body, so it raises normally,
        # letting fetch_with_retry retry it if appropriate.
        if response.status_code != 404:
            response.raise_for_status()
        return response

    response = fetch_with_retry(
        do_fetch,
        description=f"chart API fallback fetch ({history_range}) for '{symbol}'",
        max_retries=FALLBACK_FETCH_MAX_RETRIES,
        base_backoff_seconds=PRIMARY_FETCH_BASE_BACKOFF_SECONDS,
    )

    try:
        payload = response.json()
        chart = payload.get("chart", {})
        results = chart.get("result") or []
        if not results:
            error_description = (chart.get("error") or {}).get("description", "no data returned")
            raise TickerNotFoundError(f"chart API returned no data for '{symbol}': {error_description}")

        result = results[0]
        meta = result.get("meta", {})
        quote = (result.get("indicators", {}).get("quote") or [{}])[0]
        closes = [float(close) for close in quote.get("close", []) if close is not None]
        highs = [float(high) for high in quote.get("high", []) if high is not None]

        price = meta.get("regularMarketPrice")
        if price is None and closes:
            price = closes[-1]
        if price is None:
            raise TickerNotFoundError(f"chart API returned no usable price for '{symbol}'")
        price = float(price)
    except TickerNotFoundError:
        raise
    except (KeyError, IndexError, TypeError, ValueError) as parse_error:
        raise ValueError(f"Failed to parse chart API response for '{symbol}': {parse_error}") from parse_error

    sma50 = sum(closes[-SMA_50_WINDOW:]) / SMA_50_WINDOW if len(closes) >= SMA_50_WINDOW else None
    sma200 = sum(closes[-SMA_200_WINDOW:]) / SMA_200_WINDOW if len(closes) >= SMA_200_WINDOW else None

    high_52 = meta.get("fiftyTwoWeekHigh")
    if high_52 is not None:
        high_52 = float(high_52)
    elif highs:
        high_52 = max(highs)

    # This endpoint's meta object reports the instrument's currency
    # directly (e.g. "USD", "ILA") — same field the Multi-Currency engine
    # (_resolve_currency_converters) reads from fast_info.currency on the
    # primary path.
    currency = meta.get("currency")

    return TickerSnapshot(
        price=price, sma50=sma50, sma200=sma200, high_52=high_52, closes=closes, currency=currency
    )


def _has_sufficient_sma_history(snapshot: TickerSnapshot) -> bool:
    """True once a snapshot has enough daily closes to compute SMA200 — the
    stricter of the two windows this file cares about, so "sufficient for
    SMA200" always implies "sufficient for SMA50" too (SMA_200_WINDOW >
    SMA_50_WINDOW). Used by _fetch_ticker_snapshot_with_fallback to decide
    whether a technically-successful fetch is actually good enough to stop
    on, or whether it's worth trying another source/window instead.
    """
    return len(snapshot.closes) >= SMA_200_WINDOW


def _fetch_ticker_snapshot_with_fallback(symbol: str) -> TickerSnapshot:
    """AMBUSH RADAR MOVING-AVERAGE FIX: orchestrates the full SMA50/SMA200
    history fetch across every data source/window this file has, in order
    of preference, stopping as soon as one actually returns enough daily
    closes to compute SMA200 — not just as soon as one merely avoids
    raising an exception.

    That distinction is the actual bug this fixes. The old orchestration
    (formerly inlined in get_stock) only ever tried the chart API fallback
    when the primary yfinance fetch RAISED — but yfinance's
    history(period="1y") has been observed, live, to sometimes return a
    truncated series under load/rate-limiting WITHOUT raising anything at
    all; it just silently hands back however many rows it happened to
    fetch. That truncated-but-"successful" snapshot used to be accepted as
    final and cached for CACHE_TTL_SECONDS (15 minutes), which is exactly
    what produced "Not enough moving-average data" for tickers that
    genuinely do have 200+ trading days available — a transient fetch
    problem, not a real data gap, being treated as if it were one.

    The order tried:
      1. yfinance, default TICKER_HISTORY_PERIOD ("1y").
      2. Yahoo's chart API, default CHART_HISTORY_RANGE ("1y") — tried
         both on an outright failure of (1) AND when (1) "succeeded" but
         came up short on closes, since an independent endpoint is a
         meaningfully different chance at a clean, untruncated response.
      3. Yahoo's chart API again, but with EXTENDED_CHART_HISTORY_RANGE
         ("2y") — a last resort, only reached if BOTH default-range
         attempts above came up short, on the theory that a longer
         requested window has a real chance of still landing >= 200 closes
         even if the underlying truncation issue drops some of the most
         recent rows.

    If every attempt raises outright, the first one's error is the one
    surfaced (via TickerNotFoundError, or re-raised for get_stock's own
    generic-failure handling) — matching the original behavior for a
    ticker that doesn't exist at all. If at least one attempt SUCCEEDED
    but none reached SMA_200_WINDOW closes, the snapshot with the MOST
    closes collected is returned (not simply the last one tried) — at that
    point this is very likely a genuinely short-history ticker (a recent
    IPO), not a bug, so SMA50 can still be computed even though SMA200
    legitimately can't be, exactly like before this fix for that case.
    """
    candidates: list[TickerSnapshot] = []
    first_error: Exception | None = None

    try:
        snapshot = _fetch_ticker_snapshot_via_yfinance(symbol)
        candidates.append(snapshot)
        if _has_sufficient_sma_history(snapshot):
            return snapshot
        print(
            f"[resilience] yfinance returned only {len(snapshot.closes)} closes for '{symbol}' "
            f"(need {SMA_200_WINDOW} for SMA200); trying the chart API fallback for more history."
        )
    except TickerNotFoundError as not_found_error:
        # A clean "not found" from yfinance itself is still worth
        # double-checking against the fallback, since yfinance being
        # blocked can sometimes surface as an empty/missing-price result
        # rather than a raised network error.
        first_error = not_found_error
    except Exception as primary_error:  # noqa: BLE001 - yfinance raises many different error types
        print(f"[resilience] yfinance failed for '{symbol}' ({primary_error}); trying chart API fallback.")
        first_error = primary_error

    try:
        snapshot = _fetch_ticker_snapshot_via_chart_fallback(symbol)
        candidates.append(snapshot)
        if _has_sufficient_sma_history(snapshot):
            return snapshot
        print(
            f"[resilience] chart API fallback also returned only {len(snapshot.closes)} closes for "
            f"'{symbol}'; retrying with an extended {EXTENDED_CHART_HISTORY_RANGE} window."
        )
    except TickerNotFoundError as not_found_error:
        # A clean "this ticker doesn't exist" signal from a SECOND,
        # independent data source (not a transient network/rate-limit
        # failure) — no amount of extended-window retrying changes that,
        # so short-circuit straight to raising it rather than burning
        # another 4-attempt retry budget against a symbol that simply
        # isn't real. Only short-circuits when yfinance didn't already
        # collect a real (if insufficient) candidate of its own — if it
        # did, this ticker clearly DOES exist, and the extended window is
        # still worth trying for it despite the chart API's own failure.
        if not candidates:
            raise
        first_error = first_error or not_found_error
    except Exception as fallback_error:  # noqa: BLE001 - network/parse errors from the fallback request
        if first_error is None:
            first_error = fallback_error
        print(f"[resilience] chart API fallback failed for '{symbol}' ({fallback_error}).")

    # LAST RESORT: neither default-range attempt reached SMA_200_WINDOW
    # closes (or both raised outright). One more try, explicitly asking
    # for a longer window — see this function's own docstring for why that
    # has a real chance of recovering from a transient truncation that a
    # 1-year request didn't.
    try:
        snapshot = _fetch_ticker_snapshot_via_chart_fallback(symbol, history_range=EXTENDED_CHART_HISTORY_RANGE)
        candidates.append(snapshot)
        if _has_sufficient_sma_history(snapshot):
            return snapshot
    except Exception as extended_error:  # noqa: BLE001 - best-effort last resort; candidates may still have data
        print(f"[resilience] extended {EXTENDED_CHART_HISTORY_RANGE} chart API fetch failed for '{symbol}' ({extended_error}).")
        if first_error is None:
            first_error = extended_error

    if not candidates:
        assert first_error is not None
        raise first_error

    # Every attempt fell short of SMA_200_WINDOW closes, but at least one
    # returned SOME data — return whichever collected the most (very
    # likely a genuinely short-history ticker at this point, not a bug),
    # so SMA50 can still be computed even where SMA200 legitimately can't.
    return max(candidates, key=lambda candidate: len(candidate.closes))


# --- Israeli mutual funds (קרנות נאמנות / קרנות מחקות) via Bizportal -----
# Yahoo Finance does not list Israeli mutual funds at all, so a fund's
# 7-digit paper number (e.g. "5122510") 404s on both yfinance and the
# chart API. Those funds are priced from Bizportal's public fund quote page
# instead (see _fetch_mutual_fund_snapshot_via_bizportal).
#
# A 7-digit number is NOT proof of a mutual fund: TASE stocks (e.g.
# 1081124) and TASE ETFs (e.g. 1159250) use 7-digit paper numbers too, and
# Yahoo serves those fine as "<number>.TA". So 7-digit tickers try
# Bizportal FIRST, and fall through to the existing Yahoo path whenever
# Bizportal says the number isn't a mutual fund — see _fetch_ticker_snapshot.
MUTUAL_FUND_TICKER_PATTERN = re.compile(r"^(\d{7})" + re.escape(TASE_TICKER_SUFFIX) + r"$")
BIZPORTAL_FUND_URL = "https://www.bizportal.co.il/mutualfunds/quote/generalview/{fund_number}"
# Verified live: a real mutual fund's page stays on this path. Any other
# 7-digit paper number is REDIRECTED away from it (stocks to
# /capitalmarket/, ETFs to /tradedfund/, unknown numbers to a paper list),
# so the final URL path is the primary "is this a mutual fund" signal.
BIZPORTAL_FUND_PATH_PREFIX = "/mutualfunds/quote/"
BIZPORTAL_REQUEST_TIMEOUT_SECONDS = 10.0
BIZPORTAL_FETCH_MAX_RETRIES = 2
# Hebrew labels Bizportal renders on a fund page. The redemption price
# (מחיר פדיון) is what a holding is actually worth if sold, so it's the
# valuation price used here rather than the buy price (מחיר קנייה), which
# can include a front-end load.
BIZPORTAL_REDEMPTION_PRICE_LABEL = "מחיר פדיון"
BIZPORTAL_CURRENCY_LABEL = "מטבע"
BIZPORTAL_ILS_CURRENCY_VALUE = 'ש"ח'
BIZPORTAL_52_WEEK_RANGE_LABEL = "טווח 52 שבועות"
# Bizportal quotes ILS-denominated fund unit prices in Agorot — the same
# unit Yahoo reports for ".TA" instruments — so the raw price is recorded
# with this code and the existing Multi-Currency engine
# (_resolve_currency_converters) applies its usual ÷100 and ÷USD/ILS math.
BIZPORTAL_PRICE_CURRENCY_CODE = "ILA"
BIZPORTAL_BROWSER_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
    "Connection": "keep-alive",
}


class NotAMutualFundError(Exception):
    """Bizportal says this 7-digit paper number is not a mutual fund (it
    redirected away from the fund page, or 404'd). The caller falls through
    to the regular Yahoo path, since the number may be a TASE stock/ETF."""


class UnsupportedFundCurrencyError(Exception):
    """The fund exists on Bizportal but isn't ILS-denominated. Its price is
    not in Agorot, so running it through the ".TA" Agorot conversion would
    misprice it — this is surfaced as an explicit error instead."""


class MutualFundSourceUnavailableError(Exception):
    """Bizportal couldn't be reached/parsed AND the Yahoo fallback also
    failed for the same 7-digit ticker."""


def _extract_mutual_fund_number(symbol: str) -> str | None:
    """Returns the 7-digit paper number if `symbol` (already normalized by
    _normalize_ticker_symbol, so a bare "5122510" has become "5122510.TA")
    is a candidate Israeli mutual fund ticker, else None."""
    match = MUTUAL_FUND_TICKER_PATTERN.match(symbol.strip().upper())
    return match.group(1) if match else None


def _parse_bizportal_number(raw_text: str) -> float:
    """Parses a Bizportal numeric cell ("301.7", "1,234.56") into a float.
    Raises ValueError on anything unparseable, including an empty cell."""
    cleaned = raw_text.strip().replace(",", "")
    if not cleaned:
        raise ValueError("empty numeric value")
    return float(cleaned)


def _parse_bizportal_fund_page(html: str | bytes, fund_number: str) -> TickerSnapshot:
    """Extracts the redemption price, currency, and 52-week range from a
    Bizportal mutual fund page into the same TickerSnapshot shape the Yahoo
    paths produce. Raises NotAMutualFundError if the page has no redemption
    price label, UnsupportedFundCurrencyError for a non-ILS fund, and
    ValueError if the price itself can't be parsed (i.e. the markup
    changed)."""
    soup = BeautifulSoup(html, "html.parser")

    # The redemption price lives in <div class="top-area-cube"> as a
    # <div class="label">מחיר פדיון</div><div class="num">301.7</div> pair.
    # Matching on the label text, not on the cube's position, so a buy
    # price cube appearing first (or not at all) can't be misread as it.
    price_label = soup.find("div", class_="label", string=lambda text: text and text.strip() == BIZPORTAL_REDEMPTION_PRICE_LABEL)
    if price_label is None:
        raise NotAMutualFundError(f"Bizportal page for '{fund_number}' has no redemption price.")
    price_cell = price_label.find_next_sibling("div", class_="num")
    if price_cell is None:
        raise ValueError(f"Bizportal redemption price cell missing for fund '{fund_number}'.")
    price_agorot = _parse_bizportal_number(price_cell.get_text())
    if price_agorot <= 0:
        raise ValueError(f"Bizportal returned a non-positive price ({price_agorot}) for fund '{fund_number}'.")

    # The fund's details are <dt>label</dt><dd>value</dd> pairs. Only an
    # explicit non-ILS currency is rejected; a missing currency row is
    # treated as ILS, since every fund page checked carries one and ILS is
    # by far the common case.
    currency_label = soup.find("dt", string=lambda text: text and text.strip() == BIZPORTAL_CURRENCY_LABEL)
    if currency_label is not None:
        currency_value_cell = currency_label.find_next_sibling("dd")
        currency_value = currency_value_cell.get_text(strip=True) if currency_value_cell else ""
        if currency_value and currency_value != BIZPORTAL_ILS_CURRENCY_VALUE:
            raise UnsupportedFundCurrencyError(
                f"Fund '{fund_number}' is denominated in '{currency_value}', not ILS; "
                "only ILS (Agorot-priced) mutual funds are supported."
            )

    # 52-week range: two <div class="num"> cells under the range graph.
    # max() rather than relying on their order, which follows the page's
    # RTL layout. Optional — a missing range just leaves high_52 as None,
    # the same way the Yahoo paths degrade.
    high_52: float | None = None
    range_label = soup.find("dt", string=lambda text: text and text.strip() == BIZPORTAL_52_WEEK_RANGE_LABEL)
    if range_label is not None:
        range_value_cell = range_label.find_next_sibling("dd")
        if range_value_cell is not None:
            range_values: list[float] = []
            for cell in range_value_cell.find_all("div", class_="num"):
                try:
                    range_values.append(_parse_bizportal_number(cell.get_text()))
                except ValueError:
                    continue
            if range_values:
                high_52 = max(range_values)

    # Bizportal's general view has no daily price history, so there are no
    # closes to compute SMA50/SMA200 from. Those stay None and the existing
    # "can't be evaluated" handling applies (the same as a newly listed
    # Yahoo ticker). `closes` holds just today's price, so every downstream
    # history check (anomaly move, std dev, Z-Score) sees too little data
    # and returns None rather than raising.
    return TickerSnapshot(
        price=price_agorot,
        sma50=None,
        sma200=None,
        high_52=high_52,
        closes=[price_agorot],
        currency=BIZPORTAL_PRICE_CURRENCY_CODE,
    )


def _fetch_mutual_fund_snapshot_via_bizportal(fund_number: str) -> TickerSnapshot:
    """Fetches one Israeli mutual fund's current unit price from Bizportal.

    Uses plain `requests` with browser headers and a rotated User-Agent
    (verified to be served normally by Bizportal), routed through
    fetch_with_retry so it shares the app's process-wide request spacing and
    retries 429/503/network errors with backoff. Results land in the same
    15-minute TICKER_CACHE as Yahoo snapshots (see get_stock), so each fund
    page is fetched at most once per 15 minutes.
    """
    url = BIZPORTAL_FUND_URL.format(fund_number=fund_number)

    def do_fetch() -> _plain_requests.Response:
        headers = {**BIZPORTAL_BROWSER_HEADERS, "User-Agent": random.choice(USER_AGENTS)}
        response = _plain_requests.get(
            url, headers=headers, timeout=BIZPORTAL_REQUEST_TIMEOUT_SECONDS, allow_redirects=True
        )
        # A 404 is a definitive "no such fund page", not a transient error,
        # so it's returned for the caller to classify rather than raised
        # (raising would make fetch_with_retry retry it pointlessly).
        if response.status_code != 404:
            response.raise_for_status()
        return response

    response = fetch_with_retry(
        do_fetch,
        description=f"Bizportal mutual fund fetch for '{fund_number}'",
        max_retries=BIZPORTAL_FETCH_MAX_RETRIES,
    )

    if response.status_code == 404:
        raise NotAMutualFundError(f"Bizportal returned 404 for paper number '{fund_number}'.")
    if not urlparse(response.url).path.startswith(BIZPORTAL_FUND_PATH_PREFIX):
        raise NotAMutualFundError(
            f"Bizportal redirected paper number '{fund_number}' to '{response.url}' (not a mutual fund)."
        )

    # Raw bytes, not response.text: if a response ever lacks a charset
    # header, `requests` decodes text/html as ISO-8859-1, which would
    # garble the Hebrew labels the parser matches on. BeautifulSoup reads
    # the page's own <meta charset> from the bytes instead.
    return _parse_bizportal_fund_page(response.content, fund_number)


def _fetch_ticker_snapshot(symbol: str) -> TickerSnapshot:
    """Top-level data-source router for get_stock.

    - Not a 7-digit ".TA" ticker: the existing Yahoo orchestration
      (_fetch_ticker_snapshot_with_fallback), unchanged.
    - A 7-digit ".TA" ticker: Bizportal first, bypassing Yahoo entirely
      when it is a mutual fund. If Bizportal says it isn't one, the Yahoo
      path runs as before, since 7-digit TASE stocks/ETFs live there.
    - If Bizportal is unreachable or its page can't be parsed, there's no
      way to know whether the number is a fund or a stock/ETF, so Yahoo is
      still tried. Only if that ALSO fails is an error raised, carrying
      both failures so a real fund's error doesn't read as "not found".
    """
    fund_number = _extract_mutual_fund_number(symbol)
    if fund_number is None:
        return _fetch_ticker_snapshot_with_fallback(symbol)

    try:
        return _fetch_mutual_fund_snapshot_via_bizportal(fund_number)
    except NotAMutualFundError as not_a_fund:
        print(f"[mutual-fund] {not_a_fund} Falling back to Yahoo for '{symbol}'.")
        return _fetch_ticker_snapshot_with_fallback(symbol)
    except UnsupportedFundCurrencyError:
        raise
    except Exception as bizportal_error:  # noqa: BLE001 - network/parse failures; fund-vs-stock is unknown
        print(f"[mutual-fund] Bizportal failed for '{fund_number}' ({bizportal_error}); trying Yahoo for '{symbol}'.")
        try:
            return _fetch_ticker_snapshot_with_fallback(symbol)
        except Exception as yahoo_error:  # noqa: BLE001 - combined into one explicit error below
            raise MutualFundSourceUnavailableError(
                f"Bizportal (mutual funds) failed: {bizportal_error}; Yahoo also failed: {yahoo_error}"
            ) from yahoo_error


def fetch_anomaly_news(
    ticker_symbol: str, closes: list[float], threshold: float = ANOMALY_THRESHOLD_DEFAULT
) -> str | None:
    """Checks whether ticker_symbol moved >= threshold since the prior
    close and, if so, returns a formatted string naming the move plus its
    latest news headlines. Returns None when there's no notable move.

    closes comes from the same cached TickerSnapshot get_stock already
    fetched for the primary price/SMA response — day-over-day % change is
    scale-invariant, so these can be used as-is even for TASE tickers
    (still in raw Agorot, unconverted) without this function needing its
    own separate history call any more. The news fetch itself (only made
    when the move actually crosses the threshold) still uses the shared
    TLS-impersonating session and a small retry budget via fetch_with_retry
    instead of an unthrottled direct call.
    """
    if len(closes) < 2:
        return None

    prev_close = closes[-2]
    current_price = closes[-1]
    if prev_close == 0:
        return None

    pct_change = (current_price - prev_close) / prev_close
    if abs(pct_change) < threshold:
        return None

    direction = "CRASH" if pct_change < 0 else "SURGE"

    try:
        news_data = fetch_with_retry(
            lambda: yf.Ticker(ticker_symbol, session=_yahoo_session).news,
            description=f"anomaly news fetch for '{ticker_symbol}'",
            max_retries=ANOMALY_FETCH_MAX_RETRIES,
            base_backoff_seconds=ANOMALY_FETCH_BASE_BACKOFF_SECONDS,
        )
    except Exception as error:  # noqa: BLE001 - supplementary data; never let this break the main stock response
        print(f"[resilience] Anomaly news fetch failed for '{ticker_symbol}': {error}")
        return f"[ANOMALY: {direction} {abs(pct_change) * 100:.1f}%] News fetch failed."

    if not news_data:
        return f"[ANOMALY: {direction} {abs(pct_change) * 100:.1f}%] No recent news found."

    # Verified against the live API: current Yahoo news items nest the
    # headline under "content" (e.g. article["content"]["title"]), not
    # as a flat article["title"] — falling back to the flat shape too
    # in case Yahoo reverts it.
    headlines = []
    for article in news_data[:ANOMALY_NEWS_COUNT]:
        content = article.get("content") or {}
        title = content.get("title") or article.get("title") or "No Title"
        headlines.append(title)

    news_str = " | ".join(headlines)
    return f"[ANOMALY: {direction} {abs(pct_change) * 100:.1f}%] NEWS: {news_str}"


def _calculate_std_dev(closes: list[float], window: int = ANOMALY_STD_DEV_WINDOW) -> float | None:
    """Population standard deviation of the last `window` daily closes.

    Returns None — not a raised error — when there isn't enough price
    history to compute a meaningful figure. Callers treat that as "the
    std-dev trigger can't be evaluated," never as a fetch failure, and
    ANOMALY_STD_DEV_WINDOW > 0 always, so there's no division-by-zero risk
    here.
    """
    if len(closes) < window:
        return None

    recent_closes = closes[-window:]
    mean = sum(recent_closes) / window
    variance = sum((close - mean) ** 2 for close in recent_closes) / window
    return variance**0.5


def _update_high_water_mark(existing_high_water_mark: float | None, current_price: float) -> float:
    """Trailing Stop Engine: the sync rule, verbatim — "update
    high_water_mark ... if the new current_price is strictly greater than
    the existing high_water_mark." A missing existing watermark (a
    position's very first fetch — nothing to compare against yet) seeds it
    from current_price, matching the frontend's own computeHighestWatermark
    (src/app/(tabs)/index.tsx) so the two stay consistent whether or not a
    caller has an existing value to send.
    """
    if existing_high_water_mark is None:
        return current_price
    return current_price if current_price > existing_high_water_mark else existing_high_water_mark


def _calculate_quality_zscore(
    closes: list[float], current_price: float, current_sma50: float | None
) -> float | None:
    """Quality Z-Score Module: how many standard deviations `current_price`
    sits away from its own SMA50, relative to how that same (price - SMA50)
    / SMA50 relationship has behaved over the trailing QUALITY_ZSCORE_WINDOW
    trading days.

    For each of the last QUALITY_ZSCORE_WINDOW days, computes that day's own
    trailing SMA50 (a rolling calculation, not the single current SMA50
    reused for every day) and its percentage deviation from it, then takes
    the population mean/std dev of those deviations. The current deviation
    is standardized against that mean/std dev the usual way: z = (x -
    mean) / std_dev.

    Deliberately computed from RATIOS ((close - sma) / sma), not raw price
    differences — this is currency-scale-invariant (a fixed linear
    conversion like Agorot -> ILS or ILS -> USD cancels out of a ratio), so
    `closes` can safely be the raw/native-currency history already cached
    on the TickerSnapshot (same one check_mean_reversion_anomaly reuses)
    without needing its own currency-converted history. `current_price`/
    `current_sma50` should be from that same raw basis for consistency,
    though the ratio math means it would be equally valid on the
    USD-converted basis instead.

    Returns None whenever there isn't enough history
    (QUALITY_ZSCORE_MIN_HISTORY closes) to compute every rolling SMA50 the
    window needs, current_sma50 itself is unavailable/non-positive, or the
    historical deviations have zero variance (a division-by-zero guard,
    not expected in practice for real price data) — "can't be evaluated,"
    never a misleading guessed value, matching this file's existing
    convention (drawdown_pct, mean_reversion_anomaly's own std dev).
    """
    if current_sma50 is None or current_sma50 <= 0:
        return None
    if len(closes) < QUALITY_ZSCORE_MIN_HISTORY:
        return None

    historical_deviations: list[float] = []
    for offset in range(QUALITY_ZSCORE_WINDOW):
        # offset 0 = the most recent historical day in the window, up to
        # QUALITY_ZSCORE_WINDOW - 1 = the oldest. end_index is exclusive
        # (Python slice convention), so closes[end_index - 1] is that day's
        # own close and closes[end_index - SMA_50_WINDOW:end_index] is the
        # trailing 50 closes ending on (and including) it.
        end_index = len(closes) - offset
        rolling_window = closes[end_index - SMA_50_WINDOW : end_index]
        day_sma50 = sum(rolling_window) / SMA_50_WINDOW
        if day_sma50 <= 0:
            continue
        day_close = closes[end_index - 1]
        historical_deviations.append(((day_close - day_sma50) / day_sma50) * 100)

    # Fewer than 2 usable data points can't produce a meaningful std dev
    # (and would risk a near-zero one even if it technically computed).
    if len(historical_deviations) < 2:
        return None

    mean_deviation = sum(historical_deviations) / len(historical_deviations)
    variance = sum((deviation - mean_deviation) ** 2 for deviation in historical_deviations) / len(
        historical_deviations
    )
    std_deviation = variance**0.5
    if std_deviation == 0:
        return None

    current_deviation = ((current_price - current_sma50) / current_sma50) * 100
    return (current_deviation - mean_deviation) / std_deviation


def _quality_zscore_alert_active(
    z_score: float | None, roic: float | None, quality_layer_weight_pct: float | None
) -> bool:
    """Z-SCORE CONSTRAINTS gate — see the constants' own comments above for
    the full rationale. Returns False (never raises, never guesses "maybe")
    whenever any one of the three conditions is unmet OR unknown: a missing
    roic or quality_layer_weight_pct (the caller simply didn't supply
    portfolio-composition context — see get_stock's own query params) is
    treated the same as "condition not satisfied," not as "condition
    doesn't apply." This is a pure gate function, deliberately separate
    from _calculate_quality_zscore, so the raw z_score can always be
    returned/displayed even when the alert itself can't fire.
    """
    if z_score is None:
        return False
    if not (QUALITY_ZSCORE_ALERT_LOWER <= z_score <= QUALITY_ZSCORE_ALERT_UPPER):
        return False
    if roic is None or roic < QUALITY_ZSCORE_MIN_ROIC:
        return False
    if quality_layer_weight_pct is None or quality_layer_weight_pct > QUALITY_MAX_LAYER_WEIGHT_PCT:
        return False
    return True


def check_mean_reversion_anomaly(
    ticker_symbol: str,
    category: str,
    price: float,
    sma50: float | None,
    high_52: float | None,
    closes: list[float],
    currency_converter: Callable[[float], float] | None = None,
) -> str | None:
    """UNIFIED DEFENSE PROTOCOLS: Margin-of-Safety anomaly check for the
    Ambush Radar / Mean Reversion screen, bifurcated by Fortress 2.0
    portfolio LAYER — Satellite vs. Quality (see BEARISH_ANOMALY_RULES) —
    not by Stock/ETF asset type any more.

    'Core' returns None immediately, before any trigger is evaluated at
    all: Core positions are held through drawdowns by design (same
    philosophy as this app's client-side trailing-stop logic, which never
    gives Core an automatic stop either), so there is no "Core threshold"
    to fall back to.

    price/sma50/high_52 must already be in the same currency (e.g. already
    USD-converted for ILS/Agorot-quoted instruments — see get_stock's
    Multi-Currency engine) since the structural support trigger compares
    them directly. closes comes from the same cached TickerSnapshot
    get_stock already fetched (raw/native currency, unconverted) — this
    function no longer makes its own separate history call for the 20-day
    std dev the way it used to. currency_converter (get_stock's `to_usd`)
    is applied to the computed std dev to bring it onto the same basis as
    price/sma50/high_52 — valid because standard deviation scales linearly
    under a zero-intercept conversion like Agorot -> USD or ILS -> USD.

    Returns None (not an error) whenever a trigger can't be evaluated at all
    for lack of data (missing/zero 52-week high, missing SMA50, or fewer
    than ANOMALY_STD_DEV_WINDOW closes) rather than treating "unknown" as
    "no anomaly" on one trigger while still checking the other normally.
    """
    if category == "Core":
        return None

    rules = BEARISH_ANOMALY_RULES.get(category, BEARISH_ANOMALY_RULES[DEFAULT_ANOMALY_CATEGORY])
    drawdown_threshold_pct = rules["drawdown_pct"]
    std_dev_multiplier = rules["std_dev_multiplier"]

    triggers: list[str] = []

    # Trigger 1: drawdown from the 52-week high. Guarded against a missing
    # or non-positive high_52 to avoid a division-by-zero on bad upstream
    # data (mirrors the guard already used for drawdown_pct in get_stock).
    # -15% is now EXCLUSIVELY the Quality layer's Kill Switch; every
    # Satellite position (Stock or ETF alike) is judged at the single
    # unified -7% threshold instead — see BEARISH_ANOMALY_RULES.
    if high_52 is not None and high_52 > 0:
        drawdown_pct = ((price - high_52) / high_52) * 100
        if drawdown_pct <= -drawdown_threshold_pct:
            triggers.append(
                f"{abs(drawdown_pct):.1f}% off its 52-week high "
                f"(>= {drawdown_threshold_pct:.0f}% {category} threshold)"
            )

    # Trigger 2: structural support break, SMA50 - (multiplier * 20-day std dev).
    std_dev = _calculate_std_dev(closes)
    if std_dev is not None and currency_converter is not None:
        std_dev = currency_converter(std_dev)

    if sma50 is not None and std_dev is not None:
        support_floor = sma50 - (std_dev_multiplier * std_dev)
        if price < support_floor:
            triggers.append(
                f"price ${price:.2f} broke below its structural support floor "
                f"${support_floor:.2f} (SMA50 - {std_dev_multiplier:g}x {ANOMALY_STD_DEV_WINDOW}-day std dev)"
            )

    if not triggers:
        return None

    kill_switch_tag = " KILL SWITCH" if category == "Quality" else ""
    return f"[ANOMALY: {category} MEAN REVERSION{kill_switch_tag}] " + "; ".join(triggers)


def _fetch_usd_ils_rate() -> float:
    """Fetch the current USD/ILS exchange rate (shekels per one US dollar),
    using the shared cache (15-minute TTL — see CACHE_TTL_SECONDS/
    fx_rate_cache) and the shared retry/throttle layer.

    Uses fast_info, not .info, for the same reason every other fetch in
    this file does: .info pulls the full quoteSummary payload and is by far
    the most rate-limit-prone endpoint yfinance exposes, whereas fast_info
    is much lighter. Only ever called for ILS/Agorot-quoted instruments
    (see _resolve_currency_converters) — a USD-quoted ticker, the
    overwhelming majority, never triggers this fetch at all, cached or not.
    """
    cached_rate = fx_rate_cache.get(USD_ILS_FX_SYMBOL)
    if cached_rate is not None:
        return cached_rate

    try:
        fast_info = fetch_with_retry(
            lambda: yf.Ticker(USD_ILS_FX_SYMBOL, session=_yahoo_session).fast_info,
            description="USD/ILS FX rate fetch",
        )
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch the USD/ILS exchange rate: {error}",
        ) from error

    raw_rate = getattr(fast_info, "last_price", None)
    if not raw_rate or raw_rate <= 0:
        raise HTTPException(
            status_code=502,
            detail="Failed to fetch a valid USD/ILS exchange rate.",
        )

    fx_rate = float(raw_rate)
    fx_rate_cache.set(USD_ILS_FX_SYMBOL, fx_rate)
    return fx_rate


def _resolve_currency_converters(
    symbol: str,
    currency: str | None,
) -> tuple[str, Callable[[float | None], float | None], Callable[[float | None], float | None]]:
    """Multi-Currency engine: returns (currency_symbol, to_usd,
    to_local_display) — the two converter functions get_stock applies
    identically to each raw price-like field (price, sma50, sma200,
    high_52; local_price only needs to_local_display, applied to price
    alone).

    TASE PRICE NORMALIZATION (Agorot -> ILS): any `symbol` ending in
    TASE_TICKER_SUFFIX (".TA") is ALWAYS treated as Agorot-quoted — 1/100
    of a New Israeli Shekel, matching how Israeli brokerages base their
    unit quantities (Nominal Value / Erech Nakuv) — regardless of what
    `currency` (Yahoo's self-reported code) says. This is deliberately a
    symbol check, not a `currency` check: Yahoo has been observed to report
    ".TA" instruments inconsistently as already-divided 'ILS' for some and
    raw 'ILA'/'ILX' Agorot for others, and trusting that string under-
    converts a meaningful fraction of TASE tickers, inflating their
    USD-normalized price by roughly 100x. So to_local_display always
    divides by 100 to get whole Shekels, and to_usd does that AND divides
    by the cached USD/ILS rate — for every ".TA" symbol, unconditionally.

    For any other symbol, the pre-existing currency-string-based behavior
    is unchanged:
    - 'USD' (or missing/unrecognized — Fallback: default to USD): both
      converters are the identity function.
    - 'ILS': to_local_display is the identity function (already whole
      Shekels); to_usd divides by the cached USD/ILS rate.
    - 'ILA'/'ILX' (Israeli Agorot reported outside TASE, or just as a
      belt-and-suspenders match): same Agorot treatment as the ".TA" branch
      above.

    The USD/ILS rate is only fetched for the ILS/Agorot branches (and only
    once per call here, reused via closure by both converters) — a
    USD-quoted instrument, the overwhelming majority, never triggers an FX
    lookup at all.
    """
    normalized_currency = (currency or DEFAULT_CURRENCY).strip().upper()
    is_tase_ticker = symbol.strip().upper().endswith(TASE_TICKER_SUFFIX)

    if is_tase_ticker or normalized_currency in AGOROT_CURRENCY_CODES:
        fx_rate = _fetch_usd_ils_rate()

        def to_local_display(agorot_value: float | None) -> float | None:
            return agorot_value / AGOROT_PER_SHEKEL if agorot_value is not None else None

        def to_usd(agorot_value: float | None) -> float | None:
            local_value = to_local_display(agorot_value)
            return local_value / fx_rate if local_value is not None else None

        return CURRENCY_SYMBOL_ILS, to_usd, to_local_display

    if normalized_currency == "ILS":
        fx_rate = _fetch_usd_ils_rate()

        def to_local_display(shekel_value: float | None) -> float | None:
            return shekel_value

        def to_usd(shekel_value: float | None) -> float | None:
            return shekel_value / fx_rate if shekel_value is not None else None

        return CURRENCY_SYMBOL_ILS, to_usd, to_local_display

    # 'USD', or any missing/unrecognized code — Fallback: default to USD
    # rather than guessing at a conversion that may not apply.
    def identity(value: float | None) -> float | None:
        return value

    return CURRENCY_SYMBOL_USD, identity, identity


# TREND CLASSIFICATION: two independent, equally-weighted signals rather
# than one asset-type-dependent verdict (the old logic silently used SMA200
# for ETFs and SMA50 for Stocks, hiding whichever signal it didn't pick).
# Deliberately symmetric between the two callers below (macro_trend vs.
# SMA200, tactical_momentum vs. SMA50) — same function, different sma
# argument — so both indicators are computed identically off the same
# already-currency-normalized `price`.
#
# Returns None (not a guessed "Bearish") when `sma` itself is None —
# insufficient price history to compute it — matching this file's existing
# convention elsewhere (drawdown_pct, mean_reversion_anomaly) of surfacing
# "can't be evaluated" as null rather than a misleading default verdict.
def _classify_trend(price: float, sma: float | None) -> str | None:
    if sma is None:
        return None
    return "Bullish" if price > sma else "Bearish"


def _with_request_scoped_fields(
    cached_result: dict[str, float | str | None],
    normalized_category: str,
    high_water_mark: float | None,
    roic: float | None,
    quality_weight_pct: float | None,
) -> dict[str, float | str | bool | None]:
    """Layers the Trailing Stop Engine's high_water_mark/trailing_stop_price
    and the Quality Z-Score Module's alert gate on top of an already-
    computed (possibly cached) base response.

    These three fields must NEVER be part of the cached payload itself
    (get_stock's stock_cache): they're derived from PER-REQUEST,
    caller-supplied context (a position's own currently-tracked watermark,
    its roic, the Quality layer's current live portfolio weight) rather
    than from Yahoo data — baking them into the shared, symbol-keyed cache
    would let one caller's numbers leak into another's, or let a stale
    watermark survive past whatever CACHE_TTL_SECONDS this ticker happens
    to be cached for. A stale Sell Alert / trailing-stop price is exactly
    the class of bug that isn't acceptable here, so these are always
    recomputed fresh, on every single call, cache hit or miss alike.

    Returns a NEW dict (`dict(cached_result)`, a shallow copy) — never
    mutates cached_result in place, since on a cache hit that's the literal
    object sitting inside stock_cache, and mutating it would corrupt every
    OTHER caller's (and every future request's, until the TTL expires)
    view of it with THIS request's one-off watermark/roic/weight.
    """
    result: dict[str, float | str | bool | None] = dict(cached_result)

    current_price = result["price"]
    assert isinstance(current_price, (int, float))  # always set by get_stock

    updated_high_water_mark = _update_high_water_mark(high_water_mark, float(current_price))
    result["high_water_mark"] = round(updated_high_water_mark, 2)

    # TRAILING STOP DEFENSE CONSTRAINTS: a hardcoded architectural block —
    # Core/Quality get None here UNCONDITIONALLY, never a computed price,
    # regardless of what high_water_mark a caller supplies. Mirrors the
    # identical guard on the frontend (see computeSatelliteTrailingStopPrice
    # in src/app/(tabs)/index.tsx) — belt and suspenders, per the PRD's own
    # "Hardcode a block preventing this from ever showing or calculating
    # for 'Core' or 'Quality' assets" requirement.
    result["trailing_stop_price"] = (
        round(updated_high_water_mark * (1 - SATELLITE_TRAILING_STOP_PCT), 2)
        if normalized_category == "Satellite"
        else None
    )

    raw_z_score = result.get("quality_z_score")
    z_score = raw_z_score if isinstance(raw_z_score, (int, float)) else None
    result["quality_z_score_alert"] = _quality_zscore_alert_active(z_score, roic, quality_weight_pct)

    return result


@app.get("/api/stock/{ticker}")
def get_stock(
    ticker: str,
    include_anomaly: bool = False,
    category: str = DEFAULT_ANOMALY_CATEGORY,
    # TRAILING STOP ENGINE: this position's currently-tracked high water
    # mark (see PortfolioTickerEntry.highestWatermark on the frontend),
    # sent so the sync rule (_update_high_water_mark) and the Satellite-
    # only trailing_stop_price below have something to compare the fresh
    # `price` against. None (the default) means "no prior watermark to
    # compare against" — _update_high_water_mark then seeds it from this
    # response's own price, same as a brand-new position.
    high_water_mark: float | None = None,
    # QUALITY Z-SCORE MODULE: this asset's fundamental Return on Invested
    # Capital and the Quality layer's current live share of the whole
    # portfolio — the two portfolio-composition-dependent halves of the
    # Z-Score alert gate (see QUALITY_ZSCORE_* / _quality_zscore_alert_
    # active) that this stateless, per-ticker endpoint has no way to know
    # on its own. Ambush Radar never sends either (no layer/fundamentals
    # concept at all — same reasoning as `category` above), so both
    # default to None, which _quality_zscore_alert_active treats as
    # "gate not satisfied," never "gate doesn't apply."
    roic: float | None = None,
    quality_weight_pct: float | None = None,
) -> dict[str, float | str | bool | None]:
    # TASE TICKER INTERCEPTOR: a bare numeric security number (e.g.
    # "1081124") is auto-suffixed to "1081124.TA" here, before anything
    # else touches it, so the rest of this function — and every helper it
    # calls — processes it as an ordinary Yahoo Finance symbol without any
    # special-casing of its own. This decides which symbol gets queried;
    # the Multi-Currency engine below decides how to interpret the price
    # Yahoo returns for it — and now also reuses this same normalized
    # `symbol` (specifically its ".TA" suffix, if any) as part of that
    # decision, not just Yahoo's own reported currency.
    symbol = _normalize_ticker_symbol(ticker)
    if not symbol:
        raise HTTPException(status_code=400, detail="Ticker symbol is required.")

    # PORTFOLIO LAYER IDENTIFICATION: read from the incoming query mapping
    # ('Core' / 'Satellite' / 'Quality'), case-insensitively, defaulting to
    # DEFAULT_ANOMALY_CATEGORY ('Satellite') for any missing/unrecognized
    # value — Ambush Radar requests never send this at all (it has no
    # portfolio-layer concept of its own), so they always take that
    # default. Replaces the old Stock/ETF `asset_type` param entirely — see
    # BEARISH_ANOMALY_RULES for why the trigger is now layer-based, not
    # asset-type-based.
    normalized_category = category.strip().capitalize()
    if normalized_category not in ("Core", "Satellite", "Quality"):
        normalized_category = DEFAULT_ANOMALY_CATEGORY

    # The formatted-response cache covers the fully-assembled JSON
    # (including the anomaly checks below, which is why the flag/layer are
    # part of the key — the bifurcated thresholds mean the same ticker can
    # produce a different anomaly string per layer). ALWAYS includes
    # normalized_category now (not just when include_anomaly) — the
    # Quality Z-Score Module's quality_z_score below is category-gated
    # too, so a bare `symbol` key is no longer safe on its own the way it
    # used to be when every non-anomaly field was category-independent.
    # high_water_mark/roic/quality_weight_pct deliberately do NOT become
    # part of this key: those drive fields that must be computed fresh on
    # every single call, after this cache lookup, never cached — see
    # _with_request_scoped_fields' own comment for why baking them in here
    # would risk handing back a stale Sell Alert / trailing-stop price.
    cache_key = f"{symbol}:{normalized_category}:{include_anomaly}"
    cached_result = stock_cache.get(cache_key)
    if cached_result is not None:
        final_result = _with_request_scoped_fields(
            cached_result, normalized_category, high_water_mark, roic, quality_weight_pct
        )
        _sync_high_water_mark_to_supabase(symbol, final_result["high_water_mark"], roic)
        return final_result

    # THE SPEED FIX: check TICKER_CACHE before making any outbound Yahoo
    # call at all. A hit here means this request costs zero network calls,
    # regardless of whether it's also a stock_cache miss (e.g. a first-time
    # include_anomaly=True request for a ticker whose plain price was
    # already fetched and cached moments ago by a different screen).
    snapshot = _get_cached_ticker_snapshot(symbol)
    if snapshot is None:
        # AMBUSH RADAR MOVING-AVERAGE FIX: this used to be an inline
        # try/except chain that only tried the chart API fallback when the
        # primary yfinance fetch RAISED — see
        # _fetch_ticker_snapshot_with_fallback's own (much longer) comment
        # for why that missed the actual bug: a "successful" yfinance fetch
        # that came back truncated (too few closes for SMA200) used to be
        # accepted as final here. That whole orchestration — including the
        # extended-window last resort — is now centralized there instead.
        #
        # ISRAELI MUTUAL FUNDS: _fetch_ticker_snapshot routes a 7-digit
        # ".TA" ticker to Bizportal first (Yahoo doesn't list mutual funds)
        # and every other ticker straight to the Yahoo orchestration above.
        try:
            snapshot = _fetch_ticker_snapshot(symbol)
        except TickerNotFoundError as not_found_error:
            raise HTTPException(
                status_code=404,
                detail=f"No market data found for ticker '{symbol}'.",
            ) from not_found_error
        except UnsupportedFundCurrencyError as currency_error:
            raise HTTPException(status_code=422, detail=str(currency_error)) from currency_error
        except Exception as fetch_error:  # noqa: BLE001 - network/parse errors from every data source tried
            # Every data source/window failed outright: return a clean,
            # formatted JSON error instead of letting an unhandled
            # exception surface as an opaque 502 from the platform
            # (Render) itself.
            raise HTTPException(
                status_code=502,
                detail=f"Failed to fetch data for ticker '{symbol}' from every available data source: {fetch_error}",
            ) from fetch_error

        _set_cached_ticker_snapshot(symbol, snapshot)

    raw_price = snapshot.price
    raw_sma50 = snapshot.sma50
    raw_sma200 = snapshot.sma200
    raw_high_52 = snapshot.high_52
    closes = snapshot.closes

    # MULTI-CURRENCY ENGINE: normalize every price-like field into USD.
    # Any ".TA" (TASE) symbol is ALWAYS treated as Agorot-quoted — see the
    # comment above TASE_TICKER_SUFFIX and inside _resolve_currency_
    # converters for why this is keyed off the symbol itself rather than
    # Yahoo's self-reported currency, which has been observed to be
    # unreliable for this exchange specifically. Every other symbol still
    # uses Yahoo's own reported currency. If this instrument needs an FX
    # rate (ILS/Agorot) and we can't get a trustworthy one,
    # _fetch_usd_ils_rate raises a clean 502 rather than letting a silent
    # guess mislead the user by roughly two orders of magnitude (Agorot) or
    # the day's FX move (ILS).
    currency_symbol, to_usd, to_local_display = _resolve_currency_converters(symbol, snapshot.currency)

    price = to_usd(raw_price)
    local_price = to_local_display(raw_price)
    sma50 = to_usd(raw_sma50)
    sma200 = to_usd(raw_sma200)
    high_52 = to_usd(raw_high_52)

    # Both are non-None here: raw_price is always a real float (never None
    # on TickerSnapshot), and every branch of _resolve_currency_converters'
    # to_usd/to_local_display maps a non-None input to a non-None output.
    assert price is not None
    assert local_price is not None

    # Kept bound to a plain (non-Optional) callable for
    # check_mean_reversion_anomaly's currency_converter param below, which
    # always calls it with a real float (the std dev), never None.
    def to_usd_strict(value: float) -> float:
        converted = to_usd(value)
        assert converted is not None  # to_usd(non-None) never returns None
        return converted

    # 52-week drawdown: how far the current price sits below its 52-week
    # high, as a negative percentage (0 = at the high, more negative = a
    # deeper pullback). high_52 <= 0 shouldn't happen for a real security,
    # but guarded against to avoid a division error on bad upstream data.
    if high_52 is not None and high_52 > 0:
        drawdown_pct = round(((price - high_52) / high_52) * 100, 2)
    else:
        drawdown_pct = None

    high_52_rounded = round(float(high_52), 2) if high_52 is not None else None

    # PULLBACK DEPTH CALCULATION: how far price sits below (or above) its
    # own SMA50, as a percentage — the continuous, graduated sibling of
    # tactical_momentum's binary Bullish/Bearish verdict below, and the
    # basis for the frontend's 3-tier Pullback Depth Indicator (Gray
    # "Premium" > 0%, Orange "Watch" 0% to -2.9%, Red "Kill Zone" <= -3%,
    # see src/components/TrendBadges.tsx). Computed for EVERY asset
    # regardless of category — unlike the Quality Z-Score below, this
    # isn't gated, since both Portfolio and Ambush Radar callers use SMA50
    # already (see tactical_momentum). None whenever sma50 itself is
    # unavailable, same "can't be evaluated" convention as drawdown_pct.
    if sma50 is not None and sma50 > 0:
        pullback_depth = round(((price - sma50) / sma50) * 100, 2)
    else:
        pullback_depth = None

    # QUALITY Z-SCORE MODULE: "For 'Quality' category assets only, fetch
    # historical data to calculate the standard deviation of the price
    # relative to the SMA50 to derive the Z-Score" — see
    # _calculate_quality_zscore. Computed from the RAW (pre-currency-
    # conversion) price/sma50/closes — see that function's own comment for
    # why a ratio-based calculation is currency-scale-invariant regardless.
    # None for every other category, unconditionally — this is gated
    # exactly like tactical_momentum/macro_trend are gated on SMA
    # availability, just on category instead.
    quality_z_score = (
        _calculate_quality_zscore(closes, raw_price, raw_sma50) if normalized_category == "Quality" else None
    )

    # TREND CLASSIFICATION: computed from the already USD-normalized
    # price/sma50/sma200 above — see _classify_trend. Note this is valid
    # regardless of any further scaling a caller might apply downstream
    # (e.g. the frontend's own per-position Auto-Calibration correction for
    # a handful of TASE funds Yahoo misreports): price > sma is a ratio
    # comparison, so multiplying both sides by the same positive factor
    # never flips it. Callers can trust these labels as-is without
    # recomputing them against a rescaled price.
    macro_trend = _classify_trend(price, sma200)
    tactical_momentum = _classify_trend(price, sma50)

    try:
        print(
            f"[intel] {symbol}: price={currency_symbol}{local_price:.2f} (${price:.2f} USD) | 52W High="
            f"{'$' + format(high_52_rounded, '.2f') if high_52_rounded is not None else 'N/A'} | "
            f"Drawdown={drawdown_pct if drawdown_pct is not None else 'N/A'}%"
        )
    except UnicodeEncodeError:
        # This is a diagnostic log line only — some host stdout encodings
        # (observed: Windows cp1252 consoles during local development)
        # can't represent the '₪' currency symbol, and a console encoding
        # quirk must never be allowed to break the actual response.
        print(f"[intel] {symbol}: price={price:.2f} USD | drawdown={drawdown_pct if drawdown_pct is not None else 'N/A'}%")

    result: dict[str, float | str | None] = {
        # JSON EXPORT: normalized USD price — this MUST stay the portfolio-
        # math value (allocation totals, drawdown, trailing stops, ...), so
        # the frontend never has to know or care what currency a given
        # instrument actually trades in.
        "price": round(float(price), 2),
        # The instrument's own actual local-currency value (e.g. 13.48),
        # for display alongside currency_symbol — never used in math.
        "local_price": round(float(local_price), 2),
        "currency_symbol": currency_symbol,
        # Named with the same snake_case + underscore convention as every
        # other multi-word key in this response (local_price, high_52,
        # drawdown_pct) — for BOTH Portfolio and Ambush Radar callers alike,
        # since both hit this same endpoint.
        "sma_50": round(float(sma50), 2) if sma50 is not None else None,
        "sma_200": round(float(sma200), 2) if sma200 is not None else None,
        "high_52": high_52_rounded,
        "drawdown_pct": drawdown_pct,
        # PULLBACK DEPTH CALCULATION: see its own comment above. Category-
        # independent, unlike quality_z_score below.
        "pullback_depth": pullback_depth,
        # QUALITY Z-SCORE MODULE: the raw score (None for every non-Quality
        # asset, or when there isn't enough history) — see its own comment
        # above. The gated ALERT boolean is NOT part of this cached dict;
        # it's layered on per-request by _with_request_scoped_fields, same
        # as trailing_stop_price/high_water_mark.
        "quality_z_score": round(quality_z_score, 2) if quality_z_score is not None else None,
        # TREND CLASSIFICATION: see _classify_trend above. Null (not a
        # guessed "Bearish") whenever the underlying SMA itself is
        # unavailable.
        "macro_trend": macro_trend,
        "tactical_momentum": tactical_momentum,
    }

    if include_anomaly:
        result["anomaly"] = fetch_anomaly_news(symbol, closes=closes)
        # JSON EXPORT: the bifurcated Margin-of-Safety trigger is appended
        # under its own key, alongside (not replacing) the existing
        # day-over-day move detector above, so the frontend Intel modal can
        # surface either signal independently.
        result["mean_reversion_anomaly"] = check_mean_reversion_anomaly(
            symbol,
            normalized_category,
            price,
            sma50,
            high_52,
            closes=closes,
            currency_converter=to_usd_strict,
        )

    stock_cache.set(cache_key, result)

    final_result = _with_request_scoped_fields(result, normalized_category, high_water_mark, roic, quality_weight_pct)
    _sync_high_water_mark_to_supabase(symbol, final_result["high_water_mark"], roic)
    return final_result


@app.get("/api/search/{query}")
def search_tickers(query: str) -> list[dict[str, str]]:
    trimmed_query = query.strip()
    if not trimmed_query:
        raise HTTPException(status_code=400, detail="Search query is required.")

    def do_search():
        # Uses the shared TLS-impersonating session (not plain httpx): the
        # search endpoint bot-detects on TLS fingerprint alone even with
        # correct browser headers, confirmed by testing both directly
        # against Yahoo — plain httpx got 429'd on the same query that this
        # session resolved instantly.
        response = _yahoo_session.get(
            "https://query2.finance.yahoo.com/v1/finance/search",
            params={"q": trimmed_query},
            timeout=10.0,
        )
        response.raise_for_status()
        return response

    try:
        response = fetch_with_retry(do_search, description=f"ticker search for '{trimmed_query}'")
    except _http_backend.exceptions.RequestException as error:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to reach the ticker search provider: {error}",
        ) from error

    payload = response.json()
    quotes = payload.get("quotes", [])

    results: list[dict[str, str]] = []
    for quote in quotes:
        symbol = quote.get("symbol")
        if not symbol:
            continue

        results.append(
            {
                "symbol": symbol,
                "shortname": quote.get("shortname") or quote.get("longname") or "",
                "exchDisp": quote.get("exchDisp", ""),
            }
        )

        if len(results) == MAX_SEARCH_RESULTS:
            break

    return results


def _title_has_critical_keyword(title: str) -> bool:
    """Word-boundary match against CRITICAL_KEYWORDS rather than a raw
    substring check (`keyword in title.lower()`). A naive substring check
    would false-positive constantly — e.g. "sec" would match inside
    "sector"/"securities"/"second", and "cut" inside "execute"/"acute"."""
    words = set(re.findall(r"[a-z']+", title.lower()))
    return not CRITICAL_KEYWORDS.isdisjoint(words)


def _format_publish_timestamp(raw_timestamp: object) -> str:
    """Formats a publish time as 'YYYY-MM-DD HH:MM UTC'.

    Yahoo's current news schema publishes an ISO 8601 string under
    content.pubDate / content.displayTime (e.g. "2026-08-05T14:30:00Z"),
    not the legacy numeric providerPublishTime Unix timestamp — verified
    against the live API. Both shapes are handled here in case Yahoo ever
    reverts, or a different content type returns the older format.
    """
    if not raw_timestamp:
        return "N/A"

    try:
        if isinstance(raw_timestamp, (int, float)):
            published_dt = datetime.fromtimestamp(raw_timestamp, tz=timezone.utc)
        else:
            published_dt = datetime.fromisoformat(str(raw_timestamp).replace("Z", "+00:00"))
            published_dt = published_dt.astimezone(timezone.utc)
    except (ValueError, TypeError, OSError):
        return "N/A"

    return published_dt.strftime("%Y-%m-%d %H:%M UTC")


def _extract_article_link(content: dict) -> str:
    """Extracts the deep link to the article.

    There is no flat "link"/"url" field on the current schema — verified
    against the live API. The usable URL lives under
    content.canonicalUrl.url, falling back to content.clickThroughUrl.url,
    then content.previewUrl, then an empty string if none are present.
    """
    canonical_url = content.get("canonicalUrl") or {}
    if canonical_url.get("url"):
        return canonical_url["url"]

    click_through_url = content.get("clickThroughUrl") or {}
    if click_through_url.get("url"):
        return click_through_url["url"]

    return content.get("previewUrl") or ""


def _format_intel_article(article: dict) -> dict[str, object]:
    """Normalizes one raw yfinance news item into the V3.1 article shape,
    with a flat-schema fallback for title/publisher in case Yahoo reverts
    to the older format (content.* is the current, verified shape)."""
    content = article.get("content") or {}

    title = content.get("title") or article.get("title") or "No Title"

    provider = content.get("provider") or {}
    publisher = provider.get("displayName") or article.get("publisher") or "Unknown Publisher"

    published_at = _format_publish_timestamp(content.get("pubDate") or content.get("displayTime"))
    link = _extract_article_link(content)
    is_critical = _title_has_critical_keyword(title)

    return {
        "title": title,
        "publisher": publisher,
        "published_at": published_at,
        "link": link,
        "is_critical": is_critical,
        "tag": CRITICAL_ALERT_TAG if is_critical else "",
    }


def _fetch_intel_for_ticker(symbol: str) -> dict[str, object]:
    """Fetches and formats up to INTEL_NEWS_COUNT articles for one ticker.

    Both the fetch and the formatting step are covered by the same
    try/except so that one malformed or unreachable ticker can never break
    the rest of a batch request — it just comes back with an "error" field
    instead of a "news" list, while every other ticker in the batch is
    unaffected.
    """
    cached_result = intel_cache.get(symbol)
    if cached_result is not None:
        return cached_result

    try:
        news_data = fetch_with_retry(
            lambda: yf.Ticker(symbol, session=_yahoo_session).news,
            description=f"on-demand intel fetch for '{symbol}'",
        )
        articles = [_format_intel_article(article) for article in (news_data or [])[:INTEL_NEWS_COUNT]]
    except Exception as error:  # noqa: BLE001 - isolate this ticker's failure from the rest of the batch
        return {"ticker": symbol, "news": [], "error": f"Failed to fetch intel for '{symbol}': {error}"}

    result = {"ticker": symbol, "news": articles}
    intel_cache.set(symbol, result)
    return result


@app.get("/api/intel/{tickers}")
def get_intel(tickers: str) -> dict[str, list[dict[str, object]]]:
    """On-Demand Intel V3.1: latest news for one or more tickers (comma-
    separated, e.g. "PLD, UNH, AMT"), regardless of whether they moved
    today. Each article is timestamped, deep-linked, and flagged for
    critical keywords. Not a REST/CLI hybrid — this is a plain
    request/response route, no input() prompts of any kind.
    """
    # TASE TICKER INTERCEPTOR: same normalization as get_stock — a bare
    # numeric security number is auto-suffixed with '.TA' so each ticker in
    # the batch is treated as an ordinary Yahoo Finance symbol downstream.
    ticker_list = [_normalize_ticker_symbol(symbol) for symbol in tickers.split(",")]
    ticker_list = [symbol for symbol in ticker_list if symbol]

    if not ticker_list:
        raise HTTPException(status_code=400, detail="At least one ticker symbol is required.")

    if len(ticker_list) > MAX_BATCH_TICKERS:
        raise HTTPException(
            status_code=400,
            detail=f"Too many tickers in one request (max {MAX_BATCH_TICKERS}); got {len(ticker_list)}.",
        )

    # JITTER: a small random pause between tickers (not before the first
    # one) so this main batch loop doesn't hit Yahoo with a burst of
    # back-to-back requests, on top of yahoo_rate_limiter's own per-call
    # spacing enforced inside fetch_with_retry.
    results: list[dict[str, object]] = []
    for index, symbol in enumerate(ticker_list):
        if index > 0:
            time.sleep(random.uniform(TICKER_LOOP_JITTER_MIN_SECONDS, TICKER_LOOP_JITTER_MAX_SECONDS))
        results.append(_fetch_intel_for_ticker(symbol))

    return {"results": results}


if __name__ == "__main__":
    import uvicorn

    # Bind to 0.0.0.0 so devices on the same LAN (e.g. a phone running
    # Expo Go) can reach this server, not just localhost.
    uvicorn.run(app, host="0.0.0.0", port=8000)
