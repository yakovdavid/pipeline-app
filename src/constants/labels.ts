import type { AssetType } from '@/types/asset';
import type { PortfolioCategory } from '@/types/portfolio';

// Hebrew display labels for internal English data-model values. The
// underlying values ('Stock'/'ETF', 'Core'/'Satellite'/'Quality') stay in
// English everywhere else this app touches them — persisted AsyncStorage
// entries, backend query params (?asset_type=ETF), the Satellite Trailing
// Stop / Quality drawdown-review bifurcation logic — only the on-screen
// text swaps to Hebrew, via these maps, at render time.
export const ASSET_TYPE_LABEL_HE: Record<AssetType, string> = {
  Stock: 'מניה',
  ETF: 'תעודת סל',
};

export const CATEGORY_LABEL_HE: Record<PortfolioCategory, string> = {
  Core: 'ליבה',
  Satellite: 'לוויינים',
  Quality: 'איכות',
};

// The Fortress 2.0 Model's fixed allocation targets (Core/Satellite/
// Quality = 70/20/10) — used both for the "Add Asset" category picker and
// the Portfolio SectionList headers' "יעד: X%" (target) figure.
export const CATEGORY_TARGET_PCT: Record<PortfolioCategory, number> = {
  Core: 70,
  Satellite: 20,
  Quality: 10,
};
