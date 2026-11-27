"""Quality pipeline: the automatic inputs of the Quality entry rules.

Sources:
  - Z-Score: Yahoo Finance daily closes via `yfinance`.
  - ROIC, P/E and CapEx ratios: Financial Modeling Prep (FMP). Requires the
    FMP_API_KEY environment variable. A missing figure is returned as null,
    never guessed: a null input fails its entry rule in the app.

MOAT IS NOT COMPUTED HERE (2026-11-27). FMP has no moat data, and the old
ROE/operating-margin proxy produced unapproved ratings (LIN/AMT/ECL/DE/CNI
= Wide, FICO = None). Moat is now a manual, per-ticker field kept by the
app (src/utils/moat-store.ts). This endpoint no longer returns `moat`.

GET /api/quality/{ticker} returns, for one ticker:
  - Statistics (refreshed after 24h):
      z_score = (current_price - mean_price) / std_dev over the last
                Z_SCORE_WINDOW_TRADING_DAYS (504) daily closes.
      pe_ttm  = FMP ratios-ttm priceToEarningsRatioTTM. Price-dependent,
                so it refreshes with the statistics, not monthly.
  - Fundamentals (refreshed after 30 days):
      roic               = FMP key-metrics-ttm returnOnInvestedCapitalTTM, percent.
      pe_5y_avg          = mean annual priceToEarningsRatio over the last 5
                           fiscal years (FMP ratios, annual). Years with a
                           non-positive P/E (a loss year) are skipped.
      capex_to_revenue_3y = mean of yearly capexPerShare / revenuePerShare
                            over the last 3 fiscal years, percent.
      capex_to_ocf_3y     = mean of yearly capexPerShare /
                            operatingCashFlowPerShare over the same years, percent.
    Verified against ZTS (FY2023-2025): CapEx/Revenue 7.4%, CapEx/OCF 24.9%.

Each half is cached with its own timestamp (see backend/sql/
004_quality_metrics_cache.sql and 005_quality_entry_rules.sql).

Caching: Supabase when it is configured (main.py passes its client in),
otherwise an in-memory cache with the same lifetimes.

Failure policy: if a refresh fails (rate limit, network, Yahoo/FMP down) and
an expired cached value exists, that value is served and flagged *_stale in
the response, rather than failing the request.
"""

import math
import os
import re
import statistics
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

import requests
import yfinance as yf
from fastapi import APIRouter, HTTPException
from yfinance.exceptions import YFRateLimitError, YFTickerMissingError

# --- Configuration --------------------------------------------------------

STATS_TTL = timedelta(hours=24)
FUNDAMENTALS_TTL = timedelta(days=30)

# Z-Score window: the last 504 trading days (about 2 years). Enough
# calendar days are fetched to always cover 504 sessions, holidays included.
Z_SCORE_WINDOW_TRADING_DAYS = 504
PRICE_HISTORY_DAYS = 760

# Yahoo Finance requests. A transient failure is retried once; a rate limit
# is not retried, since retrying straight away only prolongs the block.
YF_MAX_ATTEMPTS = 2
YF_RETRY_BACKOFF_SECONDS = 1.5
YF_TIMEOUT_SECONDS = 15

# Fundamentals windows (fiscal years).
PE_AVERAGE_YEARS = 5
CAPEX_AVERAGE_YEARS = 3

QUALITY_METRICS_TABLE = "quality_metrics"

# FMP (Financial Modeling Prep) - the ROIC source. Stable API.
FMP_KEY_METRICS_TTM_URL = "https://financialmodelingprep.com/stable/key-metrics-ttm"
FMP_RATIOS_TTM_URL = "https://financialmodelingprep.com/stable/ratios-ttm"
FMP_RATIOS_ANNUAL_URL = "https://financialmodelingprep.com/stable/ratios"
FMP_TIMEOUT_SECONDS = 15
FMP_ROIC_FIELD = "returnOnInvestedCapitalTTM"
FMP_PE_TTM_FIELD = "priceToEarningsRatioTTM"
FMP_PE_FIELD = "priceToEarningsRatio"
FMP_CAPEX_PER_SHARE_FIELD = "capexPerShare"
FMP_REVENUE_PER_SHARE_FIELD = "revenuePerShare"
FMP_OCF_PER_SHARE_FIELD = "operatingCashFlowPerShare"

# Accepted ticker shape: US-style symbols plus dot or dash classes and
# exchange suffixes (BRK-B, RY.TO). Validated before the symbol is sent to
# Yahoo Finance.
TICKER_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,14}$")

