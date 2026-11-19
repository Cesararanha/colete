import type { PropsWithChildren } from 'react';
import Head from 'expo-router/head';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { AppSafeArea } from '@/components/ui/AppSafeArea';

import { pt } from '@/lib/i18n/pt';
import { getLayoutMode } from '@/theme/layout';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { BrandBand } from './BrandBand';
import { Scoreboard } from './Scoreboard';

type AuthShellProps = PropsWithChildren<{
  description: string;
  title: string;
}>;

// docs/29 §5: authentication screens carry the decorative COLETE board. The
// name stays as real text in the banner for assistive technology; the board
// and the visually hidden text never duplicate each other on screen.
const brandGroups = [{ chars: pt.app.name.toUpperCase() }];

export function AuthShell({ children, description, title }: AuthShellProps) {
  const { width } = useWindowDimensions();
  const wide = getLayoutMode(width) === 'wide';
  const { colors } = useTheme();

  return (
    <>
      <Head>
        <title>{pt.app.pageTitle(title)}</title>
      </Head>
      <AppSafeArea style={[styles.safeArea, { backgroundColor: colors.background }]}>
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
            </View>
            <View style={styles.board}>
              <Scoreboard decorative groups={brandGroups} size="lg" />
            </View>
          </BrandBand>
          <View style={styles.frame}>
            <View role="main" style={styles.main} testID="auth-main">
              <View style={styles.intro}>
                <Text aria-level={1} role="heading" style={[styles.title, { color: colors.text }]}>
                  {title}
                </Text>
                <Text style={[styles.body, { color: colors.textMuted }]}>{description}</Text>
              </View>
              {children}
            </View>
          </View>
        </ScrollView>
      </AppSafeArea>
    </>
  );
}

const styles = StyleSheet.create({
  band: { paddingBottom: spacing.lg },
  board: { alignSelf: 'center', maxWidth: 560, paddingHorizontal: spacing.lg, width: '100%' },
  body: { ...typography.body },
  frame: { alignSelf: 'center', maxWidth: 560, padding: spacing.lg, width: '100%' },
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
