// AsyncStorage keys shared across screens (Ambush Radar persists its own
// watchlist; the Portfolio screen's "Copy ALL Data" export reads it too).
export const AMBUSH_TICKERS_STORAGE_KEY = '@pipeline/watchlist_tickers';
export const PORTFOLIO_TICKERS_STORAGE_KEY = '@pipeline/portfolio_tickers';

// User's Light/Dark mode preference for the Pipeline screens (see
// ThemeContext). Stored as the literal string 'light' | 'dark' rather than
// a boolean so the raw AsyncStorage value is self-describing if inspected.
export const THEME_PREFERENCE_STORAGE_KEY = '@pipeline/theme_preference';
