import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { AppError, TransportError, api, type MutationIntent, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT, withCurrentAccessToken } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';

import { groupErrorMessage } from './group-errors';

export function GroupDetailScreen({ groupId, profile }: { groupId: string; profile: OwnProfile }) {
  const queryClient = useQueryClient();
  const { colors } = useTheme();
  const intent = useRef<MutationIntent<unknown> | null>(null);
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
  return (
    <AuthenticatedShell {...pt.groups.detail}>
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
          <SectionHeading
            eyebrow={
              group.role === 'owner'
                ? pt.groups.list.owner
                : group.role === 'organizer'
                  ? pt.groups.list.organizer
                  : pt.groups.list.player
            }
            title={group.name}
          />
          {group.role === 'owner' || group.role === 'organizer' ? (
            <AppButton
              label={pt.groups.detail.invites}
              onPress={() => router.push(`/grupos/${group.id}/convites`)}
            />
          ) : null}
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
            <View testID="group-members-list">
              <SectionHeading eyebrow={pt.groups.detail.eyebrow} title={pt.groups.detail.members} />
              {members.data
                .filter((member) => member.status === 'active')
                .map((member) => (
                  <Text key={member.profile_id} style={[styles.reason, { color: colors.text }]}>
                    {member.display_name} ·{' '}
                    {member.role === 'owner'
                      ? pt.groups.list.owner
                      : member.role === 'organizer'
                        ? pt.groups.list.organizer
                        : pt.groups.detail.player}
                  </Text>
                ))}
              {members.data.some((member) => member.status === 'pending') ? (
                <View testID="group-pending-members-list">
                  <SectionHeading
                    eyebrow={pt.groups.list.pending}
                    title={pt.groups.detail.pendingMembers}
                  />
                  {members.data
                    .filter((member) => member.status === 'pending')
                    .map((member) => (
                      <Text key={member.profile_id} style={[styles.reason, { color: colors.text }]}>
                        {member.display_name}
                      </Text>
                    ))}
                </View>
              ) : null}
            </View>
          ) : null}
          {leaving.error ? <AppAlert message={groupErrorMessage(leaving.error)} /> : null}
          {leaving.isSuccess ? <AppStatus message={pt.groups.detail.left} /> : null}
          {group.role === 'owner' ? (
            <Text nativeID="owner-leave-reason" style={[styles.reason, { color: colors.text }]}>
              {pt.groups.detail.ownerLeaveReason}
            </Text>
          ) : null}
          <AppButton
            ariaDisabled={group.role === 'owner'}
            describedBy={group.role === 'owner' ? 'owner-leave-reason' : undefined}
            label={pt.groups.detail.leave}
            onPress={() => {
              if (group.role !== 'owner' && !leaving.isPending) leaving.mutate();
            }}
            testID="leave-group"
            variant="secondary"
          />
        </AppCard>
      ) : null}
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({ reason: { fontSize: 16, lineHeight: 24 } });
