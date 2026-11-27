// Run: npm test   (node --test, native TypeScript type stripping)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { legacyUsdWatermarkToLocal, localWatermarkToUsd, resolveWatermark } from '../watermark.ts';

// 5127527.TA as observed 2026-11-27: Bizportal 249 Agorot, normalized once
// by the backend to 2.49 ILS; $0.736 at the quote's rate.
const quote = { price: 0.736, localPrice: 2.49 };

test('a TASE peak is stored in normalized shekels, never agorot or USD', () => {
  const { local, usd } = resolveWatermark({ highestWatermarkLocal: null, highestWatermark: null }, quote);
  assert.equal(local, 2.49);
  assert.ok(Math.abs(usd - 0.736) < 1e-12);
});

test('a USD/ILS move alone never raises the shekel peak', () => {
  const stored = { highestWatermarkLocal: 2.49, highestWatermark: 0.736 };
  // Shekel strengthens: same 2.49 ILS now reads $0.80.
  const { local, usd } = resolveWatermark(stored, { price: 0.8, localPrice: 2.49 });
  assert.equal(local, 2.49);
  assert.ok(Math.abs(usd - 0.8) < 1e-12);
});

test('a higher shekel price raises the peak', () => {
  const stored = { highestWatermarkLocal: 2.49, highestWatermark: 0.736 };
  assert.equal(resolveWatermark(stored, { price: 0.75, localPrice: 2.55 }).local, 2.55);
});

test('a legacy USD-only peak is migrated once with the current rate', () => {
  // The backup's 0.87 (USD) reads as about 2.94 ILS at today's rate.
  const local = legacyUsdWatermarkToLocal(0.87, quote);
  assert.ok(local !== null && Math.abs(local - 2.9434) < 1e-3);
  const resolved = resolveWatermark({ highestWatermarkLocal: null, highestWatermark: 0.87 }, quote);
  assert.ok(Math.abs(resolved.local - 2.9434) < 1e-3);
});

test('an unavailable placeholder quote converts nothing', () => {
  assert.equal(localWatermarkToUsd(2.49, { price: 0, localPrice: 0 }), null);
  assert.equal(legacyUsdWatermarkToLocal(0.87, { price: 0, localPrice: 0 }), null);
});

test('a USD instrument is unchanged (local = USD)', () => {
  const { local, usd } = resolveWatermark({ highestWatermarkLocal: null, highestWatermark: 410 }, { price: 400, localPrice: 400 });
  assert.equal(local, 410);
  assert.equal(usd, 410);
});
