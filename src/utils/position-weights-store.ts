import { useSyncExternalStore } from 'react';

// P9 SINGLE-STOCK CAP: each held single stock's live weight (percent of
// invested + cash, the same denominator as the layer weights), published
// by the Portfolio screen and read by the Ambush Radar for its CAP LOCK.
// Only positions the cap applies to are listed (see isCapApplicable in
// @/utils/position-cap). Null means "not known yet", which locks nothing,
// the same rule as @/utils/layer-weights-store.

export type PositionWeights = Readonly<Record<string, number>>;

let snapshot: PositionWeights | null = null;
const listeners = new Set<() => void>();

function sameWeights(a: PositionWeights | null, b: PositionWeights | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  const aKeys = Object.keys(a);
  return aKeys.length === Object.keys(b).length && aKeys.every((key) => a[key] === b[key]);
}

export function publishPositionWeights(next: PositionWeights | null): void {
  if (sameWeights(snapshot, next)) {
    return;
  }
  snapshot = next === null ? null : { ...next };
  listeners.forEach((listener) => listener());
}

export function getPositionWeights(): PositionWeights | null {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePositionWeights(): PositionWeights | null {
  return useSyncExternalStore(subscribe, getPositionWeights, getPositionWeights);
}
