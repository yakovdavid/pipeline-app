// FUNDAMENTAL AUDIT LATCH (P5 2026-11-27, P12 and P13 2026-11-28). Pure (no
// app imports), so it runs under `node --test`; persistence lives in
// @/utils/audit-latch-store.
//
// A held Quality position gets FUNDAMENTAL AUDIT REQUIRED on any of:
//   drawdown  its DAILY CLOSE is 15% or more below its peak since entry
//             (P12, see @/utils/quality-peak). Never the live price.
//   step      (P13-A) after an audit marked "thesis intact", a daily close
//             at or below the step level set then: 0.85 × the close on the
//             day it was marked. Repeats with every "intact" mark.
//   earnings  (P13-B) the 3rd completed trading session after a quarterly
//             report (so FMP's TTM figures have been updated), whatever the
//             price.
// Once triggered it stays latched until the user marks it "Audited": a
// price recovery never clears it. AUDIT is a review prompt only and never
// generates a sell.
//
// Marking it "Audited" records an outcome:
//   intact  sets the next step level (P13-A).
//   broken  no step; for a Legacy holding it's a LEGACY EXIT trigger (P10).
// After "Audited", a daily close back above the -15% line re-arms the latch
// and cancels any step: the next breach is a new audit. (One audit covers
// one drawdown episode; a deeper fall after an "intact" mark is caught by
// the step.)
//
// The first report seen for a holding only sets a baseline (no audit): the
// entry analysis, or the holding's existing state, already covers it.

export const AUDIT_DRAWDOWN_TRIGGER_PCT = -15;
// P13-A: the next step is this fraction of the close at an "intact" mark.
export const AUDIT_STEP_FACTOR = 0.85;

export type AuditLatchStatus = 'armed' | 'triggered' | 'audited';

export type AuditTriggerReason = 'drawdown' | 'step' | 'earnings';

// P10: what the user concluded when marking the audit done. Kept until the
// next audit.
export type AuditOutcome = 'intact' | 'broken';

// P12: which drawdown reference the latch was evaluated against. Latches
// saved under the old 52-week-high reference (no marker) are discarded on
// load, so a holding that "triggered" at purchase starts armed again.
export const AUDIT_LATCH_BASIS = 'peakSinceEntry';

export type AuditLatch = {
  basis: typeof AUDIT_LATCH_BASIS;
  status: AuditLatchStatus;
  lastOutcome: AuditOutcome | null;
  // Why the current/last audit fired, and the close that fired it.
  triggerReason: AuditTriggerReason | null;
  triggerCloseDate: string | null;
  triggerDrawdownPct: number | null;
  // ISO timestamp of the last "Audited" mark.
  auditedAt: string | null;
  // P13-A: the close (normalized local currency) at or below which the
  // next audit fires after an "intact" mark. Null when no step is active.
  nextAuditLevel: number | null;
  // P13-B: the latest report date already covered (audited, or the
  // baseline set on first sight). Null until the first report is seen;
  // '' when the first report seen was still inside its 3 sessions, so that
  // report's audit still fires when due.
  earningsCoveredDate: string | null;
};

export const ARMED_LATCH: AuditLatch = {
  basis: AUDIT_LATCH_BASIS,
  status: 'armed',
  lastOutcome: null,
  triggerReason: null,
  triggerCloseDate: null,
  triggerDrawdownPct: null,
  auditedAt: null,
  nextAuditLevel: null,
  earningsCoveredDate: null,
};

export type DailyCloseReading = {
  // Percent, negative below the peak since entry.
  closeDrawdownPct: number | null;
  // YYYY-MM-DD of the close it was computed from.
  closeDate: string | null;
  // P13-A: that close, normalized local currency.
  closeLocal?: number | null;
  // P13-B: the latest report out, and the close date of the 3rd session
  // after it (null until 3 sessions have closed).
  lastEarningsDate?: string | null;
  earningsAuditDueDate?: string | null;
};

export function isAuditBreach(closeDrawdownPct: number): boolean {
  return closeDrawdownPct <= AUDIT_DRAWDOWN_TRIGGER_PCT;
}

function trigger(current: AuditLatch, reason: AuditTriggerReason, reading: DailyCloseReading): AuditLatch {
  return {
    ...current,
    status: 'triggered',
    triggerReason: reason,
    triggerCloseDate: reading.closeDate,
    triggerDrawdownPct: reading.closeDrawdownPct,
  };
}

