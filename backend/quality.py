"""Quality pipeline: Z-Score, ROIC and Moat for Quality assets, cached so
Financial Modeling Prep's (FMP) free tier (250 requests/day) is enough.

Two data sources:
  - Prices: Yahoo Finance, via the `yfinance` library (the same library
    main.py uses for quotes). FMP's free tier paywalls historical prices:
    /stable/historical-price-eod/full answers HTTP 402.
  - Fundamentals: FMP key-metrics, which the free tier does include.

GET /api/quality/{ticker} returns, for one ticker:
  - Statistics, from the last 2 years of daily closes (Yahoo Finance):
      z_score = (current_price - mean_price) / std_dev
    current_price is the most recent close in the series. Refreshed after 24h.
  - Fundamentals, from up to 5 years of FMP annual key metrics:
      roic: the most recent year's ROIC, as a percent (28 = 28%)
      moat: Wide   if the average ROIC >= 15% and no year is below 10%
            Narrow if the average ROIC >= 10% (and not Wide)
            None   otherwise, or with fewer than 3 years of history
    Refreshed after 30 days.

Each half is cached with its own timestamp (see backend/sql/
004_quality_metrics_cache.sql), so a daily price refresh never refetches
financial statements.

Caching: Supabase when it is configured (main.py passes its client in),
otherwise an in-memory cache with the same lifetimes. Without either, every
request would cost an FMP call and a Yahoo call.

Failure policy: if a refresh fails (rate limit, network, FMP or Yahoo down)
and an expired cached value exists, that value is served and flagged
*_stale in the response, rather than failing the request.

Security: FMP takes the API key as a URL query parameter, and `requests`
puts the full URL into its exception messages. So this module never
includes a requests exception's text in its own errors or logs, and raises
its own exceptions `from None`, which keeps the URL out of traceback
context too.
"""

import math
import os
import re
import statistics
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Literal
from urllib.parse import quote

import requests
import yfinance as yf
from fastapi import APIRouter, HTTPException
from yfinance.exceptions import YFRateLimitError, YFTickerMissingError

# --- Configuration --------------------------------------------------------

FMP_BASE_URL = "https://financialmodelingprep.com"
FMP_API_KEY_ENV = "FMP_API_KEY"
FMP_TIMEOUT_SECONDS = 15.0
# Retries cover network errors and 5xx only. A 429 is not retried: on the
# free tier it means the daily quota is used up, and retrying would only
# waste time.
FMP_MAX_NETWORK_RETRIES = 2
FMP_RETRY_BACKOFF_SECONDS = 1.5

STATS_TTL = timedelta(hours=24)
FUNDAMENTALS_TTL = timedelta(days=30)

PRICE_HISTORY_DAYS = 730  # "the last 2 years of daily closing prices"
# Yahoo Finance (yfinance) price history. Retried once on a transient
# failure; a rate limit is not retried, same reasoning as FMP's 429.
YF_MAX_ATTEMPTS = 2
YF_RETRY_BACKOFF_SECONDS = 1.5
YF_TIMEOUT_SECONDS = 15

MOAT_MAX_YEARS = 5
MOAT_MIN_YEARS = 3
WIDE_MOAT_MIN_AVG_ROIC_PCT = 15.0
WIDE_MOAT_MIN_YEAR_ROIC_PCT = 10.0
NARROW_MOAT_MIN_AVG_ROIC_PCT = 10.0

QUALITY_METRICS_TABLE = "quality_metrics"

# Accepted ticker shape: US-style symbols plus dot or dash classes and
# exchange suffixes (BRK-B, RY.TO). Validated before the symbol is sent to
# Yahoo Finance or put into an FMP URL path.
TICKER_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,14}$")

Moat = Literal["Wide", "Narrow", "None"]


# --- Errors ---------------------------------------------------------------


class FmpError(Exception):
    """An FMP request failed. Messages never contain the API key."""


class FmpNotConfiguredError(FmpError):
    """FMP_API_KEY is not set."""


class FmpAuthError(FmpError):
    """FMP rejected the API key."""


class FmpRateLimitError(FmpError):
    """FMP's request quota is used up (HTTP 429)."""


class FmpPaymentRequiredError(FmpError):
    """The FMP plan doesn't include this endpoint (HTTP 402)."""


