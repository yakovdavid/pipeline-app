"""FastAPI backend for the Pipeline app.

Serves the current price plus the 50-day and 200-day Simple Moving Averages
(SMA 50 / SMA 200) for a given ticker, sourced from Yahoo Finance via
yfinance, plus a ticker search/autocomplete endpoint backed by Yahoo
Finance's search API.

Includes a resilience layer around every outbound Yahoo Finance call
(browser header/TLS spoofing, request throttling, retry with backoff, and
short-lived in-memory caching) since cloud IPs like Render's are otherwise
bot-detected and rate-limited (HTTP 429) almost immediately.
"""

import threading
import time
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

# Standard browser headers layered on top of curl_cffi's TLS impersonation.
# Yahoo Finance rejects requests without something resembling this, whether
# hit via yfinance or the raw search endpoint.
YAHOO_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive",
}

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
MAX_RETRIES = 3
BASE_BACKOFF_SECONDS = 2.0
RETRYABLE_STATUS_CODES = {429, 503}

T = TypeVar("T")


def _is_retryable_error(error: Exception) -> bool:
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    if status_code in RETRYABLE_STATUS_CODES:
        return True
    # Some yfinance/curl_cffi failure paths don't attach a `.response`
    # object; fall back to sniffing the error message for the status code.
    message = str(error)
    return any(str(code) in message for code in RETRYABLE_STATUS_CODES)


def fetch_with_retry(fetch_fn: Callable[[], T], description: str) -> T:
    """Runs fetch_fn under the shared rate limiter, retrying on 429/503
    with exponential backoff (2s, 4s, 8s) up to MAX_RETRIES times."""
    last_error: Exception | None = None

    for attempt in range(MAX_RETRIES + 1):
        try:
            with yahoo_rate_limiter:
                return fetch_fn()
        except Exception as error:  # noqa: BLE001 - yfinance/curl_cffi/httpx all raise different types
            last_error = error
            if attempt >= MAX_RETRIES or not _is_retryable_error(error):
                raise
            backoff_seconds = BASE_BACKOFF_SECONDS * (2**attempt)
            print(
                f"[resilience] {description} failed on attempt {attempt + 1}/"
                f"{MAX_RETRIES + 1} ({error}); retrying in {backoff_seconds:.0f}s."
            )
            time.sleep(backoff_seconds)

    # Unreachable: the loop above always either returns or raises.
    assert last_error is not None
    raise last_error


# --- Short-lived in-memory cache ----------------------------------------
CACHE_TTL_SECONDS = 60.0


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

# One shared, browser-like session reused across every yfinance call. Safe
# to share across FastAPI's threadpool workers because yahoo_rate_limiter
# already guarantees only one outbound call using it runs at a time.
if _HAS_CURL_CFFI:
    _yahoo_session = _http_backend.Session(impersonate="chrome")
else:  # pragma: no cover - depends on host platform
    _yahoo_session = _http_backend.Session()
_yahoo_session.headers.update(YAHOO_BROWSER_HEADERS)

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


def _fetch_usd_ils_rate() -> float:
    """Fetch the current USD/ILS exchange rate (shekels per one US dollar),
    using the 60s cache and the shared retry/throttle layer."""
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
def get_stock(ticker: str) -> dict[str, float | None]:
    symbol = ticker.strip().upper()
    if not symbol:
        raise HTTPException(status_code=400, detail="Ticker symbol is required.")

    cached_result = stock_cache.get(symbol)
    if cached_result is not None:
        return cached_result

    try:
        info = fetch_with_retry(
            lambda: yf.Ticker(symbol, session=_yahoo_session).info,
            description=f"stock info fetch for '{symbol}'",
        )
    except Exception as error:  # yfinance raises various network/parse errors
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch data for ticker '{symbol}': {error}",
        ) from error

    raw_price = info.get("currentPrice") or info.get("regularMarketPrice")
    if not raw_price:
        raise HTTPException(
            status_code=404,
            detail=f"No market data found for ticker '{symbol}'.",
        )

    raw_sma50 = info.get("fiftyDayAverage")
    raw_sma200 = info.get("twoHundredDayAverage")

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
    else:
        price = raw_price
        sma50 = raw_sma50
        sma200 = raw_sma200

    result = {
        "price": round(float(price), 2),
        "sma50": round(float(sma50), 2) if sma50 is not None else None,
        "sma200": round(float(sma200), 2) if sma200 is not None else None,
    }
    stock_cache.set(symbol, result)
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


if __name__ == "__main__":
    import uvicorn

    # Bind to 0.0.0.0 so devices on the same LAN (e.g. a phone running
    # Expo Go) can reach this server, not just localhost.
    uvicorn.run(app, host="0.0.0.0", port=8000)
