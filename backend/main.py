"""FastAPI backend for the Pipeline app.

Serves the current price and 50-day Simple Moving Average (SMA 50) for a
given stock ticker, sourced from Yahoo Finance via yfinance, plus a ticker
search/autocomplete endpoint backed by Yahoo Finance's search API.
"""

import httpx
import yfinance as yf
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

SMA_WINDOW = 50
MAX_SEARCH_RESULTS = 6

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


@app.get("/api/stock/{ticker}")
def get_stock(ticker: str) -> dict[str, float]:
    symbol = ticker.strip().upper()
    if not symbol:
        raise HTTPException(status_code=400, detail="Ticker symbol is required.")

    history = yf.Ticker(symbol).history(period="3mo")

    if history.empty:
        raise HTTPException(
            status_code=404,
            detail=f"No market data found for ticker '{symbol}'.",
        )

    close_prices = history["Close"]

    if len(close_prices) < SMA_WINDOW:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Not enough trading days ({len(close_prices)}) to compute a "
                f"{SMA_WINDOW}-day SMA for '{symbol}'."
            ),
        )

    sma50 = close_prices.rolling(window=SMA_WINDOW).mean().iloc[-1]
    price = close_prices.iloc[-1]

    return {"price": round(float(price), 2), "sma50": round(float(sma50), 2)}


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
