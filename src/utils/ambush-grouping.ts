import type { AmbushAsset, QualityAmbushAsset, SatelliteAmbushAsset } from '@/types/ambush';
import { classifyPullbackZone } from '@/utils/ambush-zone';
import { isQualityBuySignal, passesQualityFundamentals } from '@/utils/quality-signal';

// UNIFIED RADAR: assets are grouped by operational readiness, not by layer,
// so Satellite and Quality assets in the same state share a section.
export type AmbushReadinessZone = 'valueZone' | 'watch' | 'invalidated';

// Display order of the radar's sections.
export const AMBUSH_READINESS_ORDER: readonly AmbushReadinessZone[] = ['valueZone', 'watch', 'invalidated'];

export type AmbushReadinessGroups = Record<AmbushReadinessZone, AmbushAsset[]>;

// Satellite (technical):
//   Invalidated: Macro Trend is not Bullish. Checked FIRST, so a Bearish
//     asset with a deep pullback is Invalidated, not Value Zone. This is the
//     app's Macro Override (see ambush-zone.ts): a pullback only counts
//     inside a long-term uptrend. A null Macro Trend (no SMA200 history, or
//     a failed price fetch) is treated like Bearish, as it is there.
//     A null pullback depth (no SMA50 history) can't be judged and is also
//     Invalidated.
//   Invalidated (CRASH RULE): pullback depth <= -7.00%. That is a crash,
//     not a pullback, even in an uptrend. Exactly -7.00% counts as a crash.
//   Value Zone: pullback depth from -3.00% down to -6.99%.
//   Watch:      pullback depth  > -3.00%.
// All boundaries come from classifyPullbackZone (ambush-zone.ts), the same
// function behind the card's Pullback Depth badge, so a row's section and
// its badge always agree: Value Zone rows read "Kill Zone", crash rows read
// "Overshot". It classifies on the 2-decimal value the card prints, so a
// displayed "-3.00%" or "-7.00%" can't land in the wrong zone because of
// float noise.
function classifySatellite(asset: SatelliteAmbushAsset): AmbushReadinessZone {
  if (asset.macroTrend !== 'Bullish' || asset.pullbackDepth === null) {
    return 'invalidated';
  }
  switch (classifyPullbackZone(asset.pullbackDepth)) {
    case 'killZone':
      return 'valueZone';
    case 'overshot':
      return 'invalidated';
    case 'premium':
    case 'watch':
    default:
      return 'watch';
  }
}

// Quality (fundamental + statistical), on live GET /api/quality data. The
// rules live in @/utils/quality-signal, shared with the Portfolio alert:
//   Invalidated: fails a fundamental gate (ROIC < 15%, no moat, or either
//     unknown), or the fetch failed.
//   Value Zone:  a Buy Signal: passes both gates and Z-Score <= -1.0. The
//     Portfolio raises its Quality alert on exactly the same condition.
//   Watch:       passes both gates, but Z-Score > -1.0 or no Z-Score yet
//                (too little price history).
function classifyQuality(asset: QualityAmbushAsset): AmbushReadinessZone {
  if (asset.priceStatus === 'unavailable' || !passesQualityFundamentals(asset)) {
    return 'invalidated';
  }
  return isQualityBuySignal(asset) ? 'valueZone' : 'watch';
}

export function classifyAmbushReadiness(asset: AmbushAsset): AmbushReadinessZone {
  return asset.layer === 'Quality' ? classifyQuality(asset) : classifySatellite(asset);
}

// Within Value Zone and Watch, the most stretched assets come first:
//   Satellites by ascending pullback depth (crashes never get here; the
//     crash rule sends them to Invalidated).
//   Quality by ascending Z-Score.
// Satellite rows are listed before Quality rows. Invalidated keeps
// watchlist order.
function compareSatellite(a: SatelliteAmbushAsset, b: SatelliteAmbushAsset): number {
  // Rows without a pullback depth are always Invalidated, so this guard
  // only narrows the type; it never decides an order in practice.
  if (a.pullbackDepth === null || b.pullbackDepth === null) {
    return 0;
  }
  return a.pullbackDepth - b.pullbackDepth;
}

function compareReadiness(a: AmbushAsset, b: AmbushAsset): number {
  if (a.layer !== b.layer) {
    return a.layer === 'Satellite' ? -1 : 1;
  }
  if (a.layer === 'Satellite' && b.layer === 'Satellite') {
    return compareSatellite(a, b);
  }
  if (a.layer === 'Quality' && b.layer === 'Quality') {
    // Rows without a Z-Score sort after those with one.
    if (a.zScore === null || b.zScore === null) {
      if (a.zScore === b.zScore) return 0;
      return a.zScore === null ? 1 : -1;
    }
    return a.zScore - b.zScore;
  }
  return 0;
}

// Splits the combined list into the three readiness zones. Returns new
// arrays and never mutates the input. Array.prototype.sort is stable, so
// ties keep watchlist order.
export function groupAmbushByReadiness(assets: readonly AmbushAsset[]): AmbushReadinessGroups {
  const groups: AmbushReadinessGroups = { valueZone: [], watch: [], invalidated: [] };
  for (const asset of assets) {
    groups[classifyAmbushReadiness(asset)].push(asset);
  }
  groups.valueZone.sort(compareReadiness);
  groups.watch.sort(compareReadiness);
  return groups;
}
