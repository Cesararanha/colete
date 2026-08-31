import type { PropsWithChildren } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pt } from '@/lib/i18n/pt';
import { getLayoutMode } from '@/theme/layout';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

import { AppButton } from './AppButton';
import { AppNavLink } from './AppNavLink';

type AppShellProps = PropsWithChildren<{
  activeRoute: 'foundation' | 'home';
}>;

export function AppShell({ activeRoute, children }: AppShellProps) {
  const { width } = useWindowDimensions();
  const layout = getLayoutMode(width);
  const { colors, mode, toggleMode } = useTheme();
  const wide = layout === 'wide';
  const themeLabel = mode === 'dark' ? pt.theme.useLight : pt.theme.useDark;

  const navigation = (
    <View
      accessibilityLabel={pt.navigation.label}
      role="navigation"
      style={[styles.navigation, wide ? styles.navigationWide : styles.navigationNarrow]}
      testID={wide ? 'wide-navigation' : 'narrow-navigation'}
    >
      <AppNavLink active={activeRoute === 'home'} href="/" label={pt.navigation.home} />
      <AppNavLink
        active={activeRoute === 'foundation'}
        href="/foundation"
        label={pt.navigation.foundation}
      />
    </View>
  );

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <View style={[styles.frame, wide ? styles.frameWide : styles.frameNarrow]}>
        <View
          style={[
            styles.header,
            wide ? styles.headerWide : styles.headerNarrow,
            { borderColor: colors.border },
          ]}
        >
          <Text aria-level={1} role="heading" style={[styles.brand, { color: colors.text }]}>
            {pt.app.name}
          </Text>
          {wide ? navigation : null}
          <AppButton
            label={themeLabel}
            onPress={toggleMode}
            pressed={mode === 'dark'}
            testID="theme-toggle"
            variant="secondary"
          />
        </View>
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
  brand: {
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: -0.8,
    lineHeight: 34,
  },
  frame: {
    flex: 1,
    width: '100%',
  },
  frameNarrow: {
    alignSelf: 'stretch',
  },
  frameWide: {
    alignSelf: 'center',
    flexDirection: 'row',
    maxWidth: 1180,
  },
  header: {
    borderColor: 'transparent',
    gap: spacing.md,
    padding: spacing.md,
  },
  headerNarrow: {
    alignItems: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  headerWide: {
    alignItems: 'stretch',
    borderRightWidth: 1,
    minWidth: 240,
    paddingTop: spacing.xl,
  },
  main: {
    alignSelf: 'center',
    gap: spacing.lg,
    maxWidth: 820,
    padding: spacing.md,
    width: '100%',
  },
  navigation: {
    gap: spacing.sm,
  },
  navigationNarrow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  navigationWide: {
    marginTop: spacing.lg,
  },
  safeArea: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingBottom: spacing.xxl,
  },
});
