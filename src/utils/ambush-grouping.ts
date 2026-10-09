import type { TrendLabel } from '@/types/asset';
import { classifyPullbackZone } from '@/utils/ambush-zone';

// The three Ambush Radar list sections, in display order.
export type AmbushGroupKey = 'bullish' | 'bearish' | 'insufficient';

export const AMBUSH_GROUP_ORDER: readonly AmbushGroupKey[] = ['bullish', 'bearish', 'insufficient'];

// The minimal shape grouping needs. Structural rather than importing the
// StockCard `Stock` type, so this module stays independent of any component.
export interface AmbushGroupable {
  macroTrend: TrendLabel;
  sma200: number | null;
  pullbackDepth: number | null;
}

export type AmbushGroups<T extends AmbushGroupable> = Record<AmbushGroupKey, T[]>;

// Which section an asset belongs to. "Insufficient Data" means no SMA200:
// the backend's macro_trend is null exactly when SMA200 is, but both are
// checked so neither field alone can misfile an asset into Bullish/Bearish.
export function getAmbushGroupKey(asset: AmbushGroupable): AmbushGroupKey {
  if (asset.sma200 === null || asset.macroTrend === null) {
    return 'insufficient';
  }
  return asset.macroTrend === 'Bullish' ? 'bullish' : 'bearish';
}

// Bullish ordering: ascending pullback depth, so the deepest valid pullbacks
// (Kill Zone, -3.00% to -7.00%) come first, then Watch, then Premium. One
// exception: Overshot assets (below -7.00%) go after all of those. They are
// "a crash, not an entry" (see ambush-zone.ts), and a plain ascending sort
// would otherwise put them ABOVE the Kill Zone. Assets with no pullback depth
// at all (no SMA50 history) go last.
function compareBullish(a: AmbushGroupable, b: AmbushGroupable): number {
  if (a.pullbackDepth === null || b.pullbackDepth === null) {
    if (a.pullbackDepth === b.pullbackDepth) return 0;
    return a.pullbackDepth === null ? 1 : -1;
  }
  const aOvershot = classifyPullbackZone(a.pullbackDepth) === 'overshot';
  const bOvershot = classifyPullbackZone(b.pullbackDepth) === 'overshot';
  if (aOvershot !== bOvershot) {
    return aOvershot ? 1 : -1;
  }
  return a.pullbackDepth - b.pullbackDepth;
}

// Splits assets into the three sections. Bullish is sorted (see
// compareBullish); Bearish and Insufficient Data keep the user's watchlist
// order. Array.prototype.sort is stable, so equal depths keep watchlist
// order too. Returns new arrays and never mutates the input.
export function groupAmbushAssets<T extends AmbushGroupable>(assets: readonly T[]): AmbushGroups<T> {
  const groups: AmbushGroups<T> = { bullish: [], bearish: [], insufficient: [] };
  for (const asset of assets) {
    groups[getAmbushGroupKey(asset)].push(asset);
  }
  groups.bullish.sort(compareBullish);
  return groups;
}
