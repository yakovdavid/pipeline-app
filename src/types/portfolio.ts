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
  // for both Stock and ETF positions — see SATELLITE_STOCK_TS_PCT /
  // SATELLITE_ETF_TS_PCT in thresholds.ts). Null until the first live price
  // is fetched.
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
  // Add SMA Visuals to Portfolio: previously an Ambush-Radar-only pair
  // (StockQuote already carried them; PortfolioStock didn't). Live/
  // ephemeral like every other fetched field above, never persisted — see
  // MomentumBar (shared by both screens) and TrendBadges in index.tsx.
  sma50: number | null;
  sma200: number | null;
  // TREND CLASSIFICATION: two independent backend-computed signals — see
  // StockQuote's own field comments for the full rationale. Replaces the
  // single trend indicator this screen never actually had before (Ambush
  // Radar was the only screen with a Bullish/Bearish badge); now both
  // screens show both indicators identically.
  macroTrend: TrendLabel;
  tacticalMomentum: TrendLabel;
};