class FmpLegacyEndpointError(FmpError):
    """FMP refused a /api/v3/ endpoint as legacy. FMP keeps v3 working only
    for subscriptions that existed before August 31, 2025."""


class PriceHistoryError(Exception):
    """Fetching daily closes from Yahoo Finance (yfinance) failed."""


class QualityTickerNotFoundError(Exception):
    """Yahoo Finance has no price history for this ticker and nothing is
    cached."""


# --- FMP client -----------------------------------------------------------

# Which FMP API generation to call. Starts with the /api/v3/ endpoints this
# pipeline was specified against. On the first "Legacy Endpoint" refusal it
# switches to the equivalent /stable/ endpoints for the rest of the process,
# so a key that lacks v3 access costs one wasted request per restart, not
# one per call. A benign race: two threads may both make one v3 attempt.
_use_stable_api = False


def _fmp_api_key() -> str:
    key = os.environ.get(FMP_API_KEY_ENV, "").strip()
    if not key:
        raise FmpNotConfiguredError(f"{FMP_API_KEY_ENV} is not set.")
    return key


def _fmp_error_message(payload: Any) -> str | None:
    if isinstance(payload, dict):
        message = payload.get("Error Message") or payload.get("error")
        if isinstance(message, str):
            return message.strip()[:300]
    return None


def _parse_fmp_response(response: requests.Response, path: str) -> Any:
    try:
        payload: Any = response.json()
    except ValueError:
        payload = None

    message = _fmp_error_message(payload)
    lowered = (message or "").lower()

    if response.status_code == 429 or "limit reach" in lowered:
        raise FmpRateLimitError("FMP request limit reached for today.")
    # Checked before the generic message branch: a 402 carries an error body
    # too, but naming the cause (the plan) is what makes it actionable.
    if response.status_code == 402:
        raise FmpPaymentRequiredError(f"FMP's current plan does not include {path} (HTTP 402).")
    # Checked before the auth branch: FMP sends the legacy refusal as a 403.
    if "legacy endpoint" in lowered:
        raise FmpLegacyEndpointError(f"FMP refused {path} as a legacy endpoint.")
    if response.status_code in (401, 403) or "invalid api key" in lowered:
        raise FmpAuthError(f"FMP rejected the API key (HTTP {response.status_code}).")
    if message is not None:
        # A 200 can still carry an error body, e.g. a plan restriction.
        raise FmpError(f"FMP error for {path}: {message}")
    if not response.ok:
        raise FmpError(f"FMP returned HTTP {response.status_code} for {path}.")
    if payload is None:
        raise FmpError(f"FMP returned a non-JSON response for {path}.")
    return payload


def _fmp_get_json(path: str, params: dict[str, str | int]) -> Any:
    key = _fmp_api_key()
    url = FMP_BASE_URL + path
    for attempt in range(FMP_MAX_NETWORK_RETRIES + 1):
        try:
            response = requests.get(url, params={**params, "apikey": key}, timeout=FMP_TIMEOUT_SECONDS)
        except requests.RequestException as error:
            # Only the exception TYPE is reported: its text contains the URL,
            # and the URL contains the API key.
            if attempt < FMP_MAX_NETWORK_RETRIES:
                time.sleep(FMP_RETRY_BACKOFF_SECONDS * (2**attempt))
                continue
            raise FmpError(f"FMP request to {path} failed ({type(error).__name__}).") from None
        if response.status_code >= 500 and attempt < FMP_MAX_NETWORK_RETRIES:
            time.sleep(FMP_RETRY_BACKOFF_SECONDS * (2**attempt))
            continue
        return _parse_fmp_response(response, path)
    # Unreachable: the final attempt always returns or raises.
    raise FmpError(f"FMP request to {path} failed.")


def _fmp_get_with_fallback(
    v3_request: tuple[str, dict[str, str | int]],
    stable_request: tuple[str, dict[str, str | int]],
) -> Any:
    global _use_stable_api
    if not _use_stable_api:
        try:
            return _fmp_get_json(*v3_request)
        except FmpLegacyEndpointError:
            _use_stable_api = True
            print("[quality] FMP refused /api/v3/ as legacy; using the /stable/ API from now on.")
    return _fmp_get_json(*stable_request)


