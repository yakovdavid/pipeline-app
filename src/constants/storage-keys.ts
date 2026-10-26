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
