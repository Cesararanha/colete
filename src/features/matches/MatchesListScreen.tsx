import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AuthenticatedListShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { Scoreboard } from '@/components/ui/Scoreboard';
import type { OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { MatchCard } from './MatchCard';
import { matchDay, matchTime } from './match-format';
import { useUpcomingMatches } from './use-upcoming-matches';

export { matchesQueryKey } from './use-upcoming-matches';

export function MatchesListScreen({ profile }: { profile: OwnProfile }) {
  const { colors } = useTheme();
  const listing = useUpcomingMatches(profile);
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
        <MatchCard match={match} occupancy={listing.data?.occupancy.get(match.id)} showGroup />
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
  overline: { ...typography.overline },
});
