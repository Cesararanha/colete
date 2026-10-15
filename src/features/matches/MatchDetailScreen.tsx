import { useQuery } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppIcon, type IconName } from '@/components/ui/AppIcon';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { Scoreboard } from '@/components/ui/Scoreboard';
import { api, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { backTo } from '@/lib/navigation';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { matchLongDay, matchPrice, matchTime } from './match-format';
import { openMatchMap } from './match-map';

function Fact({
  icon,
  label,
  testID,
  value,
  detail,
}: {
  icon: IconName;
  label: string;
  testID: string;
  value: string;
  detail?: string | undefined;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.fact} testID={testID}>
      <AppIcon color={colors.textMuted} name={icon} size={20} />
      <View style={styles.factText}>
        <Text style={[styles.factLabel, { color: colors.textMuted }]}>{label}</Text>
        <Text style={[styles.factValue, { color: colors.text }]}>{value}</Text>
        {detail ? (
          <Text style={[styles.factDetail, { color: colors.textMuted }]}>{detail}</Text>
        ) : null}
      </View>
    </View>
  );
}

export function MatchDetailScreen({ matchId, profile }: { matchId: string; profile: OwnProfile }) {
  const { colors } = useTheme();
  const detail = useQuery({
    queryKey: [PRIVATE_QUERY_ROOT, 'matches', profile.id, matchId],
    queryFn: ({ signal }) => api.getMatch(matchId, signal),
  });
  const match = detail.data ?? undefined;
  const back = {
    label: pt.matches.detail.back,
    href: '/rachas' as const,
    testID: 'match-back',
  };
  const start = match ? matchTime(match.starts_at, match.timezone) : '';
  const hero = match ? (
    <View style={styles.hero}>
      <Text aria-hidden style={[styles.overline, { color: colors.onBandMuted }]}>
        {pt.matches.detail.overline}
      </Text>
      <Scoreboard
        accessibilityLabel={pt.matches.detail.scoreboard(start, match.field_slots)}
        groups={[
          { chars: start },
          { chars: String(match.field_slots).padStart(2, '0'), reference: true },
        ]}
        testID="match-scoreboard"
      />
    </View>
  ) : undefined;
  return (
    <AuthenticatedShell
      back={back}
      eyebrow={pt.matches.detail.eyebrow}
      hero={hero}
      title={match?.location_name ?? pt.matches.detail.title}
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
      {detail.isSuccess && match === undefined ? (
        <AsyncNotice
          action={() => backTo(back.href)}
          actionLabel={pt.matches.detail.back}
          kind="empty"
          message={pt.matches.detail.missing}
          title={pt.matches.detail.missingTitle}
        />
      ) : null}
      {match ? (
        <>
          <AppCard testID="match-detail-card">
            <Fact
              detail={pt.matches.detail.timezone(match.timezone)}
              icon="calendar"
              label={pt.matches.detail.when}
              testID="match-fact-when"
              value={pt.matches.detail.schedule(
                matchLongDay(match.starts_at, match.timezone),
                start,
                matchTime(match.ends_at, match.timezone),
              )}
            />
            <Fact
              detail={match.location_address ?? undefined}
              icon="map-pin"
              label={pt.matches.detail.where}
              testID="match-fact-where"
              value={match.location_name}
            />
            <Fact
              detail={pt.matches.detail.payNote}
              icon="dollar-sign"
              label={pt.matches.detail.price}
              testID="match-fact-price"
              value={matchPrice(match.field_price)}
            />
            <Fact
              icon="users"
              label={pt.matches.detail.group}
              testID="match-fact-group"
              value={match.group_name}
            />
          </AppCard>
          <View style={styles.actions}>
            <AppButton
              icon="map"
              label={pt.matches.detail.map}
              onPress={() => openMatchMap(match)}
              testID="match-map"
              variant="secondary"
            />
            <Text style={[styles.hint, { color: colors.textMuted }]}>
              {pt.matches.detail.mapHint}
            </Text>
          </View>
        </>
      ) : null}
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.xs },
  fact: { flexDirection: 'row', gap: spacing.md },
  factDetail: { ...typography.support },
  factLabel: { ...typography.supportStrong },
  factText: { flex: 1, gap: 2, minWidth: 0 },
  factValue: { ...typography.body },
  hero: { gap: spacing.ms },
  hint: { ...typography.support },
  overline: { ...typography.overline },
});
