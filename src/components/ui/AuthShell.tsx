import type { PropsWithChildren } from 'react';
import Head from 'expo-router/head';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pt } from '@/lib/i18n/pt';
import { raisedShadow } from '@/theme/elevation';
import { getLayoutMode } from '@/theme/layout';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { BrandBand } from './BrandBand';
import { Scoreboard } from './Scoreboard';
import { ThemeToggle } from './ThemeToggle';

type AuthShellProps = PropsWithChildren<{
  description: string;
  eyebrow: string;
  title: string;
}>;

// docs/29 §5: authentication screens carry the decorative COLETE board. The
// name stays as real text in the banner for assistive technology; the board
// and the visually hidden text never duplicate each other on screen.
const brandGroups = [{ chars: pt.app.name.toUpperCase() }];

export function AuthShell({ children, description, eyebrow, title }: AuthShellProps) {
  const { width } = useWindowDimensions();
  const wide = getLayoutMode(width) === 'wide';
  const { colors, mode } = useTheme();

  return (
    <>
      <Head>
        <title>{pt.app.pageTitle(title)}</title>
      </Head>
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
        <ScrollView
          contentContainerStyle={[
            styles.scrollContent,
            wide ? styles.scrollContentWide : undefined,
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <BrandBand rounded style={styles.band}>
            <View role="banner" style={[styles.header, wide ? styles.headerWide : undefined]}>
              <Text style={styles.visuallyHidden}>{pt.app.name}</Text>
              <ThemeToggle />
            </View>
            {wide ? null : (
              <View style={styles.board}>
                <Scoreboard decorative groups={brandGroups} size="lg" />
              </View>
            )}
          </BrandBand>
          <View style={[styles.frame, wide ? styles.frameWide : undefined]}>
            {wide ? (
              <View
                role="complementary"
                style={[
                  styles.aside,
                  { backgroundColor: colors.surfaceRaised },
                  raisedShadow(mode),
                ]}
                testID="auth-wide-aside"
              >
                <Scoreboard decorative groups={brandGroups} size="lg" />
                <Text style={[styles.asideTitle, { color: colors.text }]}>
                  {pt.auth.shell.asideTitle}
                </Text>
                <Text style={[styles.body, { color: colors.textMuted }]}>
                  {pt.auth.shell.asideBody}
                </Text>
              </View>
            ) : null}
            <View role="main" style={styles.main} testID="auth-main">
              <View style={styles.intro}>
                <Text style={[styles.eyebrow, { color: colors.textMuted }]}>{eyebrow}</Text>
                <Text aria-level={1} role="heading" style={[styles.title, { color: colors.text }]}>
                  {title}
                </Text>
                <Text style={[styles.body, { color: colors.textMuted }]}>{description}</Text>
              </View>
              {children}
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  aside: {
    alignSelf: 'stretch',
    borderRadius: radius.row,
    flex: 1,
    gap: spacing.lg,
    justifyContent: 'center',
    minHeight: 360,
    padding: spacing.xl,
  },
  asideTitle: { ...typography.display },
  band: { paddingBottom: spacing.lg },
  board: { alignSelf: 'center', maxWidth: 560, paddingHorizontal: spacing.lg, width: '100%' },
  body: { ...typography.body },
  eyebrow: { ...typography.supportStrong },
  frame: { alignSelf: 'center', maxWidth: 560, padding: spacing.lg, width: '100%' },
  frameWide: { alignItems: 'center', flexDirection: 'row', gap: spacing.xl, maxWidth: 1080 },
  header: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    maxWidth: 1080,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.ms,
    width: '100%',
  },
  headerWide: { paddingTop: spacing.lg },
  intro: { gap: spacing.xs },
  main: { flex: 1, gap: spacing.lg, minWidth: 0, width: '100%' },
  safeArea: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  scrollContentWide: { justifyContent: 'flex-start' },
  title: { ...typography.display },
  visuallyHidden: {
    height: 1,
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    top: 0,
    width: 1,
  },
});
