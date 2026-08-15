import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TAB_LABEL } from '@/constants/labels';
import { usePipelineLanguage } from '@/contexts/language-context';
import { usePipelineTheme } from '@/contexts/theme-context';

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const { colors } = usePipelineTheme();
  // DYNAMIC LANGUAGE TOGGLE: options.title (which tabBarLabel falls back
  // to) is read fresh on every render, so switching languages elsewhere in
  // the app relabels the always-visible tab bar immediately — no navigation
  // stack reset or app restart needed.
  const { language } = usePipelineLanguage();

  return (
    <Tabs
      initialRouteName="ambush"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.bullish,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          backgroundColor: colors.background,
          borderTopColor: colors.cardBackground,
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
          title: TAB_LABEL[language].ambush,
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons name={focused ? 'locate' : 'locate-outline'} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: TAB_LABEL[language].portfolio,
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
