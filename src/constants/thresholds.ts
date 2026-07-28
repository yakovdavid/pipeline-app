// An ETF trading at or below 102% of its 200-day average is considered to
// be testing that support level. Shared by the in-app warning banner
// (StockCard) and the one-time structural stop notification (ambush.tsx)
// so both agree on exactly the same trigger condition.
export const STRUCTURAL_STOP_THRESHOLD = 1.02;

// Trailing stop trigger price for 'Stock' positions: 88% of the highest
// price observed since the position was added (its "Highest Watermark").
export const TRAILING_STOP_MULTIPLIER = 0.88;
