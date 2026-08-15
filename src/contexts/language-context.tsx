import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { LANGUAGE_PREFERENCE_STORAGE_KEY } from '@/constants/storage-keys';

export type Language = 'he' | 'en';

// ROBUST LANGUAGE CONTEXT: every on-screen string this app translates is a
// key into TRANSLATIONS below (see t() on the context value) rather than a
// scattered set of per-component Hebrew/English maps — one dictionary is
// the single source of truth for what's translatable and what each
// language's copy actually says.
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
  | 'structuralStopWarning';

export type TFunction = (key: TranslationKey) => string;

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
  },
};

type LanguageContextValue = {
  language: Language;
  // Convenience flag for the handful of call sites that only need to know
  // "is this Hebrew" rather than the specific language value.
  isRTL: boolean;
  setLanguage: (language: Language) => void;
  // ROBUST LANGUAGE CONTEXT: t(key) looks up the active language's copy for
  // `key` in TRANSLATIONS above. A plain object lookup, not a template
  // engine — every value is already a complete, final string per language
  // (no runtime interpolation inside the dictionary itself), so callers
  // build any surrounding numbers/punctuation themselves and only reach
  // into t() for the translated words.
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
// Wraps the whole app (see app/_layout.tsx) so Portfolio and Ambush Radar —
// separately mounted screens under the tabs navigator, with no state of
// their own in common — share one live language instead of each guessing
// independently, mirroring ThemeContext's own reasoning exactly.
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
  const t = useCallback<TFunction>((key) => TRANSLATIONS[language][key], [language]);

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
