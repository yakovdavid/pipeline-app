import type { Stock } from '@/components/StockCard';
import type { PriceStatus } from '@/services/api';
import type { AssetType } from '@/types/asset';

// UNIFIED RADAR: which playbook an Ambush asset is judged by.
//   Satellite: technical (Macro Trend + Pullback Depth), live Yahoo quote.
//   Quality:   fundamental (ROIC + moat) plus a statistical trigger
//              (Z-Score), from GET /api/quality/{ticker}.
export type AmbushLayer = 'Satellite' | 'Quality';

// What gets persisted to AsyncStorage for each watched ticker. `layer`
// decides which data source is fetched on load. Entries saved before
// layers existed have no `layer` and load as Satellite (see
// normalizeAmbushEntries in @/utils/ambush-storage).
export type AmbushTickerEntry = {
  ticker: string;
  assetType: AssetType;
  layer: AmbushLayer;
};

export type QualityMoat = 'Wide' | 'Narrow' | 'None';

// A Satellite row is the live Ambush row (the StockCard `Stock`, including
// macroTrend and pullbackDepth) tagged with its layer.
export type SatelliteAmbushAsset = Stock & {
  layer: 'Satellite';
};

// A Quality row, populated from GET /api/quality/{ticker}.
export type QualityAmbushAsset = {
  layer: 'Quality';
  ticker: string;
  // Persisted alongside the ticker (see AmbushTickerEntry).
  assetType: AssetType;
  // The latest daily close the backend's Z-Score was computed from, in the
  // listing currency (USD for the US symbols FMP's free tier covers).
  // localPrice/currencySymbol mirror StockCard's display fields.
  price: number;
  localPrice: number;
  currencySymbol: string;
  // Most recent year's ROIC as a percent (28 = 28%). Null when the company
  // has no financial statements on file (e.g. an ETF).
  roic: number | null;
  // Null only while unavailable (the fetch failed).
  moat: QualityMoat | null;
  // 2-year Z-Score. Null when there wasn't enough price data to compute one.
  zScore: number | null;
  // 'unavailable' when the fetch failed. The row stays on the radar (so the
  // saved watchlist never shrinks) and every number above is a placeholder.
  priceStatus: PriceStatus;
};

// Discriminated on `layer`: checking `asset.layer` narrows to the right
// shape, which is how the radar decides which card to render.
export type AmbushAsset = SatelliteAmbushAsset | QualityAmbushAsset;
