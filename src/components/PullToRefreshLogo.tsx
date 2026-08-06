import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { PipelineColors } from '@/constants/pipeline-colors';

type PullToRefreshLogoProps = {
  isRefreshing: boolean;
};

// Stands in for the OS's native pull-to-refresh spinner. The screens that
// render this pair it with tintColor="transparent"/colors={['transparent']}
// on their RefreshControl, so the native spinner stays invisible while its
// pull gesture and scroll offset still drive the refresh — this is purely
// the on-brand visual replacement, spun for as long as isRefreshing is true.
export function PullToRefreshLogo({ isRefreshing }: PullToRefreshLogoProps) {
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
    <View style={styles.container} pointerEvents="none">
      <Animated.View style={[styles.badge, { transform: [{ rotate }] }]}>
        <Ionicons name="pulse" size={18} color={PipelineColors.textPrimary} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 10,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 20,
  },
  badge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: PipelineColors.core,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
});
