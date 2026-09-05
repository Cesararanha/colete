import type { PropsWithChildren } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pt } from '@/lib/i18n/pt';
import { getLayoutMode } from '@/theme/layout';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';

import { AppButton } from './AppButton';

type AuthShellProps = PropsWithChildren<{
  description: string;
  eyebrow: string;
  title: string;
}>;

export function AuthShell({ children, description, eyebrow, title }: AuthShellProps) {
  const { width } = useWindowDimensions();
  const wide = getLayoutMode(width) === 'wide';
  const { colors, mode, toggleMode } = useTheme();
  const themeLabel = mode === 'dark' ? pt.theme.useLight : pt.theme.useDark;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.scrollContent, wide ? styles.scrollContentWide : undefined]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.header, wide ? styles.headerWide : undefined]}>
          <Text style={[styles.brand, { color: colors.text }]}>{pt.app.name}</Text>
          <AppButton
            label={themeLabel}
            onPress={toggleMode}
            pressed={mode === 'dark'}
            variant="secondary"
          />
        </View>
        <View style={[styles.frame, wide ? styles.frameWide : undefined]}>
          {wide ? (
            <View
              style={[
                styles.aside,
                { backgroundColor: colors.surfaceStrong, borderColor: colors.border },
              ]}
              testID="auth-wide-aside"
            >
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
              <Text style={[styles.eyebrow, { color: colors.primary }]}>{eyebrow}</Text>
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
  );
}

const styles = StyleSheet.create({
  aside: {
    alignSelf: 'stretch',
    borderRadius: radius.md,
    borderWidth: 1,
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    minHeight: 360,
    padding: spacing.xl,
  },
  asideTitle: { fontSize: 30, fontWeight: '900', letterSpacing: -0.6, lineHeight: 38 },
  body: { fontSize: 16, lineHeight: 24 },
  brand: { fontSize: 24, fontWeight: '900', letterSpacing: -0.5 },
  eyebrow: { fontSize: 14, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  frame: { alignSelf: 'center', maxWidth: 560, padding: spacing.md, width: '100%' },
  frameWide: { alignItems: 'center', flexDirection: 'row', gap: spacing.xl, maxWidth: 1080 },
  header: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    maxWidth: 1080,
    padding: spacing.md,
    width: '100%',
  },
  headerWide: { paddingTop: spacing.xl },
  intro: { gap: spacing.sm },
  main: { flex: 1, gap: spacing.lg, minWidth: 0, width: '100%' },
  safeArea: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  scrollContentWide: { justifyContent: 'center' },
  title: { fontSize: 34, fontWeight: '900', letterSpacing: -0.8, lineHeight: 42 },
});
