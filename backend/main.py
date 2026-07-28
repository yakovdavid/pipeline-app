"""FastAPI backend for the Pipeline app.

Serves the current price plus the 50-day and 200-day Simple Moving Averages
(SMA 50 / SMA 200) for a given ticker, sourced from Yahoo Finance via
yfinance, plus a ticker search/autocomplete endpoint backed by Yahoo
Finance's search API.
"""

import httpx
import yfinance as yf
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

MAX_SEARCH_RESULTS = 6

# Tel Aviv Stock Exchange tickers (symbol suffix ".TA") are quoted by Yahoo
# in Agorot (1/100 of a New Israeli Shekel), not USD. To get a comparable
# USD value we convert: shekels = agorot / 100, then divide by the USD/ILS
# rate (how many shekels one dollar buys) to get USD.
TASE_TICKER_SUFFIX = ".TA"
USD_ILS_FX_SYMBOL = "ILS=X"
AGOROT_PER_SHEKEL = 100

# Yahoo Finance's search endpoint rejects requests without a browser-like
# User-Agent, responding with 403 Forbidden.
YAHOO_SEARCH_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

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
    """Fetch the current USD/ILS exchange rate (shekels per one US dollar)."""
    try:
        fx_info = yf.Ticker(USD_ILS_FX_SYMBOL).info
    except Exception as error:  # yfinance raises various network/parse errors
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

    return float(fx_rate)


@app.get("/api/stock/{ticker}")
def get_stock(ticker: str) -> dict[str, float | None]:
    symbol = ticker.strip().upper()
    if not symbol:
        raise HTTPException(status_code=400, detail="Ticker symbol is required.")

    try:
        info = yf.Ticker(symbol).info
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

    return {
        "price": round(float(price), 2),
        "sma50": round(float(sma50), 2) if sma50 is not None else None,
        "sma200": round(float(sma200), 2) if sma200 is not None else None,
    }


@app.get("/api/search/{query}")
def search_tickers(query: str) -> list[dict[str, str]]:
    trimmed_query = query.strip()
    if not trimmed_query:
        raise HTTPException(status_code=400, detail="Search query is required.")

    try:
        response = httpx.get(
            "https://query2.finance.yahoo.com/v1/finance/search",
            params={"q": trimmed_query},
            headers={"User-Agent": YAHOO_SEARCH_USER_AGENT},
            timeout=10.0,
        )
        response.raise_for_status()
    except httpx.HTTPError as error:
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
