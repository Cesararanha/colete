import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

type StatusTagProps = {
  readonly label: string;
  readonly tone?: 'critical' | 'neutral' | 'positive' | 'primary';
};

export function StatusTag({ label, tone = 'neutral' }: StatusTagProps) {
  const { colors } = useTheme();
  const accent =
    tone === 'critical'
      ? colors.critical
      : tone === 'positive'
        ? colors.positive
        : tone === 'primary'
          ? colors.primary
          : colors.text;

  return (
    <View style={[styles.tag, { backgroundColor: colors.surfaceStrong, borderColor: accent }]}>
      <Text style={[styles.label, { color: accent }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    ...typography.caption,
  },
  tag: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
});
