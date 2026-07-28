// Shared between the Ambush Radar watchlist and Portfolio positions: which
// trend rule and price logic apply depends on whether a ticker is a plain
// equity or a fund/ETF (see report-formatters.ts and the SMA50/SMA200
// branching logic in ambush.tsx).
export type AssetType = 'Stock' | 'ETF';
