import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { CATEGORY_TARGET_PCT } from '@/constants/labels';
import { TARGET_ALLOCATION_STORAGE_KEY } from '@/constants/storage-keys';
import type { AllocationLayer } from '@/utils/allocation';

// DYNAMIC LAYER TARGETS: the user's target allocation (e.g. 70/20/10, or
// 80/0/20 while moving out of Satellite), shared by every screen that
// checks a layer against its target: the Ambush Radar's overweight lock,
// the Portfolio's radar-buy guard, its section headers and its exports.
// CATEGORY_TARGET_PCT is only the default for a user who never set one.
//
// Same store shape as @/utils/layer-weights-store. Until the saved value
// has been read, `isLoaded` is false and the default is reported; callers
// that lock or block on the targets wait for isLoaded, so a slow read
// can't lock a layer on the wrong targets.

export type TargetAllocations = Record<AllocationLayer, number>;

export type TargetAllocationState = {
  targets: TargetAllocations;
  isLoaded: boolean;
};

export const DEFAULT_TARGET_ALLOCATIONS: TargetAllocations = {
  Core: CATEGORY_TARGET_PCT.Core,
  Satellite: CATEGORY_TARGET_PCT.Satellite,
  Quality: CATEGORY_TARGET_PCT.Quality,
};

// Targets are entered with at most one decimal, and their sum is checked
// at that precision.
const SUM_TOLERANCE = 0.05;

function isValidPct(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

// A valid set of targets: three percents from 0 to 100 that sum to 100.
export function parseTargetAllocations(raw: unknown): TargetAllocations | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const { Core, Satellite, Quality } = raw as Record<string, unknown>;
  if (!isValidPct(Core) || !isValidPct(Satellite) || !isValidPct(Quality)) {
    return null;
  }
  if (Math.abs(Core + Satellite + Quality - 100) > SUM_TOLERANCE) {
    return null;
  }
  return { Core, Satellite, Quality };
}

let state: TargetAllocationState = { targets: DEFAULT_TARGET_ALLOCATIONS, isLoaded: false };
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: TargetAllocationState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

// Reads the saved targets once per app session; every caller shares the
// same read. A missing or unreadable value keeps the default (an invalid
// one can't be acted on, and the default is the documented fallback).
export function ensureTargetAllocationsLoaded(): Promise<void> {
  if (loadPromise === null) {
    loadPromise = (async () => {
      let targets = DEFAULT_TARGET_ALLOCATIONS;
      try {
        const stored = await AsyncStorage.getItem(TARGET_ALLOCATION_STORAGE_KEY);
        if (stored !== null) {
          targets = parseTargetAllocations(JSON.parse(stored)) ?? DEFAULT_TARGET_ALLOCATIONS;
        }
      } catch {
        // Keep the default.
      }
      // A save that finished before this read wins over the stored value.
      if (!state.isLoaded) {
        publish({ targets, isLoaded: true });
      }
    })();
  }
  return loadPromise;
}

// Publishes at once (every screen re-renders on the new targets), then
// persists. Throws if the targets are invalid or can't be saved.
export async function saveTargetAllocations(next: TargetAllocations): Promise<void> {
  const targets = parseTargetAllocations(next);
  if (targets === null) {
    throw new Error('Target allocations must be 0-100% each and sum to 100%.');
  }
  publish({ targets, isLoaded: true });
  await AsyncStorage.setItem(TARGET_ALLOCATION_STORAGE_KEY, JSON.stringify(targets));
}

export function getTargetAllocationState(): TargetAllocationState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTargetAllocations(): TargetAllocationState {
  return useSyncExternalStore(subscribe, getTargetAllocationState, getTargetAllocationState);
}
