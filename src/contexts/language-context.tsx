import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { LANGUAGE_PREFERENCE_STORAGE_KEY } from '@/constants/storage-keys';

export type Language = 'he' | 'en';

// ROBUST LANGUAGE CONTEXT: every on-screen string this app shows is a key
// into TRANSLATIONS below (see t() on the context value) rather than a
// scattered set of per-component Hebrew/English maps — one dictionary is
// the single source of truth for what's translatable and what each
// language's copy actually says. RUTHLESS LOCALIZATION AUDIT: this now
// covers every visible string across both screens (headers, loading
// states, menus, modals, Alerts, placeholders) — not just the original
// pass's tabs/section-headers/StockCard subset — so switching to English
// leaves zero Hebrew text on screen anywhere in the app.
export type TranslationKey =
  | 'portfolio'
  | 'ambushRadar'
  | 'core'
  | 'satellite'
  | 'quality'
  | 'all'
  | 'addAsset'
  | 'stock'
  | 'etf'
  | 'units'
  | 'atPrice'
  | 'ag'
  | 'sma50'
  | 'sma200'
  | 'macroTrend'
  | 'tacticalMomentum'
  | 'high52'
  | 'drop'
  | 'target'
  | 'actual'
  | 'assets'
  | 'review'
  | 'bullish'
  | 'bearish'
  | 'notAvailable'
  | 'insufficientMomentumData'
  | 'structuralStopWarning'
  // Loading states
  | 'loadingPortfolio'
  | 'loadingAmbush'
  // Portfolio: empty state, menu, headers
  | 'noPositionsYet'
  | 'copyPortfolioData'
  | 'copyAllData'
  | 'exportBackupJson'
  | 'importBackupJson'
  | 'intelOnDemand'
  | 'importBackupTitle'
  | 'pasteBackupJsonLabel'
  | 'pasteBackupPlaceholder'
  | 'restore'
  | 'tickersCommaSeparatedLabel'
  | 'tickersPlaceholderExample'
  | 'fetchIntel'
  | 'errorPrefix'
  | 'noNewsForTicker'
  | 'criticalAlertTag'
  | 'readFullArticle'
  | 'copyIntel'
  | 'trailingStopActivatedAt'
  // Add/Edit Asset modal
  | 'category'
  | 'assetType'
  | 'addToPortfolio'
  | 'unitsPlaceholder'
  | 'totalValueInBank'
  // Ambush Radar screen chrome
  | 'copyAmbushData'
  | 'add'
  | 'addTickerPlaceholder'
  // Shared Alert dialogs (title/message pairs, some parameterized via {{ticker}})
  | 'invalidUnitsTitle'
  | 'invalidUnitsMessage'
  | 'cannotAddTickerTitle'
  | 'fetchFailedForTicker'
  | 'copiedTitle'
  | 'portfolioDataCopiedMessage'
  | 'copyFailedTitle'
  | 'copyPortfolioFailedMessage'
  | 'allDataCopiedMessage'
  | 'combinedExportFailedMessage'
  | 'backupExportedTitle'
  | 'backupExportedMessage'
  | 'backupExportFailedMessage'
  | 'exportFailedTitle'
  | 'invalidBackupTitle'
  | 'invalidBackupMessage'
  | 'backupRestoredTitle'
  | 'backupRestoredPricesFailedMessage'
  | 'backupRestoredMessage'
  | 'restoreFailedTitle'
  | 'backupRestoreFailedMessage'
  | 'tickerRequiredTitle'
  | 'tickerRequiredMessage'
  | 'noNewsFoundTitle'
  | 'noNewsFoundMessage'
  | 'intelFetchFailedTitle'
  | 'intelFetchFailedMessage'
  | 'cannotOpenLinkTitle'
  | 'cannotOpenLinkMessage'
  | 'intelCopiedMessage'
  | 'intelCopyFailedMessage'
  | 'ambushDataCopiedMessage'
  | 'ambushCopyFailedMessage';

// t(key, params?) — params are substituted into `{{paramName}}` tokens in
// the resolved string (e.g. 'fetchFailedForTicker': "Failed to fetch data
// for {{ticker}}." + { ticker: 'AAPL' } => "Failed to fetch data for
// AAPL."). Plain object lookup + substitution, not a template engine —
// every dictionary value is already a complete, final string per language.
export type TFunction = (key: TranslationKey, params?: Record<string, string | number>) => string;

