import { createUnavailableQuote, type StockQuote } from '@/services/api';
import type { PortfolioStock, PortfolioTickerEntry } from '@/types/portfolio';
import { calibrateQuote, DEFAULT_CALIBRATION_FACTOR } from '@/utils/calibration';
import { resolveWatermark } from '@/utils/watermark';

// The "Highest Watermark" (highest price seen since a position was added)
// that drives the Satellite trailing-stop trigger price is tracked in the
// instrument's LOCAL currency (see @/utils/watermark) for every position
// regardless of category/assetType; Core/Quality positions simply never
// use it for a trailing-stop calculation.

// DATA-LOSS FIX: the one place a Portfolio row is built from a stored entry
// plus its fetch result, shared by load, backup restore, and refresh in
// PortfolioScreen (app/(tabs)/index.tsx). It always returns a row, so no
// caller can drop a ticker whose fetch failed:
//   - quote !== null: the quote is calibrated with this position's factor
//     (see @/utils/calibration) and the watermark advances if the price is
//     a new high.
//   - quote === null (the fetch failed): every persisted field (units,
//     watermark, calibration, internal target) is kept exactly as
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
  // P2: the peak advances in local currency (a USD/ILS move alone can't
  // set one) and its USD view is re-derived at this quote's rate. A legacy
  // USD-only entry is migrated here, once.
  const watermark = resolveWatermark(entry, calibratedQuote);
  return {
    ...entry,
    ...calibratedQuote,
    highestWatermarkLocal: watermark.local,
    highestWatermark: watermark.usd,
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
    highestWatermarkLocal: stock.highestWatermarkLocal,
    highestWatermark: stock.highestWatermark,
    // AUTO-CALIBRATION FOR BROKEN PRICES: dropping this would silently
    // un-calibrate a position the next time the app restarts.
    calibrationFactor: stock.calibrationFactor,
    // CORE INTERNAL ALLOCATION: user-entered, so it must survive every
    // save.
    internalTargetPct: stock.internalTargetPct,
    // TRADE RECONCILIATION: the recorded execution cost.
    costBasisUsd: stock.costBasisUsd,
    // PROTECTION STATE: the entry anchors of the stop-loss.
    purchasePrice: stock.purchasePrice,
    historicalHWM: stock.historicalHWM,
    // P8: user-entered from IBI, so it must survive every save.
    avgCostLocal: stock.avgCostLocal,
  };
}
