import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

// ANDROID BACKGROUND/FOREGROUND DATA HYDRATION FIX: when the OS suspends
// an in-flight network request (or throttles the JS engine entirely) while
// the app is backgrounded, that request can fail or simply never resolve
// — but the data on screen (and in AsyncStorage) must never be wiped
// because of it. This hook is the OTHER half of that fix: once the app
// comes back to the foreground, it re-triggers a fresh fetch so the
// Portfolio/Ambush screens actually re-sync with the server instead of
// silently sitting on whatever (possibly stale, possibly never-loaded)
// data survived the background period.
//
// Shared by both PortfolioScreen and AmbushRadarScreen (index.tsx /
// ambush.tsx) — each screen owns its own data and passes its own
// "refetch everything" callback; this hook only knows about AppState
// transitions, never about what a refetch actually does.
export function useAppForegroundRefresh(onForeground: () => void): void {
  // AppState.currentState is the SDK's own live value — seeding the ref
  // with it (rather than a hardcoded 'active') avoids a false-positive
  // "returning from background" fire on first mount if the app happens to
  // mount while already backgrounded (e.g. a backgrounded cold start).
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // Always points at the LATEST onForeground closure (updated after every
  // render, not just on mount) so the AppState listener — registered once
  // and never re-subscribed — never calls a stale closure that captured
  // an old `stocks`/`entries` snapshot from the render it was created in.
  // Updated inside an effect (not written directly in the render body) —
  // mutating a ref during render itself isn't safe under React's rules,
  // even though the ref's VALUE is never read until later, from the
  // AppState callback below.
  const onForegroundRef = useRef(onForeground);
  useEffect(() => {
    onForegroundRef.current = onForeground;
  });

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      // The exact transition that matters: the app was inactive/backgrounded
      // and has just become active again — NOT every AppState change (e.g.
      // active -> inactive, the OUTBOUND transition, must not re-trigger a
      // fetch).
      if (appStateRef.current.match(/inactive|background/) && nextAppState === 'active') {
        onForegroundRef.current();
      }
      appStateRef.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, []);
}
