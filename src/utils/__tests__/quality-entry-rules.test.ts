import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateQualityEntry, type QualityEntryReading, type QualityEntryThresholds } from '../quality-entry-rules.ts';

const hyperQuality: QualityEntryThresholds = {
  minRoicPct: 15,
  capitalLightRequired: true,
  maxCapexToRevenuePct: 5,
  maxCapexToOcfPct: 20,
  maxZScore: -1,
};
const tactical: QualityEntryThresholds = { ...hyperQuality, minRoicPct: 8, capitalLightRequired: false };

const passing: QualityEntryReading = {
  roic: 30,
  moat: 'Wide',
  capexToRevenue3y: 2,
  capexToOcf3y: 10,
  peTtm: 20,
  pe5yAvg: 30,
  zScore: -1.2,
};

test('every rule passing is a Value Zone buy signal', () => {
  const result = evaluateQualityEntry(passing, hyperQuality);
  assert.equal(result.isBuySignal, true);
  assert.deepEqual(result.failedRules, []);
});

test('ZTS fails Capital Light under Hyper-Quality (7.4% / 24.9%)', () => {
  const zts = { ...passing, capexToRevenue3y: 7.4, capexToOcf3y: 24.9 };
  const result = evaluateQualityEntry(zts, hyperQuality);
  assert.equal(result.isBuySignal, false);
  assert.equal(result.passesQualityGates, false);
  assert.deepEqual(result.failedRules, ['capexToRevenue', 'capexToOcf']);
});

test('Capital Light is not applied to a Tactical template', () => {
  const zts = { ...passing, capexToRevenue3y: 7.4, capexToOcf3y: 24.9 };
  assert.equal(evaluateQualityEntry(zts, tactical).isBuySignal, true);
});

test('Unrated and None moats both fail', () => {
  for (const moat of ['Unrated', 'None'] as const) {
    assert.deepEqual(evaluateQualityEntry({ ...passing, moat }, hyperQuality).failedRules, ['moat']);
  }
  assert.equal(evaluateQualityEntry({ ...passing, moat: 'Narrow' }, hyperQuality).isBuySignal, true);
});

test('ROIC must be strictly above the floor', () => {
  assert.deepEqual(evaluateQualityEntry({ ...passing, roic: 15 }, hyperQuality).failedRules, ['roic']);
});

test('P/E at or above its 5y average, or a loss P/E, fails as a price gate only', () => {
  for (const peTtm of [30, 35, -12]) {
    const result = evaluateQualityEntry({ ...passing, peTtm }, hyperQuality);
    assert.deepEqual(result.failedRules, ['peBelowAverage']);
    assert.equal(result.passesQualityGates, true);
  }
});

test('Z-Score above -1.0 fails; exactly -1.0 passes', () => {
  assert.deepEqual(evaluateQualityEntry({ ...passing, zScore: -0.99 }, hyperQuality).failedRules, ['zScore']);
  assert.equal(evaluateQualityEntry({ ...passing, zScore: -1 }, hyperQuality).isBuySignal, true);
});

test('unknown data fails its rule', () => {
  const unknown = { ...passing, roic: null, capexToOcf3y: null, pe5yAvg: null, zScore: null };
  assert.deepEqual(evaluateQualityEntry(unknown, hyperQuality).failedRules, [
    'roic',
    'capexToOcf',
    'peBelowAverage',
    'zScore',
  ]);
});

test('a single stock at the 5% cap fails only the portfolio gate', () => {
  const result = evaluateQualityEntry({ ...passing, withinPositionCap: false }, hyperQuality);
  assert.deepEqual(result.failedRules, ['positionCap']);
  assert.equal(result.passesQualityGates, true);
  assert.equal(result.isBuySignal, false);
  assert.equal(evaluateQualityEntry({ ...passing, withinPositionCap: null }, hyperQuality).rules.length, 6);
});
