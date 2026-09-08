import { StyleSheet, Text, View } from 'react-native';

import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';

type OccupancyBarProps = {
  readonly capacity: number;
  readonly filled: number;
};

export function OccupancyBar({ capacity, filled }: OccupancyBarProps) {
  const { colors } = useTheme();
  const label = pt.racha.list.occupancy(filled, capacity);

  return (
    <View
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityValue={{ max: capacity, min: 0, now: filled, text: label }}
      style={styles.container}
    >
      <View accessibilityElementsHidden style={styles.track}>
        {Array.from({ length: capacity }, (_, index) => (
          <View
            key={index}
            style={[
              styles.segment,
              {
                backgroundColor: index < filled ? colors.primary : colors.surface,
                borderColor: index < filled ? colors.primary : colors.border,
              },
            ]}
          />
        ))}
      </View>
      <Text style={[styles.label, { color: colors.textMuted }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  label: {
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },
  segment: {
    borderRadius: radius.pill,
    borderWidth: 1,
    flex: 1,
    height: 9,
  },
  track: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
});
