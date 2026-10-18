// ALLOCATION DENOMINATOR FIX: every layer's weight is its share of
// invested capital PLUS available cash:
//   LayerWeight = LayerValue / (TotalInvested + cashBalance)
// so uninvested cash dilutes Core, Satellite and Quality instead of being
// invisible, and Cash gets a weight of its own. All values are USD (the
// same `effectiveUnits × price` basis the rest of the Portfolio uses).

export type AllocationBucket = 'Core' | 'Satellite' | 'Quality' | 'Cash';

export const ALLOCATION_BUCKETS: readonly AllocationBucket[] = ['Core', 'Satellite', 'Quality', 'Cash'];

export type AllocationValues = Record<AllocationBucket, number>;

export type AllocationBreakdown = {
  // Percentages rounded to one decimal place that sum to exactly 100.0
  // (or are all 0 when there is nothing invested and no cash).
  weightsPct: AllocationValues;
  // TotalInvested + cash counted toward the denominator.
  totalValue: number;
};

const DECIMAL_SCALE = 10; // one decimal place
const TOTAL_UNITS = 100 * DECIMAL_SCALE;

// A negative cash balance (a trade the user confirmed past a warning) is
// money owed, not an asset: it counts as 0 here, so the weights still sum
// to 100% and no layer can show more than 100%. The balance itself is
// still shown as negative.
function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Largest-remainder rounding: every bucket is rounded down to one decimal,
// and the tenths left over go to the buckets with the largest discarded
// fractions. Plain per-bucket rounding can display 99.9% or 100.1%; this
// always displays 100.0%.
export function computeAllocation(values: AllocationValues): AllocationBreakdown {
  const safe: AllocationValues = {
    Core: nonNegative(values.Core),
    Satellite: nonNegative(values.Satellite),
    Quality: nonNegative(values.Quality),
    Cash: nonNegative(values.Cash),
  };
  const totalValue = ALLOCATION_BUCKETS.reduce((sum, bucket) => sum + safe[bucket], 0);

  const weightsPct: AllocationValues = { Core: 0, Satellite: 0, Quality: 0, Cash: 0 };
  if (totalValue <= 0) {
    return { weightsPct, totalValue: 0 };
  }

  const shares = ALLOCATION_BUCKETS.map((bucket) => {
    const exactUnits = (safe[bucket] / totalValue) * TOTAL_UNITS;
    const flooredUnits = Math.floor(exactUnits);
    return { bucket, flooredUnits, remainder: exactUnits - flooredUnits };
  });
  let leftoverUnits = TOTAL_UNITS - shares.reduce((sum, share) => sum + share.flooredUnits, 0);
  // Stable order on ties: bucket order (Core first).
  const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder);
  for (const share of byRemainder) {
    if (leftoverUnits <= 0) {
      break;
    }
    share.flooredUnits += 1;
    leftoverUnits -= 1;
  }
  for (const share of shares) {
    weightsPct[share.bucket] = share.flooredUnits / DECIMAL_SCALE;
  }
  return { weightsPct, totalValue };
}
