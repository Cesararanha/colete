import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppIcon, type IconName } from '@/components/ui/AppIcon';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { Avatar } from '@/components/ui/Avatar';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import { GroupIcon } from '@/components/ui/GroupIcon';
import { OccupancyBar } from '@/components/ui/OccupancyBar';
import {
  api,
  type MatchPaymentResult,
  type MatchPresenceResult,
  type MatchRoster,
  type MatchRosterEntry,
  type MatchSummary,
  type OwnProfile,
} from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { backTo } from '@/lib/navigation';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { face, typography } from '@/theme/typography';

import { focusGroupControl, GroupConfirmation } from '../groups/GroupConfirmation';
import { matchErrorMessage } from './match-errors';
import { distanceInMeters, distanceText } from './match-distance';
import { endsNextDay } from './match-card-state';
import { matchDateTitle, matchPrice, matchTimeRange } from './match-format';
import { openMatchMap } from './match-map';
import { useDeviceLocation } from './use-device-location';
import { useMatchActions } from './useMatchActions';

function entryName(entry: MatchRosterEntry): string {
  return entry.account_removed || entry.name === null
    ? pt.matches.detail.removedAccount
    : entry.name;
}

function entryDetail(entry: MatchRosterEntry): string {
  if (entry.account_removed) return '';
  const position =
    entry.position === null
      ? pt.matches.detail.noPosition
      : pt.matches.detail.positions[entry.position];
  return [entry.nickname, position, entry.is_viewer ? pt.matches.detail.you : null]
    .filter(Boolean)
    .join(' · ');
}

/** The state of the viewer on the board (prévia aprovada); the detail knows the waitlist position. */
function viewerChip(
  roster: MatchRoster,
): { tone: ChipTone; label: string; icon?: IconName } | null {
  if (roster.started) return { label: pt.matches.detail.startedChip, tone: 'neutral' };
  const viewer = roster.viewer;
  if (viewer.status === 'starter')
    return { icon: 'check', label: pt.matches.card.youGo, tone: 'positive' };
  if (viewer.status === 'waitlist')
    return {
      icon: 'clock',
      label:
        viewer.waitlist_position === null
          ? pt.matches.card.onWaitlist
          : pt.matches.detail.waitlistPosition(viewer.waitlist_position),
      tone: 'warning',
    };
  const open = roster.field_slots - roster.confirmed_count;
  return open > 0 ? { label: pt.matches.card.openSlots(open), tone: 'info' } : null;
}

/** The scoreboard of the match: confirmed over slots, the viewer's state and what is left. */
function Board({ roster }: { roster: MatchRoster }) {
  const { colors } = useTheme();
  const chip = viewerChip(roster);
  const open = Math.max(0, roster.field_slots - roster.confirmed_count);
  return (
    <View style={[styles.board, { backgroundColor: colors.scoreboard }]}>
      <View style={styles.boardTop}>
        <View
          accessibilityLabel={pt.matches.detail.occupancy(
            roster.confirmed_count,
            roster.field_slots,
          )}
          role="img"
          testID="match-scoreboard"
        >
          <Text aria-hidden style={[styles.boardLabel, { color: colors.digitDim }]}>
            {pt.matches.detail.confirmedLabel}
          </Text>
          <Text aria-hidden style={[styles.boardCount, { color: colors.digit }]}>
            {roster.confirmed_count}
            <Text style={{ color: colors.digitDim }}>/{roster.field_slots}</Text>
          </Text>
        </View>
        {chip ? (
          <Chip
            {...(chip.icon ? { icon: chip.icon } : {})}
            label={chip.label}
            testID="match-viewer-chip"
            tone={chip.tone}
          />
        ) : null}
      </View>
      <OccupancyBar
        color={colors.digit}
        height={8}
        ratio={roster.confirmed_count / Math.max(1, roster.field_slots)}
        track={colors.scoreTileTop}
      />
      <Text style={[styles.boardFoot, { color: colors.digitDim }]} testID="match-board-summary">
        {pt.matches.detail.openSummary(open, roster.waitlist_count)}
      </Text>
    </View>
  );
}

/**
 * The place, the map and the distance, the description and the price. "Ver
 * distância" asks for the position only on the press, computes the distance
 * on the device and shows it. The position stays in this component's memory:
 * never sent, stored, logged or put in a URL.
 */
