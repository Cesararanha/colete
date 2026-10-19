import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, router } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppIcon } from '@/components/ui/AppIcon';
import { Chip } from '@/components/ui/Chip';
import { GroupIcon } from '@/components/ui/GroupIcon';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { AppError, TransportError, api, type MutationIntent, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT, withCurrentAccessToken } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { groupErrorMessage } from './group-errors';
import { focusGroupControl, GroupConfirmation } from './GroupConfirmation';
import { useLeaveMissingGroup } from './leave-missing-group';
import { MemberRow } from './MemberRow';
import { MemberStack } from './MemberStack';
import { MatchCard } from '../matches/MatchCard';
import { useUpcomingMatches } from '../matches/use-upcoming-matches';

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
  useLeaveMissingGroup(detail.isSuccess && group === null);
  // The group's own upcoming matches, by start, from the Agenda's cached read.
  const upcoming = useUpcomingMatches(profile);
  const groupMatches = (upcoming.data?.matches ?? []).filter((match) => match.group_id === groupId);
  // The same role gate as the group tools; create_match decides again.
  const canOrganize = group?.role === 'owner' || group?.role === 'organizer';
  // docs/29 §5: the count comes from the getGroupMembers read the screen
  // already makes; no capacity is shown because the contract has none.
  const active = members.data?.filter((member) => member.status === 'active');
  const requests = members.data?.filter((member) => member.status === 'pending').length ?? 0;
  const intro = group ? (
    <View style={styles.intro} testID="group-detail-card">
      <GroupIcon appearance={group.appearance} size={56} tile />
      <View style={styles.introText}>
        <Text aria-level={1} role="heading" style={[styles.name, { color: colors.text }]}>
          {group.name}
        </Text>
        {active ? (
          <Text style={[styles.summary, { color: colors.textMuted }]} testID="group-summary">
            {pt.groups.detail.summary(active.length, group.role)}
          </Text>
        ) : null}
      </View>
    </View>
  ) : undefined;
  return (
    <AuthenticatedShell
      {...pt.groups.detail}
      back={{ label: pt.navigation.groups, href: '/grupos', testID: 'group-back' }}
      description=""
      {...(intro ? { intro } : {})}
    >
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
      {group ? (
        <View style={styles.section} testID="group-upcoming-matches">
          <View style={styles.sectionHeader}>
            <Text
              aria-level={2}
              role="heading"
              style={[styles.sectionTitle, { color: colors.text }]}
            >
              {pt.groups.detail.upcoming}
            </Text>
            {canOrganize ? (
              <AppButton
                compact
                icon="plus"
                label={pt.groups.detail.createMatch}
                onPress={() =>
                  router.push({ pathname: '/criar-racha', params: { groupId: group.id } })
                }
                testID="group-create-match"
              />
            ) : null}
          </View>
          {upcoming.isPending ? <AsyncNotice kind="loading" message={pt.common.loading} /> : null}
          {upcoming.isError ? (
            <AsyncNotice
              kind="network"
              title={pt.common.networkTitle}
              message={pt.common.networkBody}
              actionLabel={pt.common.retry}
              action={() => void upcoming.refetch()}
            />
          ) : null}
          {upcoming.data && groupMatches.length === 0 ? (
            <Text style={[styles.reason, { color: colors.textMuted }]}>
              {pt.groups.detail.upcomingEmpty}
            </Text>
          ) : null}
          {groupMatches.length > 0 ? (
            <View role="list" style={styles.lists}>
              {groupMatches.map((match) => (
                <View key={match.id} role="listitem">
                  <MatchCard
                    match={match}
                    occupancy={upcoming.data?.occupancy.get(match.id)}
                    showGroup={false}
                  />
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {group ? (
        <View style={styles.section}>
          <Text aria-level={2} role="heading" style={[styles.sectionTitle, { color: colors.text }]}>
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
          {active && canOrganize ? (
            // The organisation opens the member management from the card; the
            // requests chip is theirs only, as the decision is.
            <Link asChild href={`/grupos/${group.id}/membros`}>
              <Pressable
                accessibilityLabel={pt.groups.detail.openMembers(active.length, requests)}
                accessibilityRole="link"
                // Link asChild merges styles as an array, which the web DOM rejects:
                // one style object here, the colour on the View inside.
                style={styles.membersTarget}
                testID="group-members-link"
              >
                <View style={[styles.membersCard, { backgroundColor: colors.surface }]}>
                  <MemberStack members={active} />
                  <View style={styles.membersEnd}>
                    {requests > 0 ? (
                      <Chip
                        label={pt.groups.detail.requests(requests)}
                        testID="group-requests"
                        tone="warning"
                      />
                    ) : null}
                    <AppIcon color={colors.textMuted} name="chevron-right" size={20} />
                  </View>
                </View>
              </Pressable>
            </Link>
          ) : null}
          {active && !canOrganize ? (
            // A player cannot open the management screen (docs/25): the card
            // lists the members here, with their roles.
            <View
              style={[styles.membersList, { backgroundColor: colors.surface }]}
              testID="group-members-list"
            >
              <View role="list">
                {active.map((member, index) => (
                  <MemberRow
                    divider={index > 0}
                    id={member.profile_id}
                    key={member.profile_id}
                    name={member.display_name}
                    role={member.role}
                  />
                ))}
              </View>
            </View>
          ) : null}
          {canOrganize ? (
            <View style={styles.tools}>
              <View style={styles.tool}>
                <AppButton
                  icon="grid"
                  label={pt.groups.detail.invite}
                  onPress={() => router.push(`/grupos/${group.id}/convites`)}
                  testID="group-invites"
                  variant="outline"
                />
              </View>
              <View style={styles.tool}>
                <AppButton
                  icon="settings"
                  label={pt.groups.detail.configure}
                  onPress={() => router.push(`/grupos/${group.id}/configuracoes`)}
                  testID="group-settings"
                  variant="outline"
                />
              </View>
            </View>
          ) : null}
        </View>
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
  intro: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    minWidth: 0,
    paddingTop: spacing.xs,
  },
  introText: { flex: 1, gap: 2, minWidth: 0 },
  leave: { gap: spacing.sm, paddingTop: spacing.sm },
  // The text-only button keeps its 48 px target; its text lines up with the reason.
  leaveAction: { alignItems: 'flex-start', marginLeft: -spacing.md },
  lists: { gap: spacing.ms },
  membersCard: {
    alignItems: 'center',
    borderRadius: radius.scoreboard - 2,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
    minHeight: size.row,
    padding: 14,
  },
  membersTarget: { borderRadius: radius.scoreboard - 2 },
  membersEnd: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  membersList: { borderRadius: radius.scoreboard - 2, overflow: 'hidden' },
  name: { ...typography.heading },
  reason: { ...typography.support },
  section: { gap: 14 },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  sectionTitle: { ...typography.section },
  summary: { ...typography.support },
  tool: { flexBasis: 140, flexGrow: 1 },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
});
