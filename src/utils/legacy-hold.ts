// LEGACY HOLD (approved 2026-11-27, backlog P10). Pure (no app imports),
// so it runs under `node --test`.
//
// A closed list of holdings kept from before the Hyper-Quality template.
// They are judged by legacy rules instead of the template's entry rules
// and FUNDAMENTAL DEGRADATION:
//   - No adds: every buy is blocked.
//   - HOLD while ROIC TTM >= 8% AND Moat != None.
//   - LEGACY EXIT (a badge, never an automatic sell) when ROIC TTM < 8%,
//     Moat = None, or the last FUNDAMENTAL AUDIT was marked "thesis broken".
// An unknown ROIC never triggers an exit: missing data is shown as missing.

export const LEGACY_TICKERS: readonly string[] = ['DE', 'ECL'];
export const LEGACY_MIN_ROIC_PCT = 8;

export function isLegacyTicker(ticker: string): boolean {
  return LEGACY_TICKERS.includes(ticker.trim().toUpperCase());
}

export type LegacyExitReason = 'roicBelowFloor' | 'moatNone' | 'thesisBroken';

export type LegacyReading = {
  roic: number | null;
  moat: 'Wide' | 'Narrow' | 'None' | 'Unrated';
  lastAuditOutcome: 'intact' | 'broken' | null;
};

export function legacyExitReasons({ roic, moat, lastAuditOutcome }: LegacyReading): LegacyExitReason[] {
  const reasons: LegacyExitReason[] = [];
  if (roic !== null && roic < LEGACY_MIN_ROIC_PCT) {
    reasons.push('roicBelowFloor');
  }
  if (moat === 'None') {
    reasons.push('moatNone');
  }
  if (lastAuditOutcome === 'broken') {
    reasons.push('thesisBroken');
  }
  return reasons;
}