def fetch_daily_closes(symbol: str, today: date) -> list[float]:
    """Daily closes for the last PRICE_HISTORY_DAYS, oldest first, from
    Yahoo Finance via yfinance.

    Uses the unadjusted-for-dividends "Close" column (auto_adjust=False):
    Yahoo still adjusts it for splits, so a split can't fake a crash in the
    Z-Score, and the latest close matches the quoted price the app shows.

    An unknown ticker (yfinance raises a YFTickerMissingError subclass)
    returns [], which the caller reports as "not found". Any other failure
    raises PriceHistoryError. raise_errors=True is what tells the two
    apart: by default yfinance logs errors and returns an empty table, so a
    Yahoo outage would look like a ticker with no history.
    """
    start = today - timedelta(days=PRICE_HISTORY_DAYS)
    end = today + timedelta(days=1)  # yfinance's `end` is exclusive

    history = None
    for attempt in range(YF_MAX_ATTEMPTS):
        try:
            history = yf.Ticker(symbol).history(
                start=start.isoformat(),
                end=end.isoformat(),
                interval="1d",
                auto_adjust=False,
                actions=False,
                timeout=YF_TIMEOUT_SECONDS,
                raise_errors=True,
            )
            break
        except YFTickerMissingError:
            return []
        except YFRateLimitError:
            raise PriceHistoryError(f"Yahoo Finance rate-limited the price history request for '{symbol}'.") from None
        except Exception as error:  # noqa: BLE001 - yfinance surfaces network/parse failures as many types
            if attempt < YF_MAX_ATTEMPTS - 1:
                time.sleep(YF_RETRY_BACKOFF_SECONDS)
                continue
            raise PriceHistoryError(
                f"Yahoo Finance price history request for '{symbol}' failed ({type(error).__name__})."
            ) from None

    if history is None or history.empty or "Close" not in history.columns:
        return []

    dated_closes: list[tuple[date, float]] = []
    for timestamp, raw_close in history["Close"].items():
        try:
            row_date = timestamp.date()
            close = float(raw_close)
        except (AttributeError, TypeError, ValueError):
            continue
        # NaN rows (e.g. a trading halt) fail isfinite and are skipped.
        if row_date >= start and math.isfinite(close) and close > 0:
            dated_closes.append((row_date, close))
    dated_closes.sort(key=lambda pair: pair[0])
    return [close for _, close in dated_closes]


def fetch_annual_roic_pcts(symbol: str) -> list[float]:
    """Annual ROIC as percents, newest first, at most MOAT_MAX_YEARS.

    v3 key-metrics reports ROIC as `roic`; /stable/ as
    `returnOnInvestedCapital`. Both are ratios (0.28 means 28%) and are
    converted to percents here. Years with no ROIC value are skipped. An
    empty list (e.g. an ETF, which has no financial statements) is a valid
    result, not an error.
    """
    path_symbol = quote(symbol, safe="")
    payload = _fmp_get_with_fallback(
        (f"/api/v3/key-metrics/{path_symbol}", {"period": "annual", "limit": MOAT_MAX_YEARS}),
        ("/stable/key-metrics", {"symbol": symbol, "period": "annual", "limit": MOAT_MAX_YEARS}),
    )
    if not isinstance(payload, list):
        return []

    dated_roics: list[tuple[str, float]] = []
    for row in payload:
        if not isinstance(row, dict):
            continue
        raw = row.get("roic", row.get("returnOnInvestedCapital"))
        if raw is None:
            continue
        try:
            dated_roics.append((str(row.get("date", "")), float(raw) * 100))
        except (TypeError, ValueError):
            continue
    dated_roics.sort(key=lambda pair: pair[0], reverse=True)  # ISO dates sort as text
    return [roic for _, roic in dated_roics[:MOAT_MAX_YEARS]]


# --- Calculations ---------------------------------------------------------


@dataclass(frozen=True)
class PriceStatistics:
    current_price: float
    mean_price: float
    std_dev: float | None
    z_score: float | None


