import type { AssetType } from '@/types/asset';
import type { Language } from '@/contexts/language-context';
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

// --- Dynamic Language Toggle translations --------------------------------
// Deliberately scoped: this app's UI text is Hebrew-first and stays that
// way regardless of the language toggle EXCEPT for the specific pieces
// listed below (bottom tab titles, the Ambush Radar StockCard's moving-
// average labels, and the TASE Agorot suffix) — this is not a full i18n
// pass over every string in the app.

// Bottom Tabs (see app/(tabs)/_layout.tsx) — the only chrome that's always
// on screen regardless of which tab is active, so it's the most visible
// place a language switch needs to be reflected immediately.
export const TAB_LABEL: Record<Language, { portfolio: string; ambush: string }> = {
  he: { portfolio: 'תיק השקעות', ambush: 'מכ״ם מארבים' },
  en: { portfolio: 'Portfolio', ambush: 'Ambush Radar' },
};

// Moving-average labels for the Ambush Radar StockCard's momentum bar.
export const SMA_LABEL: Record<Language, { sma50: string; sma200: string }> = {
  he: { sma50: 'מ.נ 50', sma200: 'מ.נ 200' },
  en: { sma50: 'SMA50', sma200: 'SMA200' },
};

// TASE AGOROT DISPLAY: suffix appended to an Agorot-denominated unit price
// (e.g. "3985 אג'" / "3985 Ag.") — see formatUnitPrice in @/utils/currency.
export const AGOROT_SUFFIX: Record<Language, string> = {
  he: "אג'",
  en: 'Ag.',
};

// RTL MIXED TEXT RENDERING FIX: the "<units> <at-word> <price>" row (see
// PortfolioStockRow in app/(tabs)/index.tsx) is built from separate <Text>
// nodes instead of one interpolated string — a number-first Hebrew string
// like "1436 יח' ב-₪39.85" confuses the bidi text engine and renders
// reversed. Each language supplies its own word order/phrasing here rather
// than just swapping one embedded word into an otherwise-fixed template.
export function formatUnitsLabel(language: Language, units: number): string {
  if (language === 'he') {
    return `${units} יח'`;
  }
  return `${units} unit${units === 1 ? '' : 's'}`;
}

export const AT_PRICE_LABEL: Record<Language, string> = {
  he: 'ב-',
  en: '@',
};
