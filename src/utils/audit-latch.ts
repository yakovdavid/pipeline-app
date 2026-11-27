// FUNDAMENTAL AUDIT LATCH (approved 2026-11-27, backlog P5). Pure (no app
// imports), so it runs under `node --test`; persistence lives in
// @/utils/audit-latch-store.
//
// Rule: a held Quality position triggers FUNDAMENTAL AUDIT REQUIRED when
// its DAILY CLOSE is 15% or more below its 52-week high (of daily closes).
// Never the live intraday price. Once triggered it stays latched until the
// user marks it "Audited": a price recovery never clears it. AUDIT is a
// review prompt only and never generates a sell.
//
// Marking it "Audited" records an outcome: thesis intact or thesis broken
// (P10; "broken" is a LEGACY EXIT trigger for a Legacy holding).
// After "Audited", the latch re-arms only once a daily close is back above
// the -15% line; the next breach after that triggers a new audit. (So one
// audit covers one drawdown episode, and a position that is still down
// does not re-alert every day.)

export const AUDIT_DRAWDOWN_TRIGGER_PCT = -15;

export type AuditLatchStatus = 'armed' | 'triggered' | 'audited';

// P10: what the user concluded when marking the audit done. "broken"
// triggers LEGACY EXIT for a Legacy holding. Kept until the next audit.
export type AuditOutcome = 'intact' | 'broken';

export type AuditLatch = {
  status: AuditLatchStatus;
  lastOutcome: AuditOutcome | null;
  // The close that triggered the current/last audit.
  triggerCloseDate: string | null;
  triggerDrawdownPct: number | null;
  // ISO timestamp of the last "Audited" mark.
  auditedAt: string | null;
};

export const ARMED_LATCH: AuditLatch = {
  status: 'armed',
  lastOutcome: null,
  triggerCloseDate: null,
  triggerDrawdownPct: null,
  auditedAt: null,
};

export type DailyCloseReading = {
  // Percent, negative below the 52-week high of daily closes.
  closeDrawdownPct: number | null;
  // YYYY-MM-DD of the close it was computed from.
  closeDate: string | null;
};

export function isAuditBreach(closeDrawdownPct: number): boolean {
  return closeDrawdownPct <= AUDIT_DRAWDOWN_TRIGGER_PCT;
}

// The next latch state for one daily-close reading. An unknown reading
// never changes anything.
export function nextAuditLatch(current: AuditLatch, reading: DailyCloseReading): AuditLatch {
  const { closeDrawdownPct, closeDate } = reading;
  if (closeDrawdownPct === null) {
    return current;
  }
  const breach = isAuditBreach(closeDrawdownPct);
  switch (current.status) {
    case 'armed':
      return breach
        ? { ...current, status: 'triggered', triggerCloseDate: closeDate, triggerDrawdownPct: closeDrawdownPct }
        : current;
    case 'triggered':
      // Latched: never auto-cleared by a recovery.
      return current;
    case 'audited':
      return breach ? current : { ...current, status: 'armed' };
    default:
      return current;
  }
}

export function markAudited(current: AuditLatch, now: Date, outcome: AuditOutcome): AuditLatch {
  return current.status === 'triggered'
    ? { ...current, status: 'audited', auditedAt: now.toISOString(), lastOutcome: outcome }
    : current;
}

export function parseAuditLatch(raw: unknown): AuditLatch | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (value.status !== 'armed' && value.status !== 'triggered' && value.status !== 'audited') {
    return null;
  }
  return {
    status: value.status,
    lastOutcome: value.lastOutcome === 'intact' || value.lastOutcome === 'broken' ? value.lastOutcome : null,
    triggerCloseDate: typeof value.triggerCloseDate === 'string' ? value.triggerCloseDate : null,
    triggerDrawdownPct: typeof value.triggerDrawdownPct === 'number' ? value.triggerDrawdownPct : null,
    auditedAt: typeof value.auditedAt === 'string' ? value.auditedAt : null,
  };
}
