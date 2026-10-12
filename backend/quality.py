"""Quality pipeline: Z-Score, ROIC and Moat for Quality assets, sourced
entirely from Yahoo Finance through the `yfinance` library (the same library
main.py uses for quotes). No API key, no paid plan.

GET /api/quality/{ticker} returns, for one ticker:
  - Statistics, from the last 2 years of daily closes:
      z_score = (current_price - mean_price) / std_dev
    current_price is the most recent close in the series. Refreshed after 24h.
  - Fundamentals, self-calculated from up to 4 fiscal years of raw annual
    statements (Ticker.financials and Ticker.balance_sheet):
      per year: ROE              = Net Income / Stockholders' Equity
                operating margin = Operating Income / Total Revenue
      A year is viable only when both ratios can be computed (no missing
      figure, equity > 0, revenue > 0); other years are skipped, never
      counted as zero.
      roic: the AVERAGE ROE across viable years, as a percent (28 = 28%).
            A ROIC proxy: Yahoo doesn't publish ROIC. The response key stays
            `roic` so the app and the cache table keep working unchanged.
      moat: Wide   if average ROE >= 15% AND average operating margin >= 15%
            Narrow if both averages >= 10% (and not Wide)
            None   otherwise, or with fewer than 2 viable years
    Refreshed after 30 days.

Each half is cached with its own timestamp (see backend/sql/
004_quality_metrics_cache.sql), so a daily price refresh never refetches
financial statements.

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

import pandas as pd
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

# Fundamentals window and moat thresholds. Thresholds are ratios
# (0.15 = 15%), applied to the multi-year average ROE and average operating
# margin together.
FUNDAMENTALS_MAX_YEARS = 4
MOAT_MIN_VIABLE_YEARS = 2
WIDE_MOAT_MIN_RATIO = 0.15
NARROW_MOAT_MIN_RATIO = 0.10

# Statement row labels, tried in order for each fiscal year. The first name
# in each tuple is the one the PRD specifies; the others are the labels
# yfinance actually uses for the same line where they differ (for example,
# it has no plain "Total Equity" or "Total Liabilities" row).
NET_INCOME_LABELS = ("Net Income", "Net Income Common Stockholders")
OPERATING_INCOME_LABELS = ("Operating Income", "Total Operating Income As Reported")
TOTAL_REVENUE_LABELS = ("Total Revenue", "Operating Revenue")
EQUITY_LABELS = ("Stockholders Equity", "Total Equity", "Total Equity Gross Minority Interest")
TOTAL_ASSETS_LABELS = ("Total Assets",)
TOTAL_LIABILITIES_LABELS = ("Total Liabilities", "Total Liabilities Net Minority Interest")

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
    """Fetching the annual financial statements failed."""


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
class FinancialStatements:
    """Annual statements as yfinance returns them: rows are line items,
    columns are fiscal year-end dates. Either may be empty, e.g. for an
    ETF, which files no statements."""

    income_statement: pd.DataFrame
    balance_sheet: pd.DataFrame

    @property
    def is_empty(self) -> bool:
        return self.income_statement.empty and self.balance_sheet.empty


def _as_frame(value: Any) -> pd.DataFrame:
    return value if isinstance(value, pd.DataFrame) else pd.DataFrame()


def fetch_financial_statements(symbol: str) -> FinancialStatements:
    """Ticker.financials (income statement) and Ticker.balance_sheet, both
    annual. Anything that isn't a DataFrame is treated as empty."""

    def load() -> FinancialStatements:
        ticker = yf.Ticker(symbol)
        return FinancialStatements(_as_frame(ticker.financials), _as_frame(ticker.balance_sheet))

    try:
        return _with_retries(load, FundamentalsError, f"financial statements request for '{symbol}'")
    except YFTickerMissingError:
        return FinancialStatements(pd.DataFrame(), pd.DataFrame())


# --- Statement parsing ----------------------------------------------------


def _finite_float(value: Any) -> float | None:
    """A finite float, or None for NaN, infinity, bool or non-numbers."""
    if isinstance(value, bool):  # bool is an int subclass; never a figure
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _cell(frame: pd.DataFrame, label: str, column: Any) -> float | None:
    """One figure, safely: None when the label is absent or the value is
    unusable. A label that appears more than once yields a Series, of which
    the first usable value is taken."""
    try:
        if label not in frame.index:
            return None
        value = frame.loc[label, column]
    except (KeyError, TypeError, ValueError, IndexError):
        return None
    if isinstance(value, (pd.Series, pd.DataFrame)):
        for item in pd.Series(value.to_numpy().ravel()):
            number = _finite_float(item)
            if number is not None:
                return number
        return None
    return _finite_float(value)


def _first_figure(frame: pd.DataFrame, labels: tuple[str, ...], column: Any) -> float | None:
    for label in labels:
        number = _cell(frame, label, column)
        if number is not None:
            return number
    return None


