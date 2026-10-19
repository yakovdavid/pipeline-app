import type { AssetType } from '@/types/asset';
import { getEffectiveUnits, isTaseTicker } from '@/utils/currency';
import { usdPerLocalFromQuote } from '@/utils/trade-execution';

// GAP 3: EXPLICIT FX CONVERSION FOR ISRAELI ASSETS.
//
// Every Israeli-quoted position (any ".TA" ticker, which includes the
// 7-digit mutual funds, or anything the API quotes in ₪) is valued in USD
// as localPrice / USD-ILS, with the live rate from GET /api/fx/usd-ils,
// instead of the API's pre-converted `price`. That `price` is rounded to
// cents by the backend, which for a sub-$5 fund unit is a distortion of
// its own (₪3.08 at 3.10 is $0.9935, delivered as $1.00, 0.65% too high on
// the whole position).
//
// AGOROT vs SHEKELS: the API's `local_price` is ALREADY in Shekels. The
// backend divides every ".TA" quote from Agorot by 100 before sending it
// (see _resolve_currency_converters in backend/main.py; e.g. TEVA.TA
// 12,820 Agorot arrives as local_price 128.2). So the only step here is
// Shekels / rate. Dividing by 100 again would undervalue the position
// 100x. (The Agorot convention survives only in the Execute Trade price
// field, where the user types the broker's Agorot quote; see
// @/utils/trade-execution.)
//
// Without a valid rate (not fetched yet, or the fetch failed), the API's
// own USD price is used: it was converted with the same backend rate,
// just rounded to cents.

export const ILS_CURRENCY_SYMBOL = '₪';

// Plausible shekels per dollar; mirrors backend/fx.py's sanity bounds.
const MIN_PLAUSIBLE_USD_ILS = 1;
const MAX_PLAUSIBLE_USD_ILS = 10;

type PricedPosition = {
  ticker: string;
  currencySymbol: string;
  // USD, as converted by the API.
  price: number;
  // The instrument's own currency; Shekels for Israeli instruments.
  localPrice: number;
};

export function isIlsQuoted(ticker: string, currencySymbol: string): boolean {
  return currencySymbol === ILS_CURRENCY_SYMBOL || isTaseTicker(ticker);
}

export function isValidUsdIlsRate(rate: number | null | undefined): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= MIN_PLAUSIBLE_USD_ILS && rate <= MAX_PLAUSIBLE_USD_ILS;
}

// One unit's USD value: localPrice (Shekels) / rate for Israeli
// positions, the API's USD price for everything else.
export function usdUnitPrice(position: PricedPosition, usdIlsRate: number | null): number {
  if (isIlsQuoted(position.ticker, position.currencySymbol) && isValidUsdIlsRate(usdIlsRate)) {
    return position.localPrice / usdIlsRate;
  }
  return position.price;
}

// A position's total USD value: effective units (TASE ETF Nominal Value
// ÷100, see getEffectiveUnits) × the unit price above. The ONLY function
// portfolio totals, layer weights and exports may use.
export function positionUsdValue(
  position: PricedPosition & { assetType: AssetType; units: number },
  usdIlsRate: number | null,
): number {
  return getEffectiveUnits(position.ticker, position.assetType, position.units) * usdUnitPrice(position, usdIlsRate);
}

// USD per one unit of local currency for pricing a trade: 1 / live rate
// for an Israeli instrument (the same rate its valuation uses), otherwise
// the ratio inferred from the quote (exactly 1 for a USD instrument).
export function usdPerLocalForTrade(
  ticker: string,
  currencySymbol: string,
  quoteUsdPrice: number,
  quoteLocalPrice: number,
  usdIlsRate: number | null,
): number | null {
  if (isIlsQuoted(ticker, currencySymbol) && isValidUsdIlsRate(usdIlsRate)) {
    return 1 / usdIlsRate;
  }
  return usdPerLocalFromQuote(quoteUsdPrice, quoteLocalPrice);
}

// LEGACY ENTRY DATA: converts a price typed the way the broker shows it
// (Agorot for ".TA", otherwise the instrument's currency, i.e. dollars) to
// USD on the same basis as a position's live price, and back for display.
// A USD instrument converts 1:1 even while its live price is unavailable;
// an Israeli one needs the live rate (or, without it, the quote's own
// ratio), and returns null when neither exists.
const AGOROT_PER_SHEKEL = 100;

function usdPerLocalForEntry(position: PricedPosition, usdIlsRate: number | null): number | null {
  if (!isIlsQuoted(position.ticker, position.currencySymbol)) {
    return 1;
  }
  return usdPerLocalForTrade(position.ticker, position.currencySymbol, position.price, position.localPrice, usdIlsRate);
}

export function brokerQuoteToUsd(value: number, position: PricedPosition, usdIlsRate: number | null): number | null {
  const usdPerLocal = usdPerLocalForEntry(position, usdIlsRate);
  if (usdPerLocal === null) {
    return null;
  }
  const localValue = isTaseTicker(position.ticker) ? value / AGOROT_PER_SHEKEL : value;
  return localValue * usdPerLocal;
}

// The inverse, in the instrument's local currency (Shekels for Israeli
// instruments), ready for formatUnitPrice.
export function usdToLocalPrice(usdValue: number, position: PricedPosition, usdIlsRate: number | null): number | null {
  const usdPerLocal = usdPerLocalForEntry(position, usdIlsRate);
  return usdPerLocal === null || usdPerLocal <= 0 ? null : usdValue / usdPerLocal;
}
