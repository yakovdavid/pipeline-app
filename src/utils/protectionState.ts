// "Protection State Tracker" (Satellite layer), HWM-decoupled: decides
// where a position's stop-loss sits and which order the user must place
// with their broker, which doesn't universally support a true server-side
// trailing stop.
//
// Three different "high water marks" are involved, and keeping them apart
// is the point of this module:
//   historicalHWM: the 52-week high when the position was opened. The
//     level the price must reclaim before the stop may start trailing.
//   activeHWM: the highest price observed since the position was opened
//     (the position's `highestWatermark`). Every price observed before a
//     breakout is below historicalHWM, so once the price has broken out
//     this is exactly "the highest price observed since breaking out".
//   purchasePrice: the average executed price, the anchor of the locked
//     stop.
//
// Recovery State: the position has never reclaimed historicalHWM
//   (activeHWM < historicalHWM, which before any breakout is the same test
//   as currentPrice < historicalHWM). The stop is rigidly locked at
//   purchasePrice × 0.88 and does not trail; a broker-side trailing stop
//   would ratchet with the price, so a static Stop Market order is
//   required. A price alert at historicalHWM tells the user when the
//   breakout happens.
// Automated Tracking: the price has reclaimed historicalHWM at least once.
//   The stop trails at activeHWM × 0.88, and a broker-side 12% Trailing
//   Stop can track it.
//
// The breakout is deliberately one-way. Read literally,
// "currentPrice < historicalHWM" would send a position back to Recovery on
// any dip after a breakout, swapping the higher trailing stop for the
// lower purchase-price stop: the stop would move DOWN. Since activeHWM
// never decreases, testing it instead keeps the stop monotonic.
//
// Positions without a recorded entry (opened before trade logging) have no
// purchasePrice/historicalHWM and are in Automated Tracking off activeHWM,
// which is exactly how their stop worked before.

// The single 12% stop distance (matches SATELLITE_TS_PCT in
// @/constants/thresholds); both modes use it.
export const PROTECTION_TRAILING_STOP_PCT = 0.12;
const STOP_MULTIPLIER = 1 - PROTECTION_TRAILING_STOP_PCT; // 0.88

export type ProtectionMode = 'recovery' | 'tracking';
export type ProtectionOrderType = 'Stop Market' | 'Trailing Stop';
export type ProtectionStatusColor = 'orange' | 'green';

export type ProtectionInputs = {
  currentPrice: number;
  purchasePrice: number | null;
  historicalHWM: number | null;
  // The position's highestWatermark; null if no price was ever observed.
  activeHWM: number | null;
};

export interface ProtectionState {
  mode: ProtectionMode;
  isRecoveryState: boolean;
  // The USD price at which the position must be sold.
  stopPrice: number;
  // 'Stop Market' (Recovery) or 'Trailing Stop' (Automated Tracking): the
  // order type to place with the broker.
  orderType: ProtectionOrderType;
  // What to type into the order ticket: the fixed stop price (Recovery),
  // or the literal "12%" (a broker trailing stop has no fixed price).
  stopPriceTarget: number | string;
  // Recovery only: historicalHWM, where to set a broker price alert for
  // the breakout. Null in Automated Tracking.
  alertTriggerPrice: number | null;
  // The activeHWM actually used (never below the current price).
  activeHWM: number;
  statusColor: ProtectionStatusColor;
}

export function computeProtectionState({
  currentPrice,
  purchasePrice,
  historicalHWM,
  activeHWM,
}: ProtectionInputs): ProtectionState {
  // The watermark is updated on every refresh, but taking the max here too
  // means a stop is never computed off a peak below the price on screen.
  const effectiveActiveHWM = Math.max(activeHWM ?? currentPrice, currentPrice);
  const isRecoveryState = purchasePrice !== null && historicalHWM !== null && effectiveActiveHWM < historicalHWM;

  if (isRecoveryState) {
    const stopPrice = purchasePrice * STOP_MULTIPLIER;
    return {
      mode: 'recovery',
      isRecoveryState: true,
      stopPrice,
      orderType: 'Stop Market',
      stopPriceTarget: stopPrice,
      alertTriggerPrice: historicalHWM,
      activeHWM: effectiveActiveHWM,
      statusColor: 'orange',
    };
  }

  return {
    mode: 'tracking',
    isRecoveryState: false,
    stopPrice: effectiveActiveHWM * STOP_MULTIPLIER,
    orderType: 'Trailing Stop',
    stopPriceTarget: `${PROTECTION_TRAILING_STOP_PCT * 100}%`,
    alertTriggerPrice: null,
    activeHWM: effectiveActiveHWM,
    statusColor: 'green',
  };
}

// historicalHWM for a new position: the reported 52-week high, or, when
// none is available (undefined, zero, not finite), the execution-time
// price, so the position starts in Automated Tracking and trails at once.
export function resolveHistoricalHWM(fiftyTwoWeekHigh: number | null | undefined, currentPrice: number): number {
  return typeof fiftyTwoWeekHigh === 'number' && Number.isFinite(fiftyTwoWeekHigh) && fiftyTwoWeekHigh > 0
    ? fiftyTwoWeekHigh
    : currentPrice;
}