const TRANSLATIONS: Record<Language, Record<TranslationKey, string>> = {
  he: {
    portfolio: 'תיק השקעות',
    ambushRadar: 'מכ״ם מארבים',
    core: 'ליבה',
    satellite: 'לוויינים',
    quality: 'איכות',
    all: 'הכל',
    addAsset: 'הוסף נכס',
    stock: 'מניה',
    etf: 'תעודת סל',
    units: "יח'",
    atPrice: 'ב-',
    ag: "אג'",
    sma50: 'מ.נ 50',
    sma200: 'מ.נ 200',
    macroTrend: 'מגמה כללית',
    tacticalMomentum: 'מומנטום טקטי',
    high52: 'שיא 52 שבועות',
    drop: 'ירידה',
    target: 'יעד',
    actual: 'מצוי',
    assets: 'נכסים',
    review: 'לבדיקה',
    bullish: 'עולה',
    bearish: 'יורד',
    notAvailable: 'לא זמין',
    insufficientMomentumData: 'אין מספיק נתוני ממוצע נע',
    structuralStopWarning: '⚠ אזהרת עצירה מבנית: במרחק 2% מתמיכת ממוצע 200 יום',
    loadingPortfolio: 'טוען את התיק שלך...',
    loadingAmbush: 'טוען את רשימת המעקב שלך...',
    noPositionsYet: 'אין עדיין פוזיציות.',
    copyPortfolioData: 'העתק נתוני תיק',
    copyAllData: 'העתק את כל הנתונים',
    exportBackupJson: 'ייצוא גיבוי (JSON)',
    importBackupJson: 'ייבוא גיבוי (JSON)',
    intelOnDemand: 'מודיעין לפי דרישה',
    importBackupTitle: 'ייבוא גיבוי',
    pasteBackupJsonLabel: 'הדבק JSON של גיבוי',
    pasteBackupPlaceholder: 'הדבק כאן את ה-JSON שהועתק מייצוא הגיבוי...',
    restore: 'שחזר',
    tickersCommaSeparatedLabel: 'טיקרים (מופרדים בפסיקים)',
    tickersPlaceholderExample: 'לדוגמה: PLD, UNH, AMT',
    fetchIntel: 'שלוף מודיעין',
    errorPrefix: 'שגיאה',
    noNewsForTicker: 'לא נמצאו חדשות עבור {{ticker}}.',
    criticalAlertTag: '[התראה קריטית]',
    readFullArticle: 'קרא כתבה מלאה ←',
    copyIntel: 'העתק מודיעין',
    trailingStopActivatedAt: 'עצירה נגררת מופעלת ב',
    category: 'קטגוריה',
    assetType: 'סוג נכס',
    addToPortfolio: 'הוסף לתיק',
    unitsPlaceholder: 'יחידות',
    totalValueInBank: 'שווי כולל בבנק (₪/$) - אופציונלי',
    copyAmbushData: 'העתק נתוני מארב',
    add: 'הוסף',
    addTickerPlaceholder: 'הוסף טיקר (למשל MSFT)',
    invalidUnitsTitle: 'יחידות לא תקינות',
    invalidUnitsMessage: 'נא להזין מספר יחידות חיובי.',
    cannotAddTickerTitle: 'לא ניתן להוסיף טיקר',
    fetchFailedForTicker: 'שליפת הנתונים עבור {{ticker}} נכשלה.',
    copiedTitle: 'הועתק',
    portfolioDataCopiedMessage: 'נתוני התיק הועתקו ללוח.',
    copyFailedTitle: 'ההעתקה נכשלה',
    copyPortfolioFailedMessage: 'לא ניתן היה להעתיק את נתוני התיק ללוח.',
    allDataCopiedMessage: 'נתוני התיק והמארב הועתקו יחד ללוח.',
    combinedExportFailedMessage: 'יצירת ייצוא הנתונים המשולב נכשלה.',
    backupExportedTitle: 'הגיבוי יוצא',
    backupExportedMessage: 'נתוני התיק והמארב הועתקו ללוח כ-JSON. הדבק אותם במקום בטוח.',
    backupExportFailedMessage: 'ייצוא הגיבוי נכשל.',
    exportFailedTitle: 'הייצוא נכשל',
    invalidBackupTitle: 'גיבוי לא תקין',
    invalidBackupMessage: 'הטקסט שהודבק אינו גיבוי תקין.',
    backupRestoredTitle: 'הגיבוי שוחזר',
    backupRestoredPricesFailedMessage:
      'הנתונים נשמרו, אך לא ניתן היה לטעון מחירים חיים כרגע. משוך לרענון בעוד רגע.',
    backupRestoredMessage: 'נתוני התיק והמארב שוחזרו.',
    restoreFailedTitle: 'השחזור נכשל',
    backupRestoreFailedMessage: 'שחזור הגיבוי נכשל.',
    tickerRequiredTitle: 'נדרש טיקר',
    tickerRequiredMessage: 'נא להזין לפחות סימול טיקר אחד.',
    noNewsFoundTitle: 'לא נמצאו חדשות',
    noNewsFoundMessage: 'לא נמצאו חדשות אחרונות עבור הטיקרים המבוקשים.',
    intelFetchFailedTitle: 'שליפת המודיעין נכשלה',
    intelFetchFailedMessage: 'שליפת המודיעין נכשלה.',
    cannotOpenLinkTitle: 'לא ניתן לפתוח את הקישור',
    cannotOpenLinkMessage: 'לא ניתן היה לפתוח את קישור הכתבה.',
    intelCopiedMessage: 'כותרות המודיעין הועתקו ללוח.',
    intelCopyFailedMessage: 'לא ניתן היה להעתיק את המודיעין ללוח.',
    ambushDataCopiedMessage: 'נתוני מכ״ם המארבים הועתקו ללוח.',
    ambushCopyFailedMessage: 'לא ניתן היה להעתיק את נתוני מכ״ם המארבים ללוח.',
  },
  en: {
    portfolio: 'Portfolio',
    ambushRadar: 'Ambush Radar',
    core: 'Core',
    satellite: 'Satellite',
    quality: 'Quality',
    all: 'All',
    addAsset: 'Add Asset',
    stock: 'Stock',
    etf: 'ETF',
    units: 'units',
    atPrice: '@',
    ag: 'Ag.',
    sma50: 'SMA50',
    sma200: 'SMA200',
    macroTrend: 'Macro Trend',
    tacticalMomentum: 'Tactical Momentum',
    high52: '52-Week High',
    drop: 'Drop',
    target: 'Target',
    actual: 'Actual',
    assets: 'Assets',
    review: 'Review',
    bullish: 'Bullish',
    bearish: 'Bearish',
    notAvailable: 'N/A',
    insufficientMomentumData: 'Not enough moving-average data',
    structuralStopWarning: '⚠ Structural Stop Warning: within 2% of 200-day support',
    loadingPortfolio: 'Loading your portfolio...',
    loadingAmbush: 'Loading ambush radar...',
    noPositionsYet: 'No positions yet.',
    copyPortfolioData: 'Copy Portfolio Data',
    copyAllData: 'Copy All Data',
    exportBackupJson: 'Export Backup (JSON)',
    importBackupJson: 'Import Backup (JSON)',
    intelOnDemand: 'On-Demand Intel',
    importBackupTitle: 'Import Backup',
    pasteBackupJsonLabel: 'Paste backup JSON',
    pasteBackupPlaceholder: 'Paste the JSON copied from the backup export here...',
    restore: 'Restore',
    tickersCommaSeparatedLabel: 'Tickers (comma-separated)',
    tickersPlaceholderExample: 'e.g. PLD, UNH, AMT',
    fetchIntel: 'Fetch Intel',
    errorPrefix: 'Error',
    noNewsForTicker: 'No news found for {{ticker}}.',
    criticalAlertTag: '[CRITICAL ALERT]',
    readFullArticle: 'Read full article →',
    copyIntel: 'Copy Intel',
    trailingStopActivatedAt: 'Trailing stop activated at',
    category: 'Category',
    assetType: 'Asset Type',
    addToPortfolio: 'Add to Portfolio',
    unitsPlaceholder: 'Units',
    totalValueInBank: 'Total Value in Bank (ILS/USD) - optional',
    copyAmbushData: 'Copy Ambush Data',
    add: 'Add',
    addTickerPlaceholder: 'Add ticker (e.g. MSFT)',
    invalidUnitsTitle: 'Invalid Units',
    invalidUnitsMessage: 'Please enter a positive number of units.',
    cannotAddTickerTitle: 'Cannot Add Ticker',
    fetchFailedForTicker: 'Failed to fetch data for {{ticker}}.',
    copiedTitle: 'Copied',
    portfolioDataCopiedMessage: 'Portfolio data copied to the clipboard.',
    copyFailedTitle: 'Copy Failed',
    copyPortfolioFailedMessage: 'Could not copy the portfolio data to the clipboard.',
    allDataCopiedMessage: 'Portfolio and Ambush Radar data copied together to the clipboard.',
    combinedExportFailedMessage: 'Failed to build the combined data export.',
    backupExportedTitle: 'Backup Exported',
    backupExportedMessage:
      'The portfolio and Ambush Radar data were copied to the clipboard as JSON. Paste them somewhere safe.',
    backupExportFailedMessage: 'Failed to export the backup.',
    exportFailedTitle: 'Export Failed',
    invalidBackupTitle: 'Invalid Backup',
    invalidBackupMessage: 'The pasted text is not a valid backup.',
    backupRestoredTitle: 'Backup Restored',
    backupRestoredPricesFailedMessage:
      'The data was saved, but live prices could not be loaded right now. Pull to refresh in a moment.',
    backupRestoredMessage: 'The Portfolio and Ambush Radar data were restored.',
    restoreFailedTitle: 'Restore Failed',
    backupRestoreFailedMessage: 'Failed to restore the backup.',
    tickerRequiredTitle: 'Ticker Required',
    tickerRequiredMessage: 'Please enter at least one ticker symbol.',
    noNewsFoundTitle: 'No News Found',
    noNewsFoundMessage: 'No recent news was found for the requested tickers.',
    intelFetchFailedTitle: 'Intel Fetch Failed',
    intelFetchFailedMessage: 'Failed to fetch intel.',
    cannotOpenLinkTitle: 'Cannot Open Link',
    cannotOpenLinkMessage: 'Could not open the article link.',
    intelCopiedMessage: 'Intel headlines copied to the clipboard.',
    intelCopyFailedMessage: 'Could not copy the intel to the clipboard.',
    ambushDataCopiedMessage: 'Ambush Radar data copied to the clipboard.',
    ambushCopyFailedMessage: 'Could not copy the Ambush Radar data to the clipboard.',
  },
};

