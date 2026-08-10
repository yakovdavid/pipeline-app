import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { DarkPipelineColors, LightPipelineColors, type PipelineColorScheme } from '@/constants/pipeline-colors';
import { THEME_PREFERENCE_STORAGE_KEY } from '@/constants/storage-keys';

type ThemeContextValue = {
  isDarkMode: boolean;
  colors: PipelineColorScheme;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

// Wraps the whole app (see app/_layout.tsx) so Portfolio and Ambush Radar —
// separately mounted screens under the tabs navigator, with no state of
// their own in common — share one live theme instead of each guessing
// independently, and so the toggle in Portfolio's header menu is instantly
// reflected on Ambush Radar too, no navigation/refocus required.
export function ThemeProvider({ children }: { children: ReactNode }) {
  // Defaults to dark (the app's original, only theme before this toggle
  // existed) until the persisted preference, if any, has been read — this
  // avoids a light-mode flash for existing users who never set one.
  const [isDarkMode, setIsDarkMode] = useState(true);

  // Load the persisted preference once on mount. A missing key (first
  // launch, or an existing user who never toggled it) or a read/parse
  // failure both just mean "no preference to apply" — the dark default
  // above stands; this is never treated as an error the user needs to see.
  useEffect(() => {
    let isMounted = true;

    AsyncStorage.getItem(THEME_PREFERENCE_STORAGE_KEY)
      .then((stored) => {
        if (isMounted && (stored === 'light' || stored === 'dark')) {
          setIsDarkMode(stored === 'dark');
        }
      })
      .catch((error) => {
        console.error('[theme] Failed to read the saved theme preference; using the default.', error);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const toggleTheme = useCallback(() => {
    setIsDarkMode((previous) => {
      const next = !previous;
      AsyncStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, next ? 'dark' : 'light').catch((error) => {
        console.warn('[theme] Failed to save the theme preference:', error);
      });
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      isDarkMode,
      colors: isDarkMode ? DarkPipelineColors : LightPipelineColors,
      toggleTheme,
    }),
    [isDarkMode, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// Throws (rather than returning a silent dark-mode fallback) if called
// outside ThemeProvider — every Pipeline screen/component that reads
// theme colors is expected to be mounted under it via the root layout, so
// a missing provider is a real bug worth surfacing loudly, not papering
// over with a default that would just look wrong.
export function usePipelineTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error('usePipelineTheme() must be used within a <ThemeProvider>.');
  }
  return context;
}
