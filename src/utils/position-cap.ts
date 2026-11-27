// SINGLE-STOCK CAP (approved 2026-11-27, backlog P9). Pure (no app
// imports), so it runs under `node --test`.
//
// A single stock may be at most 5% of the portfolio denominator, the same
// denominator as the layer weights: invested value + cash (a negative cash
// balance counts as 0; see computeAllocation in @/utils/allocation).
// ETFs and index/mutual funds are exempt. Above the cap is a PURCHASE LOCK
// only ("CAP LOCK"): adds are blocked, nothing is ever sold.
//
// Two checks use it:
//   - CAP LOCK (radar card, Portfolio row, the start of any buy): the
//     position is already at or above 5%, so there is no room for any add.
//   - Execute Trade: the weight the position would have AFTER this buy must
//     not exceed 5%. Exactly 5.00% is allowed.

export const SINGLE_STOCK_CAP_PCT = 5;

// 7-digit TASE paper numbers are Israeli mutual funds (see
// isIsraeliMutualFundTicker in @/utils/currency).
const MUTUAL_FUND_TICKER = /^\d{7}\.TA$/i;

export function isCapApplicable(assetType: 'Stock' | 'ETF', ticker: string): boolean {
  return assetType === 'Stock' && !MUTUAL_FUND_TICKER.test(ticker.trim());
}

export function positionWeightPct(positionValueUsd: number, denominatorUsd: number): number {
  return denominatorUsd > 0 ? (positionValueUsd / denominatorUsd) * 100 : 0;
}

export function isAtOrAboveCap(weightPct: number): boolean {
  return weightPct >= SINGLE_STOCK_CAP_PCT;
}

// The position's weight right after a buy. Cash moves into the position,
// so the denominator only shrinks by the fee.
export function weightAfterBuyPct(
  heldValueUsd: number,
  grossBuyUsd: number,
  feeUsd: number,
  denominatorUsd: number,
): number {
  return positionWeightPct(heldValueUsd + grossBuyUsd, denominatorUsd - feeUsd);
}

export function exceedsCapAfterBuy(weightAfterPct: number): boolean {
  return weightAfterPct > SINGLE_STOCK_CAP_PCT;
}
