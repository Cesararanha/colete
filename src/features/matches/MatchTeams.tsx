import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { Chip } from '@/components/ui/Chip';
import {
  AppError,
  api,
  type MatchRoster,
  type MatchTeamCount,
  type MatchTeamPlayer,
  type MatchTeams,
  type MatchTeamsOutcome,
} from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';
import { useLiveInterval } from '@/lib/use-live-interval';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { face, typography } from '@/theme/typography';

import { focusGroupControl, GroupConfirmation } from '../groups/GroupConfirmation';
import { PhotoAvatar } from '../photos/PhotoAvatar';
import { matchErrorMessage } from './match-errors';
import { entryDetail, entryName } from './roster-entry';
import { TEAM_COUNTS, teamColete } from './team-coletes';
import { useMatchActions } from './useMatchActions';

function PlayerRow({ entry, testID }: { entry: MatchTeamPlayer; testID: string }) {
  const { colors } = useTheme();
  const name = entryName(entry);
  const detail = entryDetail(entry);
  return (
    <View style={styles.player} testID={testID}>
      <PhotoAvatar id={entry.account_removed ? null : entry.profile_id} name={name} size={36} />
      <Text style={[styles.playerName, { color: colors.text }]}>
        {name}
        {detail ? (
          <Text style={[styles.playerDetail, { color: colors.textMuted }]}> · {detail}</Text>
        ) : null}
      </Text>
    </View>
  );
}

/**
 * One team as the bib it wears: the band on the left is the bib's colour, and
 * the colour is said in words under the name, since it is which bib to pick.
 * "Sem time" is the same card with a neutral band and no bib.
 */
