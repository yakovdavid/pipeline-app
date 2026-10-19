import type { PortfolioCategory } from '@/types/portfolio';

// The depth that turns a pullback into a Structural Breakdown for a HELD
// position: -11.50%, just inside the 12% stop-loss that actually executes,
// so the banner warns shortly before the stop fires rather than on every
// ordinary dip. Deliberately NOT the Ambush Radar's -7.00% crash limit
// (PULLBACK_OVERSHOT_THRESHOLD_PCT): that one decides whether to ENTER a
// position, and stays unchanged.
export const STRUCTURAL_BREAKDOWN_DEPTH_PCT = -11.5;

// GAP 4: STRUCTURAL BREAKDOWN vs. TECHNICAL PULLBACK, for positions already
// held.
//
// A Structural Breakdown requires liquidation. It applies (to Satellite
// positions only, see isStructuralBreakdownLayer below) when, and only
// when, pullbackDepth <= -11.50% (STRUCTURAL_BREAKDOWN_DEPTH_PCT).
// Anything shallower is a technical pullback, a normal part of holding a
// position.
//
// Macro Trend plays no part here. A held position's downside is governed
// by its own stop-loss (see @/utils/protectionState); an SMA200 cross on
// its own isn't a reason to sell. (The Ambush Radar still requires a
// Bullish Macro Trend to ENTER a position; that rule is separate and
// unchanged.)
//
// The depth is compared on the 2-decimal value shown on screen (the
// backend already rounds pullback_depth to 2 decimals), so a displayed
// "-11.50%" always counts and "-11.49%" never does.
//
// Missing data never triggers it: a null pullback depth (too little price
// history, or a failed fetch) is "unknown", not a breakdown. Telling the
// user to sell a position they hold requires positive evidence.

// SCOPE: Satellite ONLY. Core is an index-tracking long-term hold: by
// design it rides through SMA200 crosses and deep pullbacks, so a
// liquidation directive on it would contradict the Fortress model. Quality
// has its own Fundamental Audit Kill Switch instead. Kept here, next to the
// rule, so no caller can apply it to another layer by accident.
export function isStructuralBreakdownLayer(category: PortfolioCategory): boolean {
  return category === 'Satellite';
}

export type StructuralSignals = {
  pullbackDepth: number | null;
};

export function isStructuralBreakdown({ pullbackDepth }: StructuralSignals): boolean {
  if (pullbackDepth === null) {
    return false;
  }
  const displayedDepth = Math.round(pullbackDepth * 100) / 100;
  return displayedDepth <= STRUCTURAL_BREAKDOWN_DEPTH_PCT;
}
