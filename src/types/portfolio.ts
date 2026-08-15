import type { AssetType } from '@/types/asset';

export type PortfolioCategory = 'Core' | 'Satellite' | 'Quality';

// What actually gets persisted to AsyncStorage: symbol, allocation bucket,
// asset type, position size, and the trailing-stop watermark. Price is
// always re-fetched live, never stored stale.
export type PortfolioTickerEntry = {
  ticker: string;
  category: PortfolioCategory;
  assetType: AssetType;
  units: number;
  // Highest price observed for this position since it was added, tracked
  // for every asset type (drives the Satellite trailing-stop trigger price
  // for both Stock and ETF positions — see SATELLITE_STOCK_TS_PCT /
  // SATELLITE_ETF_TS_PCT in thresholds.ts). Null until the first live price
  // is fetched.
  highestWatermark: number | null;
};

export type PortfolioStock = PortfolioTickerEntry & {
  // Multi-Currency engine: normalized to USD by the backend. This is the
  // ONLY field portfolio-total/layer-allocation math may use — mixing in
  // localPrice (a Shekel value for TASE positions) would silently corrupt
  // every sum it touches.
  price: number;
  // The instrument's own actual local-currency value and the symbol to
  // display it with ('$' or '₪') — display-only, live/ephemeral like price
  // itself, never persisted.
  localPrice: number;
  currencySymbol: string;
  // Anomaly News Fetcher output: live/ephemeral, re-fetched every time —
  // never persisted, since a stale anomaly note from a prior day would be
  // actively misleading.
  anomalyReport: string | null;
  // 52-week high / drawdown from the backend: also live/ephemeral, never
  // persisted, for the same reason.
  high52: number | null;
  drawdownPct: number | null;
};
