import {
  QUALITY_MARGIN_OF_SAFETY_ZSCORE,
  QUALITY_MIN_ROIC_PCT_HYPER_QUALITY,
  QUALITY_MIN_ROIC_PCT_TACTICAL,
} from '@/constants/thresholds';
import type { QualityMoat } from '@/types/ambush';
import { getTargetAllocationState, type TargetAllocations } from '@/utils/target-allocation-store';

// THE FORTRESS, Quality layer: the one definition of a Quality Buy Signal,
// shared by the Ambush Radar (its Value Zone, see ambush-grouping.ts) and
// the Portfolio (its Quality alert, see fetchPortfolioQuote in
// @/services/api). Both screens call these functions on the same
// GET /api/quality values, so they can never disagree.

export type QualityReading = {
  zScore: number | null;
  roic: number | null;
  moat: QualityMoat | null;
};

// The template-dependent ROIC floor (see QUALITY_MIN_ROIC_PCT_* in
// @/constants/thresholds): a 0% Satellite target means Hyper-Quality (15%),
// anything else Tactical (8%). Defaults to the live target allocation.
export function qualityMinRoicPct(targets: TargetAllocations = getTargetAllocationState().targets): number {
  return targets.Satellite === 0 ? QUALITY_MIN_ROIC_PCT_HYPER_QUALITY : QUALITY_MIN_ROIC_PCT_TACTICAL;
}

// The fundamental gates: ROIC >= the template floor AND a moat (Wide or
// Narrow). An unknown ROIC or moat (no FMP figure, e.g. an ETF, or a failed
// fetch) can't pass a gate.
export function passesQualityFundamentals(
  { roic, moat }: Pick<QualityReading, 'roic' | 'moat'>,
  targets?: TargetAllocations,
): boolean {
  return roic !== null && roic >= qualityMinRoicPct(targets) && moat !== null && moat !== 'None';
}

// FUNDAMENTAL DEGRADATION: a held Quality position whose (known) ROIC has
// fallen below the active template's floor. An unknown ROIC never alerts:
// missing data is shown as missing, not as a failure.
export function isFundamentalDegradation(roic: number | null, targets?: TargetAllocations): boolean {
  return roic !== null && roic < qualityMinRoicPct(targets);
}

// Buy Signal: passes both fundamental gates AND Z-Score <= -1.0. A cheap
// Z-Score on broken fundamentals is a value trap and never signals.
export function isQualityBuySignal(reading: QualityReading, targets?: TargetAllocations): boolean {
  return (
    passesQualityFundamentals(reading, targets) &&
    reading.zScore !== null &&
    reading.zScore <= QUALITY_MARGIN_OF_SAFETY_ZSCORE
  );
}
