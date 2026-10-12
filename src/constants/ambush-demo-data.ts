import type { QualityAmbushAsset } from '@/types/ambush';

// DEVELOPMENT-ONLY demo Quality assets for exercising the unified radar UI
// before real Quality data feeds the Ambush Radar. The Ambush screen shows
// these only when __DEV__ is true, so release builds never show them.
// They're merged into the DISPLAYED list only, never into the persisted
// watchlist state, so they can't be written to a user's real watchlist.
// The figures are illustrative, not real fundamentals, and the card tags
// each row "DEMO".
//
// Expected placement (see classifyAmbushReadiness):
//   AAPL: ROIC 28 >= 15, Wide moat, Z-Score -1.5 <= -1.0  -> Value Zone
//   DE:   ROIC 12 < 15                                     -> Invalidated
export const DEMO_QUALITY_AMBUSH_ASSETS: readonly QualityAmbushAsset[] = [
  {
    layer: 'Quality',
    ticker: 'AAPL',
    price: 228.4,
    localPrice: 228.4,
    currencySymbol: '$',
    roic: 28,
    moat: 'Wide',
    zScore: -1.5,
    isDemo: true,
  },
  {
    layer: 'Quality',
    ticker: 'DE',
    price: 412.15,
    localPrice: 412.15,
    currencySymbol: '$',
    roic: 12,
    moat: 'Narrow',
    zScore: 0.5,
    isDemo: true,
  },
];
