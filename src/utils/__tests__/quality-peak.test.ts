import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  advancePeak,
  auditTriggerLevel,
  brokerPriceToLocal,
  closeToLocal,
  drawdownFromPeakPct,
  firstBuyRecord,
  initialPeak,
  seedPeakFor,
} from '../quality-peak.ts';
import { ARMED_LATCH, nextAuditLatch } from '../audit-latch.ts';

const base = { seed: null, hasFirstBuy: false, maxCloseSinceFirstBuy: null, firstEntryPrice: null, high52wClose: null, latestClose: null };

test('FICO bought ~20% below its 52w high does not trigger AUDIT at purchase', () => {
  const peak = initialPeak({ ...base, seed: seedPeakFor('FICO'), latestClose: 700 });
  assert.equal(peak, 706.5);
  const dd = drawdownFromPeakPct(700, peak);
  assert.ok(dd !== null && dd > -15);
  assert.equal(nextAuditLatch(ARMED_LATCH, { closeDrawdownPct: dd, closeDate: '2026-11-27' }).status, 'armed');
});

test('a real 15% drawdown from the peak since entry triggers it', () => {
  const peak = advancePeak(706.5, 760); // new high after entry
  assert.equal(peak, 760);
  assert.equal(auditTriggerLevel(760), 646);
  const dd = drawdownFromPeakPct(646, peak);
  assert.equal(nextAuditLatch(ARMED_LATCH, { closeDrawdownPct: dd, closeDate: '2027-02-01' }).status, 'triggered');
});

test('the peak is one-way and never lowered', () => {
  assert.equal(advancePeak(760, 700), 760);
  assert.equal(advancePeak(null, 700), null);
});

test('initialization: max(close since first BUY, entry price); 52w high without a BUY', () => {
  assert.equal(initialPeak({ ...base, hasFirstBuy: true, maxCloseSinceFirstBuy: 520, firstEntryPrice: 495.55, latestClose: 510 }), 520);
  assert.equal(initialPeak({ ...base, hasFirstBuy: true, maxCloseSinceFirstBuy: null, firstEntryPrice: 495.55, latestClose: 480 }), 495.55);
  assert.equal(initialPeak({ ...base, high52wClose: 600, latestClose: 550 }), 600);
  assert.equal(initialPeak(base), null);
});

test('".TA" closes and broker prices are normalized from Agorot once', () => {
  assert.equal(closeToLocal('5127527.TA', 244.13), 2.4413);
  assert.equal(brokerPriceToLocal('5127527.TA', 252.75), 2.5275);
  assert.equal(closeToLocal('MA', 659.97), 659.97);
});

test('the first BUY is the earliest buy, sells ignored', () => {
  const records = [
    { ticker: 'MA', side: 'buy' as const, executedAt: '2026-10-02T10:00:00Z', price: 520 },
    { ticker: 'MA', side: 'sell' as const, executedAt: '2026-09-01T10:00:00Z', price: 500 },
    { ticker: 'MA', side: 'buy' as const, executedAt: '2026-09-15T10:00:00Z', price: 495.55 },
  ];
  assert.equal(firstBuyRecord(records, 'ma')?.price, 495.55);
  assert.equal(firstBuyRecord(records, 'V'), null);
});
