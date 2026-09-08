import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

const doNothing = () => undefined;

export function EmptyMatches() {
  const { colors } = useTheme();

  return (
    <View style={styles.container}>
      <Text aria-level={2} role="heading" style={[styles.title, { color: colors.text }]}>
        {pt.racha.empty.title}
      </Text>
      <Text style={[styles.description, { color: colors.textMuted }]}>
        {pt.racha.empty.description}
      </Text>
      <View style={styles.actions}>
        <AppButton
          accessibilityLabel={pt.racha.empty.join}
          label={pt.racha.empty.join}
          onPress={doNothing}
        />
        <AppButton
          accessibilityLabel={pt.racha.empty.create}
          label={pt.racha.empty.create}
          onPress={doNothing}
          variant="secondary"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  container: {
    alignItems: 'stretch',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  description: {
    fontSize: 17,
    lineHeight: 26,
    maxWidth: 560,
  },
  title: {
    fontSize: 30,
    fontWeight: '900',
    lineHeight: 36,
  },
});
