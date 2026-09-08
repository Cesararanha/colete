import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';

import { StatusTag } from './StatusTag';

type PlayerRowProps = {
  readonly highlighted?: boolean;
  readonly leadingLabel: string;
  readonly meta: string;
  readonly name: string;
  readonly statusLabel?: string;
  readonly statusTone?: 'neutral' | 'positive' | 'primary';
};

export function PlayerRow({
  highlighted = false,
  leadingLabel,
  meta,
  name,
  statusLabel,
  statusTone,
}: PlayerRowProps) {
  const { colors } = useTheme();

  return (
    <View
      style={[
        styles.row,
        {
          backgroundColor: highlighted ? colors.surfaceStrong : colors.surface,
          borderColor: highlighted ? colors.primary : colors.border,
        },
      ]}
    >
      <View style={[styles.leading, { backgroundColor: colors.surfaceStrong }]}>
        <Text style={[styles.leadingText, { color: colors.primary }]}>{leadingLabel}</Text>
      </View>
      <View style={styles.copy}>
        <Text style={[styles.name, { color: colors.text }]}>{name}</Text>
        <Text style={[styles.meta, { color: colors.textMuted }]}>{meta}</Text>
      </View>
      {statusLabel ? <StatusTag label={statusLabel} tone={statusTone ?? 'neutral'} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  copy: {
    flex: 1,
    gap: spacing.xs,
    minWidth: 140,
  },
  leading: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  leadingText: {
    fontSize: 13,
    fontWeight: '900',
  },
  meta: {
    fontSize: 14,
    lineHeight: 20,
  },
  name: {
    fontSize: 16,
    fontWeight: '800',
    lineHeight: 22,
  },
  row: {
    alignItems: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    minHeight: 68,
    padding: spacing.sm,
  },
});