def _columns_by_fiscal_year(frame: pd.DataFrame) -> dict[int, Any]:
    """Maps each fiscal year to its column, keeping the latest column when
    a year appears twice (e.g. after a fiscal-year-end change). Keyed by
    year rather than exact date, so the income statement and balance sheet
    still line up if their dates differ by a few days."""
    dated: list[tuple[pd.Timestamp, Any]] = []
    for column in frame.columns:
        try:
            dated.append((pd.Timestamp(column), column))
        except (TypeError, ValueError):
            continue
    columns: dict[int, Any] = {}
    for timestamp, column in sorted(dated, key=lambda pair: pair[0], reverse=True):
        columns.setdefault(timestamp.year, column)
    return columns


def _equity(balance_sheet: pd.DataFrame, column: Any) -> float | None:
    """Stockholders' equity, falling back to Total Assets - Total
    Liabilities when no equity row has a value."""
    equity = _first_figure(balance_sheet, EQUITY_LABELS, column)
    if equity is not None:
        return equity
    assets = _first_figure(balance_sheet, TOTAL_ASSETS_LABELS, column)
    liabilities = _first_figure(balance_sheet, TOTAL_LIABILITIES_LABELS, column)
    if assets is None or liabilities is None:
        return None
    return assets - liabilities


@dataclass(frozen=True)
class FiscalYearRatios:
    fiscal_year: int
    roe: float  # ratio, 0.28 = 28%
    operating_margin: float  # ratio


def compute_yearly_ratios(statements: FinancialStatements) -> list[FiscalYearRatios]:
    """ROE and operating margin for each viable year among the most recent
    FUNDAMENTALS_MAX_YEARS fiscal years, newest first.

    A year is skipped (never counted as zero) when a figure is missing, or
    equity or revenue is zero or negative. ROE on negative equity is
    meaningless (losses would show as positive returns), as is a margin on
    no revenue."""
    income_columns = _columns_by_fiscal_year(statements.income_statement)
    balance_columns = _columns_by_fiscal_year(statements.balance_sheet)

    ratios: list[FiscalYearRatios] = []
    for year in sorted(income_columns, reverse=True)[:FUNDAMENTALS_MAX_YEARS]:
        if year not in balance_columns:
            continue
        try:
            income_column = income_columns[year]
            net_income = _first_figure(statements.income_statement, NET_INCOME_LABELS, income_column)
            operating_income = _first_figure(statements.income_statement, OPERATING_INCOME_LABELS, income_column)
            revenue = _first_figure(statements.income_statement, TOTAL_REVENUE_LABELS, income_column)
            equity = _equity(statements.balance_sheet, balance_columns[year])
        except Exception as error:  # noqa: BLE001 - one malformed year must not sink the others
            print(f"[quality] Skipping fiscal year {year}: unreadable statements ({type(error).__name__}).")
            continue
        if net_income is None or operating_income is None or revenue is None or equity is None:
            continue
        if equity <= 0 or revenue <= 0:
            continue
        ratios.append(FiscalYearRatios(year, net_income / equity, operating_income / revenue))
    return ratios


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


def compute_moat(yearly: list[FiscalYearRatios]) -> tuple[float | None, Moat]:
    """Returns (roic, moat) from the viable years.

    roic is the average ROE as a percent, reported whenever at least one
    viable year exists. The moat is judged on the average ROE and average
    operating margin over the same years, and is 'None' with fewer than
    MOAT_MIN_VIABLE_YEARS of them.
    """
    if not yearly:
        return None, "None"
    average_roe = statistics.fmean(year.roe for year in yearly)
    average_margin = statistics.fmean(year.operating_margin for year in yearly)
    roic = average_roe * 100
    if len(yearly) < MOAT_MIN_VIABLE_YEARS:
        return roic, "None"
    if average_roe >= WIDE_MOAT_MIN_RATIO and average_margin >= WIDE_MOAT_MIN_RATIO:
        return roic, "Wide"
    if average_roe >= NARROW_MOAT_MIN_RATIO and average_margin >= NARROW_MOAT_MIN_RATIO:
        return roic, "Narrow"
    return roic, "None"


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
    refreshed first, so an unknown ticker stops before the heavier
    financial statements requests are made.
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
                statements = fetch_financial_statements(symbol)
                # yfinance's statement properties swallow request errors and
                # return empty tables, so "no statements at all" for a ticker
                # that HAD real figures is treated as a failed refresh, not
                # cached as "no moat" for 30 days. A ticker that never had
                # any (an ETF) is simply re-confirmed as having none.
                if statements.is_empty and row.get("roic") is not None:
                    raise FundamentalsError(f"Yahoo Finance returned no financial statements for '{symbol}'.")
                roic, moat = compute_moat(compute_yearly_ratios(statements))
                row.update(
                    roic=round(roic, 2) if roic is not None else None,
                    moat=moat,
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