function TeamCard({
  band,
  players,
  subtitle,
  subtitleColor,
  testID,
  title,
}: {
  band: string;
  players: MatchTeamPlayer[];
  subtitle: string;
  subtitleColor: string;
  testID: string;
  title: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.surface }]} testID={testID}>
      <View style={[styles.band, { backgroundColor: band }]} />
      <View style={styles.cardBody}>
        <View>
          <Text aria-level={3} role="heading" style={[styles.teamName, { color: colors.text }]}>
            {title}
          </Text>
          <Text style={[styles.teamMeta, { color: subtitleColor }]} testID={`${testID}-meta`}>
            {subtitle}
          </Text>
        </View>
        <View role="list" style={styles.players}>
          {players.map((entry, index) => (
            <View key={entry.profile_id ?? `removed-${index}`} role="listitem">
              <PlayerRow entry={entry} testID={`${testID}-player-${index}`} />
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

function Teams({ teams }: { teams: MatchTeams }) {
  const { colors } = useTheme();
  return (
    <View style={styles.cards}>
      {teams.teams.map((team) => {
        const colete = teamColete(team.team_number);
        return (
          <TeamCard
            band={colors[colete.tone]}
            key={team.team_number}
            players={team.players}
            subtitle={`${pt.matches.teams.coletes[colete.color]} · ${pt.matches.teams.players(team.players.length)}`}
            subtitleColor={colors[colete.tone]}
            testID={`match-team-${colete.letter}`}
            title={pt.matches.teams.team(colete.letter)}
          />
        );
      })}
      {teams.unassigned.length > 0 ? (
        <TeamCard
          band={colors.fieldBorder}
          players={teams.unassigned}
          subtitle={pt.matches.teams.players(teams.unassigned.length)}
          subtitleColor={colors.textMuted}
          testID="match-team-none"
          title={pt.matches.teams.unassigned}
        />
      ) : null}
    </View>
  );
}

/**
 * "Times", after "Confirmados" (0032). Every active member sees the teams of
 * the last draw; whoever may create matches also chooses 2, 3 or 4 and draws,
 * on the server. Drawing again replaces the teams, after a confirmation in
 * place. A canceled match shows no teams.
 */
/** The teams of a match, under the match's key; the detail also reads their state (HX-003). */
export const matchTeamsQueryKey = (profileId: string, matchId: string) =>
  [PRIVATE_QUERY_ROOT, 'matches', profileId, matchId, 'teams'] as const;

export function MatchTeamsSection({
  ended,
  matchId,
  profileId,
  roster,
}: {
  /** The match is over: nobody may draw again (can_draw is false after ends_at). */
  ended: boolean;
  matchId: string;
  profileId: string;
  roster: MatchRoster;
}) {
  const { colors } = useTheme();
  // Under the match's key: a presence, payment or draw re-reads it with the roster.
  const refetchInterval = useLiveInterval();
  const query = useQuery({
    enabled: !roster.canceled,
    queryKey: matchTeamsQueryKey(profileId, matchId),
    queryFn: ({ signal }) => api.getMatchTeams(matchId, signal),
    refetchInterval,
  });
  const actions = useMatchActions(profileId);
  const [count, setCount] = useState<MatchTeamCount>(2);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('');
  const restoreFocus = useRef<string | null>(null);
  // docs/01 section 5.7: unequal sizes need a confirmation that travels in the call.
  // The server asks for it when the list changed meanwhile: the confirmation opens from that answer.
  const askedUnequal =
    actions.error instanceof AppError &&
    actions.error.code === 'UNEQUAL_TEAMS_CONFIRMATION_REQUIRED';
  const open = confirming || askedUnequal;
  // Closing gives the focus back whichever way it opened, the server's answer
  // included (rev82, BB-013).
  useEffect(() => {
    if (!open && restoreFocus.current) {
      focusGroupControl(restoreFocus.current);
      restoreFocus.current = null;
    }
  }, [open]);

  const teams = query.data;
  if (roster.canceled || teams === undefined) {
    return query.isError ? (
      <View style={styles.section}>
        <AppAlert message={matchErrorMessage(query.error)} testID="match-teams-error" />
        <AppButton
          label={pt.common.retry}
          onPress={() => void query.refetch()}
          testID="match-teams-retry"
          variant="secondary"
        />
      </View>
    ) : null;
  }
  const drawn = teams.teams.length > 0;
  // A player sees the teams only once there are teams to see.
  if (!drawn && !teams.can_draw) return null;

  // Below two per team the server refuses first (TEAM_SIZE_INVALID); asking about sizes would mislead.
  const unequal =
    (roster.confirmed_count >= 2 * count && roster.confirmed_count % count !== 0) || askedUnequal;
  const draw = (confirmUnequal: boolean) => {
    setMessage('');
    void actions
      .run<MatchTeamsOutcome>(`draw:${count}:${confirmUnequal}`, () =>
        api.drawTeams(matchId, count, confirmUnequal),
      )
      .then((result) => {
        if (!result) return;
        setConfirming(false);
        setMessage(pt.matches.teams.drawn);
      });
  };
  const error = actions.error;
  const errorMessage =
    error instanceof AppError && error.code === 'UNEQUAL_TEAMS_CONFIRMATION_REQUIRED'
      ? ''
      : error instanceof AppError && error.code === 'TEAM_SIZE_INVALID'
        ? pt.matches.teams.errors.teamSize(count)
        : error instanceof AppError && error.code === 'RATINGS_MISSING'
          ? pt.matches.teams.errors.ratingsMissing
          : error instanceof AppError && error.code === 'NOT_ORGANIZER'
            ? pt.matches.teams.errors.notOrganizer
            : error
              ? matchErrorMessage(error, 'manage')
              : '';

  return (
    <View style={styles.section} testID="match-teams">
      <View style={styles.head}>
        <Text aria-level={2} role="heading" style={[styles.heading, { color: colors.text }]}>
          {pt.matches.teams.title}
        </Text>
        {drawn && teams.stale ? (
          <Chip
            icon="alert-triangle"
            label={pt.matches.teams.stale}
            testID="match-teams-stale"
            tone="warning"
          />
        ) : null}
      </View>
      {drawn && teams.stale ? (
        // UX-021: the chip says what happened; this says why and what can be done.
        // The server marks the teams stale when who plays changed or a drawn
        // rating changed (0032), without saying which: the reason names both.
        // A new draw is offered only where can_draw allows it; after the end
        // nobody may draw, and the text does not promise it.
        <Text style={[styles.body, { color: colors.textSoft }]} testID="match-teams-stale-hint">
          {`${pt.matches.teams.staleReason} ${
            teams.can_draw
              ? pt.matches.teams.staleDraw
              : ended
                ? pt.matches.teams.staleEnded
                : pt.matches.teams.staleAsk
          }`}
        </Text>
      ) : null}
      {drawn ? <Teams teams={teams} /> : null}
      {teams.can_draw ? (
        <View style={styles.controls}>
          <View
            aria-label={pt.matches.teams.countGroup}
            role="group"
            style={styles.counts}
            testID="match-teams-count"
          >
            {TEAM_COUNTS.map((option) => (
              <AppButton
                compact
                key={option}
                label={pt.matches.teams.count(option)}
                onPress={() => {
                  if (actions.pending) return;
                  setCount(option);
                  actions.clearError();
                }}
                pressed={count === option}
                testID={`match-teams-count-${option}`}
                variant="outline"
              />
            ))}
          </View>
          <AppStatus message={message} testID="match-teams-result" />
          <AppAlert message={errorMessage} testID="match-teams-draw-error" />
          {open ? (
            <GroupConfirmation
              title={drawn ? pt.matches.teams.redrawTitle : pt.matches.teams.unequalTitle}
              testID="match-teams-confirmation"
            >
              {drawn ? (
                <Text style={[styles.body, { color: colors.text }]}>
                  {pt.matches.teams.redrawBody}
                </Text>
              ) : null}
              {unequal ? (
                <Text style={[styles.body, { color: colors.text }]} testID="match-teams-unequal">
                  {pt.matches.teams.unequalBody}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <AppButton
                  ariaDisabled={actions.pending}
                  icon="shuffle"
                  label={
                    actions.pending
                      ? pt.matches.teams.drawing
                      : drawn
                        ? pt.matches.teams.redraw
                        : pt.matches.teams.drawAnyway
                  }
                  onPress={() => {
                    if (!actions.pending) draw(unequal);
                  }}
                  testID="match-teams-confirm"
                />
                <AppButton
                  label={pt.matches.teams.keep}
                  onPress={() => {
                    if (actions.pending) return;
                    restoreFocus.current = drawn ? 'match-teams-redraw' : 'match-teams-draw';
                    actions.clearError();
                    actions.discardIntent();
                    setConfirming(false);
                  }}
                  testID="match-teams-keep"
                  variant="secondary"
                />
              </View>
            </GroupConfirmation>
          ) : drawn ? (
            <AppButton
              icon="shuffle"
              label={pt.matches.teams.redraw}
              onPress={() => {
                setMessage('');
                actions.clearError();
                setConfirming(true);
              }}
              testID="match-teams-redraw"
              variant="outline"
            />
          ) : (
            <AppButton
              ariaDisabled={actions.pending}
              icon="shuffle"
              label={actions.pending ? pt.matches.teams.drawing : pt.matches.teams.draw}
              onPress={() => {
                if (actions.pending) return;
                setMessage('');
                actions.clearError();
                if (unequal) setConfirming(true);
                else draw(false);
              }}
              testID="match-teams-draw"
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, minWidth: 0 },
  band: { borderBottomLeftRadius: radius.field, borderTopLeftRadius: radius.field, width: 6 },
  body: { ...typography.body },
  card: { borderRadius: radius.field + 2, flexDirection: 'row', overflow: 'hidden' },
  cardBody: {
    flex: 1,
    gap: spacing.ms,
    minWidth: 0,
    paddingHorizontal: spacing.ms,
    paddingVertical: spacing.ms,
  },
  cards: { gap: spacing.ms },
  controls: { gap: spacing.sm, paddingTop: spacing.xs },
  counts: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  head: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  heading: { ...typography.section },
  player: { alignItems: 'center', flexDirection: 'row', gap: spacing.ms, minHeight: 36 },
  playerDetail: { ...face('regular') },
  playerName: { ...typography.supportStrong, flex: 1, minWidth: 0 },
  players: { gap: spacing.sm },
  section: { gap: spacing.sm, paddingTop: spacing.xs },
  teamMeta: { ...typography.captionStrong },
  teamName: { ...face('condensed'), fontSize: 24, lineHeight: 28 },
});
