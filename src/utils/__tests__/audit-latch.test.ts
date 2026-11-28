import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ARMED_LATCH, markAudited, nextAuditLatch, parseAuditLatch, type AuditLatch } from '../audit-latch.ts';

const close = (closeDrawdownPct: number | null, closeDate = '2026-11-26', closeLocal: number | null = null) => ({
  closeDrawdownPct,
  closeDate,
  closeLocal,
});
const now = new Date('2026-11-27T10:00:00Z');

test('a daily close 15% below the peak since entry triggers the audit', () => {
  const latch = nextAuditLatch(ARMED_LATCH, close(-15));
  assert.equal(latch.status, 'triggered');
  assert.equal(latch.triggerReason, 'drawdown');
  assert.equal(nextAuditLatch(ARMED_LATCH, close(-14.99)).status, 'armed');
});

test('a triggered audit is never cleared by a price recovery', () => {
  let latch = nextAuditLatch(ARMED_LATCH, close(-18));
  for (const dd of [-10, -2, 0]) {
    latch = nextAuditLatch(latch, close(dd));
  }
  assert.equal(latch.status, 'triggered');
});

test('only marking Audited clears it; it re-arms after a close back above -15%', () => {
  const triggered = nextAuditLatch(ARMED_LATCH, close(-18));
  const audited = markAudited(triggered, now, 'intact', 580);
  assert.equal(audited.status, 'audited');
  assert.equal(audited.lastOutcome, 'intact');
  assert.equal(nextAuditLatch(audited, close(-20, '2026-12-01', 560)).status, 'audited');
  const rearmed = nextAuditLatch(audited, close(-9, '2026-12-10', 640));
  assert.equal(rearmed.status, 'armed');
  assert.equal(rearmed.nextAuditLevel, null);
  assert.equal(nextAuditLatch(rearmed, close(-16, '2027-01-05', 590)).status, 'triggered');
});

test('P13-A: after "intact", a close at 0.85 × the audited close triggers a new audit (FICO example)', () => {
  // Peak 706.50, audited "intact" at a 590.00 close -> next step 501.50.
  const triggered = nextAuditLatch(ARMED_LATCH, close(-16.5, '2026-12-01', 590));
  const audited = markAudited(triggered, now, 'intact', 590);
  assert.equal(audited.nextAuditLevel, 501.5);
  assert.equal(nextAuditLatch(audited, close(-28, '2026-12-15', 508)).status, 'audited');
  const stepped = nextAuditLatch(audited, close(-29.02, '2026-12-16', 501.5));
  assert.equal(stepped.status, 'triggered');
  assert.equal(stepped.triggerReason, 'step');
  // And it repeats: intact again at 500 -> next step 425.
  assert.equal(markAudited(stepped, now, 'intact', 500).nextAuditLevel, 425);
});

test('P13-A: "thesis broken" sets no step', () => {
  const triggered = nextAuditLatch(ARMED_LATCH, close(-18));
  const broken = markAudited(triggered, now, 'broken', 580);
  assert.equal(broken.nextAuditLevel, null);
  assert.equal(broken.lastOutcome, 'broken');
  assert.equal(nextAuditLatch(broken, close(-5)).lastOutcome, 'broken');
});

test('marking a latch that is not triggered changes nothing', () => {
  assert.equal(markAudited(ARMED_LATCH, now, 'broken', 500), ARMED_LATCH);
});

test('an unknown close changes nothing', () => {
  const triggered = nextAuditLatch(ARMED_LATCH, close(-18));
  assert.equal(nextAuditLatch(triggered, close(null)), triggered);
});

const withEarnings = (last: string | null, due: string | null, dd = -3) => ({
  ...close(dd, '2027-02-01', 700),
  lastEarningsDate: last,
  earningsAuditDueDate: due,
});

test('P13-B: the first settled report seen is a baseline only', () => {
  const latch = nextAuditLatch(ARMED_LATCH, withEarnings('2026-11-04', '2026-11-09'));
  assert.equal(latch.status, 'armed');
  assert.equal(latch.earningsCoveredDate, '2026-11-04');
});

test('P13-B: a new report triggers an audit on the 3rd session after it, once', () => {
  const baseline = nextAuditLatch(ARMED_LATCH, withEarnings('2026-11-04', '2026-11-09'));
  // Report out 2027-01-27, fewer than 3 sessions closed: nothing yet.
  const waiting = nextAuditLatch(baseline, withEarnings('2027-01-27', null));
  assert.equal(waiting.status, 'armed');
  const due = nextAuditLatch(waiting, withEarnings('2027-01-27', '2027-02-01'));
  assert.equal(due.status, 'triggered');
  assert.equal(due.triggerReason, 'earnings');
  const audited = markAudited(due, now, 'intact', 700);
  // Back above the -15% line: re-armed, and the same report never fires again.
  const after = nextAuditLatch(audited, withEarnings('2027-01-27', '2027-02-01'));
  assert.equal(after.status, 'armed');
  assert.equal(nextAuditLatch(after, withEarnings('2027-01-27', '2027-02-01')).status, 'armed');
});

test('P13-B: a first report still inside its 3 sessions fires when due', () => {
  const first = nextAuditLatch(ARMED_LATCH, withEarnings('2027-01-27', null));
  assert.equal(first.earningsCoveredDate, '');
  assert.equal(nextAuditLatch(first, withEarnings('2027-01-27', '2027-02-01')).triggerReason, 'earnings');
});

test('P13-B: a report during a pending audit is covered by it', () => {
  const baseline = nextAuditLatch(ARMED_LATCH, withEarnings('2026-11-04', '2026-11-09'));
  const triggered = nextAuditLatch(baseline, close(-18));
  const covered = nextAuditLatch(triggered, withEarnings('2027-01-27', '2027-02-01', -18));
  assert.equal(covered.status, 'triggered');
  assert.equal(covered.triggerReason, 'drawdown');
  assert.equal(covered.earningsCoveredDate, '2027-01-27');
});

test('latches saved before P12 (no basis marker) are discarded', () => {
  const legacy = { status: 'triggered', triggerCloseDate: '2026-11-27' };
  assert.equal(parseAuditLatch(legacy), null);
  const current: AuditLatch = { ...ARMED_LATCH, nextAuditLevel: 501.5 };
  assert.deepEqual(parseAuditLatch(JSON.parse(JSON.stringify(current))), current);
});
