import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppIcon } from '@/components/ui/AppIcon';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { Scoreboard } from '@/components/ui/Scoreboard';
import { AppError, TransportError, api, type MutationIntent, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT, withCurrentAccessToken } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { groupErrorMessage } from './group-errors';
import { focusGroupControl, GroupConfirmation } from './GroupConfirmation';
import { roleIcon, roleName } from './group-roles';
import { MemberRow } from './MemberRow';

export function GroupDetailScreen({ groupId, profile }: { groupId: string; profile: OwnProfile }) {
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const intent = useRef<MutationIntent<unknown> | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const detail = useQuery({
    queryKey: [PRIVATE_QUERY_ROOT, 'group-detail', profile.id, groupId],
    queryFn: () =>
      withCurrentAccessToken((token) => api.getGroupDetail(groupId, profile.id, token)),
  });
  const members = useQuery({
    queryKey: [PRIVATE_QUERY_ROOT, 'group-members', profile.id, groupId],
    queryFn: ({ signal }) => api.getGroupMembers(groupId, signal),
    enabled: detail.isSuccess && detail.data !== null,
  });
  const leaving = useMutation({
    mutationFn: async () => {
      intent.current ??= api.leaveGroup(groupId);
      return intent.current.execute();
    },
    onSuccess: async () => {
      intent.current = null;
      queryClient.removeQueries({
        queryKey: [PRIVATE_QUERY_ROOT, 'group-detail', profile.id, groupId],
      });
      queryClient.removeQueries({
        queryKey: [PRIVATE_QUERY_ROOT, 'group-members', profile.id, groupId],
      });
      queryClient.removeQueries({
        queryKey: [PRIVATE_QUERY_ROOT, 'group-invites', profile.id, groupId],
      });
      await queryClient.invalidateQueries({ queryKey: [PRIVATE_QUERY_ROOT, 'groups'] });
      router.replace({ pathname: '/grupos', params: { left: '1' } });
    },
    onError: (error) => {
      if (!(error instanceof TransportError || (error instanceof AppError && error.retryable))) {
        intent.current = null;
      }
    },
  });
  const group = detail.data;
  // docs/29 §5: the count comes from the getGroupMembers read the screen
  // already makes; no capacity is shown because the contract has none.
  const activeMembers = members.data?.filter((member) => member.status === 'active').length;
  const hero =
    group && activeMembers !== undefined ? (
      <View style={styles.hero}>
        <Text aria-hidden style={[styles.overline, { color: colors.onBandMuted }]}>
          {pt.groups.detail.members}
        </Text>
        <Scoreboard
          accessibilityLabel={pt.groups.detail.activeMembers(activeMembers)}
          groups={[{ chars: String(activeMembers).padStart(2, '0') }]}
          testID="members-scoreboard"
        />
      </View>
    ) : undefined;
  return (
    <AuthenticatedShell {...pt.groups.detail} hero={hero}>
      {detail.isPending ? <AsyncNotice kind="loading" message={pt.common.loading} /> : null}
      {detail.isError ? (
        <AsyncNotice
          kind="network"
          title={pt.common.networkTitle}
          message={pt.common.networkBody}
          actionLabel={pt.common.retry}
          action={() => void detail.refetch()}
        />
      ) : null}
      {detail.isSuccess && group === null ? <AppAlert message={pt.groups.detail.missing} /> : null}
      {group ? (
        <AppCard testID="group-detail-card">
          <View style={styles.heading}>
            <Text aria-level={2} role="heading" style={[styles.name, { color: colors.text }]}>
              {group.name}
            </Text>
            <View style={styles.role}>
              <AppIcon color={colors.textMuted} name={roleIcon(group.role)} size={16} />
              <Text style={[styles.roleText, { color: colors.textMuted }]}>
                {roleName(group.role, pt.groups.list.player)}
              </Text>
            </View>
          </View>
          {group.role === 'owner' || group.role === 'organizer' ? (
            <View style={styles.actions}>
              <AppButton
                icon="user-plus"
                label={pt.groups.detail.invites}
                onPress={() => router.push(`/grupos/${group.id}/convites`)}
              />
              <AppButton
                icon="users"
                label={pt.groups.members.title}
                onPress={() => router.push(`/grupos/${group.id}/membros`)}
                variant="secondary"
              />
              <AppButton
                icon="settings"
                label={pt.groups.settings.title}
                onPress={() => router.push(`/grupos/${group.id}/configuracoes`)}
                variant="secondary"
              />
            </View>
          ) : null}
        </AppCard>
      ) : null}
      {group ? (
        <AppCard>
          <Text aria-level={2} role="heading" style={[styles.section, { color: colors.text }]}>
            {pt.groups.detail.members}
          </Text>
          {members.isPending ? <AsyncNotice kind="loading" message={pt.common.loading} /> : null}
          {members.isError ? (
            <AsyncNotice
              kind="network"
              title={pt.common.networkTitle}
              message={pt.common.networkBody}
              actionLabel={pt.common.retry}
              action={() => void members.refetch()}
            />
          ) : null}
          {members.data ? (
            <View style={styles.lists} testID="group-members-list">
              <View role="list">
                {members.data
                  .filter((member) => member.status === 'active')
                  .map((member) => (
                    <MemberRow
                      key={member.profile_id}
                      name={member.display_name}
                      role={{
                        icon: roleIcon(member.role),
                        label: roleName(member.role, pt.groups.detail.player),
                      }}
                      state={{
                        icon: 'check-circle',
                        label: pt.groups.detail.active,
                        tone: 'positive',
                      }}
                    />
                  ))}
              </View>
              {members.data.some((member) => member.status === 'pending') ? (
                <View style={styles.lists} testID="group-pending-members-list">
                  <Text
                    aria-level={3}
                    role="heading"
                    style={[styles.subsection, { color: colors.text }]}
                  >
                    {pt.groups.detail.pendingMembers}
                  </Text>
                  <View role="list">
                    {members.data
                      .filter((member) => member.status === 'pending')
                      .map((member) => (
                        <MemberRow
                          key={member.profile_id}
                          name={member.display_name}
                          state={{ icon: 'clock', label: pt.groups.list.pending, tone: 'warning' }}
                        />
                      ))}
                  </View>
                </View>
              ) : null}
            </View>
          ) : null}
        </AppCard>
      ) : null}
      {group ? (
        // The one destructive action stands apart from the group's tools.
        <View style={styles.leave}>
          {leaving.error ? <AppAlert message={groupErrorMessage(leaving.error)} /> : null}
          {leaving.isSuccess ? <AppStatus message={pt.groups.detail.left} /> : null}
          {group.role === 'owner' ? (
            <Text
              nativeID="owner-leave-reason"
              style={[styles.reason, { color: colors.textMuted }]}
            >
              {pt.groups.detail.ownerLeaveReason}
            </Text>
          ) : null}
          <View style={styles.leaveAction}>
            <AppButton
              ariaDisabled={group.role === 'owner'}
              describedBy={group.role === 'owner' ? 'owner-leave-reason' : undefined}
              icon="log-out"
              label={pt.groups.detail.leave}
              onPress={() => {
                if (group.role !== 'owner' && !leaving.isPending) setConfirmLeave(true);
              }}
              testID="leave-group"
              variant="destructive"
            />
          </View>
          {confirmLeave && group.role !== 'owner' ? (
            <GroupConfirmation
              title={pt.groups.detail.confirmLeave(group.name)}
              testID="leave-confirmation"
            >
              <AppButton
                icon="log-out"
                label={pt.groups.detail.leave}
                onPress={() => {
                  if (group.role !== 'owner' && !leaving.isPending) leaving.mutate();
                }}
                testID="confirm-leave-group"
                variant="destructive"
              />
              <AppButton
                label={pt.groups.members.cancel}
                onPress={() => {
                  if (leaving.isPending) return;
                  setConfirmLeave(false);
                  focusGroupControl('leave-group');
                }}
                testID="cancel-leave-group"
                variant="secondary"
              />
            </GroupConfirmation>
          ) : null}
        </View>
      ) : null}
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm },
  heading: { gap: spacing.xs },
  hero: { gap: spacing.ms },
  leave: { gap: spacing.sm, paddingTop: spacing.sm },
  // The text-only button keeps its 48 px target; its text lines up with the reason.
  leaveAction: { alignItems: 'flex-start', marginLeft: -spacing.md },
  lists: { gap: spacing.sm },
  name: { ...typography.title },
  overline: { ...typography.overline },
  reason: { ...typography.support },
  role: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  roleText: { ...typography.supportStrong },
  section: { ...typography.title },
  subsection: { ...typography.row, paddingTop: spacing.sm },
});
