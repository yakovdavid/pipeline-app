import type { AssetType } from '@/types/asset';

const AGOROT_PER_SHEKEL = 100;
const TASE_TICKER_SUFFIX = '.TA';
// TASE ETF MATH FIX (Nominal Value / Erech Nakuv): Israeli brokerages
// report TASE-listed ETF/mutual-fund HOLDINGS in Nominal Value units, where
// 100 nominal units = 1 real pricing unit — the same 100x relationship as
// the Agorot/Shekel unit-price split above, but on the QUANTITY side
// instead of the price side. See getEffectiveUnits below.
const NOMINAL_VALUE_UNITS_PER_PRICING_UNIT = 100;

// Mirrors backend/main.py's own TASE ticker check (TASE_TICKER_SUFFIX /
// _resolve_currency_converters): ANY ticker ending in ".TA" is unit-priced
// in Agorot by Israeli banking convention, regardless of what currency the
// backend's Multi-Currency engine reports for it.
export function isTaseTicker(ticker: string): boolean {
  return ticker.trim().toUpperCase().endsWith(TASE_TICKER_SUFFIX);
}

// TASE ETF MATH FIX: a held quantity of a TASE (".TA") ETF/mutual fund is
// reported in Nominal Value — e.g. "1433 units" held actually represents
// 1433 / 100 = 14.33 real pricing units of the fund. Ordinary TASE STOCKS
// don't carry this second 100x factor (only funds do — Nominal Value is a
// fund/bond-market convention, not an equity one), and non-TASE tickers
// don't either, so this only fires for the ".TA" + 'ETF' combination.
//
// Used ONLY for value math (position totals, layer/portfolio allocation
// sums) — the raw `units` the user actually entered/holds is still what's
// displayed in the quantity row itself; see PortfolioStockRow in index.tsx.
export function getEffectiveUnits(ticker: string, assetType: AssetType, units: number): number {
  if (assetType === 'ETF' && isTaseTicker(ticker)) {
    return units / NOMINAL_VALUE_UNITS_PER_PRICING_UNIT;
  }
  return units;
}

// Scales a USD-normalized price-like value (sma50/sma200/high52 — see the
// Multi-Currency engine's `price` field in StockQuote/PortfolioStock) onto
// the SAME local-currency basis as `referenceLocalPrice`, without needing
// its own FX rate or a separate backend round-trip.
//
// This is exact, not an approximation: the backend applies one identical
// linear, zero-intercept conversion (÷100 for Agorot, then ÷ the USD/ILS
// rate) to every price-like field for a given ticker — price, sma50,
// sma200, and high_52 alike (see _resolve_currency_converters). That means
// referenceLocalPrice / referenceUsdPrice is that exact same per-ticker
// scale factor for any other price-like field on the same ticker, so
// multiplying usdValue by it reproduces what the backend would have
// returned had it converted that field the same way it converted price.
export function deriveLocalValue(
  usdValue: number,
  referenceLocalPrice: number,
  referenceUsdPrice: number,
): number {
  if (!Number.isFinite(referenceUsdPrice) || referenceUsdPrice === 0) {
    return usdValue;
  }
  return usdValue * (referenceLocalPrice / referenceUsdPrice);
}

// TASE AGOROT UNIT-PRICE DISPLAY: Israeli banks quote TASE (".TA") unit
// prices in Agorot (1/100 of a Shekel, e.g. "3985 אג'"), not whole Shekels
// ("₪39.85") — even though the position's TOTAL value is still shown in
// whole Shekels (see formatTotalValue below). Applies identically to the
// current unit price, the 52-week high, and SMA50/SMA200 — anywhere a raw
// per-share/per-unit quote is shown for a ".TA" ticker. Non-".TA" tickers
// are shown normally, in their own reported currency.
//
// Takes the already-translated Agorot suffix (`t('ag')` at the call site)
// rather than a `language` value + its own lookup, so this stays a plain
// number-formatting utility with no dependency on the translation
// dictionary itself — the caller (which already has `t` in scope) owns
// translation, this only owns the Agorot math.
export function formatUnitPrice(
  ticker: string,
  localValue: number,
  currencySymbol: string,
  agorotSuffix: string,
): string {
  if (isTaseTicker(ticker)) {
    const agorot = Math.round(localValue * AGOROT_PER_SHEKEL);
    return `${agorot} ${agorotSuffix}`;
  }
  return `${currencySymbol}${localValue.toFixed(2)}`;
}

// TOTAL POSITION VALUE DISPLAY: always whole Shekels (or the instrument's
// own local currency) regardless of ticker — Israeli banking convention
// quotes Agorot per unit but Shekels for a position's total value, so this
// deliberately does NOT branch on isTaseTicker the way formatUnitPrice does.
export function formatTotalValue(totalLocalValue: number, currencySymbol: string): string {
  return `${currencySymbol}${totalLocalValue.toFixed(2)}`;
}