// P13-B: the earnings part of a reading. Returns the latch with the report
// marked covered, and whether it calls for an audit.
function applyEarnings(current: AuditLatch, reading: DailyCloseReading): { latch: AuditLatch; isDue: boolean } {
  const report = reading.lastEarningsDate ?? null;
  if (report === null || report === current.earningsCoveredDate) {
    return { latch: current, isDue: false };
  }
  if (current.earningsCoveredDate === null) {
    // First report seen: a settled report is a baseline only; one still
    // inside its 3 sessions is left to fire when due.
    const isSettled = reading.earningsAuditDueDate !== null && reading.earningsAuditDueDate !== undefined;
    return { latch: { ...current, earningsCoveredDate: isSettled ? report : '' }, isDue: false };
  }
  if (reading.earningsAuditDueDate === null || reading.earningsAuditDueDate === undefined) {
    // A newer report is out, but 3 sessions haven't closed yet.
    return { latch: current, isDue: false };
  }
  return { latch: { ...current, earningsCoveredDate: report }, isDue: true };
}

// The next latch state for one daily-close reading. Unknown values never
// change anything they would decide.
export function nextAuditLatch(current: AuditLatch, reading: DailyCloseReading): AuditLatch {
  const { closeDrawdownPct } = reading;
  const closeLocal = reading.closeLocal ?? null;
  const earnings = applyEarnings(current, reading);
  const latch = earnings.latch;

  switch (latch.status) {
    case 'triggered':
      // Latched: never auto-cleared. A report during a pending audit is
      // covered by that audit.
      return latch;
    case 'armed':
      if (closeDrawdownPct !== null && isAuditBreach(closeDrawdownPct)) {
        return trigger(latch, 'drawdown', reading);
      }
      if (earnings.isDue) {
        return trigger(latch, 'earnings', reading);
      }
      return latch;
    case 'audited':
      if (closeDrawdownPct !== null && !isAuditBreach(closeDrawdownPct)) {
        // Back above the -15% line: re-armed, any step cancelled. A due
        // report still calls for its own audit.
        const rearmed: AuditLatch = { ...latch, status: 'armed', nextAuditLevel: null };
        return earnings.isDue ? trigger(rearmed, 'earnings', reading) : rearmed;
      }
      if (latch.nextAuditLevel !== null && closeLocal !== null && closeLocal <= latch.nextAuditLevel) {
        return trigger({ ...latch, nextAuditLevel: null }, 'step', reading);
      }
      if (earnings.isDue) {
        return trigger(latch, 'earnings', reading);
      }
      return latch;
    default:
      return current;
  }
}

// `closeLocal`: the latest completed close at the time of marking, which
// sets the P13-A step for an "intact" outcome.
export function markAudited(
  current: AuditLatch,
  now: Date,
  outcome: AuditOutcome,
  closeLocal: number | null,
): AuditLatch {
  if (current.status !== 'triggered') {
    return current;
  }
  return {
    ...current,
    status: 'audited',
    auditedAt: now.toISOString(),
    lastOutcome: outcome,
    nextAuditLevel: outcome === 'intact' && closeLocal !== null && closeLocal > 0 ? closeLocal * AUDIT_STEP_FACTOR : null,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseAuditLatch(raw: unknown): AuditLatch | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (value.status !== 'armed' && value.status !== 'triggered' && value.status !== 'audited') {
    return null;
  }
  if (value.basis !== AUDIT_LATCH_BASIS) {
    return null;
  }
  return {
    basis: AUDIT_LATCH_BASIS,
    status: value.status,
    lastOutcome: value.lastOutcome === 'intact' || value.lastOutcome === 'broken' ? value.lastOutcome : null,
    triggerReason:
      value.triggerReason === 'drawdown' || value.triggerReason === 'step' || value.triggerReason === 'earnings'
        ? value.triggerReason
        : null,
    triggerCloseDate: stringOrNull(value.triggerCloseDate),
    triggerDrawdownPct: numberOrNull(value.triggerDrawdownPct),
    auditedAt: stringOrNull(value.auditedAt),
    nextAuditLevel: numberOrNull(value.nextAuditLevel),
    earningsCoveredDate: stringOrNull(value.earningsCoveredDate),
  };
}
