import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isLegacyTicker, legacyExitReasons } from '../legacy-hold.ts';

test('the Legacy list is closed: DE and ECL only', () => {
  assert.equal(isLegacyTicker('de'), true);
  assert.equal(isLegacyTicker('ECL'), true);
  assert.equal(isLegacyTicker('MA'), false);
});

test('HOLD while ROIC >= 8% and the moat is not None', () => {
  assert.deepEqual(legacyExitReasons({ roic: 8, moat: 'Narrow', lastAuditOutcome: 'intact' }), []);
  assert.deepEqual(legacyExitReasons({ roic: null, moat: 'Unrated', lastAuditOutcome: null }), []);
});

test('each exit trigger is reported', () => {
  assert.deepEqual(legacyExitReasons({ roic: 7.9, moat: 'None', lastAuditOutcome: 'broken' }), [
    'roicBelowFloor',
    'moatNone',
    'thesisBroken',
  ]);
});
