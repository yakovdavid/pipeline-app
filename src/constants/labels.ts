import type { TFunction } from '@/contexts/language-context';
import type { AssetType } from '@/types/asset';
import type { PortfolioCategory } from '@/types/portfolio';

// ROBUST LANGUAGE CONTEXT: the actual Hebrew/English copy lives in ONE
// dictionary (TRANSLATIONS in @/contexts/language-context), not scattered
// per-concern maps. These two helpers just bridge this app's internal,
// always-English data-model values ('Stock'/'ETF', 'Core'/'Satellite'/
// 'Quality' — persisted AsyncStorage entries, backend query params, the
// Satellite Trailing Stop / Quality drawdown-review bifurcation logic) to
// the matching translation key, so call sites never hardcode a label
// string themselves.
export function assetTypeLabel(t: TFunction, assetType: AssetType): string {
  return assetType === 'ETF' ? t('etf') : t('stock');
}

export function categoryLabel(t: TFunction, category: PortfolioCategory): string {
  switch (category) {
    case 'Satellite':
      return t('satellite');
    case 'Quality':
      return t('quality');
    case 'Core':
    default:
      return t('core');
  }
}

// The Fortress 2.0 Model's DEFAULT allocation targets (Core/Satellite/
// Quality = 70/20/10): only the starting value of the user's own targets
// (DYNAMIC LAYER TARGETS, @/utils/target-allocation-store). Never compare
// a layer against this directly; read the store instead.
export const CATEGORY_TARGET_PCT: Record<PortfolioCategory, number> = {
  Core: 70,
  Satellite: 20,
  Quality: 10,
};

// RTL MIXED TEXT RENDERING FIX: the "<units> <at-word> <price>" row (see
// PortfolioStockRow in app/(tabs)/index.tsx) is built from separate <Text>
// nodes instead of one interpolated string — a number-first Hebrew string
// like "1436 יח' ב-₪39.85" confuses the bidi text engine and renders
// reversed. This just supplies the "<units> <units-word>" half of that row
// as its own piece so the caller can place it in its own <Text> node.
export function formatUnitsLabel(t: TFunction, units: number): string {
  return `${units} ${t('units')}`;
}
