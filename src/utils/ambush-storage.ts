import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Stock } from '@/components/StockCard';
import { AMBUSH_TICKERS_STORAGE_KEY } from '@/constants/storage-keys';
import type { AmbushTickerEntry } from '@/types/ambush';

// Entries saved before assetType existed are a plain array of ticker
// strings; normalize those to 'Stock', the SMA50-only behavior they
// always had.
function normalizeAmbushEntries(raw: (string | AmbushTickerEntry)[]): AmbushTickerEntry[] {
  return raw.map((entry) => (typeof entry === 'string' ? { ticker: entry, assetType: 'Stock' } : entry));
}

// Reads the persisted Ambush Radar ticker list. Returns null when nothing
// has ever been saved (first launch), distinct from an empty array (the
// user deleted every ticker) — callers decide what to do in each case.
// Shared by ambush.tsx (initial load) and the Portfolio screen's
// "Copy ALL Data" export, so both parse the same storage format identically.
export async function loadAmbushTickerEntries(): Promise<AmbushTickerEntry[] | null> {
  const stored = await AsyncStorage.getItem(AMBUSH_TICKERS_STORAGE_KEY);
  if (!stored) {
    return null;
  }

  return normalizeAmbushEntries(JSON.parse(stored) as (string | AmbushTickerEntry)[]);
}

export type AddToAmbushResult = 'added' | 'alreadyTracked';

// CLOSED-LOOP WATCHLIST: appends one ticker to the persisted Ambush Radar
// list, skipping it if it's already there (case-insensitive). Read-modify-
// write on the same storage key the Ambush screen loads from. If the read
// fails, this throws WITHOUT writing: writing a fresh list on top of an
// unreadable one could wipe the user's real watchlist. A never-saved list
// (null) starts as [].
export async function addTickerToAmbushRadar(entry: AmbushTickerEntry): Promise<AddToAmbushResult> {
  const existing = (await loadAmbushTickerEntries()) ?? [];
  const normalizedTicker = entry.ticker.trim().toUpperCase();
  if (existing.some((tracked) => tracked.ticker.trim().toUpperCase() === normalizedTicker)) {
    return 'alreadyTracked';
  }
  const updated: AmbushTickerEntry[] = [...existing, { ticker: entry.ticker, assetType: entry.assetType }];
  await AsyncStorage.setItem(AMBUSH_TICKERS_STORAGE_KEY, JSON.stringify(updated));
  return 'added';
}

// In-memory notification for an already-mounted Ambush Radar screen. Tab
// screens stay mounted after their first visit, and the Ambush screen
// mirrors its own in-memory list back into storage whenever that list
// changes. A ticker written only to storage could therefore be overwritten
// by that screen's next write before it ever reloads. Subscribers merge
// the delivered row into their state, so it can't be lost. If the screen
// has never been mounted, nobody is subscribed and the storage write above
// is what it loads on first visit.
type AmbushAdditionListener = (stock: Stock) => void;

const ambushAdditionListeners = new Set<AmbushAdditionListener>();

export function subscribeToAmbushAdditions(listener: AmbushAdditionListener): () => void {
  ambushAdditionListeners.add(listener);
  return () => {
    ambushAdditionListeners.delete(listener);
  };
}

export function notifyAmbushAddition(stock: Stock): void {
  ambushAdditionListeners.forEach((listener) => listener(stock));
}
