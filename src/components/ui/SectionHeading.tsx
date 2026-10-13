import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { AppIcon, type IconName } from './AppIcon';

type SectionHeadingProps = {
  description?: string;
  eyebrow: string;
  /** A state eyebrow (e.g. pending) gains an icon so it is not told by colour alone. */
  eyebrowTone?: 'muted' | 'warning';
  eyebrowIcon?: IconName;
  title: string;
};

export function SectionHeading({
  description,
  eyebrow,
  eyebrowIcon,
  eyebrowTone = 'muted',
  title,
}: SectionHeadingProps) {
  const { colors } = useTheme();
  const eyebrowColor = eyebrowTone === 'warning' ? colors.warning : colors.textMuted;

  return (
    <View style={styles.container}>
      <View style={styles.eyebrowRow}>
        {eyebrowIcon ? <AppIcon color={eyebrowColor} name={eyebrowIcon} size={18} /> : null}
        <Text style={[styles.eyebrow, { color: eyebrowColor }]}>{eyebrow}</Text>
      </View>
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
  container: { gap: spacing.xs, minWidth: 0 },
  description: { ...typography.body, maxWidth: 680 },
  eyebrow: { ...typography.supportStrong, flexShrink: 1 },
  eyebrowRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  title: { ...typography.title, maxWidth: 720 },
});
