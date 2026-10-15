import { Tabs } from 'expo-router';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  BrandHeader,
  MainNavigation,
  ShellChromeContext,
  type MainTab,
} from '@/components/ui/AuthenticatedShell';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';

const TABS: readonly MainTab[] = ['grupos', 'rachas', 'perfil'];

/**
 * The authenticated area: a Tabs navigator (Grupos, Rachas, Perfil), each tab
 * with its own Stack. The tab bar is the same navigation the shell drew
 * before: a side rail on wide screens, a bottom bar on narrow ones.
 */
export default function TabsLayout() {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const wide = width >= 768;
  return (
    <ShellChromeContext.Provider value>
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <BrandHeader />
        <View style={[styles.body, wide ? styles.bodyWide : undefined]}>
          <Tabs
            screenOptions={{
              headerShown: false,
              sceneStyle: { backgroundColor: colors.background },
              tabBarPosition: wide ? 'left' : 'bottom',
            }}
            tabBar={({ state }) => (
              <MainNavigation
                active={TABS.find((tab) => tab === state.routes[state.index]?.name)}
                wide={wide}
              />
            )}
          >
            <Tabs.Screen name="grupos" options={{ title: pt.navigation.groups }} />
            <Tabs.Screen name="rachas" options={{ title: pt.navigation.matches }} />
            <Tabs.Screen name="perfil" options={{ title: pt.navigation.profile }} />
          </Tabs>
        </View>
      </SafeAreaView>
    </ShellChromeContext.Provider>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, minWidth: 0 },
  bodyWide: { alignSelf: 'center', maxWidth: 1160, width: '100%' },
  safeArea: { flex: 1 },
});
