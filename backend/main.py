"""FastAPI backend for the Pipeline app.

Serves the current price and 50-day Simple Moving Average (SMA 50) for a
given stock ticker, sourced from Yahoo Finance via yfinance.
"""

import yfinance as yf
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

SMA_WINDOW = 50

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


if __name__ == "__main__":
    import uvicorn

    # Bind to 0.0.0.0 so devices on the same LAN (e.g. a phone running
    # Expo Go) can reach this server, not just localhost.
    uvicorn.run(app, host="0.0.0.0", port=8000)
