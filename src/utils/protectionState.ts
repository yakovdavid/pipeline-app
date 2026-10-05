// "Protection State Tracker" (Satellite layer): translates the trailing-
// stop relationship between a position's current price and its Historical
// High Water Mark (HWM) into the exact order parameters a user must
// manually enter into their brokerage account — brokers don't universally
// support a true server-side trailing-stop order, so this is the bridge
// between "the app knows the position should be protected 12% off its
// peak" and "here's literally what to type into the order ticket."

// The trailing stop is a single, fixed 12% off the watermark — matches
// SATELLITE_TS_PCT in @/constants/thresholds (0.12) exactly; kept as its
// own literal here rather than importing that constant, since this
// module's contract is deliberately pinned to the exact value specified
// for the Protection State Tracker ("strictly 12% (0.12)"), independent of
// any future change to the Satellite layer's own general trailing-stop
// threshold.
export const PROTECTION_TRAILING_STOP_PCT = 0.12;

export type ProtectionOrderType = 'Stop Market' | 'Trailing Stop';
export type ProtectionStatusColor = 'orange' | 'green';

export interface ProtectionState {
  // 'Stop Market' (Condition A) or 'Trailing Stop' (Condition B) — which
  // order type the user needs to place with their broker.
  orderType: ProtectionOrderType;
  // Condition A: the exact USD stop price to enter (hwm * 0.88), as a
  // number. Condition B: the literal string "12%" — there's no fixed
  // price to enter at all, since a true broker-side Trailing Stop order
  // tracks price upward on its own; the type is deliberately `number |
  // string` to carry both shapes faithfully rather than forcing one into
  // the other.
  stopPriceTarget: number | string;
  // Condition A only: the price (equal to hwm) at which the user should
  // set a broker price alert, so they notice if/when the position
  // reclaims its watermark. Null in Condition B, where there's nothing to
  // alert on.
  alertTriggerPrice: number | null;
  // 'orange' (Condition A — manual setup required) or 'green' (Condition
  // B — automated tracking) — a UI hint only, not itself used in any
  // further calculation.
  statusColor: ProtectionStatusColor;
}

// Computes the Protection State for one Satellite position.
//
// Condition A - Recovery State (currentPrice < hwm): price has pulled back
// below its own watermark. A broker-side Trailing Stop can't safely be
// trusted here (most broker implementations re-arm/raise a trailing stop
// off the CURRENT price, which would ratchet the stop DOWN along with a
// falling price instead of leaving it frozen at the watermark's level) —
// so the user must place a static Stop Market order at hwm * 0.88 (12%
// off the watermark) themselves, and watch for price to reclaim the
// watermark (alertTriggerPrice) before it's safe to switch back to an
// automated trailing order.
//
// Condition B - Tracking State (currentPrice >= hwm): price is at or above
// its own watermark, so a standard broker-side Trailing Stop order (12%)
// can track it upward automatically — no manual price level to maintain,
// and nothing to alert on.
//
// Pure and deliberately unopinionated beyond exactly these two conditions:
// no input validation/clamping, no rounding — both are left to the
// caller/UI layer, since neither was part of the specified contract.
export function computeProtectionState(currentPrice: number, hwm: number): ProtectionState {
  if (currentPrice < hwm) {
    return {
      orderType: 'Stop Market',
      stopPriceTarget: hwm * (1 - PROTECTION_TRAILING_STOP_PCT),
      alertTriggerPrice: hwm,
      statusColor: 'orange',
    };
  }

  return {
    orderType: 'Trailing Stop',
    stopPriceTarget: `${PROTECTION_TRAILING_STOP_PCT * 100}%`,
    alertTriggerPrice: null,
    statusColor: 'green',
  };
}
