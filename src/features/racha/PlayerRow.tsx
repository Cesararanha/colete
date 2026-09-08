import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { StatusTag } from './StatusTag';

type PlayerRowProps = {
  readonly highlighted?: boolean;
  readonly leadingLabel: string;
  readonly meta: string;
  readonly name: string;
  readonly statusLabel?: string;
  readonly statusTone?: 'critical' | 'neutral' | 'positive' | 'primary';
};

const initialsFor = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toLocaleUpperCase('pt-BR'))
    .join('');

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
      <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
        <Text style={[styles.avatarText, { color: colors.onPrimary }]}>{initialsFor(name)}</Text>
      </View>
      <View
        style={[
          styles.leading,
          { backgroundColor: colors.surfaceStrong, borderColor: colors.primary },
        ]}
      >
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
  avatar: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  avatarText: {
    ...typography.caption,
    fontWeight: '800',
  },
  copy: {
    flex: 1,
    gap: spacing.xs,
    minWidth: 140,
  },
  leading: {
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  leadingText: {
    ...typography.caption,
    fontWeight: '800',
  },
  meta: {
    ...typography.caption,
  },
  name: {
    ...typography.body,
    fontWeight: '800',
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