function Place({ match }: { match: MatchSummary }) {
  const { colors } = useTheme();
  const { location, request } = useDeviceLocation();
  const located = match.latitude !== null && match.longitude !== null;
  return (
    <View style={[styles.card, { backgroundColor: colors.surface }]} testID="match-detail-card">
      <View style={styles.place} testID="match-fact-where">
        <AppIcon color={colors.info} name="map-pin" size={20} />
        <View style={styles.placeText}>
          <Text style={[styles.placeName, { color: colors.text }]}>{match.location_name}</Text>
          {match.location_address ? (
            <Text style={[styles.small, { color: colors.textMuted }]}>
              {match.location_address}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.placeActions}>
        <View style={styles.placeAction}>
          <AppButton
            label={pt.matches.detail.map}
            onPress={() => openMatchMap(match)}
            testID="match-map"
            variant="outline"
          />
        </View>
        {located ? (
          <View style={styles.placeAction} testID="match-distance">
            <AppButton
              ariaDisabled={location.status === 'requesting'}
              label={
                location.status === 'requesting'
                  ? pt.matches.detail.distanceLocating
                  : pt.matches.detail.distance
              }
              onPress={() => {
                if (location.status !== 'requesting') void request();
              }}
              testID="match-distance-button"
              variant="outline"
            />
          </View>
        ) : null}
      </View>
      {located &&
      location.status === 'found' &&
      match.latitude !== null &&
      match.longitude !== null ? (
        <AppStatus
          message={distanceText(
            distanceInMeters(location, { latitude: match.latitude, longitude: match.longitude }),
          )}
          testID="match-distance-result"
        />
      ) : null}
      {location.status === 'denied' ? (
        <AppAlert message={pt.matches.detail.distanceDenied} testID="match-distance-denied" />
      ) : null}
      {location.status === 'unavailable' ? (
        <AppAlert
          message={pt.matches.detail.distanceUnavailable}
          testID="match-distance-unavailable"
        />
      ) : null}
      {/* What leaves the device, and when: kept from the human decision on the map (#70). */}
      <Text style={[styles.caption, { color: colors.textMuted }]}>
        {pt.matches.detail.mapHint}
        {located ? ` ${pt.matches.detail.distanceHint}` : ''}
      </Text>
      {match.description ? (
        // Plain Text, never parsed: no link becomes pressable, no markup renders.
        <Text
          style={[styles.description, { color: colors.textSoft }]}
          testID="match-fact-description"
        >
          {match.description}
        </Text>
      ) : null}
      <View style={styles.price} testID="match-fact-price">
        <AppIcon color={colors.textMuted} name="dollar-sign" size={18} />
        <Text style={[styles.priceText, { color: colors.text }]}>
          {pt.matches.detail.perPlayer(matchPrice(match.field_price))}
        </Text>
      </View>
    </View>
  );
}

function Presence({
  matchId,
  profileId,
  roster,
}: {
  matchId: string;
  profileId: string;
  roster: MatchRoster;
}) {
  const { colors } = useTheme();
  const actions = useMatchActions(profileId);
  const [confirming, setConfirming] = useState(false);
  // Cancelling unmounts the focused control: focus goes back to "Desistir"
  // instead of falling to the document body (review of #71, P2).
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!confirming && restoreFocus.current) {
      restoreFocus.current = false;
      focusGroupControl('match-leave');
    }
  }, [confirming]);
  const [message, setMessage] = useState('');
  const viewer = roster.viewer;
  const resultMessage = (result: MatchPresenceResult) => {
    switch (result.outcome.logical_result) {
      case 'match_joined':
        return pt.matches.detail.joined;
      case 'match_waitlisted':
        return pt.matches.detail.waitlisted(result.current.waitlist_position ?? 0);
      case 'match_join_unchanged':
        return pt.matches.detail.joinUnchanged;
      case 'match_left':
        return pt.matches.detail.left;
      case 'match_leave_unchanged':
        return pt.matches.detail.leaveUnchanged;
    }
  };
  const join = () => {
    setMessage('');
    setConfirming(false);
    void actions
      .run('join', () => api.joinMatch(matchId))
      .then((result) => {
        if (result) setMessage(resultMessage(result));
      });
  };
  const leave = () => {
    setMessage('');
    void actions
      .run('leave', () => api.leaveMatch(matchId))
      .then((result) => {
        setConfirming(false);
        if (result) setMessage(resultMessage(result));
      });
  };
  return (
    <View style={styles.presence} testID="match-presence">
      {roster.started ? (
        <Text style={[styles.small, { color: colors.textMuted }]} testID="match-viewer-status">
          {pt.matches.detail.started}
        </Text>
      ) : null}
      <AppStatus message={message} testID="match-presence-result" />
      <AppAlert
        message={actions.error ? matchErrorMessage(actions.error) : ''}
        testID="match-presence-error"
      />
      {roster.started ? null : viewer.status === 'out' ? (
        <AppButton
          ariaDisabled={actions.pending}
          icon="check"
          label={pt.matches.detail.join}
          onPress={join}
          testID="match-join"
        />
      ) : confirming ? (
        <GroupConfirmation
          level={2}
          title={pt.matches.detail.leaveTitle}
          testID="match-leave-confirmation"
        >
          <Text style={[styles.body, { color: colors.text }]}>
            {viewer.status === 'starter'
              ? pt.matches.detail.leaveStarter
              : pt.matches.detail.leaveWaitlist}
          </Text>
          <AppButton
            ariaDisabled={actions.pending}
            label={pt.matches.detail.confirmLeave}
            onPress={leave}
            testID="match-leave-confirm"
            variant="destructive"
          />
          <AppButton
            label={pt.matches.detail.cancel}
            onPress={() => {
              restoreFocus.current = true;
              setConfirming(false);
              actions.discardIntent();
            }}
            testID="match-leave-cancel"
            variant="secondary"
          />
        </GroupConfirmation>
      ) : (
        <AppButton
          label={pt.matches.detail.leave}
          onPress={() => {
            setMessage('');
            actions.clearError();
            setConfirming(true);
          }}
          testID="match-leave"
          variant="outline-destructive"
        />
      )}
    </View>
  );
}

