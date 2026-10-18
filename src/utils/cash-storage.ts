import AsyncStorage from '@react-native-async-storage/async-storage';

import { CASH_BALANCE_STORAGE_KEY } from '@/constants/storage-keys';
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
