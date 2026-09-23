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
  // QUALITY Z-SCORE MODULE: this position's fundamental Return on
  // Invested Capital, entered manually (Yahoo/yfinance doesn't expose
  // this) — one half of the backend's Z-Score alert gate (see
  // backend/main.py's QUALITY_ZSCORE_MIN_ROIC). Null until the user
  // enters one; relevant for Quality-category positions only, but tracked
  // regardless of category (harmless, same reasoning as
  // highestWatermark above) in case a position is later recategorized.
  roic: number | null;
  // CORE LAYER INTERNAL ALLOCATION: an optional, user-defined target for
  // this asset's own share WITHIN its layer (e.g. "AAPL should be 40% of
  // Core"), entered manually — there's no fixed model for sub-asset
  // targets the way CATEGORY_TARGET_PCT fixes the Core/Satellite/Quality
  // split at the layer level (src/constants/labels.ts), so this is null
  // ("no internal target set") until the user defines one. Primarily
  // surfaced for Core positions today (see PortfolioStockRow's
  // "Internal Allocation" line), but tracked regardless of category, same
  // reasoning as roic/highestWatermark above.
  internalTargetPct: number | null;
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
  // PULLBACK DEPTH CALCULATION: ((price - sma50) / sma50) * 100 from the
  // backend (see backend/main.py) — live/ephemeral like drawdownPct,
  // never persisted. Category-independent (computed for every asset), but
  // only actually rendered for Satellite today (see
  // src/components/TrendBadges.tsx, shared with Ambush Radar's StockCard —
  // PortfolioStockRow itself still follows the Fortress 2.0 Indicator
  // Purge and shows nothing SMA-derived outside Satellite).
  pullbackDepth: number | null;
  // QUALITY Z-SCORE MODULE: backend-computed (see backend/main.py's
  // _calculate_quality_zscore), null for every non-Quality asset or
  // whenever there isn't enough price history. Live/ephemeral, never
  // persisted, same as drawdownPct.
  qualityZScore: number | null;
  // Whether the backend's roic >= 15% AND Quality-layer-weight <= 10% gate
  // (see backend/main.py's QUALITY_ZSCORE_* constants) was satisfied for
  // THIS specific request — never re-derived client-side; PortfolioStockRow
  // additionally hardcodes a `stock.category === 'Quality'` check before
  // ever showing this, so a stale/mis-set value from a future bug can't
  // surface an alert on the wrong layer.
  qualityZScoreAlert: boolean;
};
