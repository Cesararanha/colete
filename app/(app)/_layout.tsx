import Ionicons from '@expo/vector-icons/Ionicons';
import { BottomTabBar, Tabs } from 'expo-router/js-tabs';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { pt } from '@/lib/i18n/pt';
import { getLayoutMode } from '@/theme/layout';
import { useTheme } from '@/theme/ThemeProvider';

export default function AppTabsLayout() {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const wide = getLayoutMode(width) === 'wide';

  return (
    <Tabs
      backBehavior="history"
      tabBar={(props) => (
        <View
          accessibilityLabel={pt.navigation.label}
          role="navigation"
          style={wide ? styles.navigationWide : styles.navigationNarrow}
        >
          <BottomTabBar {...props} />
        </View>
      )}
      screenOptions={{
        headerShown: false,
        tabBarActiveBackgroundColor: colors.surfaceStrong,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarInactiveBackgroundColor: colors.surface,
        tabBarIconStyle: styles.tabIcon,
        tabBarItemStyle: styles.tabItem,
        tabBarLabelPosition: wide ? 'beside-icon' : 'below-icon',
        tabBarLabelStyle: styles.label,
        tabBarPosition: wide ? 'left' : 'bottom',
        tabBarShowLabel: true,
        tabBarStyle: [
          styles.tabBar,
          wide ? styles.tabBarWide : styles.tabBarNarrow,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ],
      }}
    >
      <Tabs.Screen
        name="rachas"
        options={{
          href: '/rachas',
          tabBarAccessibilityLabel: pt.racha.navigation.matchesLabel,
          tabBarIcon: ({ color, size }) => <Ionicons color={color} name="football" size={size} />,
          title: pt.racha.navigation.matches,
        }}
      />
      <Tabs.Screen
        name="perfil"
        options={{
          href: '/perfil',
          tabBarAccessibilityLabel: pt.racha.navigation.profileLabel,
          tabBarIcon: ({ color, size }) => <Ionicons color={color} name="person" size={size} />,
          title: pt.racha.navigation.profile,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 13,
    fontWeight: '800',
  },
  navigationNarrow: {
    width: '100%',
  },
  navigationWide: {
    height: '100%',
  },
  tabBar: {
    borderTopWidth: 1,
  },
  tabIcon: {
    minHeight: 30,
  },
  tabItem: {
    minHeight: 44,
    minWidth: 44,
  },
  tabBarNarrow: {
    minHeight: 68,
    paddingBottom: 6,
    paddingTop: 6,
  },
  tabBarWide: {
    borderRightWidth: 1,
    borderTopWidth: 0,
    minWidth: 112,
    paddingTop: 16,
  },
});
