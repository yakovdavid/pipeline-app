"""Quality pipeline: Z-Score, ROIC and Moat for Quality assets, sourced
entirely from Yahoo Finance through the `yfinance` library (the same library
main.py uses for quotes). No API key, no paid plan.

GET /api/quality/{ticker} returns, for one ticker:
  - Statistics, from the last 2 years of daily closes:
      z_score = (current_price - mean_price) / std_dev
    current_price is the most recent close in the series. Refreshed after 24h.
  - Fundamentals, from Ticker(symbol).info (current trailing figures):
      roic: a ROIC PROXY, as a percent (28 = 28%): Return on Equity, or
            Return on Assets when Yahoo has no ROE. Yahoo doesn't publish
            ROIC itself. The response key stays `roic` so the app and the
            cache table keep working unchanged.
      moat: Wide   if ROE >= 15% AND operating margin >= 15%
            Narrow if ROE >= 10% AND operating margin >= 10% (and not Wide)
            None   otherwise, or if either figure is missing
    Refreshed after 30 days.

Each half is cached with its own timestamp (see backend/sql/
004_quality_metrics_cache.sql), so a daily price refresh never refetches
fundamentals. That matters most for .info: it hits Yahoo's heaviest,
most rate-limited endpoint (main.py avoids it for quotes for that reason),
so it runs at most once per ticker per 30 days.

Caching: Supabase when it is configured (main.py passes its client in),
otherwise an in-memory cache with the same lifetimes.

Failure policy: if a refresh fails (rate limit, network, Yahoo down) and an
expired cached value exists, that value is served and flagged *_stale in the
response, rather than failing the request.
"""

import math
import re
import statistics
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Literal

import yfinance as yf
from fastapi import APIRouter, HTTPException
from yfinance.exceptions import YFRateLimitError, YFTickerMissingError

# --- Configuration --------------------------------------------------------

STATS_TTL = timedelta(hours=24)
FUNDAMENTALS_TTL = timedelta(days=30)

PRICE_HISTORY_DAYS = 730  # "the last 2 years of daily closing prices"

# Yahoo Finance requests. A transient failure is retried once; a rate limit
# is not retried, since retrying straight away only prolongs the block.
YF_MAX_ATTEMPTS = 2
YF_RETRY_BACKOFF_SECONDS = 1.5
YF_TIMEOUT_SECONDS = 15

# Moat thresholds, as ratios (0.15 = 15%), applied to ROE and the operating
# margin together.
WIDE_MOAT_MIN_RATIO = 0.15
NARROW_MOAT_MIN_RATIO = 0.10

QUALITY_METRICS_TABLE = "quality_metrics"

# Accepted ticker shape: US-style symbols plus dot or dash classes and
# exchange suffixes (BRK-B, RY.TO). Validated before the symbol is sent to
# Yahoo Finance.
TICKER_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,14}$")

Moat = Literal["Wide", "Narrow", "None"]


# --- Errors ---------------------------------------------------------------


class QualityDataError(Exception):
    """A Yahoo Finance request for quality data failed."""


class QualityRateLimitError(QualityDataError):
    """Yahoo Finance rate-limited the request."""


class PriceHistoryError(QualityDataError):
    """Fetching daily closes failed."""


class FundamentalsError(QualityDataError):
    """Fetching Ticker.info failed."""


class QualityTickerNotFoundError(Exception):
    """Yahoo Finance has no price history for this ticker and nothing is
    cached."""


# --- Yahoo Finance client -------------------------------------------------


def _with_retries(action: Callable[[], Any], error_type: type[QualityDataError], description: str) -> Any:
    """Runs one yfinance call with the retry policy above. A missing ticker
    (YFTickerMissingError) is re-raised for the caller to handle, a rate
    limit becomes QualityRateLimitError, and anything else becomes
    `error_type` after the last attempt."""
    for attempt in range(YF_MAX_ATTEMPTS):
        try:
            return action()
        except YFTickerMissingError:
            raise
        except YFRateLimitError:
            raise QualityRateLimitError(f"Yahoo Finance rate-limited the {description}.") from None
        except Exception as error:  # noqa: BLE001 - yfinance surfaces network/parse failures as many types
            if attempt < YF_MAX_ATTEMPTS - 1:
                time.sleep(YF_RETRY_BACKOFF_SECONDS)
                continue
            raise error_type(f"Yahoo Finance {description} failed ({type(error).__name__}).") from None
    # Unreachable: the final attempt always returns or raises.
    raise error_type(f"Yahoo Finance {description} failed.")


