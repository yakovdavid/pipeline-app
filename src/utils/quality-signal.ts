import { QUALITY_MARGIN_OF_SAFETY_ZSCORE, QUALITY_MIN_ROIC_PCT } from '@/constants/thresholds';
import type { QualityMoat } from '@/types/ambush';

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

// The fundamental gates: ROIC >= 15% AND a moat (Wide or Narrow). An
// unknown ROIC or moat (no financial statements, e.g. an ETF, or a failed
// fetch) can't pass a gate.
export function passesQualityFundamentals({ roic, moat }: Pick<QualityReading, 'roic' | 'moat'>): boolean {
  return roic !== null && roic >= QUALITY_MIN_ROIC_PCT && moat !== null && moat !== 'None';
}

// Buy Signal: passes both fundamental gates AND Z-Score <= -1.0. A cheap
// Z-Score on broken fundamentals is a value trap and never signals.
export function isQualityBuySignal(reading: QualityReading): boolean {
  return (
    passesQualityFundamentals(reading) &&
    reading.zScore !== null &&
    reading.zScore <= QUALITY_MARGIN_OF_SAFETY_ZSCORE
  );
}
