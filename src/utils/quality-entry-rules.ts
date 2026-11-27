// QUALITY ENTRY RULES (2026-11-27): the one definition of whether a Quality
// asset may be bought, shared by the Ambush Radar's VALUE ZONE and the
// Portfolio's Quality Buy Signal. Pure (no app imports), so it runs under
// `node --test`; the app-facing wrapper is @/utils/quality-signal.
//
// A Quality asset is in the VALUE ZONE only when EVERY entry rule of the
// active template passes:
//   roic            ROIC TTM > the template floor (15% Hyper-Quality, 8% Tactical)
//   moat            moat rated Wide or Narrow (Unrated / None fail)
//   capexToRevenue  3y avg CapEx/Revenue <= 5%   (Hyper-Quality only)
//   capexToOcf      3y avg CapEx/OCF     <= 20%  (Hyper-Quality only)
//   peBelowAverage  P/E TTM < 5y avg P/E (a non-positive P/E TTM fails)
//   zScore          Z-Score (504 trading days) <= -1.0
//   positionCap     (P9, single stocks only) the position is below the 5%
//                   single-stock cap, so a buy is possible at all
// Unknown data (null) fails its rule: missing data is never a pass.
//
// The first four are QUALITY GATES (the business itself); failing one puts
// the asset in Invalidated. P/E and Z-Score are PRICE GATES; failing only
// those leaves a qualifying business in Watch. positionCap is a PORTFOLIO
// gate: failing only it also leaves the asset in Watch, with CAP LOCK.

export type QualityMoatRating = 'Wide' | 'Narrow' | 'None' | 'Unrated';

export type QualityEntryRuleId =
  | 'roic'
  | 'moat'
  | 'capexToRevenue'
  | 'capexToOcf'
  | 'peBelowAverage'
  | 'zScore'
  | 'positionCap';

export type QualityEntryReading = {
  roic: number | null;
  moat: QualityMoatRating;
  capexToRevenue3y: number | null;
  capexToOcf3y: number | null;
  peTtm: number | null;
  pe5yAvg: number | null;
  zScore: number | null;
  // P9: true/false when the cap applies and the position weight is known;
  // omitted or null leaves the rule out (an ETF, or weights not loaded).
  withinPositionCap?: boolean | null;
};

export type QualityEntryThresholds = {
  minRoicPct: number;
  // Capital Light applies only to Hyper-Quality templates.
  capitalLightRequired: boolean;
  maxCapexToRevenuePct: number;
  maxCapexToOcfPct: number;
  maxZScore: number;
};

export type QualityEntryRuleResult = {
  id: QualityEntryRuleId;
  kind: 'quality' | 'price' | 'portfolio';
  passed: boolean;
};

export type QualityEntryEvaluation = {
  // Only the rules the active template applies, in display order.
  rules: QualityEntryRuleResult[];
  failedRules: QualityEntryRuleId[];
  passesQualityGates: boolean;
  isBuySignal: boolean;
};

export function isRatedMoat(moat: QualityMoatRating): boolean {
  return moat === 'Wide' || moat === 'Narrow';
}

export function evaluateQualityEntry(
  reading: QualityEntryReading,
  thresholds: QualityEntryThresholds,
): QualityEntryEvaluation {
  const { roic, moat, capexToRevenue3y, capexToOcf3y, peTtm, pe5yAvg, zScore } = reading;
  const rules: QualityEntryRuleResult[] = [
    { id: 'roic', kind: 'quality', passed: roic !== null && roic > thresholds.minRoicPct },
    { id: 'moat', kind: 'quality', passed: isRatedMoat(moat) },
  ];
  if (thresholds.capitalLightRequired) {
    rules.push(
      {
        id: 'capexToRevenue',
        kind: 'quality',
        passed: capexToRevenue3y !== null && capexToRevenue3y <= thresholds.maxCapexToRevenuePct,
      },
      {
        id: 'capexToOcf',
        kind: 'quality',
        passed: capexToOcf3y !== null && capexToOcf3y <= thresholds.maxCapexToOcfPct,
      },
    );
  }
  rules.push(
    {
      id: 'peBelowAverage',
      kind: 'price',
      passed: peTtm !== null && pe5yAvg !== null && peTtm > 0 && peTtm < pe5yAvg,
    },
    { id: 'zScore', kind: 'price', passed: zScore !== null && zScore <= thresholds.maxZScore },
  );
  if (typeof reading.withinPositionCap === 'boolean') {
    rules.push({ id: 'positionCap', kind: 'portfolio', passed: reading.withinPositionCap });
  }

  const failedRules = rules.filter((rule) => !rule.passed).map((rule) => rule.id);
  const passesQualityGates = rules.every((rule) => rule.kind !== 'quality' || rule.passed);
  return { rules, failedRules, passesQualityGates, isBuySignal: failedRules.length === 0 };
}
