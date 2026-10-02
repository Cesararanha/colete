import Head from 'expo-router/head';
import { usePathname } from 'expo-router';
import type { PropsWithChildren } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

import { AppButton } from './AppButton';
import { AppNavLink } from './AppNavLink';

type AuthenticatedShellProps = PropsWithChildren<{
  description: string;
  eyebrow: string;
  title: string;
}>;

export function AuthenticatedShell({
  children,
  description,
  eyebrow,
  title,
}: AuthenticatedShellProps) {
  const { colors, mode, toggleMode } = useTheme();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const wide = width >= 768;
  const themeLabel = mode === 'dark' ? pt.theme.useLight : pt.theme.useDark;
  const navigation = (
    <View
      accessibilityLabel={pt.navigation.label}
      role="navigation"
      style={[
        styles.navigation,
        wide ? styles.navigationWide : styles.navigationNarrow,
        { backgroundColor: colors.background, borderColor: colors.border },
      ]}
    >
      <AppNavLink
        active={pathname.startsWith('/grupos') || pathname === '/join'}
        href="/grupos"
        label={pt.navigation.groups}
      />
      <AppNavLink
        active={pathname.startsWith('/perfil')}
        href="/perfil"
        label={pt.navigation.profile}
      />
    </View>
  );

  return (
    <>
      <Head>
        <title>{pt.app.pageTitle(title)}</title>
      </Head>
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <View role="banner" style={[styles.header, { borderColor: colors.border }]}>
          <Text style={[styles.brand, { color: colors.text }]}>{pt.app.name}</Text>
          <AppButton
            label={themeLabel}
            onPress={toggleMode}
            pressed={mode === 'dark'}
            testID="theme-toggle"
            variant="secondary"
          />
        </View>
        <View style={[styles.body, wide ? styles.bodyWide : undefined]}>
          {wide ? navigation : null}
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            style={styles.scrollView}
          >
            <View role="main" style={styles.main} testID="authenticated-main">
              <View style={styles.intro}>
                <Text style={[styles.eyebrow, { color: colors.primary }]}>{eyebrow}</Text>
                <Text aria-level={1} role="heading" style={[styles.title, { color: colors.text }]}>
                  {title}
                </Text>
                <Text style={[styles.description, { color: colors.textMuted }]}>{description}</Text>
              </View>
              {children}
            </View>
          </ScrollView>
          {wide ? null : navigation}
        </View>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, minWidth: 0 },
  bodyWide: { alignSelf: 'center', flexDirection: 'row', maxWidth: 1160, width: '100%' },
  brand: { flexShrink: 1, fontSize: 24, fontWeight: '900', letterSpacing: -0.5 },
  description: { fontSize: 16, lineHeight: 24, maxWidth: 680 },
  eyebrow: { fontSize: 14, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  header: {
    alignItems: 'center',
    alignSelf: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
    maxWidth: 980,
    padding: spacing.md,
    width: '100%',
  },
  intro: { gap: spacing.sm, minWidth: 0 },
  main: {
    alignSelf: 'center',
    gap: spacing.lg,
    maxWidth: 820,
    minWidth: 0,
    padding: spacing.md,
    width: '100%',
  },
  safeArea: { flex: 1 },
  scrollView: { flex: 1, minWidth: 0 },
  navigation: { borderWidth: 1, gap: spacing.xs, padding: spacing.sm },
  navigationNarrow: { flexDirection: 'row', justifyContent: 'space-around' },
  navigationWide: { alignSelf: 'stretch', minWidth: 152, paddingTop: spacing.lg },
  scrollContent: { flexGrow: 1, paddingBottom: spacing.xxl },
  title: { fontSize: 38, fontWeight: '900', letterSpacing: -1, lineHeight: 46 },
});
