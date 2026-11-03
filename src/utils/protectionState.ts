// =========================================================================
// FIXED REQUIREMENT: DO NOT CHANGE WITHOUT THE PORTFOLIO OWNER'S EXPLICIT,
// WRITTEN SIGN-OFF. This applies to every contributor, human or AI.
//
// The Recovery State stop-loss is STRICTLY:
//
//     lockedStopPrice = historicalHWM * 0.88
//
// - It must NEVER be derived from purchasePrice (the entry price), from
//   activeHWM, or from any other tracked or dynamic peak.
// - purchasePrice is cost information only and plays no part in any stop.
// - This anchor was deliberately chosen after being reversed several times
//   (entry x 0.88 vs. HWM x 0.88). It is final.
//
// Why: historicalHWM is the objective structural peak (the verified 52-week
// high before the pullback, confirmed or corrected by the user in Execute
// Trade); the entry price is arbitrary timing. Ambush Radar buys are
// restricted to pullbacks shallower than 7% from that peak, so a position
// that later trades more than 12% below it has broken structurally. Its
// stop then sits ABOVE the current price and reads as triggered: immediate
// liquidation is the INTENDED safeguard, not a bug. Do not "fix" it.
// =========================================================================
//
// "Protection State Tracker" (Satellite layer), HWM-decoupled: decides
// where a position's stop-loss sits and which order the user must place
// with their broker, which doesn't universally support a true server-side
// trailing stop.
//
// The two stop rules (locked; do not change one without the other):
//
// RULE 1, Recovery State (Stop Market)
//   Condition: currentPrice < historicalHWM, and the position has not
//     broken out since historicalHWM was set (see the latch below).
//   Stop price: lockedStopPrice = historicalHWM × 0.88, exactly. The
//     historicalHWM is the objective structural peak (the verified 52-week
//     high before the pullback, confirmed or corrected by the user in
//     Execute Trade or Edit Entry Data); the entry price is arbitrary
//     timing and plays NO part in the stop, nor does any tracked peak. A
//     broker-side trailing stop would ratchet with the price, so a static
//     Stop Market order is required; a price alert at historicalHWM tells
//     the user when the breakout happens.
//   NOTE: a position trading more than 12% below its historicalHWM has this
//     stop ABOVE the current price, so it reads as already triggered
//     (stopPrice >= currentPrice). That is the rule working as specified.
//
// RULE 2, Automated Tracking (Trailing Stop)
//   Condition: permanently, once currentPrice >= historicalHWM; or from the
//     start when the position has no historicalHWM (nothing to recover
//     against, e.g. a legacy position not yet given one).
//   Stop price: activeHWM × 0.88, where activeHWM is the highest price the
//     app has tracked (the position's `highestWatermark`, never below the
//     current price). Every price before the breakout is below
//     historicalHWM, so after it this is exactly the highest price tracked
//     during Automated Tracking. At the crossing activeHWM equals
//     historicalHWM, so the trailing stop starts exactly where the locked
//     stop was: the hand-off never moves the stop.
//
// "Permanently" is implemented as a one-way latch on activeHWM, which
// never decreases: once it reaches historicalHWM the position stays in
// Rule 2 even if the price dips back below historicalHWM. Re-entering Rule
// 1 on such a dip would swap the trailing stop (activeHWM × 0.88) for the
// lower historicalHWM × 0.88, moving the stop DOWN. Changing a position's
// historicalHWM (Edit Entry Data, or a top-up that corrects it) restarts
// activeHWM, so a peak recorded against the old value can't trip the
// latch.

// The single 12% stop distance (matches SATELLITE_TS_PCT in
// @/constants/thresholds); both modes use it.
export const PROTECTION_TRAILING_STOP_PCT = 0.12;
const STOP_MULTIPLIER = 1 - PROTECTION_TRAILING_STOP_PCT; // 0.88

export type ProtectionMode = 'recovery' | 'tracking';
export type ProtectionOrderType = 'Stop Market' | 'Trailing Stop';
export type ProtectionStatusColor = 'orange' | 'green';

export type ProtectionInputs = {
  currentPrice: number;
  // Rule 1's threshold AND its only anchor (USD, live-price basis).
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
  historicalHWM,
  activeHWM,
}: ProtectionInputs): ProtectionState {
  // The watermark is updated on every refresh, but taking the max here too
  // means the breakout is recognized the moment the price on screen
  // reaches historicalHWM, even before the watermark itself is updated.
  const effectiveActiveHWM = Math.max(activeHWM ?? currentPrice, currentPrice);
  // Rule 1 needs a historicalHWM; without one, Rule 2 applies.
  const isRecoveryState = historicalHWM !== null && effectiveActiveHWM < historicalHWM;

  if (isRecoveryState) {
    // RULE 1: lockedStopPrice = historicalHWM × 0.88, exactly.
    const stopPrice = historicalHWM * STOP_MULTIPLIER;
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

  // RULE 2: activeHWM × 0.88.
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

// The SMART DEFAULT for a new position's historicalHWM (pre-filled in
// Execute Trade, where the user can correct it): the reported 52-week
// high, or, when none is available (undefined, zero, not finite), the
// execution-time price, so the position starts in Automated Tracking and
// trails at once.
export function resolveHistoricalHWM(fiftyTwoWeekHigh: number | null | undefined, currentPrice: number): number {
  return typeof fiftyTwoWeekHigh === 'number' && Number.isFinite(fiftyTwoWeekHigh) && fiftyTwoWeekHigh > 0
    ? fiftyTwoWeekHigh
    : currentPrice;
}
