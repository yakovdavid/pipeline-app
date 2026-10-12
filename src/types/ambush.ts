import type { Stock } from '@/components/StockCard';
import type { AssetType } from '@/types/asset';

// What gets persisted to AsyncStorage for each watched ticker. Every saved
// entry is a Satellite (technical) asset: quotes are re-fetched live and
// judged on Macro Trend / Pullback Depth.
export type AmbushTickerEntry = {
  ticker: string;
  assetType: AssetType;
};

// UNIFIED RADAR: which playbook an Ambush asset is judged by.
//   Satellite: technical (Macro Trend + Pullback Depth).
//   Quality:   fundamental (ROIC + moat) plus a statistical trigger (Z-Score).
export type AmbushLayer = 'Satellite' | 'Quality';

export type QualityMoat = 'Wide' | 'Narrow' | 'None';

// A Satellite row is the existing live Ambush row (the StockCard `Stock`,
// including macroTrend and pullbackDepth) tagged with its layer.
export type SatelliteAmbushAsset = Stock & {
  layer: 'Satellite';
};

// A Quality row carries its fundamentals instead of technical fields.
export type QualityAmbushAsset = {
  layer: 'Quality';
  ticker: string;
  // USD-normalized price, plus the local-currency value and symbol to
  // display it with: the same three fields StockCard uses.
  price: number;
  localPrice: number;
  currencySymbol: string;
  // Return on Invested Capital, as a percentage (28 means 28%).
  roic: number;
  moat: QualityMoat;
  zScore: number;
  // True for development-only demo rows (see @/constants/ambush-demo-data).
  // QualityAmbushCard labels these "DEMO" so their figures are never
  // mistaken for real data.
  isDemo: boolean;
};

// Discriminated on `layer`: checking `asset.layer` narrows to the right
// shape, which is how the radar decides which card to render.
export type AmbushAsset = SatelliteAmbushAsset | QualityAmbushAsset;
