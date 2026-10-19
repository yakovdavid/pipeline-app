"""USD/ILS exchange rate: the single source of the rate for the whole
backend.

GET /api/fx/usd-ils returns {"rate": float, "last_updated": ISO-8601}, the
number of Israeli shekels per one US dollar (Yahoo Finance's "ILS=X").

The same UsdIlsRateProvider instance also converts every Israeli quote in
main.py (see _fetch_usd_ils_rate there). Both read one cache, so a client
converting with this endpoint uses exactly the rate the backend used for its
USD prices. Two separately cached rates would themselves cause the FX
distortion this endpoint exists to remove.

Caching and failure policy:
  - A fetched rate is served for FX_CACHE_TTL (60 minutes) without calling
    Yahoo again.
  - Once it expires, the next request refreshes it. If that refresh fails
    (network error, rate limit, a malformed or implausible value), the last
    known rate is served instead, with its original last_updated, so a
    client can tell how old it is.
  - With no rate ever fetched, the endpoint answers 503.

Concurrency: refreshes happen under a lock, so simultaneous requests after
expiry make one Yahoo call, not one each.

The Yahoo call itself is injected (fetch_rate) rather than made here: main.py
passes one that goes through its shared, browser-impersonating session and
retry/throttle layer, without this module importing main.py, which would be
a circular import. That also lets tests inject a fake.
"""

import math
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

USD_ILS_SYMBOL = "ILS=X"
FX_CACHE_TTL = timedelta(minutes=60)

# Sanity bounds for shekels per dollar. The rate has stayed between roughly
# 3 and 5 for decades; a value outside 1-10 is a bad print (e.g. a quote in
# Agorot), and is treated as a failed fetch rather than cached for an hour
# and applied to every Israeli position.
MIN_PLAUSIBLE_USD_ILS = 1.0
MAX_PLAUSIBLE_USD_ILS = 10.0


@dataclass(frozen=True)
class FxRate:
    rate: float
    # When this rate was fetched from Yahoo (UTC). A stale fallback keeps
    # its original timestamp.
    last_updated: datetime


class FxRateUnavailableError(Exception):
    """No valid rate could be fetched and none has ever been cached."""


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def validate_usd_ils_rate(raw: object) -> float | None:
    """The rate as a float, or None if it is missing, not a number, not
    finite, or outside the plausible range."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    rate = float(raw)
    if not math.isfinite(rate) or not MIN_PLAUSIBLE_USD_ILS <= rate <= MAX_PLAUSIBLE_USD_ILS:
        return None
    return rate


class UsdIlsRateProvider:
    """The cached USD/ILS rate. fetch_rate returns the latest raw rate (or
    None) and may raise; clock is injectable for tests."""

    def __init__(
        self,
        fetch_rate: Callable[[], object],
        ttl: timedelta = FX_CACHE_TTL,
        clock: Callable[[], datetime] = _utc_now,
    ) -> None:
        self._fetch_rate = fetch_rate
        self._ttl = ttl
        self._clock = clock
        self._lock = threading.Lock()
        self._cached: FxRate | None = None

    def get_rate(self) -> FxRate:
        with self._lock:
            now = self._clock()
            cached = self._cached
            if cached is not None and now - cached.last_updated < self._ttl:
                return cached

            failure: str
            try:
                rate = validate_usd_ils_rate(self._fetch_rate())
                failure = "Yahoo Finance returned no valid rate"
            except Exception as error:  # noqa: BLE001 - any fetch failure falls back to the cache
                rate = None
                failure = f"Yahoo Finance request failed ({type(error).__name__})"

            if rate is not None:
                self._cached = FxRate(rate=rate, last_updated=now)
                return self._cached

            if cached is not None:
                print(
                    f"[fx] USD/ILS refresh failed: {failure}; serving the last known rate "
                    f"from {cached.last_updated.isoformat()}."
                )
                return cached

            raise FxRateUnavailableError(f"USD/ILS exchange rate unavailable: {failure}, and no cached rate exists.")


class UsdIlsRateResponse(BaseModel):
    rate: float
    last_updated: str


def create_fx_router(provider: UsdIlsRateProvider) -> APIRouter:
    router = APIRouter()

    @router.get("/api/fx/usd-ils", response_model=UsdIlsRateResponse)
    def get_usd_ils_rate() -> UsdIlsRateResponse:
        try:
            fx_rate = provider.get_rate()
        except FxRateUnavailableError as error:
            raise HTTPException(status_code=503, detail=str(error)) from None
        return UsdIlsRateResponse(rate=fx_rate.rate, last_updated=fx_rate.last_updated.isoformat())

    return router
