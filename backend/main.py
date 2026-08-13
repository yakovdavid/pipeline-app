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
"""

import random
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, TypeVar

import yfinance as yf
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

MAX_SEARCH_RESULTS = 6

# Tel Aviv Stock Exchange tickers (symbol suffix ".TA") are quoted by Yahoo
# in Agorot (1/100 of a New Israeli Shekel), not USD. To get a comparable
# USD value we convert: shekels = agorot / 100, then divide by the USD/ILS
# rate (how many shekels one dollar buys) to get USD.
TASE_TICKER_SUFFIX = ".TA"
USD_ILS_FX_SYMBOL = "ILS=X"
AGOROT_PER_SHEKEL = 100

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
    point on the rest of the pipeline, including get_stock's existing
    Agorot -> USD conversion (already keyed off this same '.TA' suffix),
    treats it as a standard Yahoo Finance symbol.
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

# Bifurcated Mean Reversion (Ambush) anomaly thresholds: Sector ETFs are
# structurally less volatile than individual Stocks (diversified holdings
# damp out idiosyncratic single-name moves), so one shared threshold would
# either almost never fire on ETFs (if sized for Stocks) or fire constantly
# on ordinary Stock noise (if sized for ETFs). Two independent triggers per
# asset type — either one fires the alert:
#   - Drawdown: price is >= drawdown_pct below the 52-week high.
#   - Structural support break: price < SMA50 - (std_dev_multiplier * the
#     20-day close std dev).
ANOMALY_STD_DEV_WINDOW = 20
DEFAULT_ANOMALY_ASSET_TYPE = "Stock"
BEARISH_ANOMALY_RULES: dict[str, dict[str, float]] = {
    "Stock": {"drawdown_pct": 15.0, "std_dev_multiplier": 2.0},
    "ETF": {"drawdown_pct": 7.0, "std_dev_multiplier": 1.5},
}

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
    if isinstance(error, _http_backend.exceptions.RequestException):
        return True

    # Some yfinance failure paths re-raise as a plain Exception that loses
    # the original exception type/`.response`; fall back to sniffing the
    # message for a retryable status code.
    message = str(error)
    return any(str(code) in message for code in RETRYABLE_STATUS_CODES)


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
    a generic network error with exponential backoff (base, base*2, base*4,
    ...) up to max_retries times. A freshly randomized User-Agent (see
    _rotate_user_agent) is applied to the shared session before every
    attempt. Callers with a known-good fallback can pass a smaller
    max_retries to fail fast instead of burning the full backoff budget."""
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
            backoff_seconds = base_backoff_seconds * (2**attempt)
            print(
                f"[resilience] {description} failed on attempt {attempt + 1}/"
                f"{max_retries + 1} ({error}); retrying in {backoff_seconds:.0f}s with a new User-Agent."
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


# Anti-rate-limit architecture: the primary (yfinance) path gets a full,
# genuine retry budget — up to 3 attempts total (1 initial + 2 retries),
# backing off 2s then 4s — before this file gives up on it and tries the
# chart API fallback. The chart fallback below gets its own equally full
# budget (MAX_RETRIES/BASE_BACKOFF_SECONDS defaults), so a ticker survives
# up to ~3 attempts against *each* data source before failing outright.
PRIMARY_FETCH_MAX_RETRIES = 2
PRIMARY_FETCH_BASE_BACKOFF_SECONDS = 2.0
TICKER_HISTORY_PERIOD = "1y"


def _fetch_ticker_snapshot_via_yfinance(symbol: str) -> TickerSnapshot:
    """Primary data source: yf.Ticker(symbol).fast_info for a real-time
    current price, plus ONE yf.Ticker(symbol).history(period="1y") call for
    everything else (SMA50/SMA200, 52-week high, and the daily closes the
    anomaly checks reuse) — deliberately never yf.Ticker(symbol).info,
    which pulls the full quoteSummary payload and is by far the most
    rate-limit-prone endpoint yfinance exposes. SMA50/SMA200 are always
    computed here from the closes ourselves (not read from fast_info's own
    fifty_day_average/two_hundred_day_average fields), so the calculation
    is identical regardless of whether this path or the chart API fallback
    below ends up serving the request.
    """
    ticker = yf.Ticker(symbol, session=_yahoo_session)

    history = fetch_with_retry(
        lambda: ticker.history(period=TICKER_HISTORY_PERIOD),
        description=f"yfinance {TICKER_HISTORY_PERIOD} history fetch for '{symbol}'",
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
    # can lag/be incomplete mid-session); fall back to the last close if
    # fast_info is unavailable or raises, so a fast_info hiccup alone never
    # fails the whole request when history already succeeded.
    price = closes[-1]
    high_52: float | None = None
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
    except Exception as fast_info_error:  # noqa: BLE001 - best-effort; history's last close/high already cover us
        print(f"[resilience] fast_info fetch failed for '{symbol}' ({fast_info_error}); using history instead.")

    if high_52 is None and highs:
        high_52 = max(highs)

    sma50 = sum(closes[-SMA_50_WINDOW:]) / SMA_50_WINDOW if len(closes) >= SMA_50_WINDOW else None
    sma200 = sum(closes[-SMA_200_WINDOW:]) / SMA_200_WINDOW if len(closes) >= SMA_200_WINDOW else None

    return TickerSnapshot(price=price, sma50=sma50, sma200=sma200, high_52=high_52, closes=closes)


def _fetch_ticker_snapshot_via_chart_fallback(symbol: str) -> TickerSnapshot:
    """Fallback data source: a direct request to Yahoo's chart endpoint,
    bypassing yfinance entirely (not just .info) — used when
    _fetch_ticker_snapshot_via_yfinance's history/fast_info calls fail
    outright. SMA50/SMA200 are computed from the returned daily close
    history the same way as the primary path; 52-week high prefers Yahoo's
    own "fiftyTwoWeekHigh" meta field (accounts for intraday highs) and
    falls back to the max of the returned daily highs.

    Routed through fetch_with_retry just like the primary path, so it gets
    the exact same anti-rate-limit treatment: up to 3 attempts with 2s/4s
    backoff, and a freshly randomized User-Agent applied to the shared
    session before each one."""

    def do_fetch():
        response = _yahoo_session.get(
            f"{CHART_API_BASE_URL}/{symbol}",
            params={"interval": CHART_HISTORY_INTERVAL, "range": CHART_HISTORY_RANGE},
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

    response = fetch_with_retry(do_fetch, description=f"chart API fallback fetch for '{symbol}'")

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

    return TickerSnapshot(price=price, sma50=sma50, sma200=sma200, high_52=high_52, closes=closes)


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


def check_mean_reversion_anomaly(
    ticker_symbol: str,
    asset_type: str,
    price: float,
    sma50: float | None,
    high_52: float | None,
    closes: list[float],
    currency_converter: Callable[[float], float] | None = None,
) -> str | None:
    """Bifurcated Margin-of-Safety anomaly check for the Ambush Radar / Mean
    Reversion screen (see BEARISH_ANOMALY_RULES for the per-asset-type
    thresholds this reads).

    price/sma50/high_52 must already be in the same currency (e.g. already
    USD-converted for TASE tickers — see get_stock) since the structural
    support trigger compares them directly. closes comes from the same
    cached TickerSnapshot get_stock already fetched (raw/native currency,
    unconverted) — this function no longer makes its own separate history
    call for the 20-day std dev the way it used to. currency_converter
    (get_stock's `to_usd`) is applied to the computed std dev to bring it
    onto the same basis as price/sma50/high_52 — valid because standard
    deviation scales linearly under a zero-intercept conversion like
    Agorot -> USD.

    Returns None (not an error) whenever a trigger can't be evaluated at all
    for lack of data (missing/zero 52-week high, missing SMA50, or fewer
    than ANOMALY_STD_DEV_WINDOW closes) rather than treating "unknown" as
    "no anomaly" on one trigger while still checking the other normally.
    """
    rules = BEARISH_ANOMALY_RULES.get(asset_type, BEARISH_ANOMALY_RULES[DEFAULT_ANOMALY_ASSET_TYPE])
    drawdown_threshold_pct = rules["drawdown_pct"]
    std_dev_multiplier = rules["std_dev_multiplier"]

    triggers: list[str] = []

    # Trigger 1: drawdown from the 52-week high. Guarded against a missing
    # or non-positive high_52 to avoid a division-by-zero on bad upstream
    # data (mirrors the guard already used for drawdown_pct in get_stock).
    if high_52 is not None and high_52 > 0:
        drawdown_pct = ((price - high_52) / high_52) * 100
        if drawdown_pct <= -drawdown_threshold_pct:
            triggers.append(
                f"{abs(drawdown_pct):.1f}% off its 52-week high "
                f"(>= {drawdown_threshold_pct:.0f}% {asset_type} threshold)"
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

    return f"[ANOMALY: {asset_type} MEAN REVERSION] " + "; ".join(triggers)


def _fetch_usd_ils_rate() -> float:
    """Fetch the current USD/ILS exchange rate (shekels per one US dollar),
    using the shared cache and the shared retry/throttle layer."""
    cached_rate = fx_rate_cache.get(USD_ILS_FX_SYMBOL)
    if cached_rate is not None:
        return cached_rate

    try:
        fx_info = fetch_with_retry(
            lambda: yf.Ticker(USD_ILS_FX_SYMBOL, session=_yahoo_session).info,
            description="USD/ILS FX rate fetch",
        )
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch the USD/ILS exchange rate: {error}",
        ) from error

    fx_rate = fx_info.get("regularMarketPrice") or fx_info.get("currentPrice")
    if not fx_rate or fx_rate <= 0:
        raise HTTPException(
            status_code=502,
            detail="Failed to fetch a valid USD/ILS exchange rate.",
        )

    fx_rate = float(fx_rate)
    fx_rate_cache.set(USD_ILS_FX_SYMBOL, fx_rate)
    return fx_rate


@app.get("/api/stock/{ticker}")
def get_stock(
    ticker: str, include_anomaly: bool = False, asset_type: str = DEFAULT_ANOMALY_ASSET_TYPE
) -> dict[str, float | str | None]:
    # TASE TICKER INTERCEPTOR: a bare numeric security number (e.g.
    # "1081124") is auto-suffixed to "1081124.TA" here, before anything
    # else touches it, so the rest of this function — and every helper it
    # calls, including the Agorot -> USD conversion below — processes it as
    # an ordinary Yahoo Finance symbol without any special-casing of its own.
    symbol = _normalize_ticker_symbol(ticker)
    if not symbol:
        raise HTTPException(status_code=400, detail="Ticker symbol is required.")

    # ASSET TYPE IDENTIFICATION: read from the incoming query mapping
    # ('Stock' vs 'ETF'), case-insensitively, defaulting to 'Stock' for any
    # missing/unrecognized value — this keeps the endpoint backward
    # compatible with callers that don't send it yet.
    normalized_asset_type = "ETF" if asset_type.strip().upper() == "ETF" else "Stock"

    # The formatted-response cache covers the fully-assembled JSON
    # (including the anomaly checks below, which is why the flag/asset type
    # are part of the key — the bifurcated thresholds mean the same ticker
    # can produce a different anomaly string per asset type).
    cache_key = f"{symbol}:anomaly:{normalized_asset_type}" if include_anomaly else symbol
    cached_result = stock_cache.get(cache_key)
    if cached_result is not None:
        return cached_result

    # THE SPEED FIX: check TICKER_CACHE before making any outbound Yahoo
    # call at all. A hit here means this request costs zero network calls,
    # regardless of whether it's also a stock_cache miss (e.g. a first-time
    # include_anomaly=True request for a ticker whose plain price was
    # already fetched and cached moments ago by a different screen).
    snapshot = _get_cached_ticker_snapshot(symbol)
    if snapshot is None:
        try:
            snapshot = _fetch_ticker_snapshot_via_yfinance(symbol)
        except TickerNotFoundError:
            # A clean "not found" from yfinance itself is still worth
            # double-checking against the fallback, since yfinance being
            # blocked can sometimes surface as an empty/missing-price result
            # rather than a raised network error.
            snapshot = None
        except Exception as primary_error:  # noqa: BLE001 - yfinance raises many different error types
            print(f"[resilience] yfinance failed for '{symbol}' ({primary_error}); trying chart API fallback.")
            snapshot = None

        if snapshot is None:
            try:
                snapshot = _fetch_ticker_snapshot_via_chart_fallback(symbol)
            except TickerNotFoundError as not_found_error:
                raise HTTPException(
                    status_code=404,
                    detail=f"No market data found for ticker '{symbol}'.",
                ) from not_found_error
            except Exception as fallback_error:  # noqa: BLE001 - network/parse errors from the fallback request
                # Both data sources failed: return a clean, formatted JSON
                # error instead of letting an unhandled exception surface as
                # an opaque 502 from the platform (Render) itself.
                raise HTTPException(
                    status_code=502,
                    detail=(
                        f"Failed to fetch data for ticker '{symbol}' from both yfinance and "
                        f"the direct chart API fallback: {fallback_error}"
                    ),
                ) from fallback_error

        _set_cached_ticker_snapshot(symbol, snapshot)

    raw_price = snapshot.price
    raw_sma50 = snapshot.sma50
    raw_sma200 = snapshot.sma200
    raw_high_52 = snapshot.high_52
    closes = snapshot.closes

    if symbol.endswith(TASE_TICKER_SUFFIX):
        # Strict handling: if we can't get a trustworthy FX rate, refuse to
        # guess — returning an unconverted Agorot value as if it were USD
        # would silently mislead the user by roughly two orders of magnitude.
        fx_rate = _fetch_usd_ils_rate()

        def to_usd(agorot_value: float | None) -> float | None:
            if agorot_value is None:
                return None
            return (agorot_value / AGOROT_PER_SHEKEL) / fx_rate

        price = to_usd(raw_price)
        sma50 = to_usd(raw_sma50)
        sma200 = to_usd(raw_sma200)
        high_52 = to_usd(raw_high_52)
    else:
        price = raw_price
        sma50 = raw_sma50
        sma200 = raw_sma200
        high_52 = raw_high_52

        def to_usd(value: float | None) -> float | None:
            return value

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

    print(
        f"[intel] {symbol}: price=${price:.2f} | 52W High="
        f"{'$' + format(high_52_rounded, '.2f') if high_52_rounded is not None else 'N/A'} | "
        f"Drawdown={drawdown_pct if drawdown_pct is not None else 'N/A'}%"
    )

    result: dict[str, float | str | None] = {
        "price": round(float(price), 2),
        "sma50": round(float(sma50), 2) if sma50 is not None else None,
        "sma200": round(float(sma200), 2) if sma200 is not None else None,
        "high_52": high_52_rounded,
        "drawdown_pct": drawdown_pct,
    }

    if include_anomaly:
        result["anomaly"] = fetch_anomaly_news(symbol, closes=closes)
        # JSON EXPORT: the bifurcated Margin-of-Safety trigger is appended
        # under its own key, alongside (not replacing) the existing
        # day-over-day move detector above, so the frontend Intel modal can
        # surface either signal independently.
        result["mean_reversion_anomaly"] = check_mean_reversion_anomaly(
            symbol,
            normalized_asset_type,
            price,
            sma50,
            high_52,
            closes=closes,
            currency_converter=to_usd_strict,
        )

    stock_cache.set(cache_key, result)
    return result


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
