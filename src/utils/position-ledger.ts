import {
  exceedsHolding,
  isFullSale,
  reduceCostBasis,
  remainingUnitsAfterSale,
} from '@/utils/trade-execution';

// TRADE RECONCILIATION: the pure position update behind Execute Sell, kept
// out of the component so the exact state transition can be tested.

type LedgerPosition = {
  ticker: string;
  units: number;
  costBasisUsd: number | null;
};

export type SaleOutcome = 'closed' | 'reduced' | 'missing' | 'exceedsHolding';

export type SaleResult<T> = {
  positions: T[];
  outcome: SaleOutcome;
};

// Applies a sale of `quantity` units of `ticker`:
//   - every unit held: the position is removed ('closed');
//   - fewer: units are reduced, and the cost basis by the same proportion
//     (average cost), unless it was never recorded ('reduced');
//   - not held, or more than held: nothing changes ('missing' /
//     'exceedsHolding'), and the same array is returned.
// Never mutates its input; untouched positions keep their identity.
export function applySale<T extends LedgerPosition>(positions: T[], ticker: string, quantity: number): SaleResult<T> {
  const held = positions.find((position) => position.ticker === ticker);
  if (held === undefined) {
    return { positions, outcome: 'missing' };
  }
  if (exceedsHolding(quantity, held.units)) {
    return { positions, outcome: 'exceedsHolding' };
  }
  if (isFullSale(quantity, held.units)) {
    return { positions: positions.filter((position) => position.ticker !== ticker), outcome: 'closed' };
  }
  const remainingUnits = remainingUnitsAfterSale(held.units, quantity);
  return {
    positions: positions.map((position) =>
      position.ticker !== ticker
        ? position
        : {
            ...position,
            units: remainingUnits,
            costBasisUsd:
              position.costBasisUsd === null
                ? null
                : reduceCostBasis(position.costBasisUsd, position.units, remainingUnits),
          },
    ),
    outcome: 'reduced',
  };
}
