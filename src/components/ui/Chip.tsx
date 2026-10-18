import { StyleSheet, Text, View } from 'react-native';

import type { ThemeColors } from '@/theme/colors';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { AppIcon, type IconName } from './AppIcon';

export type ChipTone = 'positive' | 'warning' | 'info' | 'critical' | 'primary' | 'neutral';

const tones: Record<ChipTone, { fill: keyof ThemeColors; text: keyof ThemeColors }> = {
  positive: { fill: 'positiveSoft', text: 'positive' },
  warning: { fill: 'warningSoft', text: 'warning' },
  info: { fill: 'infoSoft', text: 'info' },
  critical: { fill: 'criticalSoft', text: 'critical' },
  primary: { fill: 'primarySoft', text: 'primary' },
  neutral: { fill: 'surfaceRaised', text: 'textSoft' },
};

/**
 * A state or role in words on its soft fill (prévia aprovada). The text says
 * it; the colour and the optional icon only repeat it (docs/15).
 */
export function Chip({
  icon,
  label,
  testID,
  tone,
}: {
  icon?: IconName;
  label: string;
  testID?: string;
  tone: ChipTone;
}) {
  const { colors } = useTheme();
  const color = colors[tones[tone].text];
  return (
    <View style={[styles.chip, { backgroundColor: colors[tones[tone].fill] }]}>
      {icon ? <AppIcon color={color} name={icon} size={14} /> : null}
      <Text style={[styles.label, { color }]} testID={testID}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    borderRadius: radius.pill,
    flexDirection: 'row',
    flexShrink: 1,
    gap: spacing.xs,
    minHeight: 26,
    paddingHorizontal: 10,
    paddingVertical: 2,
  },
  label: { ...typography.chip, flexShrink: 1 },
});
