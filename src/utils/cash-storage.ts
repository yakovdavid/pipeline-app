import AsyncStorage from '@react-native-async-storage/async-storage';

import { CASH_BALANCE_STORAGE_KEY, CASH_RECONCILIATION_STORAGE_KEY } from '@/constants/storage-keys';
import { roundToCents } from '@/utils/trade-execution';

// LIQUIDITY CORE: persistence for the USD buying-power balance.
//
// Never-saved means 0. Anything unreadable THROWS instead of returning 0:
// the Portfolio screen then blocks every cash change until a read
// succeeds, so a transient storage error can never let a trade or deposit
// overwrite the real saved balance (the same rule the portfolio list
// follows; see canPersistRef in app/(tabs)/index.tsx).

export function parseCashBalance(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? roundToCents(raw) : null;
}

export async function loadCashBalance(): Promise<number> {
  const stored = await AsyncStorage.getItem(CASH_BALANCE_STORAGE_KEY);
  if (stored === null) {
    return 0;
  }
  const value = parseCashBalance(JSON.parse(stored));
  if (value === null) {
    throw new Error('Stored cash balance is not a number.');
  }
  return value;
}

export async function saveCashBalance(value: number): Promise<void> {
  await AsyncStorage.setItem(CASH_BALANCE_STORAGE_KEY, JSON.stringify(roundToCents(value)));
}

// IBI CASH RECONCILIATION (2026-11-27, backlog P7): IBI is the source of
// truth for cash. A reconciliation sets the Pipeline balance to the exact
// figure IBI shows and records the correction, so the drift (fees, FX,
// interest or a missed entry) stays visible instead of being absorbed.
export type CashReconciliation = {
  reconciledAt: string;
  previousUsd: number;
  ibiUsd: number;
  deltaUsd: number;
};

// Kept for display and the backup; older entries beyond this are dropped.
const MAX_RECONCILIATIONS = 50;

function parseReconciliation(raw: unknown): CashReconciliation | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const previousUsd = parseCashBalance(value.previousUsd);
  const ibiUsd = parseCashBalance(value.ibiUsd);
  const deltaUsd = parseCashBalance(value.deltaUsd);
  if (typeof value.reconciledAt !== 'string' || previousUsd === null || ibiUsd === null || deltaUsd === null) {
    return null;
  }
  return { reconciledAt: value.reconciledAt, previousUsd, ibiUsd, deltaUsd };
}

// Null when `raw` isn't a list (e.g. a backup from before this feature).
export function parseCashReconciliations(raw: unknown): CashReconciliation[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  return raw.map(parseReconciliation).filter((entry): entry is CashReconciliation => entry !== null);
}

export async function loadCashReconciliations(): Promise<CashReconciliation[]> {
  const stored = await AsyncStorage.getItem(CASH_RECONCILIATION_STORAGE_KEY);
  return stored === null ? [] : (parseCashReconciliations(JSON.parse(stored)) ?? []);
}

export async function saveCashReconciliations(entries: CashReconciliation[]): Promise<void> {
  await AsyncStorage.setItem(
    CASH_RECONCILIATION_STORAGE_KEY,
    JSON.stringify(entries.slice(-MAX_RECONCILIATIONS)),
  );
}

export function buildCashReconciliation(previousUsd: number, ibiUsd: number, now: Date): CashReconciliation {
  const previous = roundToCents(previousUsd);
  const ibi = roundToCents(ibiUsd);
  return { reconciledAt: now.toISOString(), previousUsd: previous, ibiUsd: ibi, deltaUsd: roundToCents(ibi - previous) };
}
