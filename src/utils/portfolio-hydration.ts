import { createUnavailableQuote, type StockQuote } from '@/services/api';
import type { PortfolioStock, PortfolioTickerEntry } from '@/types/portfolio';
import { calibrateQuote, DEFAULT_CALIBRATION_FACTOR } from '@/utils/calibration';

// Tracks the "Highest Watermark" (highest price seen since a position was
// added) that drives the Satellite trailing-stop trigger price. Tracked for
// every position regardless of category/assetType; Core/Quality positions
// simply never use it for a trailing-stop calculation.
export function computeHighestWatermark(previousWatermark: number | null, latestPrice: number): number | null {
  return previousWatermark === null ? latestPrice : Math.max(previousWatermark, latestPrice);
}

// DATA-LOSS FIX: the one place a Portfolio row is built from a stored entry
// plus its fetch result, shared by load, backup restore, and refresh in
// PortfolioScreen (app/(tabs)/index.tsx). It always returns a row, so no
// caller can drop a ticker whose fetch failed:
//   - quote !== null: the quote is calibrated with this position's factor
//     (see @/utils/calibration) and the watermark advances if the price is
//     a new high.
//   - quote === null (the fetch failed): every persisted field (units,
//     watermark, calibration, roic, internal target) is kept exactly as
//     stored, and the price fields become createUnavailableQuote's
//     placeholders with priceStatus 'unavailable'. The watermark is NOT fed
//     the placeholder price, so a failed fetch can never touch it.
// `entry` may be an existing PortfolioStock (on refresh). Its old price
// fields are spread first and then fully overwritten by the quote's.
export function buildPortfolioStock(entry: PortfolioTickerEntry, quote: StockQuote | null): PortfolioStock {
  if (quote === null) {
    return { ...entry, ...createUnavailableQuote() };
  }
  const calibratedQuote = calibrateQuote(quote, entry.calibrationFactor ?? DEFAULT_CALIBRATION_FACTOR);
  return {
    ...entry,
    ...calibratedQuote,
    highestWatermark: computeHighestWatermark(entry.highestWatermark, calibratedQuote.price),
  };
}

// The exact subset of a row that is persisted to AsyncStorage. Price fields
// are always re-fetched live and never stored. Every field listed here must
// round-trip unchanged for a row built by buildPortfolioStock(entry, null),
// which is what guarantees a failed fetch saves back exactly what was read.
export function toPortfolioTickerEntry(stock: PortfolioStock): PortfolioTickerEntry {
  return {
    ticker: stock.ticker,
    category: stock.category,
    assetType: stock.assetType,
    units: stock.units,
    highestWatermark: stock.highestWatermark,
    // AUTO-CALIBRATION FOR BROKEN PRICES: dropping this would silently
    // un-calibrate a position the next time the app restarts.
    calibrationFactor: stock.calibrationFactor,
    // QUALITY Z-SCORE MODULE / CORE INTERNAL ALLOCATION: user-entered,
    // so they must survive every save.
    roic: stock.roic,
    internalTargetPct: stock.internalTargetPct,
  };
}
