import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import type { PipelineColorScheme } from '@/constants/pipeline-colors';
import { usePipelineTheme } from '@/contexts/theme-context';

type PullToRefreshLogoProps = {
  isRefreshing: boolean;
  // true (default): absolutely positioned above a list, for the
  // pull-to-refresh case — the screens that use it this way pair it with
  // tintColor="transparent"/colors={['transparent']} on their RefreshControl
  // so the native OS spinner stays invisible underneath it.
  // false: laid out in normal flow, centered by its parent — for the
  // full-screen initial-load state, which has no list/RefreshControl to
  // overlay yet. Same badge, same spin, so this one component is the single
  // visual source of truth for "this screen is loading," on first mount and
  // on every pull-to-refresh.
  overlay?: boolean;
};

export function PullToRefreshLogo({ isRefreshing, overlay = true }: PullToRefreshLogoProps) {
  const { colors } = usePipelineTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [spinValue] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!isRefreshing) {
      spinValue.setValue(0);
      return;
    }

    const spinLoop = Animated.loop(
      Animated.timing(spinValue, {
        toValue: 1,
        duration: 850,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    spinLoop.start();

    return () => {
      spinLoop.stop();
    };
  }, [isRefreshing, spinValue]);

  if (!isRefreshing) {
    return null;
  }

  const rotate = spinValue.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View style={overlay ? styles.overlayContainer : styles.inlineContainer} pointerEvents="none">
      <Animated.View style={[styles.badge, { transform: [{ rotate }] }]}>
        <Ionicons name="pulse" size={18} color={colors.textPrimary} />
      </Animated.View>
    </View>
  );
}

// Factory (not a module-level StyleSheet.create) so it re-derives whenever
// the active theme changes — see the identical note in StockCard.tsx. The
// badge stays on `colors.core` in both themes (a fixed brand accent, not a
// background/surface color), so it doesn't need isDarkMode-specific tuning.
function createStyles(colors: PipelineColorScheme) {
  return StyleSheet.create({
    overlayContainer: {
      position: 'absolute',
      top: 10,
      left: 0,
      right: 0,
      alignItems: 'center',
      zIndex: 20,
    },
    inlineContainer: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    badge: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.core,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 2 },
      elevation: 4,
    },
  });
}
