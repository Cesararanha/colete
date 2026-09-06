import Head from 'expo-router/head';
import type { PropsWithChildren } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

import { AppButton } from './AppButton';

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
  const themeLabel = mode === 'dark' ? pt.theme.useLight : pt.theme.useDark;

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
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View role="main" style={styles.main} testID="profile-main">
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
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  brand: { fontSize: 24, fontWeight: '900', letterSpacing: -0.5 },
  description: { fontSize: 16, lineHeight: 24, maxWidth: 680 },
  eyebrow: { fontSize: 14, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  header: {
    alignItems: 'center',
    alignSelf: 'center',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    maxWidth: 980,
    padding: spacing.md,
    width: '100%',
  },
  intro: { gap: spacing.sm },
  main: {
    alignSelf: 'center',
    gap: spacing.lg,
    maxWidth: 820,
    padding: spacing.md,
    width: '100%',
  },
  safeArea: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: spacing.xxl },
  title: { fontSize: 38, fontWeight: '900', letterSpacing: -1, lineHeight: 46 },
});
