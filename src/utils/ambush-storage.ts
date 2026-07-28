import AsyncStorage from '@react-native-async-storage/async-storage';

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