type LanguageContextValue = {
  language: Language;
  // Convenience flag for the handful of call sites that only need to know
  // "is this Hebrew" rather than the specific language value.
  isRTL: boolean;
  setLanguage: (language: Language) => void;
  t: TFunction;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

// DYNAMIC LANGUAGE TOGGLE (no app restart): deliberately NOT built on React
// Native's I18nManager.forceRTL/allowRTL — that's the "real" native RTL
// layout direction, but flipping it only takes effect after the app is
// fully reloaded, which would make a simple in-app language switch feel
// broken. Instead, every screen that needs to react to the language reads
// this context directly and binds its own flexDirection/textAlign/
// writingDirection (and, via t(), its own text) per render — an ordinary
// React re-render, so switching is instant and the WHOLE app re-renders in
// the selected language immediately, not just the piece the user tapped.
//
// Wraps the whole app (see app/_layout.tsx, above even ThemeProvider — the
// entire Stack/Tabs navigation tree renders underneath it) so every screen
// and every nested navigator option (tab titles included) can call t().
export function LanguageProvider({ children }: { children: ReactNode }) {
  // Defaults to Hebrew (the app's original, only language before this
  // toggle existed) until the persisted preference, if any, has been read —
  // avoids an English-UI flash for existing users who never set one.
  const [language, setLanguageState] = useState<Language>('he');

  // Load the persisted preference once on mount. A missing key (first
  // launch, or an existing user who never toggled it) or a read/parse
  // failure both just mean "no preference to apply" — the Hebrew default
  // above stands; this is never treated as an error the user needs to see.
  useEffect(() => {
    let isMounted = true;

    AsyncStorage.getItem(LANGUAGE_PREFERENCE_STORAGE_KEY)
      .then((stored) => {
        if (isMounted && (stored === 'he' || stored === 'en')) {
          setLanguageState(stored);
        }
      })
      .catch((error) => {
        console.error(
          '[language] Failed to read the saved language preference; using the default.',
          error,
        );
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    AsyncStorage.setItem(LANGUAGE_PREFERENCE_STORAGE_KEY, next).catch((error) => {
      console.warn('[language] Failed to save the language preference:', error);
    });
  }, []);

  // Re-created only when `language` actually changes, so t() has the same
  // referential-stability profile as `language` itself — components that
  // take it as a memo()/useCallback dependency (see PortfolioStockRow in
  // index.tsx) re-render exactly when the language does, no more, no less.
  const t = useCallback<TFunction>(
    (key, params) => {
      const template = TRANSLATIONS[language][key];
      if (!params) {
        return template;
      }
      return Object.entries(params).reduce(
        (result, [paramKey, paramValue]) => result.split(`{{${paramKey}}}`).join(String(paramValue)),
        template,
      );
    },
    [language],
  );

  const value = useMemo<LanguageContextValue>(
    () => ({ language, isRTL: language === 'he', setLanguage, t }),
    [language, setLanguage, t],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

// Throws (rather than returning a silent Hebrew fallback) if called outside
// LanguageProvider — every Pipeline screen/component that reads the active
// language is expected to be mounted under it via the root layout, so a
// missing provider is a real bug worth surfacing loudly, not papering over.
export function usePipelineLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (context === null) {
    throw new Error('usePipelineLanguage() must be used within a <LanguageProvider>.');
  }
  return context;
}
