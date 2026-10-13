import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { Scoreboard } from '@/components/ui/Scoreboard';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { api, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT, withCurrentAccessToken } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { MAX_ACTIVE_GROUPS } from './group-limits';

function roleLabel(role: string) {
  if (role === 'owner') return pt.groups.list.owner;
  if (role === 'organizer') return pt.groups.list.organizer;
  return pt.groups.list.player;
}

export function GroupsListScreen({ left, profile }: { left?: boolean; profile: OwnProfile }) {
  const { colors } = useTheme();
  const listing = useQuery({
    queryKey: [PRIVATE_QUERY_ROOT, 'groups', profile.id],
    queryFn: () =>
      withCurrentAccessToken(async (token) => {
        const [groups, pending] = await Promise.all([
          api.getOwnGroups(profile.id, token),
          api.getMyPendingGroupRequests(),
        ]);
        return { groups, pending };
      }),
  });
  const actions = (
    <View style={styles.actions}>
      <AppButton
        icon="plus"
        label={pt.groups.list.create}
        onPress={() => router.push('/grupos/criar')}
      />
      <AppButton
        icon="hash"
        label={pt.groups.list.join}
        onPress={() => router.push('/join')}
        variant="tertiary"
      />
    </View>
  );
  // docs/29 §5: active groups are the size of getOwnGroups (active memberships
  // only); the limit is the D6 constant. Pending requests never count.
  const activeGroups = listing.data?.groups.length;
  const hero =
    activeGroups === undefined ? undefined : (
      <View style={styles.hero}>
        <Text aria-hidden style={[styles.overline, { color: colors.onBandMuted }]}>
          {pt.groups.list.activeOverline}
        </Text>
        <Scoreboard
          accessibilityLabel={pt.groups.list.activeCount(activeGroups, MAX_ACTIVE_GROUPS)}
          groups={[
            { chars: String(activeGroups).padStart(2, '0') },
            { chars: String(MAX_ACTIVE_GROUPS).padStart(2, '0'), reference: true },
          ]}
          testID="groups-scoreboard"
        />
      </View>
    );
  return (
    <AuthenticatedShell {...pt.groups.list} hero={hero}>
      {left ? <AppStatus message={pt.groups.detail.left} testID="group-left-status" /> : null}
      {listing.isPending ? <AsyncNotice kind="loading" message={pt.common.loading} /> : null}
      {listing.isError ? (
        <AsyncNotice
          kind="network"
          title={pt.common.networkTitle}
          message={pt.common.networkBody}
          actionLabel={pt.common.retry}
          action={() => void listing.refetch()}
        />
      ) : null}
      {listing.data && listing.data.groups.length === 0 && listing.data.pending.length === 0 ? (
        <AsyncNotice
          kind="empty"
          title={pt.groups.list.emptyTitle}
          message={pt.groups.list.emptyBody}
          actionLabel={pt.groups.list.create}
          action={() => router.push('/grupos/criar')}
        />
      ) : null}
      {listing.data?.groups.map((group) => (
        <AppCard key={group.id} testID="group-list-card">
          <SectionHeading eyebrow={roleLabel(group.role)} title={group.name} />
          <AppButton
            icon="chevron-right"
            label={`${pt.groups.list.open}: ${group.name}`}
            onPress={() => router.push(`/grupos/${group.id}`)}
            variant="secondary"
          />
        </AppCard>
      ))}
      {listing.data?.pending.map((pending) => (
        <AppCard key={pending.group_id} testID="pending-group-card">
          <SectionHeading
            eyebrow={pt.groups.list.pending}
            eyebrowIcon="clock"
            eyebrowTone="warning"
            title={pending.group_name}
          />
          <Text style={[styles.body, { color: colors.textMuted }]}>
            {pt.groups.join.pendingBody}
          </Text>
        </AppCard>
      ))}
      {listing.data && (listing.data.groups.length > 0 || listing.data.pending.length > 0)
        ? actions
        : null}
      {listing.data && listing.data.groups.length === 0 && listing.data.pending.length === 0 ? (
        <AppButton
          icon="hash"
          label={pt.groups.list.join}
          onPress={() => router.push('/join')}
          variant="tertiary"
        />
      ) : null}
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm, paddingTop: spacing.sm },
  body: { ...typography.body },
  hero: { gap: spacing.ms },
  overline: { ...typography.overline },
});
