// An ETF trading at or below 102% of its 200-day average is considered to
// be testing that support level. Shared by the in-app warning banner
// (StockCard) and the one-time structural stop notification (ambush.tsx)
// so both agree on exactly the same trigger condition.
export const STRUCTURAL_STOP_THRESHOLD = 1.02;

// Trailing Stop (TS) REVERSION: Satellite is the only category that gets an
// automatic trailing stop (Core is held through drawdowns; Quality gets a
// Fundamental Audit "Kill Switch" instead — see PortfolioStockRow). A
// single hard 12% for EVERY Satellite position now, Stock or ETF alike —
// the old ETF-specific 7% exception has been deliberately removed as part
// of "The Fortress 2.0" protocol's UI/discipline simplification: one
// unambiguous tactical rule per layer, not a per-asset-type carve-out.
export const SATELLITE_TS_PCT = 0.12;
