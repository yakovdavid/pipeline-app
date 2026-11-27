// HIGH WATER MARK, CANONICAL UNIT (2026-11-27, backlog P2). Pure (no app
// imports), so it runs under `node --test`.
//
// The tracked peak is stored in ONE unit: the instrument's local currency
// as the API's `local_price` delivers it. For a TASE (".TA") instrument
// that is normalized SHEKELS: the backend divides the raw Agorot quote by
// 100 exactly once (backend/main.py _resolve_currency_converters), and
// nothing in the app divides again. USD is derived from it only for
// display and for the USD stop math, using the CURRENT quote's rate.
//
// Why: the old watermark was stored in USD. For a Shekel instrument that
// mixes two moving quantities: a USD peak recorded at one USD/ILS rate is
// compared against a price converted at another, so a stronger shekel
// alone could "set" a peak the fund never reached in shekels, and a
// weaker one could hide a real peak.

export type WatermarkQuote = {
  // USD, from the API.
  price: number;
  // The instrument's own currency (Shekels for ".TA"), from the API.
  localPrice: number;
};

// USD per one unit of local currency, implied by the quote. Null when the
// quote can't define one (an 'unavailable' placeholder of 0/0).
export function usdPerLocal(quote: WatermarkQuote): number | null {
  if (!(quote.localPrice > 0) || !(quote.price > 0)) {
    return null;
  }
  return quote.price / quote.localPrice;
}

// The next local-currency peak: the higher of the stored peak and the new
// local price. The first observed price seeds it.
export function nextLocalWatermark(previousLocal: number | null, latestLocalPrice: number): number {
  return previousLocal === null ? latestLocalPrice : Math.max(previousLocal, latestLocalPrice);
}

// LEGACY MIGRATION: an entry saved before this change only has a USD peak.
// It is converted to local currency ONCE, at the first live quote, with
// that quote's rate. Returns null when there's nothing to convert or no
// usable rate (the entry then keeps waiting for a live quote).
export function legacyUsdWatermarkToLocal(legacyUsd: number | null, quote: WatermarkQuote): number | null {
  const rate = usdPerLocal(quote);
  if (legacyUsd === null || rate === null) {
    return null;
  }
  return legacyUsd / rate;
}

// USD view of the local peak, at the current quote's rate (display and
// USD stop math only; never stored as the source of truth).
export function localWatermarkToUsd(local: number | null, quote: WatermarkQuote): number | null {
  const rate = usdPerLocal(quote);
  if (local === null || rate === null) {
    return null;
  }
  return local * rate;
}

// Resolves the stored peak for one fresh quote, migrating a legacy USD-only
// entry on the way. Returns both units: `local` is what gets persisted.
export function resolveWatermark(
  stored: { highestWatermarkLocal: number | null; highestWatermark: number | null },
  quote: WatermarkQuote,
): { local: number; usd: number } {
  const previousLocal = stored.highestWatermarkLocal ?? legacyUsdWatermarkToLocal(stored.highestWatermark, quote);
  const local = nextLocalWatermark(previousLocal, quote.localPrice);
  return { local, usd: localWatermarkToUsd(local, quote) ?? quote.price };
}
