import type { PropsWithChildren } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pt } from '@/lib/i18n/pt';
import { getLayoutMode } from '@/theme/layout';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

import { AppNavLink } from './AppNavLink';
import { BrandBand, BrandWordmark } from './BrandBand';
import { ThemeToggle } from './ThemeToggle';

type AppShellProps = PropsWithChildren<{
  /** Omitted on public pages outside the navigation, such as /design-system. */
  activeRoute?: 'foundation' | 'home';
}>;

export function AppShell({ activeRoute, children }: AppShellProps) {
  const { width } = useWindowDimensions();
  const layout = getLayoutMode(width);
  const { colors } = useTheme();
  const wide = layout === 'wide';

  const navigation = (
    <View
      accessibilityLabel={pt.navigation.label}
      role="navigation"
      style={[
        styles.navigation,
        wide ? styles.navigationWide : styles.navigationNarrow,
        wide ? undefined : { backgroundColor: colors.surface },
      ]}
      testID={wide ? 'wide-navigation' : 'narrow-navigation'}
    >
      <AppNavLink
        active={activeRoute === 'home'}
        href="/"
        icon="home"
        label={pt.navigation.home}
        onBand={wide}
        variant={wide ? 'rail' : 'tab'}
      />
      <AppNavLink
        active={activeRoute === 'foundation'}
        href="/foundation"
        icon="layers"
        label={pt.navigation.foundation}
        onBand={wide}
        variant={wide ? 'rail' : 'tab'}
      />
    </View>
  );

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <View style={[styles.frame, wide ? styles.frameWide : styles.frameNarrow]}>
        <BrandBand style={wide ? styles.headerWideBand : undefined}>
          <View style={[styles.header, wide ? styles.headerWide : styles.headerNarrow]}>
            <BrandWordmark heading />
            {wide ? navigation : null}
            <ThemeToggle testID="theme-toggle" />
          </View>
        </BrandBand>
        {!wide ? navigation : null}
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          style={styles.scroll}
        >
          <View role="main" style={styles.main} testID="main-content">
            {children}
          </View>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, width: '100%' },
  frameNarrow: { alignSelf: 'stretch' },
  frameWide: { alignSelf: 'center', flexDirection: 'row', maxWidth: 1180 },
  header: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.ms },
  headerNarrow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  headerWide: { alignItems: 'stretch', minWidth: 240, paddingTop: spacing.xl },
  headerWideBand: { borderBottomRightRadius: 28, borderTopRightRadius: 28 },
  main: {
    alignSelf: 'center',
    gap: spacing.lg,
    maxWidth: 820,
    padding: spacing.lg,
    width: '100%',
  },
  navigation: { gap: spacing.xs },
  navigationNarrow: { flexDirection: 'row' },
  navigationWide: { marginTop: spacing.lg },
  safeArea: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: spacing.xxl },
});
