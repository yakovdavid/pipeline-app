import type { AssetType, TrendLabel } from '@/types/asset';

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
  // — a single hard 12% for Stocks and ETFs alike, see SATELLITE_TS_PCT in
  // thresholds.ts). Null until the first live price is fetched.
  highestWatermark: number | null;
  // AUTO-CALIBRATION FOR BROKEN PRICES: for a handful of funds (observed:
  // HRL-F95.TA) Yahoo Finance returns a raw index value instead of a real
  // per-unit price, so the price/units this app fetches don't line up with
  // what a user's own brokerage/bank statement shows. When set, every
  // price-like field fetched from the API for this position (price,
  // localPrice, high52 — see @/utils/calibration's calibrateQuote) is
  // multiplied by this factor before being used for display OR math — so
  // the rest of the app never has to know this correction exists.
  // Undefined/missing (older, pre-feature entries) and exactly 1.0 both
  // mean "no correction" — see DEFAULT_CALIBRATION_FACTOR.
  calibrationFactor?: number;
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
  // Live/ephemeral like every other fetched field above, never persisted.
  // "Fortress 2.0" Indicator Purge: sma50 is fetched (still returned by the
  // API for every asset — see StockQuote's own comment) but no longer
  // rendered anywhere in the Portfolio UI at all; sma200 is shown ONLY for
  // Satellite, as plain read-only macro-context text (no color coding) —
  // see PortfolioStockRow in index.tsx.
  sma50: number | null;
  sma200: number | null;
  // TREND CLASSIFICATION: two independent backend-computed signals — see
  // StockQuote's own field comments for the full rationale. Fetched/stored
  // for every position but, per the Indicator Purge, no longer rendered in
  // the Portfolio UI (macroTrend/tacticalMomentum badges were removed —
  // Ambush Radar's StockCard is the only screen that still shows them).
  macroTrend: TrendLabel;
  tacticalMomentum: TrendLabel;
};
