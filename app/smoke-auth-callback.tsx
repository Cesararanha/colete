import { Redirect, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pt } from '@/lib/i18n/pt';
import { isSmokeMode, SYNTHETIC_IDENTITY } from '@/lib/runtime';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

export default function SmokeAuthCallback() {
  const { colors } = useTheme();
  const { identity } = useLocalSearchParams<{ identity?: string }>();
  const safeIdentity = identity === SYNTHETIC_IDENTITY ? identity : SYNTHETIC_IDENTITY;

  if (!isSmokeMode()) {
    return <Redirect href="/" />;
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <View accessibilityLiveRegion="polite" role="main" style={styles.content}>
        <Text aria-level={1} role="heading" style={[styles.title, { color: colors.text }]}>
          {pt.smoke.authCallbackTitle}
        </Text>
        <Text style={[styles.body, { color: colors.textMuted }]}>{pt.smoke.authCallbackBody}</Text>
        <Redirect href={{ pathname: '/', params: { smoke_identity: safeIdentity } }} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: {
    fontSize: 17,
    lineHeight: 26,
  },
  content: {
    alignSelf: 'center',
    gap: spacing.md,
    maxWidth: 640,
    padding: spacing.lg,
    width: '100%',
  },
  safeArea: {
    flex: 1,
    justifyContent: 'center',
  },
  title: {
    fontSize: 32,
    fontWeight: '900',
    lineHeight: 40,
  },
});