# --- Errors ---------------------------------------------------------------


class QualityDataError(Exception):
    """A Yahoo Finance request for quality data failed."""


class QualityRateLimitError(QualityDataError):
    """Yahoo Finance rate-limited the request."""


class PriceHistoryError(QualityDataError):
    """Fetching daily closes failed."""


class FundamentalsError(QualityDataError):
    """An FMP fundamentals request failed."""


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


# FUNDAMENTAL AUDIT (2026-11-27): evaluated on the last COMPLETED daily
# close, never a live price. yfinance includes today's in-progress bar
# while the exchange is open, so a bar dated today (exchange time) is
# dropped until this local hour, which is after both the NYSE (16:00) and
# TASE (17:25) closes.
SESSION_COMPLETE_LOCAL_HOUR = 18
AUDIT_HIGH_WINDOW_TRADING_DAYS = 252  # 52 weeks of sessions


def fetch_daily_closes(symbol: str, today: date) -> list[float]:
    """Daily closes, oldest first (see fetch_dated_daily_closes)."""
    return [close for _, close in fetch_dated_daily_closes(symbol, today)]


def fetch_dated_daily_closes(symbol: str, today: date) -> list[tuple[date, float]]:
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
            if _is_in_progress_session(timestamp):
                continue
            dated_closes.append((row_date, close))
    dated_closes.sort(key=lambda pair: pair[0])
    return dated_closes


def _is_in_progress_session(timestamp: Any) -> bool:
    """True for a bar dated today (in its exchange's own time zone) before
    SESSION_COMPLETE_LOCAL_HOUR: its "close" is still a live price."""
    tz = getattr(timestamp, "tzinfo", None)
    if tz is None:
        return False
    now_local = datetime.now(tz)
    return timestamp.date() == now_local.date() and now_local.hour < SESSION_COMPLETE_LOCAL_HOUR


@dataclass(frozen=True)
class DailyCloseDrawdown:
    close: float
    close_date: date
    high_52w_close: float
    drawdown_pct: float  # negative below the high


def compute_close_drawdown(dated_closes: list[tuple[date, float]]) -> DailyCloseDrawdown | None:
    """The last completed close against the highest close of the last
    AUDIT_HIGH_WINDOW_TRADING_DAYS sessions (the last close included).
    `dated_closes` must be oldest first."""
    if not dated_closes:
        return None
    window = dated_closes[-AUDIT_HIGH_WINDOW_TRADING_DAYS:]
    close_date, close = window[-1]
    high = max(value for _, value in window)
    return DailyCloseDrawdown(close, close_date, high, (close - high) / high * 100)


def _finite_float(value: Any) -> float | None:
    """A finite float, or None for NaN, infinity, bool or non-numbers."""
    if isinstance(value, bool):  # bool is an int subclass; never a figure
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


# --- Calculations ---------------------------------------------------------


@dataclass(frozen=True)
class PriceStatistics:
    current_price: float
    mean_price: float
    std_dev: float | None
    z_score: float | None


def _fmp_get(url: str, symbol: str, description: str, extra_params: dict[str, Any] | None = None) -> list[dict[str, Any]] | None:
    """One FMP stable-API call. Returns the list of row dicts, or None when
    FMP has nothing for the symbol or no API key is set.

    Raises QualityRateLimitError on HTTP 429 and FundamentalsError on any
    other transport/HTTP failure, so the caller serves the cached value
    (flagged stale) instead of caching a wrong "no data". Plan restrictions
    (401/402/403) are reported as None + a log line."""
    api_key = os.environ.get("FMP_API_KEY", "").strip()
    if not api_key:
        print(f"[quality] FMP_API_KEY is not set; {description} unavailable.")
        return None
    try:
        response = requests.get(
            url,
            params={"symbol": symbol, "apikey": api_key, **(extra_params or {})},
            timeout=FMP_TIMEOUT_SECONDS,
        )
    except requests.RequestException as error:
        raise FundamentalsError(f"FMP {description} request failed for '{symbol}': {type(error).__name__}") from None
    if response.status_code == 429:
        raise QualityRateLimitError(f"FMP rate-limited the {description} request for '{symbol}'.")
    if response.status_code in (401, 402, 403):
        print(f"[quality] FMP denied {description} for '{symbol}' (HTTP {response.status_code}); outside plan coverage.")
        return None
    if response.status_code != 200:
        raise FundamentalsError(f"FMP returned HTTP {response.status_code} for the {description} of '{symbol}'.")
    try:
        payload = response.json()
    except ValueError:
        raise FundamentalsError(f"FMP returned a non-JSON {description} body for '{symbol}'.") from None
    if not isinstance(payload, list):
        return None
    rows = [row for row in payload if isinstance(row, dict)]
    return rows or None