/** One confirmed player: initials, name and detail, and the payment where it can be seen. */
function ConfirmedRow({
  entry,
  manage,
  onMark,
  ownPaid,
  testID,
}: {
  entry: MatchRosterEntry;
  manage: boolean;
  onMark: (entry: MatchRosterEntry, paid: boolean) => void;
  /** The viewer's own payment, which a player sees only on their own line. */
  ownPaid: boolean | null;
  testID: string;
}) {
  const { colors } = useTheme();
  const name = entryName(entry);
  const detail = entryDetail(entry);
  // The organisation sees every line; a player only their own (viewer.paid).
  const paid =
    manage && typeof entry.paid === 'boolean' ? entry.paid : entry.is_viewer ? ownPaid : null;
  const canMark = manage && typeof entry.paid === 'boolean' && entry.profile_id !== null;
  return (
    <View style={[styles.entry, { backgroundColor: colors.surface }]} testID={testID}>
      <View style={styles.line}>
        <Avatar id={entry.account_removed ? null : entry.profile_id} name={name} size={36} />
        <Text style={[styles.rowName, { color: colors.text }]}>
          {name}
          {detail ? (
            <Text style={[styles.rowDetail, { color: colors.textMuted }]}> · {detail}</Text>
          ) : null}
        </Text>
        {paid === null ? null : (
          <Chip
            {...(paid ? { icon: 'check' as const } : {})}
            label={paid ? pt.matches.detail.paid : pt.matches.detail.unpaidChip}
            testID={
              manage && typeof entry.paid === 'boolean' ? `${testID}-paid` : 'match-own-payment'
            }
            tone={paid ? 'positive' : 'critical'}
          />
        )}
      </View>
      {/* The organisation's toggle sits under the name, so the name keeps its width. */}
      {canMark ? (
        <View style={styles.mark}>
          <AppButton
            accessibilityLabel={
              entry.paid
                ? pt.matches.detail.markUnpaidLabel(name)
                : pt.matches.detail.markPaidLabel(name)
            }
            compact
            label={entry.paid ? pt.matches.detail.markUnpaid : pt.matches.detail.markPaid}
            onPress={() => onMark(entry, !entry.paid)}
            testID={`${testID}-mark`}
            variant="outline"
          />
        </View>
      ) : null}
    </View>
  );
}

/** Beyond this many confirmed, the list opens with the first ones and "Ver os N confirmados". */
const COLLAPSED = 5;

