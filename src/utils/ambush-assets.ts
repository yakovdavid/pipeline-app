import { createUnavailableQuote, fetchQualityMetrics, fetchStockData, type QualityMetrics } from '@/services/api';
import type { AmbushAsset, AmbushTickerEntry, QualityAmbushAsset, SatelliteAmbushAsset } from '@/types/ambush';
import { getMoatRating, type MoatRatings } from '@/utils/moat-store';
import { isAtOrAboveCap, isCapApplicable } from '@/utils/position-cap';
import type { PositionWeights } from '@/utils/position-weights-store';

// UNIFIED RADAR data layer: turns a saved watchlist entry into a radar row,
// using the data source its layer calls for:
//   Satellite -> GET /api/stock (live Yahoo quote: Macro Trend, Pullback Depth)
//   Quality   -> GET /api/quality (Z-Score, ROIC, P/E, CapEx: the same
//                source the Portfolio's Quality alert reads) plus the
//                user's manual moat (@/utils/moat-store)
// Shared by the Ambush screen (load, add, refresh) and the Portfolio screen
// (liquidation handover, "Copy All Data" export) so both build identical rows.

export function buildSatelliteAmbushAsset(
  entry: AmbushTickerEntry,
  quote: Awaited<ReturnType<typeof fetchStockData>> | null,
): SatelliteAmbushAsset {
  return {
    ticker: entry.ticker,
    assetType: entry.assetType,
    ...(quote ?? createUnavailableQuote()),
    layer: 'Satellite',
  };
}

// metrics === null means the fetch failed: the row stays on the radar as
// 'unavailable' (never dropped, so the saved watchlist can't shrink), with
// placeholder numbers QualityAmbushCard doesn't display. A response with no
// current price at all is treated the same way.
export function buildQualityAmbushAsset(entry: AmbushTickerEntry, metrics: QualityMetrics | null): QualityAmbushAsset {
  if (metrics === null || metrics.currentPrice === null) {
    return {
      layer: 'Quality',
      ticker: entry.ticker,
      assetType: entry.assetType,
      price: 0,
      localPrice: 0,
      currencySymbol: '$',
      roic: null,
      moat: getMoatRating(entry.ticker),
      zScore: null,
      peTtm: null,
      pe5yAvg: null,
      capexToRevenue3y: null,
      capexToOcf3y: null,
      priceStatus: 'unavailable',
    };
  }
  return {
    layer: 'Quality',
    ticker: entry.ticker,
    assetType: entry.assetType,
    price: metrics.currentPrice,
    localPrice: metrics.currentPrice,
    currencySymbol: '$',
    roic: metrics.roic,
    moat: getMoatRating(entry.ticker),
    zScore: metrics.zScore,
    peTtm: metrics.peTtm,
    pe5yAvg: metrics.pe5yAvg,
    capexToRevenue3y: metrics.capexToRevenue3y,
    capexToOcf3y: metrics.capexToOcf3y,
    priceStatus: 'live',
  };
}

// The placeholder row for an entry whose fetch failed, in its own layer.
export function buildUnavailableAmbushAsset(entry: AmbushTickerEntry): AmbushAsset {
  return entry.layer === 'Quality' ? buildQualityAmbushAsset(entry, null) : buildSatelliteAmbushAsset(entry, null);
}

// Never rejects: a failed fetch becomes an 'unavailable' row.
export async function fetchAmbushAsset(entry: AmbushTickerEntry): Promise<AmbushAsset> {
  if (entry.layer === 'Quality') {
    const metrics = await fetchQualityMetrics(entry.ticker).catch(() => null);
    return buildQualityAmbushAsset(entry, metrics);
  }
  const quote = await fetchStockData(entry.ticker).catch(() => null);
  return buildSatelliteAmbushAsset(entry, quote);
}

// Refreshes an existing row. Unlike fetchAmbushAsset, a failure returns
// null so the caller can keep the row's last good data instead of
// replacing it with a placeholder.
export async function refreshAmbushAsset(asset: AmbushAsset): Promise<AmbushAsset | null> {
  const entry: AmbushTickerEntry = { ticker: asset.ticker, assetType: asset.assetType, layer: asset.layer };
  if (entry.layer === 'Quality') {
    const metrics = await fetchQualityMetrics(entry.ticker).catch(() => null);
    return metrics === null || metrics.currentPrice === null ? null : buildQualityAmbushAsset(entry, metrics);
  }
  const quote = await fetchStockData(entry.ticker).catch(() => null);
  return quote === null ? null : buildSatelliteAmbushAsset(entry, quote);
}

// P9 CAP LOCK: a held single stock already at or above the 5% cap. False
// for ETFs/funds, tickers not held, and while the weights are unknown.
export function isCapLocked(asset: Pick<AmbushAsset, 'ticker' | 'assetType'>, weights: PositionWeights | null): boolean {
  if (weights === null || !isCapApplicable(asset.assetType, asset.ticker)) {
    return false;
  }
  return isAtOrAboveCap(weights[asset.ticker.trim().toUpperCase()] ?? 0);
}

// MANUAL MOAT + P9: re-applies the current moat ratings and cap state to a
// row, so a moat edit or a weight change re-groups the radar at once.
// Returns the same object when nothing changed, so memo()'d cards don't
// re-render.
export function withPortfolioContext(
  asset: AmbushAsset,
  ratings: MoatRatings,
  weights: PositionWeights | null,
): AmbushAsset {
  if (asset.layer !== 'Quality') {
    return asset;
  }
  const moat = getMoatRating(asset.ticker, ratings);
  const withinPositionCap =
    weights === null || !isCapApplicable(asset.assetType, asset.ticker) ? null : !isCapLocked(asset, weights);
  return moat === asset.moat && withinPositionCap === (asset.withinPositionCap ?? null)
    ? asset
    : { ...asset, moat, withinPositionCap };
}

export function toAmbushTickerEntry(asset: AmbushAsset): AmbushTickerEntry {
  return { ticker: asset.ticker, assetType: asset.assetType, layer: asset.layer };
}
