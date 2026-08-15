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

function normalizeAssetType(value: unknown): AssetType {
  return typeof value === 'string' && ASSET_TYPES.includes(value as AssetType) ? (value as AssetType) : 'Stock';
}

// A ticker is the one thing that can't be fabricated — everything else
// (category, units, watermark) has a safe default. Also accepts a bare
// string, since that's the legacy Ambush storage shape (see
// normalizeAmbushEntries in ambush-storage.ts) and older exports may carry
// it into either list.
function coercePortfolioEntry(value: unknown): PortfolioTickerEntry | null {
  if (typeof value === 'string') {
    const ticker = value.trim().toUpperCase();
    return ticker.length > 0
      ? { ticker, category: 'Satellite', assetType: 'Stock', units: 0, highestWatermark: null }
      : null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.ticker !== 'string' || entry.ticker.trim().length === 0) {
    return null;
  }
  return {
    ticker: entry.ticker.trim().toUpperCase(),
    category:
      typeof entry.category === 'string' && PORTFOLIO_CATEGORIES.includes(entry.category as PortfolioCategory)
        ? (entry.category as PortfolioCategory)
        : 'Satellite',
    assetType: normalizeAssetType(entry.assetType),
    units: typeof entry.units === 'number' && entry.units >= 0 ? entry.units : 0,
    highestWatermark: typeof entry.highestWatermark === 'number' ? entry.highestWatermark : null,
    // AUTO-CALIBRATION FOR BROKEN PRICES: must round-trip through backup
    // export/import same as every other persisted field — dropping it here
    // would silently un-calibrate a position (back to raw, possibly wildly
    // wrong Yahoo prices) the moment a user restores their own backup.
    // Missing/invalid/non-positive is left undefined rather than coerced to
    // 1.0 so calibrateQuote's DEFAULT_CALIBRATION_FACTOR fast path (skip
    // the math entirely) still applies for every entry that never had one.
    calibrationFactor:
      typeof entry.calibrationFactor === 'number' && entry.calibrationFactor > 0
        ? entry.calibrationFactor
        : undefined,
  };
}

// Ambush entries only ever need ticker + assetType, so any Portfolio-only
// fields present (category, units, highestWatermark) are simply ignored
// rather than causing a mismatch.
function coerceAmbushEntry(value: unknown): AmbushTickerEntry | null {
  if (typeof value === 'string') {
    const ticker = value.trim().toUpperCase();
    return ticker.length > 0 ? { ticker, assetType: 'Stock' } : null;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.ticker !== 'string' || entry.ticker.trim().length === 0) {
    return null;
  }
  return {
    ticker: entry.ticker.trim().toUpperCase(),
    assetType: normalizeAssetType(entry.assetType),
  };
}

// Coerces each entry individually instead of rejecting the whole list on
// the first mismatch. The previous all-or-nothing `.every(...)` check meant
// one Ambush entry missing a Portfolio-only field (or an older export's
// plain-string tickers) would throw away every other valid ticker in the
// same list — this repairs what it can and only drops entries with no
// usable ticker at all.
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

  if (!Array.isArray(payload.portfolio)) {
    throw new Error('Backup is missing a "portfolio" list.');
  }
  if (!Array.isArray(payload.ambush)) {
    throw new Error('Backup is missing an "ambush" list.');
  }

  const portfolio = payload.portfolio
    .map(coercePortfolioEntry)
    .filter((entry): entry is PortfolioTickerEntry => entry !== null);
  const ambush = payload.ambush
    .map(coerceAmbushEntry)
    .filter((entry): entry is AmbushTickerEntry => entry !== null);

  if (portfolio.length === 0 && payload.portfolio.length > 0) {
    throw new Error('None of the "portfolio" entries had a usable ticker symbol.');
  }
  if (ambush.length === 0 && payload.ambush.length > 0) {
    throw new Error('None of the "ambush" entries had a usable ticker symbol.');
  }

  return {
    schemaVersion: typeof payload.schemaVersion === 'number' ? payload.schemaVersion : BACKUP_SCHEMA_VERSION,
    exportedAt: typeof payload.exportedAt === 'string' ? payload.exportedAt : new Date().toISOString(),
    portfolio,
    ambush,
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
