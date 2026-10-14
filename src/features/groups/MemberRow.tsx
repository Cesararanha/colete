import { StyleSheet, Text, View } from 'react-native';

import { AppIcon, type IconName } from '@/components/ui/AppIcon';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { memberInitials } from './member-initials';

type MemberRowProps = {
  name: string;
  /** Omitted for a pending request, which has no role in the group yet. */
  role?: { icon: IconName; label: string };
  state: { icon: IconName; label: string; tone: 'positive' | 'warning' };
};

/**
 * A group member: decorative initials, the name, then role and state, each
 * said in text with an icon beside it (docs/15: never by colour alone).
 */
export function MemberRow({ name, role, state }: MemberRowProps) {
  const { colors } = useTheme();
  const stateColor = state.tone === 'positive' ? colors.positive : colors.warning;
  return (
    <View role="listitem" style={styles.row}>
      <View
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.avatar, { backgroundColor: colors.background }]}
      >
        <Text style={[styles.initials, { color: colors.text }]}>{memberInitials(name)}</Text>
      </View>
      <View style={styles.text}>
        <Text style={[styles.name, { color: colors.text }]}>{name}</Text>
        <View style={styles.meta}>
          {role ? (
            <View style={styles.tag}>
              <AppIcon color={colors.textMuted} name={role.icon} size={16} />
              <Text style={[styles.tagText, { color: colors.textMuted }]}>{role.label}</Text>
            </View>
          ) : null}
          <View style={styles.tag}>
            <AppIcon color={stateColor} name={state.icon} size={16} />
            <Text style={[styles.tagText, { color: stateColor }]}>{state.label}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: size.target,
    justifyContent: 'center',
    width: size.target,
  },
  initials: { ...typography.supportStrong, letterSpacing: 0.5 },
  meta: { columnGap: spacing.md, flexDirection: 'row', flexWrap: 'wrap', rowGap: spacing.xs },
  name: { ...typography.bodyStrong },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.ms,
    minHeight: size.row,
    paddingVertical: spacing.sm,
  },
  tag: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs + 2 },
  tagText: { ...typography.support },
  text: { flex: 1, gap: 2, minWidth: 0 },
});
