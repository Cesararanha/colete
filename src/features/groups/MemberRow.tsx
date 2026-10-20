import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Chip } from '@/components/ui/Chip';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { PhotoAvatar } from '../photos/PhotoAvatar';
import { roleName, roleTone } from './group-roles';

type MemberRowProps = {
  id: string;
  name: string;
  /** The member's role as a chip: Dono, Organizador or Jogador. */
  role: string;
  /** The "…" of the row, where the row has actions; otherwise a 44 px spacer keeps the chips aligned. */
  actions?: ReactNode;
  /** What the actions open below the row (menu, confirmation). */
  children?: ReactNode;
  divider?: boolean;
  /** The member's current rating, when the viewer may see it (0031); null is "Sem nota". */
  rating?: number | null;
  testID?: string;
};

/**
 * One member of "No grupo" (prévia aprovada): decorative initials on the
 * person's tone, the name, the role chip, and the row's actions. The role is
 * said in words; the chip's colour only repeats it (docs/15).
 */
export function MemberRow({
  actions,
  children,
  divider,
  id,
  name,
  rating,
  role,
  testID,
}: MemberRowProps) {
  const { colors } = useTheme();
  return (
    <View role="listitem" testID={testID}>
      {divider ? <View style={[styles.divider, { backgroundColor: colors.divider }]} /> : null}
      <View style={styles.row}>
        <PhotoAvatar id={id} name={name} size={40} />
        <Text style={[styles.name, { color: colors.text }]}>
          {name}
          {rating === undefined ? null : (
            <Text style={{ color: colors.textMuted }}>
              {' · '}
              {rating === null ? pt.ratings.none : pt.ratings.current(rating)}
            </Text>
          )}
        </Text>
        <Chip label={roleName(role, pt.groups.detail.player)} tone={roleTone(role)} />
        {actions ?? <View style={styles.spacer} />}
      </View>
      {children ? <View style={styles.below}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  below: { gap: spacing.sm, paddingBottom: spacing.ms, paddingHorizontal: spacing.ms },
  divider: { height: 1, marginLeft: 64 },
  name: { ...typography.bodyStrong, flex: 1, fontSize: 16, lineHeight: 22, minWidth: 0 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.ms,
    minHeight: size.row,
    padding: spacing.ms,
  },
  spacer: { width: size.compact },
});
