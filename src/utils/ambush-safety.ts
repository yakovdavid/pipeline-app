import { AMBUSH_MIN_STOP_MARGIN_PCT } from '@/constants/thresholds';
import type { TrendLabel } from '@/types/asset';
import type { PriceStatus } from '@/services/api';
import { classifyPullbackZone } from '@/utils/ambush-zone';
import { PROTECTION_TRAILING_STOP_PCT, resolveHistoricalHWM } from '@/utils/protectionState';

// AMBUSH SAFETY CROSS-CHECK: a Satellite in the Kill Zone (3%-7% below its
// SMA50) is still rejected when the price sits too close to the structural
// stop it would get the moment it's bought. That stop is Recovery's
// historicalHWM × 0.88 (see the fixed requirement in @/utils/protectionState),
// and historicalHWM is resolved exactly as Execute Trade pre-fills it: the
// 52-week high, or the live price when there is none (resolveHistoricalHWM).
// So the radar judges a candidate on the same stop the position would start
// with.
//
// The margin is the drop, as a percent of the CURRENT price, that would hit
// the stop: (price - stop) / price × 100. It's rounded to 2 decimals before
// the comparison, like pullback depth (see classifyPullbackZone), so a
// displayed "2.00%" can't fail on float noise. A price at or below the
// stop (more than 12% under the 52-week high) has a margin of zero or less,
// and fails: it would be liquidated on entry.

export type AmbushSafetyInput = {
  // USD-normalized, the same basis as high52.
  price: number;
  high52: number | null;
  macroTrend: TrendLabel;
  pullbackDepth: number | null;
  priceStatus: PriceStatus;
};

export type StructuralMargin = {
  // The stop the position would get on entry (USD).
  stopPrice: number;
  // Percent drop from the current price to that stop, 2 decimals.
  marginPct: number;
};

// Null when there's no usable price to measure from.
export function computeStructuralMargin(price: number, high52: number | null): StructuralMargin | null {
  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }
  const stopPrice = resolveHistoricalHWM(high52, price) * (1 - PROTECTION_TRAILING_STOP_PCT);
  const marginPct = Math.round(((price - stopPrice) / price) * 100 * 100) / 100;
  return { stopPrice, marginPct };
}

export function isTooCloseToStructuralStop(margin: StructuralMargin): boolean {
  return margin.marginPct < AMBUSH_MIN_STOP_MARGIN_PCT;
}

// A "Failed Ambush": a confirmed Kill Zone setup (Bullish macro trend,
// pullback depth in the Kill Zone, live price) that fails the cross-check.
// Anything outside the Kill Zone isn't an entry in the first place, so it
// is never reported as a failed one.
export function isFailedAmbush(asset: AmbushSafetyInput): boolean {
  if (asset.priceStatus === 'unavailable' || asset.macroTrend !== 'Bullish' || asset.pullbackDepth === null) {
    return false;
  }
  if (classifyPullbackZone(asset.pullbackDepth) !== 'killZone') {
    return false;
  }
  const margin = computeStructuralMargin(asset.price, asset.high52);
  // No usable price: can't measure a margin, so it can't be an entry.
  return margin === null || isTooCloseToStructuralStop(margin);
}
