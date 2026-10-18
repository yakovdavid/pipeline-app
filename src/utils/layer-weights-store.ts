import { useSyncExternalStore } from 'react';

import type { AllocationValues } from '@/utils/allocation';

// CIRCUIT BREAKER: the Portfolio's live, cash-diluted layer weights (Phase
// 1's computeAllocation), shared with the Ambush Radar. The Portfolio
// screen publishes every time they change, including when cash is added
// or withdrawn, and the radar re-renders immediately through
// useSyncExternalStore.
//
// Null means "not known yet" (the portfolio or the saved cash balance
// hasn't loaded). No layer is locked on unknown weights: a half-loaded
// portfolio could otherwise lock or unlock layers on wrong numbers.

let snapshot: AllocationValues | null = null;
const listeners = new Set<() => void>();

function sameWeights(a: AllocationValues | null, b: AllocationValues | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.Core === b.Core && a.Satellite === b.Satellite && a.Quality === b.Quality && a.Cash === b.Cash;
}

export function publishLayerWeights(next: AllocationValues | null): void {
  if (sameWeights(snapshot, next)) {
    return;
  }
  snapshot = next === null ? null : { ...next };
  listeners.forEach((listener) => listener());
}

export function getLayerWeights(): AllocationValues | null {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLayerWeights(): AllocationValues | null {
  return useSyncExternalStore(subscribe, getLayerWeights, getLayerWeights);
}
