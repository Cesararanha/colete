import Head from 'expo-router/head';
import { usePathname } from 'expo-router';
import type { PropsWithChildren, ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pt } from '@/lib/i18n/pt';
import { navigationShadow } from '@/theme/elevation';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { AppNavLink } from './AppNavLink';
import { BrandBand, BrandWordmark } from './BrandBand';
import { ThemeToggle } from './ThemeToggle';

type AuthenticatedShellProps = PropsWithChildren<{
  description: string;
  eyebrow: string;
  /** The screen's one scoreboard (docs/29 §1.2), shown in the band under the title. */
  hero?: ReactNode;
  title: string;
}>;

export function AuthenticatedShell({
  children,
  description,
  eyebrow,
  hero,
  title,
}: AuthenticatedShellProps) {
  const { colors, mode } = useTheme();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const wide = width >= 768;
  // The navigation keeps its DOM place (focus order, docs/15); only its look changed.
  const navigation = (
    <View
      accessibilityLabel={pt.navigation.label}
      role="navigation"
      style={[
        styles.navigation,
        wide ? styles.navigationWide : styles.navigationNarrow,
        { backgroundColor: colors.surface },
        wide ? undefined : navigationShadow(mode),
      ]}
    >
      <AppNavLink
        active={pathname.startsWith('/grupos') || pathname === '/join'}
        href="/grupos"
        icon="users"
        label={pt.navigation.groups}
        variant={wide ? 'rail' : 'tab'}
      />
      <AppNavLink
        active={pathname.startsWith('/perfil')}
        href="/perfil"
        icon="user"
        label={pt.navigation.profile}
        variant={wide ? 'rail' : 'tab'}
      />
    </View>
  );

  return (
    <>
      <Head>
        <title>{pt.app.pageTitle(title)}</title>
      </Head>
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <BrandBand>
          <View role="banner" style={styles.header}>
            <BrandWordmark />
            <ThemeToggle testID="theme-toggle" />
          </View>
        </BrandBand>
        <View style={[styles.body, wide ? styles.bodyWide : undefined]}>
          {wide ? navigation : null}
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            style={styles.scrollView}
          >
            <View role="main" style={styles.main} testID="authenticated-main">
              <BrandBand rounded style={styles.band}>
                <View style={styles.intro}>
                  <Text style={[styles.eyebrow, { color: colors.onBandMuted }]}>{eyebrow}</Text>
                  <Text
                    aria-level={1}
                    role="heading"
                    style={[styles.title, { color: colors.onBand }]}
                  >
                    {title}
                  </Text>
                  <Text style={[styles.description, { color: colors.onBandMuted }]}>
                    {description}
                  </Text>
                </View>
                {hero}
              </BrandBand>
              <View style={styles.content}>{children}</View>
            </View>
          </ScrollView>
          {wide ? null : navigation}
        </View>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  band: { gap: spacing.lg, paddingBottom: spacing.xl, paddingHorizontal: spacing.lg },
  body: { flex: 1, minWidth: 0 },
  bodyWide: { alignSelf: 'center', flexDirection: 'row', maxWidth: 1160, width: '100%' },
  content: { gap: spacing.lg, padding: spacing.lg },
  description: { ...typography.body, maxWidth: 680 },
  eyebrow: { ...typography.supportStrong },
  header: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
    maxWidth: 1160,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.ms,
    width: '100%',
  },
  intro: { gap: spacing.xs, minWidth: 0, paddingTop: spacing.sm },
  main: { alignSelf: 'center', maxWidth: 820, minWidth: 0, width: '100%' },
  navigation: { gap: spacing.xs },
  navigationNarrow: { flexDirection: 'row', justifyContent: 'space-around' },
  navigationWide: {
    alignSelf: 'stretch',
    minWidth: 200,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.lg,
  },
  safeArea: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: spacing.xxl },
  scrollView: { flex: 1, minWidth: 0 },
  title: { ...typography.display },
});