def compute_price_statistics(closes: list[float]) -> PriceStatistics:
    """Z-Score of the latest close against the whole window, using the
    population standard deviation (statistics.pstdev, the same convention as
    the rest of this backend). With a single close, or a perfectly flat
    series, the spread is unusable, so z_score is None instead of a
    division by zero. `closes` must be oldest first and non-empty."""
    current_price = closes[-1]
    mean_price = statistics.fmean(closes)
    if len(closes) < 2:
        return PriceStatistics(current_price, mean_price, None, None)
    std_dev = statistics.pstdev(closes, mu=mean_price)
    z_score = (current_price - mean_price) / std_dev if std_dev > 0 else None
    return PriceStatistics(current_price, mean_price, std_dev, z_score)


def compute_moat(roic_pcts_newest_first: list[float]) -> tuple[float | None, Moat]:
    """Returns (current ROIC, moat) from up to 5 years of annual ROIC.

    Current ROIC is reported as long as one year exists. Moat is judged
    strictly on the available years (3 to 5), and is 'None' with fewer
    than 3.
    """
    years = roic_pcts_newest_first[:MOAT_MAX_YEARS]
    current_roic = years[0] if years else None
    if len(years) < MOAT_MIN_YEARS:
        return current_roic, "None"
    average = statistics.fmean(years)
    if average >= WIDE_MOAT_MIN_AVG_ROIC_PCT and min(years) >= WIDE_MOAT_MIN_YEAR_ROIC_PCT:
        return current_roic, "Wide"
    if average >= NARROW_MOAT_MIN_AVG_ROIC_PCT:
        return current_roic, "Narrow"
    return current_roic, "None"


# --- Cache ----------------------------------------------------------------


def _parse_timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _is_fresh(timestamp: Any, ttl: timedelta, now: datetime) -> bool:
    parsed = _parse_timestamp(timestamp)
    return parsed is not None and now - parsed < ttl


class QualityMetricsStore:
    """Reads and writes quality_metrics rows: Supabase when a client is
    configured, plus an in-memory copy that serves as the whole cache when
    it isn't. A Supabase failure is logged and falls back to memory; it
    never fails the request."""

    def __init__(self, get_supabase_client: Callable[[], Any]) -> None:
        self._get_supabase_client = get_supabase_client
        self._memory: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    @property
    def backend_name(self) -> str:
        return "supabase" if self._get_supabase_client() is not None else "memory"

    def load(self, symbol: str) -> dict[str, Any] | None:
        client = self._get_supabase_client()
        if client is not None:
            try:
                response = client.table(QUALITY_METRICS_TABLE).select("*").eq("ticker", symbol).limit(1).execute()
                rows = response.data or []
                if rows:
                    return dict(rows[0])
                return None
            except Exception as error:  # noqa: BLE001 - any client/network error falls back to memory
                print(f"[quality] Supabase read failed for '{symbol}' ({type(error).__name__}); using memory cache.")
        with self._lock:
            row = self._memory.get(symbol)
            return dict(row) if row is not None else None

    def save(self, row: dict[str, Any]) -> None:
        with self._lock:
            self._memory[row["ticker"]] = dict(row)
        client = self._get_supabase_client()
        if client is None:
            return
        try:
            client.table(QUALITY_METRICS_TABLE).upsert(row, on_conflict="ticker").execute()
        except Exception as error:  # noqa: BLE001 - the fresh data is still returned and kept in memory
            print(f"[quality] Supabase upsert failed for '{row['ticker']}' ({type(error).__name__}).")


# One lock per ticker, so concurrent requests for the same ticker refresh
# once instead of each spending FMP quota (and Yahoo calls) on the same data.
_symbol_locks: dict[str, threading.Lock] = {}
_symbol_locks_guard = threading.Lock()


def _symbol_lock(symbol: str) -> threading.Lock:
    with _symbol_locks_guard:
        return _symbol_locks.setdefault(symbol, threading.Lock())


# --- Service --------------------------------------------------------------


def _has_stats(row: dict[str, Any]) -> bool:
    return row.get("current_price") is not None


def _has_fundamentals(row: dict[str, Any]) -> bool:
    return row.get("moat") is not None


def _to_float(value: Any) -> float | None:
    return float(value) if value is not None else None


