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

// PULLBACK DEPTH INDICATOR: the tiered color read of pullback_depth
// (backend/main.py: ((price - SMA50) / SMA50) * 100) that replaces the old
// binary Bullish/Bearish Tactical Momentum badge — see TrendBadges.tsx and
// @/utils/ambush-zone for the classification itself:
//   > 0%              Gray (Premium)
//   0% to -2.99%      Orange (Watch)
//   -3.00% to -6.99%  Red (Kill Zone / Entry Trigger)
//   -7.00% or deeper  Dark magenta (Overshot — a crash, NOT an entry)
// All tiers are additionally gated by the Macro Override: unless Macro
// Trend is Bullish the badge is neutralized to gray "Invalidated".
export const PULLBACK_PREMIUM_THRESHOLD_PCT = 0;
export const PULLBACK_KILL_ZONE_THRESHOLD_PCT = -3.0;
export const PULLBACK_OVERSHOT_THRESHOLD_PCT = -7.0;

// QUALITY MARGIN OF SAFETY: the single Z-Score line for every Quality asset,
// app-wide. At or below it, a fundamentally sound Quality asset is a Buy
// Signal: the Ambush Radar's Value Zone and the Portfolio's Quality alert.
// Both apply it through isQualityBuySignal (@/utils/quality-signal) to the
// same backend values (GET /api/quality/{ticker}), so they can't disagree.
export const QUALITY_MARGIN_OF_SAFETY_ZSCORE = -1.0;

// QUALITY FUNDAMENTAL GATE: the minimum ROIC (percent) for a Quality asset
// to count at all. Below it, a cheap Z-Score is a value trap, not a signal.
export const QUALITY_MIN_ROIC_PCT = 15;
