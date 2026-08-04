import AsyncStorage from '@react-native-async-storage/async-storage';

import { AMBUSH_TICKERS_STORAGE_KEY, PORTFOLIO_TICKERS_STORAGE_KEY } from '@/constants/storage-keys';
import type { AmbushTickerEntry } from '@/types/ambush';
import type { AssetType } from '@/types/asset';
import type { PortfolioCategory, PortfolioTickerEntry } from '@/types/portfolio';

const BACKUP_SCHEMA_VERSION = 1;
const PORTFOLIO_CATEGORIES: PortfolioCategory[] = ['Core', 'Satellite', 'Quality'];
const ASSET_TYPES: AssetType[] = ['Stock', 'ETF'];

export type BackupPayload = {
  schemaVersion: number;
  exportedAt: string;
  portfolio: PortfolioTickerEntry[];
  ambush: AmbushTickerEntry[];
};

// Reads both screens' persisted ticker lists directly from AsyncStorage
// (not live component state, which this module has no access to) into one
// exportable JSON object.
export async function createBackupPayload(): Promise<BackupPayload> {
  const [storedPortfolio, storedAmbush] = await Promise.all([
    AsyncStorage.getItem(PORTFOLIO_TICKERS_STORAGE_KEY),
    AsyncStorage.getItem(AMBUSH_TICKERS_STORAGE_KEY),
  ]);

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    portfolio: storedPortfolio ? (JSON.parse(storedPortfolio) as PortfolioTickerEntry[]) : [],
    ambush: storedAmbush ? (JSON.parse(storedAmbush) as AmbushTickerEntry[]) : [],
  };
}

function isPortfolioEntry(value: unknown): value is PortfolioTickerEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.ticker === 'string' &&
    entry.ticker.length > 0 &&
    typeof entry.category === 'string' &&
    PORTFOLIO_CATEGORIES.includes(entry.category as PortfolioCategory) &&
    typeof entry.assetType === 'string' &&
    ASSET_TYPES.includes(entry.assetType as AssetType) &&
    typeof entry.units === 'number' &&
    entry.units > 0 &&
    (entry.highestWatermark === null || typeof entry.highestWatermark === 'number')
  );
}

function isAmbushEntry(value: unknown): value is AmbushTickerEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.ticker === 'string' &&
    entry.ticker.length > 0 &&
    typeof entry.assetType === 'string' &&
    ASSET_TYPES.includes(entry.assetType as AssetType)
  );
}

// Deliberately strict: this is the disaster-recovery path, so a malformed
// backup is rejected outright rather than silently patched up the way the
// normal AsyncStorage loaders backfill old-schema data — hydrating corrupt
// or partial state here would be worse than just refusing to restore.
export function parseBackupPayload(rawText: string): BackupPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('That text is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('A backup must be a JSON object.');
  }

  const payload = parsed as Record<string, unknown>;

  if (!Array.isArray(payload.portfolio) || !payload.portfolio.every(isPortfolioEntry)) {
    throw new Error('Backup is missing a valid "portfolio" list.');
  }
  if (!Array.isArray(payload.ambush) || !payload.ambush.every(isAmbushEntry)) {
    throw new Error('Backup is missing a valid "ambush" list.');
  }

  return {
    schemaVersion: typeof payload.schemaVersion === 'number' ? payload.schemaVersion : BACKUP_SCHEMA_VERSION,
    exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : new Date().toISOString(),
    portfolio: payload.portfolio,
    ambush: payload.ambush,
  };
}

// Overwrites both screens' persisted storage. Portfolio's own live state is
// updated by the caller right after this (it's already mounted where the
// Import UI lives); Ambush Radar picks up the change next time its tab
// gains focus (see the useFocusEffect in ambush.tsx) since it's a separate
// mounted screen this module has no direct handle to.
export async function restoreBackupPayload(payload: BackupPayload): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(PORTFOLIO_TICKERS_STORAGE_KEY, JSON.stringify(payload.portfolio)),
    AsyncStorage.setItem(AMBUSH_TICKERS_STORAGE_KEY, JSON.stringify(payload.ambush)),
  ]);
}
