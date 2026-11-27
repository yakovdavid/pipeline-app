import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { AUDIT_LATCHES_STORAGE_KEY } from '@/constants/storage-keys';
import {
  ARMED_LATCH,
  markAudited,
  nextAuditLatch,
  parseAuditLatch,
  type AuditLatch,
  type AuditOutcome,
  type DailyCloseReading,
} from '@/utils/audit-latch';

// FUNDAMENTAL AUDIT LATCH persistence (rules: @/utils/audit-latch). One
// latch per ticker on device, so a triggered audit survives app restarts
// and price recoveries until the user marks it "Audited".
//
// CACHE INTEGRITY: until the saved latches have been read, no reading is
// applied and nothing is written, so a slow or failed read can never reset
// a triggered audit to 'armed'.

export type AuditLatches = Record<string, AuditLatch>;

type AuditLatchState = {
  latches: AuditLatches;
  isLoaded: boolean;
};

let state: AuditLatchState = { latches: {}, isLoaded: false };
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();
// Readings that arrived before the load finished; applied right after it.
const pendingReadings = new Map<string, DailyCloseReading>();

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

function publish(next: AuditLatchState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function persist(latches: AuditLatches): void {
  AsyncStorage.setItem(AUDIT_LATCHES_STORAGE_KEY, JSON.stringify(latches)).catch((error: unknown) => {
    console.warn('[audit] Failed to save audit latches.', error);
  });
}

export function parseAuditLatches(raw: unknown): AuditLatches | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const latches: AuditLatches = {};
  for (const [ticker, value] of Object.entries(raw as Record<string, unknown>)) {
    const latch = parseAuditLatch(value);
    if (latch !== null) {
      latches[normalizeTicker(ticker)] = latch;
    }
  }
  return latches;
}

function applyReadings(latches: AuditLatches, readings: Iterable<[string, DailyCloseReading]>): AuditLatches | null {
  let changed = false;
  const next = { ...latches };
  for (const [ticker, reading] of readings) {
    const current = next[ticker] ?? ARMED_LATCH;
    const updated = nextAuditLatch(current, reading);
    if (updated !== current) {
      next[ticker] = updated;
      changed = true;
    }
  }
  return changed ? next : null;
}

export function ensureAuditLatchesLoaded(): Promise<void> {
  if (loadPromise === null) {
    loadPromise = (async () => {
      try {
        const stored = await AsyncStorage.getItem(AUDIT_LATCHES_STORAGE_KEY);
        const latches = stored === null ? {} : parseAuditLatches(JSON.parse(stored));
        if (latches === null) {
          throw new Error('Stored audit latches are malformed.');
        }
        const withPending = applyReadings(latches, pendingReadings.entries());
        pendingReadings.clear();
        publish({ latches: withPending ?? latches, isLoaded: true });
        if (withPending !== null) {
          persist(withPending);
        }
      } catch (error) {
        // Stay unloaded (no writes); the next call retries the read.
        console.error('[audit] Failed to read audit latches; audit state stays read-only.', error);
        loadPromise = null;
      }
    })();
  }
  return loadPromise;
}

// Feeds one daily-close reading for a held Quality position.
export function recordDailyCloseReading(ticker: string, reading: DailyCloseReading): void {
  const key = normalizeTicker(ticker);
  if (!state.isLoaded) {
    pendingReadings.set(key, reading);
    void ensureAuditLatchesLoaded();
    return;
  }
  const next = applyReadings(state.latches, [[key, reading]]);
  if (next !== null) {
    publish({ ...state, latches: next });
    persist(next);
  }
}

export function markTickerAudited(ticker: string, outcome: AuditOutcome, now: Date = new Date()): void {
  if (!state.isLoaded) {
    return;
  }
  const key = normalizeTicker(ticker);
  const current = state.latches[key] ?? ARMED_LATCH;
  const updated = markAudited(current, now, outcome);
  if (updated !== current) {
    const latches = { ...state.latches, [key]: updated };
    publish({ ...state, latches });
    persist(latches);
  }
}

export function getAuditLatches(): AuditLatches {
  return state.latches;
}

// BACKUP RESTORE: replaces every latch.
export function replaceAuditLatches(next: AuditLatches): void {
  const latches = parseAuditLatches(next) ?? {};
  publish({ latches, isLoaded: true });
  persist(latches);
}

function getState(): AuditLatchState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAuditLatch(ticker: string): AuditLatch {
  const current = useSyncExternalStore(subscribe, getState, getState);
  return current.latches[normalizeTicker(ticker)] ?? ARMED_LATCH;
}