def fetch_daily_closes(symbol: str, today: date) -> list[float]:
    """Daily closes for the last PRICE_HISTORY_DAYS, oldest first.

    Uses the "Close" column with auto_adjust=False: Yahoo adjusts it for
    splits (so a split can't fake a crash in the Z-Score) but not for
    dividends (so the latest close matches the quoted price the app shows).

    An unknown ticker returns [], which the caller reports as "not found".
    Any other failure raises. raise_errors=True is what tells the two
    apart: by default yfinance logs errors and returns an empty table, so a
    Yahoo outage would look like a ticker with no history.
    """
    start = today - timedelta(days=PRICE_HISTORY_DAYS)
    end = today + timedelta(days=1)  # yfinance's `end` is exclusive

    try:
        history = _with_retries(
            lambda: yf.Ticker(symbol).history(
                start=start.isoformat(),
                end=end.isoformat(),
                interval="1d",
                auto_adjust=False,
                actions=False,
                timeout=YF_TIMEOUT_SECONDS,
                raise_errors=True,
            ),
            PriceHistoryError,
            f"price history request for '{symbol}'",
        )
    except YFTickerMissingError:
        return []

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


@dataclass(frozen=True)
class ProfitabilityMetrics:
    """Current trailing ratios from Ticker.info (0.28 = 28%). Each is None
    when Yahoo doesn't report it, e.g. for an ETF."""

    return_on_equity: float | None
    return_on_assets: float | None
    operating_margin: float | None


def _info_ratio(info: dict[str, Any], key: str) -> float | None:
    value = info.get(key)
    if isinstance(value, bool):  # bool is an int subclass; never a ratio
        return None
    try:
        ratio = float(value)
    except (TypeError, ValueError):
        return None
    return ratio if math.isfinite(ratio) else None


def fetch_profitability(symbol: str) -> ProfitabilityMetrics:
    """ROE, ROA and operating margin from Ticker(symbol).info. Missing
    figures are a valid result (all None for an ETF), not an error."""
    try:
        info = _with_retries(lambda: yf.Ticker(symbol).info, FundamentalsError, f"fundamentals request for '{symbol}'")
    except YFTickerMissingError:
        info = {}
    if not isinstance(info, dict):
        info = {}
    return ProfitabilityMetrics(
        return_on_equity=_info_ratio(info, "returnOnEquity"),
        return_on_assets=_info_ratio(info, "returnOnAssets"),
        operating_margin=_info_ratio(info, "operatingMargins"),
    )


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


def compute_roic_proxy_pct(metrics: ProfitabilityMetrics) -> float | None:
    """ROE as a percent, falling back to ROA; None when neither exists."""
    ratio = metrics.return_on_equity if metrics.return_on_equity is not None else metrics.return_on_assets
    return ratio * 100 if ratio is not None else None


def compute_moat(metrics: ProfitabilityMetrics) -> Moat:
    """Wide / Narrow / None from ROE and the operating margin together. If
    either is missing the moat is 'None', even when the ROIC proxy fell
    back to ROA."""
    roe = metrics.return_on_equity
    margin = metrics.operating_margin
    if roe is None or margin is None:
        return "None"
    if roe >= WIDE_MOAT_MIN_RATIO and margin >= WIDE_MOAT_MIN_RATIO:
        return "Wide"
    if roe >= NARROW_MOAT_MIN_RATIO and margin >= NARROW_MOAT_MIN_RATIO:
        return "Narrow"
    return "None"


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
# once instead of each making the same Yahoo calls.
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
      2. Refresh statistics if older than 24h or missing.
      3. Refresh fundamentals if older than 30 days or missing.
      4. Save the row if anything was refreshed, then return the payload.
    A failed refresh falls back to the expired cached half (flagged stale);
    with nothing cached for that half, the error is raised. Statistics are
    refreshed first, so an unknown ticker stops before the heavier .info
    call is made.
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
            except QualityDataError as error:
                if not _has_stats(row):
                    raise
                print(f"[quality] Statistics refresh failed for '{symbol}' ({error}); serving cached values.")
                stats_stale = True

        if not (_has_fundamentals(row) and _is_fresh(row.get("last_updated_fundamentals"), FUNDAMENTALS_TTL, now)):
            try:
                metrics = fetch_profitability(symbol)
                roic_proxy = compute_roic_proxy_pct(metrics)
                row.update(
                    roic=round(roic_proxy, 2) if roic_proxy is not None else None,
                    moat=compute_moat(metrics),
                    last_updated_fundamentals=now.isoformat(),
                )
                refreshed = True
            except QualityDataError as error:
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
        except QualityRateLimitError as error:
            raise HTTPException(status_code=429, detail=str(error)) from None
        except QualityDataError as error:
            raise HTTPException(status_code=502, detail=str(error)) from None

    return router
