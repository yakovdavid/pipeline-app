import AsyncStorage from '@react-native-async-storage/async-storage';

import { EXECUTION_LEDGER_STORAGE_KEY } from '@/constants/storage-keys';
import { roundToCents } from '@/utils/trade-execution';

// EXECUTION RECONCILIATION LEDGER: an append-only, on-device record of
// every confirmed buy and sell, exactly as entered from the broker's fill
// (quantity, price, fee), with the USD amount that moved and the buying
// power left afterwards. The position and the cash balance are updated by
// the trade itself (commitTrade / commitSale in app/(tabs)/index.tsx);
// this log is what makes the result checkable line by line against the
// broker statement, and the only place broker fees are recorded on their
// own (cost and proceeds include them).
//
// Persistence follows the app's no-wipe rule: an append first reads the
// stored log, and if that read fails it does NOT write (writing a fresh
// list over an unreadable one could erase the real history). Appends are
// serialized through a promise queue, so two quick trades can't overwrite
// each other's read-modify-write.

export type ExecutionSide = 'buy' | 'sell';

export type ExecutionRecord = {
  id: string;
  // ISO-8601, when the trade was logged in the app.
  executedAt: string;
  ticker: string;
  side: ExecutionSide;
  quantity: number;
  // Exactly as typed: Agorot for ".TA", otherwise the instrument currency.
  price: number;
  priceUnit: string;
  // Broker fee in the instrument's currency, and its USD value.
  feeLocal: number;
  feeUsd: number;
  currencySymbol: string;
  // Total Cost (buy) or Net Proceeds (sell), USD.
  amountUsd: number;
  // Buying power right after this execution.
  cashAfterUsd: number;
};

// Oldest entries are dropped beyond this, to keep storage bounded.
export const EXECUTION_LEDGER_MAX_ENTRIES = 500;

export function isExecutionRecord(value: unknown): value is ExecutionRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.executedAt === 'string' &&
    typeof record.ticker === 'string' &&
    (record.side === 'buy' || record.side === 'sell') &&
    typeof record.quantity === 'number' &&
    typeof record.price === 'number' &&
    typeof record.priceUnit === 'string' &&
    typeof record.feeLocal === 'number' &&
    typeof record.feeUsd === 'number' &&
    typeof record.currencySymbol === 'string' &&
    typeof record.amountUsd === 'number' &&
    typeof record.cashAfterUsd === 'number'
  );
}

// Never-saved -> []. Throws on unreadable storage (see header).
export async function loadExecutionLedger(): Promise<ExecutionRecord[]> {
  const stored = await AsyncStorage.getItem(EXECUTION_LEDGER_STORAGE_KEY);
  if (stored === null) {
    return [];
  }
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed)) {
    throw new Error('Stored execution ledger is not an array.');
  }
  return parsed.filter(isExecutionRecord);
}

let appendQueue: Promise<unknown> = Promise.resolve();

// Appends one record; resolves to the full updated log (newest last).
export function appendExecution(record: ExecutionRecord): Promise<ExecutionRecord[]> {
  const run = appendQueue.then(async () => {
    const existing = await loadExecutionLedger();
    const updated = [...existing, record].slice(-EXECUTION_LEDGER_MAX_ENTRIES);
    await AsyncStorage.setItem(EXECUTION_LEDGER_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  });
  // A failed append must not block the ones queued after it.
  appendQueue = run.catch(() => undefined);
  return run;
}

// BACKUP RESTORE: replaces the whole stored log (capped like an append),
// queued behind any append still in flight so the two can't interleave.
export function replaceExecutionLedger(records: readonly ExecutionRecord[]): Promise<ExecutionRecord[]> {
  const run = appendQueue.then(async () => {
    const capped = records.slice(-EXECUTION_LEDGER_MAX_ENTRIES);
    await AsyncStorage.setItem(EXECUTION_LEDGER_STORAGE_KEY, JSON.stringify(capped));
    return capped;
  });
  appendQueue = run.catch(() => undefined);
  return run;
}

// The valid records in an untrusted value (a backup file); malformed
// entries are dropped individually. Null when the value isn't an array at
// all (e.g. a backup made before the ledger existed).
export function parseExecutionRecords(raw: unknown): ExecutionRecord[] | null {
  return Array.isArray(raw) ? raw.filter(isExecutionRecord) : null;
}

export function createExecutionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function totalFeesUsd(records: readonly ExecutionRecord[]): number {
  return roundToCents(records.reduce((sum, record) => sum + record.feeUsd, 0));
}
