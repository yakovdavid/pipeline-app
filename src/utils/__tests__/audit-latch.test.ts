import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ARMED_LATCH, markAudited, nextAuditLatch } from '../audit-latch.ts';

const close = (closeDrawdownPct: number | null, closeDate = '2026-11-26') => ({ closeDrawdownPct, closeDate });

test('a daily close 15% below the 52w high triggers the audit', () => {
  const latch = nextAuditLatch(ARMED_LATCH, close(-15));
  assert.equal(latch.status, 'triggered');
  assert.equal(latch.triggerCloseDate, '2026-11-26');
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
  const audited = markAudited(triggered, new Date('2026-11-27T10:00:00Z'), 'intact');
  assert.equal(audited.lastOutcome, 'intact');
  assert.equal(audited.status, 'audited');
  // Still in the same drawdown episode: no new alert.
  assert.equal(nextAuditLatch(audited, close(-20)).status, 'audited');
  // Recovered above the line, then a new breach: a new audit.
  const rearmed = nextAuditLatch(audited, close(-9));
  assert.equal(rearmed.status, 'armed');
  assert.equal(nextAuditLatch(rearmed, close(-16, '2027-01-05')).status, 'triggered');
});

test('an unknown close changes nothing', () => {
  const triggered = nextAuditLatch(ARMED_LATCH, close(-18));
  assert.equal(nextAuditLatch(triggered, close(null)), triggered);
});

test('the audit outcome is kept through a re-arm until the next audit', () => {
  const triggered = nextAuditLatch(ARMED_LATCH, close(-18));
  const broken = markAudited(triggered, new Date('2026-11-27T10:00:00Z'), 'broken');
  const rearmed = nextAuditLatch(broken, close(-5));
  assert.equal(rearmed.status, 'armed');
  assert.equal(rearmed.lastOutcome, 'broken');
});

test('marking a latch that is not triggered changes nothing', () => {
  assert.equal(markAudited(ARMED_LATCH, new Date(), 'broken'), ARMED_LATCH);
});