function Rosters({
  matchId,
  profileId,
  roster,
}: {
  matchId: string;
  profileId: string;
  roster: MatchRoster;
}) {
  const { colors } = useTheme();
  const actions = useMatchActions(profileId);
  const [message, setMessage] = useState('');
  const [expanded, setExpanded] = useState(false);
  const manage = roster.viewer.can_manage;
  const summary = roster.payment_summary;
  const mark = (entry: MatchRosterEntry, paid: boolean) => {
    if (entry.profile_id === null) return;
    const target = entry.profile_id;
    setMessage('');
    void actions
      .run<MatchPaymentResult>(`pay:${target}:${paid}`, () =>
        api.setMatchPayment(matchId, target, paid),
      )
      .then((result) => {
        if (result) setMessage(pt.matches.detail.marked(entryName(entry), paid));
      });
  };
  const collapsible = roster.confirmed.length > COLLAPSED + 1;
  const shown = collapsible && !expanded ? roster.confirmed.slice(0, COLLAPSED) : roster.confirmed;
  return (
    <>
      <View style={styles.section} testID="match-confirmed">
        <View style={styles.sectionHead}>
          <Text aria-level={2} role="heading" style={[styles.heading, { color: colors.text }]}>
            {pt.matches.detail.confirmedTitle}
          </Text>
          {manage && summary ? (
            <View testID="match-payments">
              <Text
                style={[styles.small, { color: colors.textMuted }]}
                testID="match-payment-summary"
              >
                {pt.matches.detail.paymentSummary(
                  summary.paid_count,
                  summary.confirmed_count,
                  matchPrice(Number(summary.total)),
                )}
              </Text>
            </View>
          ) : null}
        </View>
        <AppStatus message={message} testID="match-payment-result" />
        <AppAlert
          message={actions.error ? matchErrorMessage(actions.error) : ''}
          testID="match-payment-error"
        />
        {roster.confirmed.length === 0 ? (
          <Text style={[styles.small, { color: colors.textMuted }]}>
            {pt.matches.detail.confirmedEmpty}
          </Text>
        ) : null}
        {/* The rows scroll with the screen: the list itself does not. */}
        <FlatList
          contentContainerStyle={styles.rows}
          data={shown}
          extraData={[manage, actions.pending, roster.viewer.paid]}
          keyExtractor={(entry, index) => entry.profile_id ?? `removed-${index}`}
          renderItem={({ item, index }) => (
            <ConfirmedRow
              entry={item}
              manage={manage}
              onMark={mark}
              ownPaid={roster.viewer.paid}
              testID={`match-confirmed-${index}`}
            />
          )}
          scrollEnabled={false}
        />
        {collapsible && !expanded ? (
          <View style={styles.more}>
            <AppButton
              label={pt.matches.detail.showAll(roster.confirmed.length)}
              onPress={() => setExpanded(true)}
              testID="match-confirmed-all"
              variant="tertiary"
            />
          </View>
        ) : null}
      </View>
      <View style={styles.section} testID="match-waitlist">
        <Text aria-level={2} role="heading" style={[styles.heading, { color: colors.text }]}>
          {pt.matches.detail.waitlistTitle}
        </Text>
        {roster.waitlist.length === 0 ? (
          <Text style={[styles.small, { color: colors.textMuted }]}>
            {pt.matches.detail.waitlistEmpty}
          </Text>
        ) : null}
        <FlatList
          contentContainerStyle={styles.rows}
          data={roster.waitlist}
          keyExtractor={(entry, index) => entry.profile_id ?? `removed-${index}`}
          renderItem={({ item, index }) => {
            const name = entryName(item);
            const detail = entryDetail(item);
            return (
              <View
                style={[styles.row, { backgroundColor: colors.surface }]}
                testID={`match-waitlist-${index}`}
              >
                <Text style={[styles.order, { color: colors.warning }]}>
                  {pt.matches.detail.ordinal(index + 1)}
                </Text>
                <Avatar id={item.account_removed ? null : item.profile_id} name={name} size={36} />
                <Text style={[styles.rowName, { color: colors.text }]}>
                  {name}
                  {detail ? (
                    <Text style={[styles.rowDetail, { color: colors.textMuted }]}> · {detail}</Text>
                  ) : null}
                </Text>
              </View>
            );
          }}
          scrollEnabled={false}
        />
      </View>
    </>
  );
}

