import { Tabs } from 'expo-router';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  MainNavigation,
  ShellChromeContext,
  type MainTab,
} from '@/components/ui/AuthenticatedShell';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';

const TABS: readonly MainTab[] = ['grupos', 'rachas'];

/**
 * The authenticated area: a Tabs navigator, each tab with its own Stack. The
 * bar shows Grupos and Agenda (prévia aprovada): a side rail on wide screens,
 * a bottom bar on narrow ones. Perfil stays a tab route, out of the bar: it
 * opens from the avatar at the top right, shows no bar (as in the prévia), and
 * its "Voltar" returns to the tab it came from (backBehavior "history").
 */
export default function TabsLayout() {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const wide = width >= 768;
  return (
    <ShellChromeContext.Provider value>
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View style={[styles.body, wide ? styles.bodyWide : undefined]}>
          <Tabs
            backBehavior="history"
            screenOptions={{
              headerShown: false,
              sceneStyle: { backgroundColor: colors.background },
              tabBarPosition: wide ? 'left' : 'bottom',
            }}
            tabBar={({ state }) => {
              const route = state.routes[state.index]?.name;
              if (route === 'perfil') return null;
              return <MainNavigation active={TABS.find((tab) => tab === route)} wide={wide} />;
            }}
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
