import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  AMBUSH_TICKERS_STORAGE_KEY,
  CASH_BALANCE_STORAGE_KEY,
  PORTFOLIO_TICKERS_STORAGE_KEY,
} from '@/constants/storage-keys';
import type { AmbushTickerEntry } from '@/types/ambush';
import type { AssetType } from '@/types/asset';
import type { PortfolioCategory, PortfolioTickerEntry } from '@/types/portfolio';
import {
  loadCashReconciliations,
  parseCashBalance,
  parseCashReconciliations,
  saveCashBalance,
  saveCashReconciliations,
  type CashReconciliation,
} from '@/utils/cash-storage';
import {
  ensureAuditLatchesLoaded,
  getAuditLatches,
  parseAuditLatches,
  replaceAuditLatches,
  type AuditLatches,
} from '@/utils/audit-latch-store';
import {
  ensureMoatRatingsLoaded,
  getMoatRatingsState,
  parseMoatRatings,
  replaceMoatRatings,
  type MoatRatings,
} from '@/utils/moat-store';
import {
  loadExecutionLedger,
  parseExecutionRecords,
  replaceExecutionLedger,
  type ExecutionRecord,
} from '@/utils/execution-ledger';
import {
  ensureTargetAllocationsLoaded,
  getTargetAllocationState,
  parseTargetAllocations,
  saveTargetAllocations,
  type TargetAllocations,
} from '@/utils/target-allocation-store';

const BACKUP_SCHEMA_VERSION = 1;
const PORTFOLIO_CATEGORIES: PortfolioCategory[] = ['Core', 'Satellite', 'Quality'];
const ASSET_TYPES: AssetType[] = ['Stock', 'ETF'];

export type BackupPayload = {
  schemaVersion: number;
  exportedAt: string;
  portfolio: PortfolioTickerEntry[];
  ambush: AmbushTickerEntry[];
  // LIQUIDITY CORE: the USD buying power. Null when the backup predates
  // cash tracking; restoring such a backup leaves the current balance
  // untouched rather than zeroing it.
  cashBalance: number | null;
  // EXECUTION RECONCILIATION: the logged fills (see
  // @/utils/execution-ledger). Null when the backup predates the ledger;
  // restoring such a backup leaves the device's ledger untouched rather
  // than erasing it. An empty array is a real, empty ledger.
  executions: ExecutionRecord[] | null;
  // DYNAMIC LAYER TARGETS: the Core/Satellite/Quality targets (see
  // @/utils/target-allocation-store). Null when the backup predates them;
  // restoring such a backup leaves the device's targets untouched. An
  // invalid set fails parseBackupPayload (see parseBackupTargets).
  targetAllocations: TargetAllocations | null;
  // 2026-11-27 additions. Each is null when the backup predates it;
  // restoring such a backup leaves the device's value untouched.
  //   moatRatings: the manual per-ticker moat (P1).
  //   auditLatches: the FUNDAMENTAL AUDIT latch per ticker (P5), so a
  //     triggered, un-audited alert survives a device migration.
  //   cashReconciliations: the IBI reconciliation log (P7).
  moatRatings: MoatRatings | null;
  auditLatches: AuditLatches | null;
  cashReconciliations: CashReconciliation[] | null;
};

// Reads both screens' persisted ticker lists, the cash balance and the
// execution ledger directly from AsyncStorage (not live component state,
// which this module has no access to) into one exportable JSON object. An
// unreadable ledger fails the export, like an unreadable portfolio would,
// rather than producing a backup that silently lacks it.
//
// The target allocations are the ones in effect (the store's state, once
// the saved value has been read): never-set targets export as the 70/20/10
// default, so a migrated device ends up with exactly the targets the old
// one was using.
export async function createBackupPayload(): Promise<BackupPayload> {
  const [storedPortfolio, storedAmbush, storedCash, executions, cashReconciliations] = await Promise.all([
    AsyncStorage.getItem(PORTFOLIO_TICKERS_STORAGE_KEY),
    AsyncStorage.getItem(AMBUSH_TICKERS_STORAGE_KEY),
    AsyncStorage.getItem(CASH_BALANCE_STORAGE_KEY),
    loadExecutionLedger(),
    loadCashReconciliations(),
    ensureTargetAllocationsLoaded(),
    ensureMoatRatingsLoaded(),
    ensureAuditLatchesLoaded(),
  ]);

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    portfolio: storedPortfolio ? (JSON.parse(storedPortfolio) as PortfolioTickerEntry[]) : [],
    ambush: storedAmbush ? (JSON.parse(storedAmbush) as AmbushTickerEntry[]) : [],
    // Never-saved cash is a real balance of 0, not "unknown".
    cashBalance: storedCash ? parseCashBalance(JSON.parse(storedCash)) : 0,
    executions,
    targetAllocations: { ...getTargetAllocationState().targets },
    moatRatings: { ...getMoatRatingsState().ratings },
    auditLatches: { ...getAuditLatches() },
    cashReconciliations,
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
      ? {
          ticker,
          category: 'Satellite',
          assetType: 'Stock',
          units: 0,
          highestWatermarkLocal: null,
          highestWatermark: null,
          internalTargetPct: null,
          costBasisUsd: null,
          purchasePrice: null,
          historicalHWM: null,
          avgCostLocal: null,
        }
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
    // P2: the canonical local-currency peak. A backup from before it has
    // only the USD value, which is migrated at the first live quote.
    highestWatermarkLocal: positiveNumberOrNull(entry.highestWatermarkLocal),
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
    // A manual `roic` from an older backup is ignored: ROIC is fetched
    // automatically from FMP (GET /api/quality).
    // CORE LAYER INTERNAL ALLOCATION: must round-trip through backup
    // export/import same as every other persisted field — dropping it
    // here would silently wipe out a user-defined internal target the
    // moment a backup is restored.
    internalTargetPct: typeof entry.internalTargetPct === 'number' ? entry.internalTargetPct : null,
    // TRADE RECONCILIATION: the recorded execution cost must round-trip,
    // or restoring a backup would erase every position's cost basis.
    costBasisUsd:
      typeof entry.costBasisUsd === 'number' && Number.isFinite(entry.costBasisUsd) ? entry.costBasisUsd : null,
    // PROTECTION STATE: losing these on restore would silently switch a
    // position in Recovery State to trailing off its watermark.
    purchasePrice: positiveNumberOrNull(entry.purchasePrice),
    historicalHWM: positiveNumberOrNull(entry.historicalHWM),
    // P8: user-entered IBI average cost.
    avgCostLocal: positiveNumberOrNull(entry.avgCostLocal),
  };
}

function positiveNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

// Ambush entries only ever need ticker + assetType, so any Portfolio-only
// fields present (category, units, highestWatermark) are simply ignored
// rather than causing a mismatch.
function coerceAmbushEntry(value: unknown): AmbushTickerEntry | null {
  if (typeof value === 'string') {
    const ticker = value.trim().toUpperCase();
    return ticker.length > 0 ? { ticker, assetType: 'Stock', layer: 'Satellite' } : null;
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
    // UNIFIED RADAR: the layer must round-trip, or restoring a backup would
    // turn every Quality entry back into a Satellite. Older backups have no
    // layer and restore as Satellite, which is what they always were.
    layer: entry.layer === 'Quality' ? 'Quality' : 'Satellite',
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
    cashBalance: parseCashBalance(payload.cashBalance),
    // Malformed entries are dropped one by one; a missing or non-array
    // value means "no ledger in this backup" (null).
    executions: parseExecutionRecords(payload.executions),
    targetAllocations: parseBackupTargets(payload),
    moatRatings: 'moatRatings' in payload ? parseMoatRatings(payload.moatRatings) : null,
    auditLatches: 'auditLatches' in payload ? parseAuditLatches(payload.auditLatches) : null,
    cashReconciliations: parseCashReconciliations(payload.cashReconciliations),
  };
}

// STRICT BACKUP VALIDATION: an absent block (a backup from before targets
// existed) restores nothing, keeping the device's targets. A block that is
// present but invalid (not 0-100% each, not summing to 100%, a missing
// layer, or null) rejects the WHOLE import: skipping it would leave the
// device on targets the user never chose, possibly reopening a 0% layer.
function parseBackupTargets(payload: Record<string, unknown>): TargetAllocations | null {
  if (!('targetAllocations' in payload)) {
    return null;
  }
  const targets = parseTargetAllocations(payload.targetAllocations);
  if (targets === null) {
    throw new Error(
      'Backup has a corrupted "targetAllocations" block: Core, Satellite and Quality must each be 0-100% ' +
        'and sum to 100%. Nothing was restored.',
    );
  }
  return targets;
}

// Overwrites both screens' persisted storage. Portfolio's own live state is
// updated by the caller right after this (it's already mounted where the
// Import UI lives); Ambush Radar picks up the change next time its tab
// gains focus (see the useFocusEffect in ambush.tsx) since it's a separate
// mounted screen this module has no direct handle to. The target
// allocations are the exception: saveTargetAllocations publishes them to
// both screens at once, so the radar's locks update without a refocus.
export async function restoreBackupPayload(payload: BackupPayload): Promise<void> {
  await Promise.all([
    AsyncStorage.setItem(PORTFOLIO_TICKERS_STORAGE_KEY, JSON.stringify(payload.portfolio)),
    AsyncStorage.setItem(AMBUSH_TICKERS_STORAGE_KEY, JSON.stringify(payload.ambush)),
    ...(payload.cashBalance !== null ? [saveCashBalance(payload.cashBalance)] : []),
    ...(payload.executions !== null ? [replaceExecutionLedger(payload.executions)] : []),
    ...(payload.targetAllocations !== null ? [saveTargetAllocations(payload.targetAllocations)] : []),
    ...(payload.moatRatings !== null ? [replaceMoatRatings(payload.moatRatings)] : []),
    ...(payload.cashReconciliations !== null ? [saveCashReconciliations(payload.cashReconciliations)] : []),
  ]);
  if (payload.auditLatches !== null) {
    replaceAuditLatches(payload.auditLatches);
  }
}