def fetch_fmp_roic_ttm(symbol: str) -> float | None:
    """ROIC (TTM, NOPAT-based) as a percent, or None (ETF, non-US listing,
    no API key)."""
    rows = _fmp_get(FMP_KEY_METRICS_TTM_URL, symbol, "ROIC")
    if rows is None:
        return None
    value = _finite_float(rows[0].get(FMP_ROIC_FIELD))
    return value * 100 if value is not None else None


def fetch_fmp_pe_ttm(symbol: str) -> float | None:
    """P/E TTM, or None. A non-positive P/E (trailing losses) is returned as
    is; the app's rule P/E TTM < 5y avg P/E rejects it explicitly."""
    rows = _fmp_get(FMP_RATIOS_TTM_URL, symbol, "P/E TTM")
    if rows is None:
        return None
    return _finite_float(rows[0].get(FMP_PE_TTM_FIELD))


def fetch_fmp_annual_ratios(symbol: str) -> list[dict[str, Any]]:
    """Annual FMP ratios, newest first, at most PE_AVERAGE_YEARS rows."""
    rows = _fmp_get(
        FMP_RATIOS_ANNUAL_URL,
        symbol,
        "annual ratios",
        {"period": "annual", "limit": PE_AVERAGE_YEARS},
    )
    if rows is None:
        return []
    return sorted(rows, key=lambda row: str(row.get("date", "")), reverse=True)[:PE_AVERAGE_YEARS]


@dataclass(frozen=True)
class EntryRuleFundamentals:
    pe_5y_avg: float | None
    capex_to_revenue_3y: float | None  # percent
    capex_to_ocf_3y: float | None  # percent


