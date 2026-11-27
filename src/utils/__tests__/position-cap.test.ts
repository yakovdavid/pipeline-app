import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  exceedsCapAfterBuy,
  isAtOrAboveCap,
  isCapApplicable,
  positionWeightPct,
  weightAfterBuyPct,
} from '../position-cap.ts';

test('the cap applies to single stocks only, not ETFs or mutual funds', () => {
  assert.equal(isCapApplicable('Stock', 'MA'), true);
  assert.equal(isCapApplicable('Stock', 'BRK-B'), true);
  assert.equal(isCapApplicable('ETF', 'VOO'), false);
  assert.equal(isCapApplicable('Stock', '5127527.TA'), false);
});

test('CAP LOCK at or above 5% of the denominator', () => {
  assert.equal(isAtOrAboveCap(positionWeightPct(499, 10_000)), false);
  assert.equal(isAtOrAboveCap(positionWeightPct(500, 10_000)), true);
  assert.equal(positionWeightPct(100, 0), 0);
});

test('a buy may bring the position to exactly 5% but not above', () => {
  // $300 held + $200 buy, $10,000 denominator, no fee: exactly 5.00%.
  assert.equal(exceedsCapAfterBuy(weightAfterBuyPct(300, 200, 0, 10_000)), false);
  // The fee shrinks the denominator: 500 / 9,990 > 5%.
  assert.equal(exceedsCapAfterBuy(weightAfterBuyPct(300, 200, 10, 10_000)), true);
});
