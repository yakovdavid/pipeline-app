// An ETF trading at or below 102% of its 200-day average is considered to
// be testing that support level. Shared by the in-app warning banner
// (StockCard) and the one-time structural stop notification (ambush.tsx)
// so both agree on exactly the same trigger condition.
export const STRUCTURAL_STOP_THRESHOLD = 1.02;

// Trailing Stop (TS) bifurcation: Satellite is the only category that gets
// an automatic trailing stop (Core is held through drawdowns, Quality is
// manually risk-reviewed instead — see PortfolioStockRow). Within
// Satellite, ETFs are structurally less volatile than individual Stocks, so
// they get a tighter percentage — a Stock-sized stop would let an ETF give
// back too much before triggering, while an ETF-sized stop would whipsaw a
// Stock on ordinary single-name noise.
export const SATELLITE_STOCK_TS_PCT = 0.12;
export const SATELLITE_ETF_TS_PCT = 0.07;
