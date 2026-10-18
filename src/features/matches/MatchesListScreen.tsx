import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AuthenticatedListShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import type { MatchSummary, OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { MatchCard } from './MatchCard';
import {
  matchesInNextWeek,
  matchPassesFilter,
  matchWeek,
  type MatchFilter,
  type MatchWeek,
} from './match-card-state';
import { useUpcomingMatches } from './use-upcoming-matches';

export { matchesQueryKey } from './use-upcoming-matches';

type Row =
  | { kind: 'week'; key: string; week: MatchWeek }
  | { kind: 'match'; key: string; match: MatchSummary };

const FILTERS: readonly MatchFilter[] = ['all', 'playing', 'open'];

/** A filter of the Agenda: a real button whose selection is aria-pressed. */
function FilterButton({
  filter,
  onPress,
  selected,
}: {
  filter: MatchFilter;
  onPress: () => void;
  selected: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      aria-pressed={selected}
      onPress={onPress}
      style={styles.filterTarget}
      testID={`matches-filter-${filter}`}
    >
      <View
        style={[styles.filter, { backgroundColor: selected ? colors.text : colors.surfaceRaised }]}
      >
        <Text style={[styles.filterText, { color: selected ? colors.background : colors.text }]}>
          {pt.matches.list.filters[filter]}
        </Text>
      </View>
    </Pressable>
  );
}

export function MatchesListScreen({ profile }: { profile: OwnProfile }) {
  const { colors } = useTheme();
  const listing = useUpcomingMatches(profile);
  const [filter, setFilter] = useState<MatchFilter>('all');
  const matches = useMemo(() => listing.data?.matches ?? [], [listing.data]);
  const occupancy = listing.data?.occupancy;
  // The weeks are read once per listing: "now" moves only when the list does.
  const rows = useMemo(() => {
    const now = new Date();
    const result: Row[] = [];
    let current: MatchWeek | null = null;
    for (const match of matches) {
      if (!matchPassesFilter(filter, match, occupancy?.get(match.id))) continue;
      const week = matchWeek(match.starts_at, match.timezone, now);
      if (week !== current) {
        current = week;
        result.push({ key: `week-${week}`, kind: 'week', week });
      }
      result.push({ key: match.id, kind: 'match', match });
    }
    return result;
  }, [filter, matches, occupancy]);
  const create = () => router.push('/criar-racha');
  return (
    <AuthenticatedListShell
      data={rows}
      description={
        listing.data ? pt.matches.list.nextSevenDays(matchesInNextWeek(matches, new Date())) : ''
      }
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
      keyExtractor={(row) => row.key}
      renderItem={(row) =>
        row.kind === 'week' ? (
          <Text
            aria-level={2}
            role="heading"
            style={[styles.week, { color: colors.textMuted }]}
            testID={`matches-week-${row.week}`}
          >
            {pt.matches.list.weeks[row.week]}
          </Text>
        ) : (
          <MatchCard match={row.match} occupancy={occupancy?.get(row.match.id)} showGroup />
        )
      }
      title={pt.matches.list.title}
      titleSize="display"
    >
      {matches.length > 0 ? (
        <View
          accessibilityLabel={pt.matches.list.filtersLabel}
          role="group"
          style={styles.filters}
          testID="matches-filters"
        >
          {FILTERS.map((item) => (
            <FilterButton
              filter={item}
              key={item}
              onPress={() => setFilter(item)}
              selected={filter === item}
            />
          ))}
        </View>
      ) : null}
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
      {matches.length > 0 && rows.length === 0 ? (
        <Text style={[styles.empty, { color: colors.textMuted }]} testID="matches-filter-empty">
          {pt.matches.list.filterEmpty}
        </Text>
      ) : null}
    </AuthenticatedListShell>
  );
}

const styles = StyleSheet.create({
  empty: { ...typography.support },
  filter: {
    alignItems: 'center',
    borderRadius: radius.pill,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: 14,
  },
  filterTarget: { justifyContent: 'center', minHeight: size.compact },
  filterText: { ...typography.supportStrong, fontSize: 14 },
  filters: { columnGap: spacing.sm, flexDirection: 'row', flexWrap: 'wrap' },
  week: {
    ...typography.overline,
    letterSpacing: 1.4,
    paddingTop: spacing.xs,
  },
});
