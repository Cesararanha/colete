import { StyleSheet, Text, View } from 'react-native';

import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

type OccupancyBarProps = {
  readonly capacity: number;
  readonly filled: number;
};

export function OccupancyBar({ capacity, filled }: OccupancyBarProps) {
  const { colors } = useTheme();
  const label = pt.racha.list.occupancy(filled, capacity);
  const percent = capacity > 0 ? Math.round((filled / capacity) * 100) : 0;
  const percentLabel = pt.racha.list.occupancyPercent(percent);
  const accessibleLabel = `${label}, ${percentLabel}`;

  return (
    <View
      accessibilityLabel={accessibleLabel}
      accessibilityRole="progressbar"
      accessibilityValue={{ max: capacity, min: 0, now: filled, text: accessibleLabel }}
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
      <View style={styles.labels}>
        <Text style={[styles.label, { color: colors.textMuted }]}>{label}</Text>
        <Text style={[styles.percent, { color: colors.primary }]}>{percentLabel}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  label: {
    ...typography.caption,
  },
  labels: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  percent: {
    ...typography.caption,
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
