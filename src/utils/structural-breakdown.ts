import type { TrendLabel } from '@/types/asset';
import type { PortfolioCategory } from '@/types/portfolio';
import { classifyPullbackZone } from '@/utils/ambush-zone';

// GAP 4: STRUCTURAL BREAKDOWN vs. TECHNICAL PULLBACK.
//
// A technical pullback is a dip inside an intact uptrend: Macro Trend still
// Bullish and the pullback shallower than the crash limit. It is a normal
// part of holding a position.
//
// A Structural Breakdown is the trend itself failing, and requires
// liquidation. It applies (to Satellite positions only, see
// isStructuralBreakdownLayer below) when EITHER holds:
//   - macroTrend === 'Bearish' (price below its SMA200), or
//   - pullbackDepth <= -7.00% (the crash limit, PULLBACK_OVERSHOT_THRESHOLD_PCT).
// The crash test reuses classifyPullbackZone (the same function behind the
// Ambush Radar's "Overshot" badge and its crash rule), which compares on
// the 2-decimal value shown on screen, so a displayed "-7.00%" always
// counts and the two screens can never disagree about a crash.
//
// Missing data never triggers it: a null Macro Trend or pullback depth
// (too little price history, or a failed fetch) is "unknown", not a
// breakdown. This differs on purpose from the radar's Invalidated zone,
// which treats unknown as disqualifying for a NEW entry: telling the user
// to sell a position they hold requires positive evidence.

// SCOPE: Satellite ONLY. Core is an index-tracking long-term hold: by
// design it rides through SMA200 crosses and deep pullbacks, so a
// liquidation directive on it would contradict the Fortress model. Quality
// has its own Fundamental Audit Kill Switch instead. Kept here, next to the
// rule, so no caller can apply it to another layer by accident.
export function isStructuralBreakdownLayer(category: PortfolioCategory): boolean {
  return category === 'Satellite';
}

export type StructuralSignals = {
  macroTrend: TrendLabel | null;
  pullbackDepth: number | null;
};

export function isStructuralBreakdown({ macroTrend, pullbackDepth }: StructuralSignals): boolean {
  if (macroTrend === 'Bearish') {
    return true;
  }
  return pullbackDepth !== null && classifyPullbackZone(pullbackDepth) === 'overshot';
}
