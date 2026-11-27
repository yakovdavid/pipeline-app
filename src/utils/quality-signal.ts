import {
  QUALITY_MARGIN_OF_SAFETY_ZSCORE,
  QUALITY_MAX_CAPEX_TO_OCF_PCT,
  QUALITY_MAX_CAPEX_TO_REVENUE_PCT,
  QUALITY_MIN_ROIC_PCT_HYPER_QUALITY,
  QUALITY_MIN_ROIC_PCT_TACTICAL,
} from '@/constants/thresholds';
import {
  evaluateQualityEntry,
  type QualityEntryEvaluation,
  type QualityEntryReading,
  type QualityEntryThresholds,
} from '@/utils/quality-entry-rules';
import { getTargetAllocationState, type TargetAllocations } from '@/utils/target-allocation-store';

// THE FORTRESS, Quality layer: the app-facing wrapper of the Quality entry
// rules (@/utils/quality-entry-rules), shared by the Ambush Radar (its Value
// Zone, see ambush-grouping.ts) and the Portfolio (its Quality Buy Signal).
// Both evaluate the same GET /api/quality values with the same manual moat,
// so they can never disagree.

export type QualityReading = QualityEntryReading;

// A 0% Satellite target means Hyper-Quality (e.g. 80/0/20): Quality must
// carry the Alpha, so the 15% ROIC floor and Capital Light apply.
// Anything else is Tactical (8%, no Capital Light).
export function isHyperQualityTemplate(targets: TargetAllocations = getTargetAllocationState().targets): boolean {
  return targets.Satellite === 0;
}

export function qualityMinRoicPct(targets: TargetAllocations = getTargetAllocationState().targets): number {
  return isHyperQualityTemplate(targets) ? QUALITY_MIN_ROIC_PCT_HYPER_QUALITY : QUALITY_MIN_ROIC_PCT_TACTICAL;
}

export function qualityEntryThresholds(
  targets: TargetAllocations = getTargetAllocationState().targets,
): QualityEntryThresholds {
  return {
    minRoicPct: qualityMinRoicPct(targets),
    capitalLightRequired: isHyperQualityTemplate(targets),
    maxCapexToRevenuePct: QUALITY_MAX_CAPEX_TO_REVENUE_PCT,
    maxCapexToOcfPct: QUALITY_MAX_CAPEX_TO_OCF_PCT,
    maxZScore: QUALITY_MARGIN_OF_SAFETY_ZSCORE,
  };
}

export function evaluateQualityReading(reading: QualityReading, targets?: TargetAllocations): QualityEntryEvaluation {
  return evaluateQualityEntry(reading, qualityEntryThresholds(targets));
}

// FUNDAMENTAL DEGRADATION: a held Quality position whose (known) ROIC has
// fallen below the active template's floor. An unknown ROIC never alerts:
// missing data is shown as missing, not as a failure.
export function isFundamentalDegradation(roic: number | null, targets?: TargetAllocations): boolean {
  return roic !== null && roic < qualityMinRoicPct(targets);
}
