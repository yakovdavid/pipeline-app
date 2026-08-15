import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { LANGUAGE_PREFERENCE_STORAGE_KEY } from '@/constants/storage-keys';

export type Language = 'he' | 'en';

type LanguageContextValue = {
  language: Language;
  // Convenience flag for the handful of call sites that only need to know
  // "is this Hebrew" rather than the specific language value.
  isRTL: boolean;
  setLanguage: (language: Language) => void;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

// DYNAMIC LANGUAGE TOGGLE (no app restart): deliberately NOT built on React
// Native's I18nManager.forceRTL/allowRTL — that's the "real" native RTL
// layout direction, but flipping it only takes effect after the app is
// fully reloaded, which would make a simple in-app language switch feel
// broken. Instead, every screen that needs to react to the language reads
// this context directly and binds its own flexDirection/textAlign/
// writingDirection per render (e.g. `language === 'he' ? 'row-reverse' :
// 'row'`) — an ordinary React re-render, so switching is instant.
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

  const value = useMemo<LanguageContextValue>(
    () => ({ language, isRTL: language === 'he', setLanguage }),
    [language, setLanguage],
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
