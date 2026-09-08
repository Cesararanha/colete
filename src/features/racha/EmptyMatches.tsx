import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

const doNothing = () => undefined;

export function EmptyMatches() {
  const { colors } = useTheme();

  return (
    <View style={styles.container}>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.iconCircle, { backgroundColor: colors.surfaceStrong }]}
      >
        <Ionicons color={colors.primary} name="football-outline" size={48} />
      </View>
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
    alignSelf: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    maxWidth: 360,
    width: '100%',
  },
  container: {
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xxl,
  },
  description: {
    ...typography.body,
    maxWidth: 560,
    textAlign: 'center',
  },
  iconCircle: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 96,
    justifyContent: 'center',
    marginBottom: spacing.sm,
    width: 96,
  },
  title: {
    ...typography.title,
    textAlign: 'center',
  },
});
