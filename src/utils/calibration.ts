// AUTO-CALIBRATION FOR BROKEN PRICES: for a handful of TASE funds (observed
// live: HRL-F95.TA) Yahoo Finance returns a raw index value instead of a
// real per-unit price — no fixed conversion (Agorot/100, currency) rescues
// this, since it isn't a currency-unit mismatch, it's Yahoo's own data being
// wrong for that specific instrument. The only reliable correction is a
// user-supplied real-world reference point: "here's what my bank statement
// says this position is actually worth," from which a single per-position
// scale factor is derived and applied to every price-like field fetched for
// it going forward — see calibrateQuote below — so nobody has to do this
// math by hand every time the price refreshes.
export const DEFAULT_CALIBRATION_FACTOR = 1.0;

// Computes the calibration factor from a user-entered real-world total
// position value (e.g. "what my bank statement shows"), given the units
// held and the RAW (uncalibrated) local-currency unit price fetched from
// the API. Returns DEFAULT_CALIBRATION_FACTOR (a no-op multiplier) whenever
// there's nothing usable to calibrate from — the field was left blank, or
// any of the inputs can't produce a meaningful ratio — so a bad/blank entry
// degrades to "no correction" rather than corrupting the position with
// NaN/Infinity.
export function computeCalibrationFactor(
  userEnteredTotalValue: number | null,
  units: number,
  rawLocalPrice: number,
): number {
  if (userEnteredTotalValue === null || !Number.isFinite(userEnteredTotalValue) || userEnteredTotalValue <= 0) {
    return DEFAULT_CALIBRATION_FACTOR;
  }
  if (!Number.isFinite(units) || units <= 0 || !Number.isFinite(rawLocalPrice) || rawLocalPrice <= 0) {
    return DEFAULT_CALIBRATION_FACTOR;
  }
  return userEnteredTotalValue / (units * rawLocalPrice);
}

export function applyCalibration(rawValue: number, calibrationFactor: number): number {
  return rawValue * calibrationFactor;
}

// The inverse of applyCalibration: recovers the RAW (uncalibrated) value
// this app already corrected once (see calibrateQuote), given the factor
// that was applied. Used when the user wants to RE-calibrate an existing
// position (Edit Asset's "Total Value in Bank" field) from a fresh
// reference value, without needing a second live fetch — we already have
// the calibrated figure on screen, so we just divide the old correction
// back out before computing a new one.
export function stripCalibration(calibratedValue: number, calibrationFactor: number): number {
  if (!Number.isFinite(calibrationFactor) || calibrationFactor === 0) {
    return calibratedValue;
  }
  return calibratedValue / calibrationFactor;
}

// Applies a calibration factor uniformly to every price-like field on a
// freshly-fetched StockQuote (price, localPrice, high52, sma50, sma200 —
// now including the moving averages, since PortfolioStock carries them
// too as of the Portfolio SMA visual/trend-badge feature; previously only
// StockQuote's Ambush-Radar-only fields did). This is the SAME "one linear
// scalar applied to every price-like field" pattern the backend's TASE
// Agorot conversion and this app's deriveLocalValue already use (see
// @/utils/currency) — correcting the current price by X correctly corrects
// its 52-week high AND its SMA50/SMA200 by X too, since all of them are
// drawn from the same (equally distorted) Yahoo data for that instrument.
//
// drawdownPct, macroTrend, and tacticalMomentum are deliberately NOT
// touched: drawdownPct is a ratio between price and high52, and scaling
// both of those by the same factor leaves their ratio unchanged.
// macroTrend/tacticalMomentum are just the backend's price-vs-SMA
// comparison result (see backend/main.py's _classify_trend) — a ratio
// comparison, so it's equally unaffected by scaling both sides by the same
// positive factor; the label stays correct without recomputing it. Both
// simply pass through unchanged via the spread.
export function calibrateQuote<
  Q extends {
    price: number;
    localPrice: number;
    high52: number | null;
    sma50: number | null;
    sma200: number | null;
  },
>(quote: Q, calibrationFactor: number): Q {
  if (calibrationFactor === DEFAULT_CALIBRATION_FACTOR) {
    return quote;
  }
  return {
    ...quote,
    price: applyCalibration(quote.price, calibrationFactor),
    localPrice: applyCalibration(quote.localPrice, calibrationFactor),
    high52: quote.high52 !== null ? applyCalibration(quote.high52, calibrationFactor) : null,
    sma50: quote.sma50 !== null ? applyCalibration(quote.sma50, calibrationFactor) : null,
    sma200: quote.sma200 !== null ? applyCalibration(quote.sma200, calibrationFactor) : null,
  };
}