def _mean_or_none(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def compute_entry_rule_fundamentals(annual_rows: list[dict[str, Any]]) -> EntryRuleFundamentals:
    """The 5y average P/E and the 3y Capital Light ratios from FMP annual
    ratio rows (newest first).

    5y average P/E: loss years (P/E <= 0) are skipped, not averaged in.
    CapEx ratios: the mean of each year's ratio. FMP reports capexPerShare
    as a positive number on the ratios endpoint; abs() guards against a
    sign change. A year with a non-positive revenue or OCF is skipped.
    Both CapEx averages require all CAPEX_AVERAGE_YEARS years: a partial
    window is reported as None (unknown), which fails the rule in the app."""
    pe_values = [
        pe for pe in (_finite_float(row.get(FMP_PE_FIELD)) for row in annual_rows[:PE_AVERAGE_YEARS]) if pe is not None and pe > 0
    ]

    capex_rows = annual_rows[:CAPEX_AVERAGE_YEARS]
    revenue_ratios: list[float] = []
    ocf_ratios: list[float] = []
    for row in capex_rows:
        capex = _finite_float(row.get(FMP_CAPEX_PER_SHARE_FIELD))
        revenue = _finite_float(row.get(FMP_REVENUE_PER_SHARE_FIELD))
        ocf = _finite_float(row.get(FMP_OCF_PER_SHARE_FIELD))
        if capex is None:
            continue
        if revenue is not None and revenue > 0:
            revenue_ratios.append(abs(capex) / revenue * 100)
        if ocf is not None and ocf > 0:
            ocf_ratios.append(abs(capex) / ocf * 100)

    return EntryRuleFundamentals(
        pe_5y_avg=_mean_or_none(pe_values),
        capex_to_revenue_3y=_mean_or_none(revenue_ratios) if len(revenue_ratios) == CAPEX_AVERAGE_YEARS else None,
        capex_to_ocf_3y=_mean_or_none(ocf_ratios) if len(ocf_ratios) == CAPEX_AVERAGE_YEARS else None,
    )


def compute_price_statistics(closes: list[float]) -> PriceStatistics:
    """Z-Score of the latest close against the last
    Z_SCORE_WINDOW_TRADING_DAYS closes (fewer when the history is shorter),
    using the
    population standard deviation (statistics.pstdev, the same convention as
    the rest of this backend). With a single close, or a perfectly flat
    series, the spread is unusable, so z_score is None instead of a
    division by zero. `closes` must be oldest first and non-empty."""
    closes = closes[-Z_SCORE_WINDOW_TRADING_DAYS:]
    current_price = closes[-1]
    mean_price = statistics.fmean(closes)
    if len(closes) < 2:
        return PriceStatistics(current_price, mean_price, None, None)
    std_dev = statistics.pstdev(closes, mu=mean_price)
    z_score = (current_price - mean_price) / std_dev if std_dev > 0 else None
    return PriceStatistics(current_price, mean_price, std_dev, z_score)


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
    return row.get("last_updated_fundamentals") is not None


def _to_float(value: Any) -> float | None:
    return float(value) if value is not None else None


def get_quality_metrics(symbol: str, store: QualityMetricsStore, now: datetime | None = None) -> dict[str, Any]:
    """The full cache-then-fetch flow for one already-validated symbol:
      1. Load the cached row.
      2. Refresh statistics if older than 24h or missing.
      3. Refresh fundamentals if older than 30 days or missing.
      4. Save the row if anything was refreshed, then return the payload.
    A failed statistics refresh falls back to the expired cached half
    (flagged stale); with nothing cached, the error is raised. A failed FMP
    fundamentals refresh never fails the request (the Z-Score is still
    valid): cached values are kept, or left null, and flagged stale, and the
    timestamp is not advanced, so the next request retries. Statistics are
    refreshed first, so an unknown ticker stops before any FMP call.
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
                dated_closes = fetch_dated_daily_closes(symbol, now.date())
                closes = [close for _, close in dated_closes]
                if not closes:
                    if not _has_stats(row):
                        raise QualityTickerNotFoundError(f"Yahoo Finance has no price history for '{symbol}'.")
                    stats_stale = True
                else:
                    stats = compute_price_statistics(closes)
                    audit = compute_close_drawdown(dated_closes)
                    row.update(
                        audit_close=round(audit.close, 4) if audit else None,
                        audit_close_date=audit.close_date.isoformat() if audit else None,
                        high_52w_close=round(audit.high_52w_close, 4) if audit else None,
                        close_drawdown_pct=round(audit.drawdown_pct, 2) if audit else None,
                    )
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

            # P/E TTM moves with the price, so it refreshes with the
            # statistics. Its failure only marks the statistics stale.
            try:
                pe_ttm = fetch_fmp_pe_ttm(symbol)
                row.update(pe_ttm=round(pe_ttm, 2) if pe_ttm is not None else None)
                refreshed = True
            except QualityDataError as fmp_error:
                print(f"[quality] FMP P/E TTM refresh failed for '{symbol}' ({fmp_error}); keeping cached P/E.")
                stats_stale = True

        if not (_has_fundamentals(row) and _is_fresh(row.get("last_updated_fundamentals"), FUNDAMENTALS_TTL, now)):
            try:
                roic = fetch_fmp_roic_ttm(symbol)
                entry = compute_entry_rule_fundamentals(fetch_fmp_annual_ratios(symbol))
                row.update(
                    roic=round(roic, 2) if roic is not None else None,
                    pe_5y_avg=round(entry.pe_5y_avg, 2) if entry.pe_5y_avg is not None else None,
                    capex_to_revenue_3y=(
                        round(entry.capex_to_revenue_3y, 2) if entry.capex_to_revenue_3y is not None else None
                    ),
                    capex_to_ocf_3y=round(entry.capex_to_ocf_3y, 2) if entry.capex_to_ocf_3y is not None else None,
                    last_updated_fundamentals=now.isoformat(),
                )
                refreshed = True
            except QualityDataError as fmp_error:
                print(f"[quality] FMP fundamentals refresh failed for '{symbol}' ({fmp_error}); keeping cached values.")
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
            "pe_ttm": _to_float(row.get("pe_ttm")),
            "pe_5y_avg": _to_float(row.get("pe_5y_avg")),
            "capex_to_revenue_3y": _to_float(row.get("capex_to_revenue_3y")),
            "capex_to_ocf_3y": _to_float(row.get("capex_to_ocf_3y")),
            "z_score_window_trading_days": Z_SCORE_WINDOW_TRADING_DAYS,
            # FUNDAMENTAL AUDIT inputs: last completed daily close vs. the
            # 52-week high of daily closes.
            "audit_close": _to_float(row.get("audit_close")),
            "audit_close_date": row.get("audit_close_date"),
            "high_52w_close": _to_float(row.get("high_52w_close")),
            "close_drawdown_pct": _to_float(row.get("close_drawdown_pct")),
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
