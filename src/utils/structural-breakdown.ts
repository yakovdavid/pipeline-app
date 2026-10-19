import type { TrendLabel } from '@/types/asset';
import type { PortfolioCategory } from '@/types/portfolio';

// The depth that turns a pullback into a Structural Breakdown for a HELD
// position: -11.50%, just inside the 12% stop-loss that actually executes,
// so the banner warns shortly before the stop fires rather than on every
// ordinary dip. Deliberately NOT the Ambush Radar's -7.00% crash limit
// (PULLBACK_OVERSHOT_THRESHOLD_PCT): that one decides whether to ENTER a
// position, and stays unchanged.
export const STRUCTURAL_BREAKDOWN_DEPTH_PCT = -11.5;

// GAP 4: STRUCTURAL BREAKDOWN vs. TECHNICAL PULLBACK.
//
// A technical pullback is a dip inside an intact uptrend: Macro Trend still
// Bullish and the pullback shallower than -11.50%. It is a normal part of
// holding a position.
//
// A Structural Breakdown is the trend itself failing, and requires
// liquidation. It applies (to Satellite positions only, see
// isStructuralBreakdownLayer below) when EITHER holds:
//   - macroTrend === 'Bearish' (price below its SMA200), or
//   - pullbackDepth <= -11.50% (STRUCTURAL_BREAKDOWN_DEPTH_PCT).
// The depth is compared on the 2-decimal value shown on screen (the
// backend already rounds pullback_depth to 2 decimals), so a displayed
// "-11.50%" always counts and "-11.49%" never does.
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
  if (pullbackDepth === null) {
    return false;
  }
  const displayedDepth = Math.round(pullbackDepth * 100) / 100;
  return displayedDepth <= STRUCTURAL_BREAKDOWN_DEPTH_PCT;
}
