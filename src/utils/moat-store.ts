import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import { MOAT_RATINGS_STORAGE_KEY } from '@/constants/storage-keys';
import type { QualityMoat } from '@/types/ambush';

// MANUAL MOAT (2026-11-27, backlog P1). Moat is a judgement, not a figure:
// FMP has no moat data, and the old backend proxy (ROE + operating margin)
// rated LIN/AMT/ECL/DE/CNI "Wide" and FICO "None" without approval. It is
// now a manual, editable field per ticker, and nothing derives it.
//
// Every ticker without a saved rating is 'Unrated', which fails the Value
// Zone's moat rule (see @/utils/quality-entry-rules). Same store shape as
// @/utils/target-allocation-store.

export const MOAT_RATINGS: readonly QualityMoat[] = ['Wide', 'Narrow', 'None', 'Unrated'];
export const DEFAULT_MOAT: QualityMoat = 'Unrated';

// Approved in the analyst chat, 2026-11-27 (FICO, ADBE and INTU approved
// later the same day). Applied once, on the first load with no saved
// ratings; never re-applied over a user's edit.
export const APPROVED_MOAT_SEED: Readonly<Record<string, QualityMoat>> = {
  MA: 'Wide',
  V: 'Wide',
  DE: 'Narrow',
  ECL: 'Narrow',
  LIN: 'Narrow',
  AMT: 'Narrow',
  WM: 'Narrow',
  FICO: 'Narrow',
  ADBE: 'Narrow',
  INTU: 'Narrow',
};

export type MoatRatings = Record<string, QualityMoat>;

export type MoatRatingsState = {
  ratings: MoatRatings;
  isLoaded: boolean;
};

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

function isMoat(value: unknown): value is QualityMoat {
  return typeof value === 'string' && (MOAT_RATINGS as readonly string[]).includes(value);
}

// Keeps only valid ticker -> rating pairs; 'Unrated' is the default, so it
// isn't stored.
export function parseMoatRatings(raw: unknown): MoatRatings | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const ratings: MoatRatings = {};
  for (const [ticker, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isMoat(value) && value !== DEFAULT_MOAT && ticker.trim() !== '') {
      ratings[normalizeTicker(ticker)] = value;
    }
  }
  return ratings;
}

let state: MoatRatingsState = { ratings: { ...APPROVED_MOAT_SEED }, isLoaded: false };
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: MoatRatingsState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

async function persist(ratings: MoatRatings): Promise<void> {
  await AsyncStorage.setItem(MOAT_RATINGS_STORAGE_KEY, JSON.stringify(ratings));
}

// Reads the saved ratings once per app session. Never saved: the approved
// seed is written as the starting ratings. Unreadable: the seed is shown
// but NOT written, so a transient read error can't overwrite real edits.
export function ensureMoatRatingsLoaded(): Promise<void> {
  if (loadPromise === null) {
    loadPromise = (async () => {
      let ratings: MoatRatings = { ...APPROVED_MOAT_SEED };
      let shouldSeed = false;
      try {
        const stored = await AsyncStorage.getItem(MOAT_RATINGS_STORAGE_KEY);
        if (stored === null) {
          shouldSeed = true;
        } else {
          ratings = parseMoatRatings(JSON.parse(stored)) ?? ratings;
        }
      } catch (error) {
        console.warn('[moat] Failed to read saved moat ratings; showing the approved seed.', error);
      }
      if (!state.isLoaded) {
        publish({ ratings, isLoaded: true });
        if (shouldSeed) {
          persist(ratings).catch((error) => console.warn('[moat] Failed to save the seed ratings.', error));
        }
      }
    })();
  }
  return loadPromise;
}

export function getMoatRating(ticker: string, ratings: MoatRatings = state.ratings): QualityMoat {
  return ratings[normalizeTicker(ticker)] ?? DEFAULT_MOAT;
}

// Publishes at once, then persists. Throws if it can't be saved.
export async function saveMoatRating(ticker: string, moat: QualityMoat): Promise<void> {
  const key = normalizeTicker(ticker);
  const ratings = { ...state.ratings };
  if (moat === DEFAULT_MOAT) {
    delete ratings[key];
  } else {
    ratings[key] = moat;
  }
  publish({ ratings, isLoaded: true });
  await persist(ratings);
}

// BACKUP RESTORE: replaces every rating.
export async function replaceMoatRatings(next: MoatRatings): Promise<void> {
  const ratings = parseMoatRatings(next) ?? {};
  publish({ ratings, isLoaded: true });
  await persist(ratings);
}

export function getMoatRatingsState(): MoatRatingsState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMoatRatings(): MoatRatingsState {
  return useSyncExternalStore(subscribe, getMoatRatingsState, getMoatRatingsState);
}
