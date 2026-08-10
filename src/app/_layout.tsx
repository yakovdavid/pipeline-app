import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { ThemeProvider, usePipelineTheme } from '@/contexts/theme-context';

SplashScreen.preventAutoHideAsync();

// Separate from RootLayout below so it can call usePipelineTheme() — the
// hook needs to be inside <ThemeProvider>, not the component that renders it.
function RootLayoutContent() {
  const { colors } = usePipelineTheme();

  return (
    <>
      <AnimatedSplashOverlay />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      />
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <RootLayoutContent />
    </ThemeProvider>
  );
}
