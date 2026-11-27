// AsyncStorage keys shared across screens (Ambush Radar persists its own
// watchlist; the Portfolio screen's "Copy ALL Data" export reads it too).
export const AMBUSH_TICKERS_STORAGE_KEY = '@pipeline/watchlist_tickers';
export const PORTFOLIO_TICKERS_STORAGE_KEY = '@pipeline/portfolio_tickers';

// LIQUIDITY CORE: the available buying power in USD, stored as a plain
// JSON number. The 30,000 ILS emergency reserve is never part of it: this
// is only the cash that can actually be invested.
export const CASH_BALANCE_STORAGE_KEY = '@pipeline/cash_balance';

// EXECUTION RECONCILIATION: the append-only log of confirmed buys and
// sells (see @/utils/execution-ledger).
export const EXECUTION_LEDGER_STORAGE_KEY = '@pipeline/execution_ledger';

// User's Light/Dark mode preference for the Pipeline screens (see
// ThemeContext). Stored as the literal string 'light' | 'dark' rather than
// a boolean so the raw AsyncStorage value is self-describing if inspected.
export const THEME_PREFERENCE_STORAGE_KEY = '@pipeline/theme_preference';

// User's UI language preference (see LanguageContext). Stored as the
// literal string 'he' | 'en' — same self-describing rationale as the theme
// preference above. Deliberately NOT read/written via I18nManager (RN's
// own RTL layout direction setting): that requires a full app reload to
// take effect, whereas this toggle is meant to apply live.
export const LANGUAGE_PREFERENCE_STORAGE_KEY = '@pipeline/language_preference';

// DYNAMIC LAYER TARGETS: the user's Core/Satellite/Quality target
// allocation, a JSON object of percents summing to 100 (see
// @/utils/target-allocation-store). Never saved means the Fortress 2.0
// default, 70/20/10.
export const TARGET_ALLOCATION_STORAGE_KEY = '@pipeline/target_allocation';

// MANUAL MOAT (2026-11-27): the user's per-ticker moat rating, a JSON object
// { [ticker]: 'Wide' | 'Narrow' | 'None' | 'Unrated' } (see
// @/utils/moat-store). Never saved means the approved seed values.
export const MOAT_RATINGS_STORAGE_KEY = '@pipeline/moat_ratings';

// FUNDAMENTAL AUDIT LATCH (2026-11-27): per-ticker audit latch state, a
// JSON object { [ticker]: AuditLatch } (see @/utils/audit-latch-store).
export const AUDIT_LATCHES_STORAGE_KEY = '@pipeline/audit_latches';

// IBI CASH RECONCILIATION (2026-11-27): the log of manual reconciliations
// of the cash balance to IBI, the source of truth (see @/utils/cash-storage).
export const CASH_RECONCILIATION_STORAGE_KEY = '@pipeline/cash_reconciliations';
