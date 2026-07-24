import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PipelineColors } from '@/constants/pipeline-colors';

export default function TabsLayout() {
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      initialRouteName="ambush"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: PipelineColors.bullish,
        tabBarInactiveTintColor: PipelineColors.textSecondary,
        tabBarStyle: {
          backgroundColor: PipelineColors.background,
          borderTopColor: PipelineColors.cardBackground,
          borderTopWidth: 1,
          // Dynamic safe-area handling: extend the bar height by the
          // device's actual bottom inset (Android system nav bar / gesture
          // bar, iOS home indicator) instead of a fixed guess, since this
          // varies by device and OS navigation mode.
          height: 60 + insets.bottom,
          paddingBottom: insets.bottom + 10,
        },
        // The icon/label pair fills the tab bar item's flex box, so
        // centering it here keeps it visually centered in the shrunk
        // content area above the reserved inset padding, regardless of how
        // large insets.bottom ends up being.
        tabBarItemStyle: {
          justifyContent: 'center',
          alignItems: 'center',
        },
        tabBarLabelStyle: {
          fontSize: 13,
          fontWeight: '600',
        },
      }}>
      <Tabs.Screen
        name="ambush"
        options={{
          title: 'Ambush Radar',
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons name={focused ? 'locate' : 'locate-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'Portfolio',
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons
              name={focused ? 'briefcase' : 'briefcase-outline'}
              size={size}
              color={color}
            />
          ),
        }}
      />
    </Tabs>
  );
}