def get_quality_metrics(symbol: str, store: QualityMetricsStore, now: datetime | None = None) -> dict[str, Any]:
    """The full cache-then-fetch flow for one already-validated symbol:
      1. Load the cached row.
      2. Refresh statistics (Yahoo Finance) if older than 24h or missing.
      3. Refresh fundamentals (FMP) if older than 30 days or missing.
      4. Save the row if anything was refreshed, then return the payload.
    A failed refresh falls back to the expired cached half (flagged stale);
    with nothing cached for that half, the error is raised. Statistics are
    refreshed first, so an unknown ticker stops before the fundamentals
    call spends FMP quota.
    """
    now = now or datetime.now(timezone.utc)
    with _symbol_lock(symbol):
        cached = store.load(symbol) or {}
        row: dict[str, Any] = {**cached, "ticker": symbol}
        refreshed = False
        stats_stale = False
        fundamentals_stale = False

        if not (_has_stats(row) and _is_fresh(row.get("last_updated_stats"), STATS_TTL, now)):
            try:
                closes = fetch_daily_closes(symbol, now.date())
                if not closes:
                    if not _has_stats(row):
                        raise QualityTickerNotFoundError(f"Yahoo Finance has no price history for '{symbol}'.")
                    stats_stale = True
                else:
                    stats = compute_price_statistics(closes)
                    row.update(
                        current_price=round(stats.current_price, 4),
                        mean_price=round(stats.mean_price, 4),
                        std_dev=round(stats.std_dev, 4) if stats.std_dev is not None else None,
                        z_score=round(stats.z_score, 4) if stats.z_score is not None else None,
                        last_updated_stats=now.isoformat(),
                    )
                    refreshed = True
            except PriceHistoryError as error:
                if not _has_stats(row):
                    raise
                print(f"[quality] Statistics refresh failed for '{symbol}' ({error}); serving cached values.")
                stats_stale = True

        if not (_has_fundamentals(row) and _is_fresh(row.get("last_updated_fundamentals"), FUNDAMENTALS_TTL, now)):
            try:
                current_roic, moat = compute_moat(fetch_annual_roic_pcts(symbol))
                row.update(
                    roic=round(current_roic, 2) if current_roic is not None else None,
                    moat=moat,
                    last_updated_fundamentals=now.isoformat(),
                )
                refreshed = True
            except FmpError as error:
                if not _has_fundamentals(row):
                    raise
                print(f"[quality] Fundamentals refresh failed for '{symbol}' ({error}); serving cached values.")
                fundamentals_stale = True

        if refreshed:
            store.save(row)

        return {
            "ticker": symbol,
            "current_price": _to_float(row.get("current_price")),
            "mean_price": _to_float(row.get("mean_price")),
            "std_dev": _to_float(row.get("std_dev")),
            "z_score": _to_float(row.get("z_score")),
            "roic": _to_float(row.get("roic")),
            "moat": row.get("moat"),
            "last_updated_stats": row.get("last_updated_stats"),
            "last_updated_fundamentals": row.get("last_updated_fundamentals"),
            # True when a refresh failed and an expired cached value is shown.
            "stats_stale": stats_stale,
            "fundamentals_stale": fundamentals_stale,
            "cache": store.backend_name,
        }


# --- Router ---------------------------------------------------------------


def normalize_quality_ticker(raw_ticker: str) -> str | None:
    symbol = raw_ticker.strip().upper()
    return symbol if TICKER_PATTERN.match(symbol) else None


def create_quality_router(get_supabase_client: Callable[[], Any]) -> APIRouter:
    """Builds the router. main.py passes a getter for its Supabase client
    (None when unconfigured) rather than this module importing main.py,
    which would be a circular import, and so tests can inject a fake."""
    router = APIRouter()
    store = QualityMetricsStore(get_supabase_client)

    @router.get("/api/quality/{ticker}")
    def get_quality(ticker: str) -> dict[str, Any]:
        symbol = normalize_quality_ticker(ticker)
        if symbol is None:
            raise HTTPException(status_code=400, detail=f"'{ticker}' is not a valid ticker symbol.")
        try:
            return get_quality_metrics(symbol, store)
        except QualityTickerNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from None
        except (FmpNotConfiguredError, FmpAuthError, FmpPaymentRequiredError) as error:
            raise HTTPException(status_code=503, detail=f"Quality data source unavailable: {error}") from None
        except FmpRateLimitError as error:
            raise HTTPException(status_code=429, detail=str(error)) from None
        except (FmpError, PriceHistoryError) as error:
            raise HTTPException(status_code=502, detail=str(error)) from None

    return router
