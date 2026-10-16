import { useQuery } from '@tanstack/react-query';
import { Link, router } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppIcon } from '@/components/ui/AppIcon';
import { AuthenticatedListShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { Scoreboard } from '@/components/ui/Scoreboard';
import { api, type MatchOccupancy, type MatchSummary, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT, withCurrentAccessToken } from '@/lib/private-queries';
import { useReducedMotion } from '@/theme/motion';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { matchDay, matchPrice, matchTime } from './match-format';

export const matchesQueryKey = (profileId: string) => [PRIVATE_QUERY_ROOT, 'matches', profileId];

/** One match: the whole row opens it. Day and time, place, group, occupancy and price. */
function MatchRow({
  match,
  occupancy,
}: {
  match: MatchSummary;
  occupancy?: MatchOccupancy | undefined;
}) {
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();
  const day = matchDay(match.starts_at, match.timezone);
  const time = matchTime(match.starts_at, match.timezone);
  return (
    <Link asChild href={`/rachas/${match.id}`}>
      <Pressable
        accessibilityLabel={pt.matches.list.view(match.location_name, day, time)}
        accessibilityRole="link"
        style={styles.rowTarget}
        testID="match-list-card"
      >
        {({ pressed }) => (
          <View
            style={[
              styles.row,
              {
                backgroundColor: colors.surfaceRaised,
                opacity: pressed ? 0.86 : 1,
                transform: [{ scale: pressed && !reducedMotion ? 0.99 : 1 }],
              },
              Platform.OS === 'web'
                ? ({
                    transitionDuration: pressed ? '100ms' : '160ms',
                    transitionProperty: 'transform, opacity',
                  } as ViewStyle)
                : null,
            ]}
          >
            <View style={[styles.when, { backgroundColor: colors.scoreboard }]}>
              <Text style={[styles.whenDay, { color: colors.digitDim }]}>{day}</Text>
              <Text style={[styles.whenTime, { color: colors.digit }]}>{time}</Text>
            </View>
            <View style={styles.rowText}>
              <Text aria-level={2} role="heading" style={[styles.rowName, { color: colors.text }]}>
                {match.location_name}
              </Text>
              <View style={styles.meta}>
                <AppIcon color={colors.textMuted} name="users" size={16} />
                <Text style={[styles.metaText, { color: colors.textMuted }]}>
                  {match.group_name}
                </Text>
              </View>
              <Text
                style={[styles.metaText, styles.metaStrong, { color: colors.text }]}
                testID="match-list-occupancy"
              >
                {occupancy
                  ? pt.matches.list.occupancy(occupancy.confirmed_count, match.field_slots)
                  : pt.matches.list.slots(match.field_slots)}
                {occupancy && occupancy.waitlist_count > 0
                  ? ` · ${pt.matches.list.waiting(occupancy.waitlist_count)}`
                  : ''}{' '}
                · {pt.matches.list.perPlayer(matchPrice(match.field_price))}
              </Text>
              {occupancy && occupancy.viewer_status !== 'out' ? (
                <View style={styles.meta}>
                  <AppIcon
                    color={colors.positive}
                    name={occupancy.viewer_status === 'starter' ? 'check-circle' : 'clock'}
                    size={16}
                  />
                  <Text
                    style={[styles.metaText, { color: colors.positive }]}
                    testID="match-list-viewer"
                  >
                    {occupancy.viewer_status === 'starter'
                      ? pt.matches.list.viewerStarter
                      : pt.matches.list.viewerWaitlist}
                  </Text>
                </View>
              ) : null}
            </View>
            <AppIcon color={colors.textMuted} name="chevron-right" size={24} />
          </View>
        )}
      </Pressable>
    </Link>
  );
}

export function MatchesListScreen({ profile }: { profile: OwnProfile }) {
  const { colors } = useTheme();
  const listing = useQuery({
    queryKey: matchesQueryKey(profile.id),
    queryFn: () =>
      withCurrentAccessToken(async (token) => {
        const [matches, groups, occupancy] = await Promise.all([
          api.getUpcomingMatches(),
          api.getOwnGroups(profile.id, token),
          api.getMatchesOccupancy(),
        ]);
        return {
          matches,
          occupancy: new Map(occupancy.map((row) => [row.match_id, row])),
          canCreate: groups.some((group) => group.role === 'owner' || group.role === 'organizer'),
        };
      }),
  });
  const matches = listing.data?.matches ?? [];
  const next = matches[0];
  const hero =
    next === undefined ? undefined : (
      <View style={styles.hero}>
        <Text aria-hidden style={[styles.overline, { color: colors.onBandMuted }]}>
          {pt.matches.list.nextOverline}
        </Text>
        <Scoreboard
          accessibilityLabel={pt.matches.list.next(
            matchDay(next.starts_at, next.timezone),
            matchTime(next.starts_at, next.timezone),
            next.field_slots,
          )}
          groups={[
            { chars: matchTime(next.starts_at, next.timezone) },
            { chars: String(next.field_slots).padStart(2, '0'), reference: true },
          ]}
          testID="matches-scoreboard"
        />
      </View>
    );
  const create = () => router.push('/criar-racha');
  return (
    <AuthenticatedListShell
      data={matches}
      footer={
        listing.data?.canCreate && matches.length > 0 ? (
          <AppButton
            icon="plus"
            label={pt.matches.list.create}
            onPress={create}
            testID="matches-create"
          />
        ) : undefined
      }
      hero={hero}
      keyExtractor={(match) => match.id}
      renderItem={(match) => (
        <MatchRow match={match} occupancy={listing.data?.occupancy.get(match.id)} />
      )}
      title={pt.matches.list.title}
    >
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
      {listing.data && matches.length === 0 ? (
        <AsyncNotice
          kind="empty"
          title={pt.matches.list.emptyTitle}
          message={
            listing.data.canCreate ? pt.matches.list.emptyOrganizer : pt.matches.list.emptyBody
          }
          actionLabel={listing.data.canCreate ? pt.matches.list.create : pt.matches.list.groups}
          action={listing.data.canCreate ? create : () => router.navigate('/grupos')}
        />
      ) : null}
    </AuthenticatedListShell>
  );
}

const styles = StyleSheet.create({
  hero: { gap: spacing.ms },
  meta: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  metaStrong: { ...typography.supportStrong },
  metaText: { ...typography.support, flexShrink: 1 },
  overline: { ...typography.overline },
  row: {
    alignItems: 'center',
    borderRadius: radius.row,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: size.row + spacing.ms,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingVertical: spacing.md,
  },
  rowName: { ...typography.row },
  rowTarget: { borderRadius: radius.row },
  rowText: { flex: 1, gap: spacing.xs, minWidth: 0 },
  when: {
    alignItems: 'center',
    borderRadius: radius.row,
    gap: 2,
    minWidth: 76,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  whenDay: { ...typography.overline },
  whenTime: { ...typography.row, fontVariant: ['tabular-nums'] },
});
