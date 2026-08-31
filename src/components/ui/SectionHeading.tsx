import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

type SectionHeadingProps = {
  description?: string;
  eyebrow: string;
  title: string;
};

export function SectionHeading({ description, eyebrow, title }: SectionHeadingProps) {
  const { colors } = useTheme();

  return (
    <View style={styles.container}>
      <Text style={[styles.eyebrow, { color: colors.primary }]}>{eyebrow}</Text>
      <Text aria-level={2} role="heading" style={[styles.title, { color: colors.text }]}>
        {title}
      </Text>
      {description ? (
        <Text style={[styles.description, { color: colors.textMuted }]}>{description}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  description: {
    fontSize: 18,
    lineHeight: 28,
    maxWidth: 680,
  },
  eyebrow: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 1.1,
    lineHeight: 20,
    textTransform: 'uppercase',
  },
  title: {
    fontSize: 38,
    fontWeight: '900',
    letterSpacing: -1.2,
    lineHeight: 44,
    maxWidth: 720,
  },
});
