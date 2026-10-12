import AsyncStorage from '@react-native-async-storage/async-storage';

import { AMBUSH_TICKERS_STORAGE_KEY } from '@/constants/storage-keys';
import type { AmbushAsset, AmbushTickerEntry } from '@/types/ambush';

// Normalizes one stored entry, whatever generation of the format it is:
//   - a plain ticker string (before assetType existed),
//   - { ticker, assetType } (before layers existed),
//   - { ticker, assetType, layer } (current).
// Missing or unrecognized values fall back to 'Stock' and 'Satellite', the
// behavior those older entries always had. An entry with no usable ticker
// is dropped: there's nothing to fetch or show for it.
export function normalizeAmbushEntry(raw: unknown): AmbushTickerEntry | null {
  if (typeof raw === 'string') {
    const ticker = raw.trim();
    return ticker ? { ticker, assetType: 'Stock', layer: 'Satellite' } : null;
  }
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  if (typeof entry.ticker !== 'string' || entry.ticker.trim() === '') {
    return null;
  }
  return {
    ticker: entry.ticker.trim(),
    assetType: entry.assetType === 'ETF' ? 'ETF' : 'Stock',
    layer: entry.layer === 'Quality' ? 'Quality' : 'Satellite',
  };
}

function normalizeAmbushEntries(raw: unknown): AmbushTickerEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error('Stored Ambush watchlist is not an array.');
  }
  return raw.map(normalizeAmbushEntry).filter((entry): entry is AmbushTickerEntry => entry !== null);
}

// Reads the persisted Ambush Radar ticker list. Returns null when nothing
// has ever been saved (first launch), distinct from an empty array (the
// user deleted every ticker) — callers decide what to do in each case.
// Shared by ambush.tsx (initial load) and the Portfolio screen's
// "Copy ALL Data" export, so both parse the same storage format identically.
// Throws on unreadable storage, so callers never mistake it for "empty".
export async function loadAmbushTickerEntries(): Promise<AmbushTickerEntry[] | null> {
  const stored = await AsyncStorage.getItem(AMBUSH_TICKERS_STORAGE_KEY);
  if (!stored) {
    return null;
  }
  return normalizeAmbushEntries(JSON.parse(stored));
}

export type AddToAmbushResult = 'added' | 'alreadyTracked';

// CLOSED-LOOP WATCHLIST: appends one ticker (with its layer) to the
// persisted Ambush Radar list, skipping it if the ticker is already there
// in EITHER layer (case-insensitive): a ticker appears on the radar once.
// Read-modify-write on the same storage key the Ambush screen loads from.
// If the read fails, this throws WITHOUT writing: writing a fresh list on
// top of an unreadable one could wipe the user's real watchlist. A
// never-saved list (null) starts as [].
export async function addTickerToAmbushRadar(entry: AmbushTickerEntry): Promise<AddToAmbushResult> {
  const existing = (await loadAmbushTickerEntries()) ?? [];
  const normalizedTicker = entry.ticker.trim().toUpperCase();
  if (existing.some((tracked) => tracked.ticker.trim().toUpperCase() === normalizedTicker)) {
    return 'alreadyTracked';
  }
  const updated: AmbushTickerEntry[] = [
    ...existing,
    { ticker: entry.ticker, assetType: entry.assetType, layer: entry.layer },
  ];
  await AsyncStorage.setItem(AMBUSH_TICKERS_STORAGE_KEY, JSON.stringify(updated));
  return 'added';
}

// In-memory notification for an already-mounted Ambush Radar screen. Tab
// screens stay mounted after their first visit, and the Ambush screen
// mirrors its own in-memory list back into storage whenever that list
// changes. A ticker written only to storage could therefore be overwritten
// by that screen's next write before it ever reloads. Subscribers merge
// the delivered row (either layer) into their state, so it can't be lost.
// If the screen has never been mounted, nobody is subscribed and the
// storage write above is what it loads on first visit.
type AmbushAdditionListener = (asset: AmbushAsset) => void;

const ambushAdditionListeners = new Set<AmbushAdditionListener>();

export function subscribeToAmbushAdditions(listener: AmbushAdditionListener): () => void {
  ambushAdditionListeners.add(listener);
  return () => {
    ambushAdditionListeners.delete(listener);
  };
}

export function notifyAmbushAddition(asset: AmbushAsset): void {
  ambushAdditionListeners.forEach((listener) => listener(asset));
}
