// Shared between the Ambush Radar watchlist and Portfolio positions: which
// trend rule and price logic apply depends on whether a ticker is a plain
// equity or a fund/ETF (see report-formatters.ts).
export type AssetType = 'Stock' | 'ETF';

// TREND CLASSIFICATION: mirrors the backend's own _classify_trend
// (backend/main.py) — 'Bullish'/'Bearish' when the underlying SMA is
// available, null when it isn't (insufficient price history), never a
// guessed default. Two independent instances of this are returned per
// asset — macro_trend (price vs. SMA200) and tactical_momentum (price vs.
// SMA50) — see StockQuote/PortfolioStock.
export type TrendLabel = 'Bullish' | 'Bearish' | null;
