import { forwardRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppIcon } from '@/components/ui/AppIcon';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { Avatar } from '@/components/ui/Avatar';
import { Chip } from '@/components/ui/Chip';
import { GroupIcon } from '@/components/ui/GroupIcon';
import { groupAppearance } from '@/components/ui/group-icon';
import type { InvitePage } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { roleName, roleTone } from './group-roles';

/**
 * The top of the invitation page: the group's icon, name and active members,
 * as on the group's own screen (prévia aprovada). The wrapper takes the focus
 * when the page replaces the form, so a screen reader starts at the name.
 */
export const InvitePageIntro = forwardRef<View, { page: InvitePage }>(function InvitePageIntro(
  { page },
  ref,
) {
  const { colors } = useTheme();
  return (
    <View ref={ref} style={styles.intro} tabIndex={-1} testID="invite-page-header">
      <GroupIcon appearance={groupAppearance(page.group_icon, page.group_color)} size={56} tile />
      <View style={styles.introText}>
        <Text aria-level={1} role="heading" style={[styles.name, { color: colors.text }]}>
          {page.group_name}
        </Text>
        <Text style={[styles.support, { color: colors.textMuted }]} testID="invite-page-members">
          {pt.groups.join.members(page.member_count)}
        </Text>
      </View>
    </View>
  );
});

type InvitePageBodyProps = {
  page: InvitePage;
  joining: boolean;
  joiningError: string | null;
  onJoin: () => void;
  /** Runs as "Abrir grupo" follows its link to the group. */
  onOpen: () => void;
};

/**
 * What the page offers, by the person's own state: the amber "Pedir para
 * entrar"; "Abrir grupo" for a member; "Aguardando aprovação" for a request
 * already sent; the current refusal message for a full group or a full quota.
 */
export function InvitePageBody({
  joining,
  joiningError,
  onJoin,
  onOpen,
  page,
}: InvitePageBodyProps) {
  const { colors } = useTheme();
  const refusal =
    page.refusal === 'GROUP_FULL'
      ? pt.groups.errors.full
      : page.refusal === 'GROUP_LIMIT'
        ? pt.groups.errors.limit
        : null;
  return (
    <View style={styles.body} testID="join-confirmation">
      {page.owner_name ? (
        <View
          style={[styles.owner, { backgroundColor: colors.surface }]}
          testID="invite-page-owner"
        >
          <Avatar id={page.owner_name} name={page.owner_name} size={40} />
          <Text style={[styles.ownerName, { color: colors.text }]}>{page.owner_name}</Text>
          <Chip label={roleName('owner', pt.groups.detail.player)} tone={roleTone('owner')} />
        </View>
      ) : null}
      {page.viewer_status === 'active' && page.group_id ? (
        <AppButton
          href={`/grupos/${page.group_id}`}
          label={pt.groups.list.open}
          onPress={onOpen}
          replace
          testID="join-open-group"
        />
      ) : page.viewer_status === 'pending' ? (
        <View role="status" style={styles.pending}>
          <AppIcon color={colors.warning} name="clock" size={18} />
          <Text style={[styles.pendingText, { color: colors.warning }]} testID="join-pending">
            {pt.groups.join.pending}
          </Text>
        </View>
      ) : refusal ? (
        <AppAlert message={refusal} testID="join-refusal" />
      ) : (
        <>
          {joiningError ? <AppAlert message={joiningError} testID="join-error" /> : null}
          {joining ? <AppSkeleton lines={1} /> : null}
          <AppButton label={pt.groups.join.enter} onPress={onJoin} testID="join-submit" />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.md },
  intro: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    minWidth: 0,
    paddingTop: spacing.xs,
  },
  introText: { flex: 1, gap: 2, minWidth: 0 },
  name: { ...typography.heading },
  owner: {
    alignItems: 'center',
    borderRadius: radius.scoreboard - 2,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.ms,
    minHeight: size.row,
    padding: 14,
  },
  ownerName: { ...typography.bodyStrong, flex: 1, fontSize: 16, lineHeight: 22, minWidth: 0 },
  pending: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: size.compact },
  pendingText: { ...typography.supportStrong },
  support: { ...typography.support },
});
