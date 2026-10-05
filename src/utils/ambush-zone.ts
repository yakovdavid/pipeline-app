import {
  PULLBACK_KILL_ZONE_THRESHOLD_PCT,
  PULLBACK_OVERSHOT_THRESHOLD_PCT,
  PULLBACK_PREMIUM_THRESHOLD_PCT,
} from '@/constants/thresholds';
import type { TrendLabel } from '@/types/asset';

// Raw-math read of pullback_depth alone, before the Macro Override is applied.
export type PullbackZone = 'premium' | 'watch' | 'killZone' | 'overshot';

// What the Pullback Depth badge actually shows: the raw zone when Macro Trend
// is Bullish, or 'invalidated' when it isn't (Bearish, or no SMA200 history).
export type AmbushSignalState = PullbackZone | 'invalidated';

export interface AmbushSignal {
  // Null when there's no SMA50 history to compute pullback_depth from.
  pullbackDepth: number | null;
  rawZone: PullbackZone | null;
  state: AmbushSignalState | null;
}

// Classified on the 2-decimal value the UI displays (backend/main.py already
// rounds pullback_depth to 2dp), so a printed "-7.00%" can never be labelled
// Overshot or a printed "-3.00%" labelled Watch by sub-cent float noise.
//   > 0%              Premium
//   0% .. -2.99%      Watch
//   -3.00% .. -7.00%  Kill Zone (both ends inclusive)
//   < -7.00%          Overshot (a crash, not an entry)
export function classifyPullbackZone(pullbackDepth: number): PullbackZone {
  const depth = Math.round(pullbackDepth * 100) / 100;
  if (depth > PULLBACK_PREMIUM_THRESHOLD_PCT) return 'premium';
  if (depth > PULLBACK_KILL_ZONE_THRESHOLD_PCT) return 'watch';
  if (depth >= PULLBACK_OVERSHOT_THRESHOLD_PCT) return 'killZone';
  return 'overshot';
}

// MACRO OVERRIDE: an ambush setup is only valid inside a long-term uptrend
// (price > SMA200). Anything other than a confirmed Bullish macro trend —
// Bearish, or null for insufficient SMA200 history — neutralizes the zone
// entirely, whatever the raw pullback math says.
export function resolveAmbushSignal(macroTrend: TrendLabel, pullbackDepth: number | null): AmbushSignal {
  if (pullbackDepth === null) {
    return { pullbackDepth: null, rawZone: null, state: null };
  }
  const rawZone = classifyPullbackZone(pullbackDepth);
  return {
    pullbackDepth,
    rawZone,
    state: macroTrend === 'Bullish' ? rawZone : 'invalidated',
  };
}
