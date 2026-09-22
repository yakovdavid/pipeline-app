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
// Matches backend/main.py's SATELLITE_TRAILING_STOP_PCT exactly (both are
// literally "* 0.88" of the watermark) and backend/sql/
// 002_trailing_stop_and_quality_zscore.sql's view — three independent
// copies of the same constant, kept in sync deliberately.
export const SATELLITE_TS_PCT = 0.12;

// PULLBACK DEPTH INDICATOR: the 3-tier color read of pullback_depth
// (backend/main.py: ((price - SMA50) / SMA50) * 100) that replaces the old
// binary Bullish/Bearish Tactical Momentum badge — see TrendBadges.tsx.
// The PRD's literal bands are "> 0% Gray (Premium)", "0% to -2.9% Orange
// (Watch)", "-3.0% to -7.0% Red (Kill Zone / Entry Trigger)"; collapsed
// here into two clean boundaries since the bands are contiguous in
// practice (there's no defined tier for the -2.9%-to-3.0% sliver, and the
// PRD doesn't say what happens below -7.0% either) — anything at or below
// PULLBACK_KILL_ZONE_THRESHOLD_PCT stays Kill Zone, the most severe tier,
// rather than left unclassified past -7.0%.
export const PULLBACK_PREMIUM_THRESHOLD_PCT = 0;
export const PULLBACK_KILL_ZONE_THRESHOLD_PCT = -3.0;
