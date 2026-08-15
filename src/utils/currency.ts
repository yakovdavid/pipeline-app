import { AGOROT_SUFFIX } from '@/constants/labels';
import type { Language } from '@/contexts/language-context';

const AGOROT_PER_SHEKEL = 100;
const TASE_TICKER_SUFFIX = '.TA';

// Mirrors backend/main.py's own TASE ticker check (TASE_TICKER_SUFFIX /
// _resolve_currency_converters): ANY ticker ending in ".TA" is unit-priced
// in Agorot by Israeli banking convention, regardless of what currency the
// backend's Multi-Currency engine reports for it.
export function isTaseTicker(ticker: string): boolean {
  return ticker.trim().toUpperCase().endsWith(TASE_TICKER_SUFFIX);
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
export function formatUnitPrice(
  ticker: string,
  localValue: number,
  currencySymbol: string,
  language: Language,
): string {
  if (isTaseTicker(ticker)) {
    const agorot = Math.round(localValue * AGOROT_PER_SHEKEL);
    return `${agorot} ${AGOROT_SUFFIX[language]}`;
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