export function MatchDetailScreen({ matchId, profile }: { matchId: string; profile: OwnProfile }) {
  const { colors } = useTheme();
  const detail = useQuery({
    queryKey: [PRIVATE_QUERY_ROOT, 'matches', profile.id, matchId],
    queryFn: ({ signal }) => api.getMatch(matchId, signal),
  });
  const match = detail.data ?? undefined;
  const rosterQuery = useQuery({
    enabled: match !== undefined,
    queryKey: [PRIVATE_QUERY_ROOT, 'matches', profile.id, matchId, 'roster'],
    queryFn: ({ signal }) => api.getMatchRoster(matchId, signal),
  });
  const roster = rosterQuery.data;
  const back = {
    label: pt.navigation.matches,
    href: '/rachas' as const,
    testID: 'match-back',
  };
  // The date is the title, in the match's own time zone ("Sáb, 18 out").
  const intro = match ? (
    <View style={styles.intro} testID="match-fact-when">
      <Text aria-level={1} role="heading" style={[styles.title, { color: colors.text }]}>
        {matchDateTitle(match.starts_at, match.timezone)}
      </Text>
      <Text style={[styles.when, { color: colors.textSoft }]}>
        {matchTimeRange(match.starts_at, match.ends_at, match.timezone)}
        {endsNextDay(match.starts_at, match.ends_at, match.timezone) ? (
          <Text style={{ color: colors.textMuted }}> {pt.matches.card.nextDay}</Text>
        ) : null}
      </Text>
      <View style={styles.group} testID="match-fact-group">
        <GroupIcon size={16} />
        <Text style={[styles.small, { color: colors.textMuted }]}>{match.group_name}</Text>
      </View>
    </View>
  ) : undefined;
  return (
    <AuthenticatedShell
      back={back}
      description=""
      hero={roster ? <Board roster={roster} /> : undefined}
      {...(intro ? { intro } : {})}
      title={match ? matchDateTitle(match.starts_at, match.timezone) : pt.matches.detail.title}
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
          <Place match={match} />
          {rosterQuery.isPending ? (
            <AsyncNotice kind="loading" message={pt.common.loading} />
          ) : null}
          {rosterQuery.isError ? (
            <AppAlert message={matchErrorMessage(rosterQuery.error)} testID="match-roster-error" />
          ) : null}
          {roster ? (
            <>
              <Presence matchId={matchId} profileId={profile.id} roster={roster} />
              <Rosters matchId={matchId} profileId={profile.id} roster={roster} />
            </>
          ) : null}
        </>
      ) : null}
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  board: {
    borderRadius: radius.scoreboard - 2,
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  boardCount: { ...face('condensed'), fontSize: 52, fontVariant: ['tabular-nums'], lineHeight: 56 },
  boardFoot: { ...typography.support, fontSize: 14 },
  boardLabel: { ...typography.captionStrong },
  boardTop: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  body: { ...typography.body },
  caption: { ...typography.caption },
  card: {
    borderRadius: radius.scoreboard - 2,
    gap: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  description: { ...typography.support },
  group: { alignItems: 'center', flexDirection: 'row', gap: 6, paddingTop: 2 },
  heading: { ...typography.section },
  intro: { gap: spacing.xs, minWidth: 0, paddingTop: spacing.xs },
  more: { alignItems: 'flex-start', marginLeft: -spacing.md },
  entry: {
    borderRadius: radius.field + 2,
    gap: spacing.sm,
    paddingHorizontal: spacing.ms,
    paddingVertical: 10,
  },
  line: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.ms,
    minHeight: 36,
  },
  mark: { alignItems: 'flex-start', paddingLeft: 48 },
  order: { ...face('condensed'), fontSize: 22, lineHeight: 26, minWidth: 28, textAlign: 'center' },
  place: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  // "Abrir no Google Maps" keeps its name (decision of #70): when both do not fit
  // on one line, each button takes its own.
  placeAction: { flexBasis: 200, flexGrow: 1 },
  placeActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  placeName: { ...typography.bodyStrong, ...face('bold') },
  placeText: { flex: 1, gap: 2, minWidth: 0 },
  presence: { gap: spacing.sm },
  price: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  priceText: { ...typography.supportStrong },
  row: {
    alignItems: 'center',
    borderRadius: radius.field + 2,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.ms,
    minHeight: 56,
    paddingHorizontal: spacing.ms,
    paddingVertical: 10,
  },
  rowDetail: { ...face('regular') },
  rowName: { ...typography.bodyStrong, flex: 1, fontSize: 16, lineHeight: 22, minWidth: 0 },
  rows: { gap: spacing.sm },
  section: { gap: spacing.sm, paddingTop: spacing.xs },
  sectionHead: {
    alignItems: 'baseline',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  small: { ...typography.support, fontSize: 14, lineHeight: 20 },
  title: { ...typography.heading },
  when: { ...typography.bodyStrong },
});
