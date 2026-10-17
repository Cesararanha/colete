import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppIcon, type IconName } from '@/components/ui/AppIcon';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { Scoreboard } from '@/components/ui/Scoreboard';
import {
  api,
  type MatchPaymentResult,
  type MatchPresenceResult,
  type MatchRoster,
  type MatchRosterEntry,
  type OwnProfile,
} from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { backTo } from '@/lib/navigation';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { focusGroupControl, GroupConfirmation } from '../groups/GroupConfirmation';
import { matchErrorMessage } from './match-errors';
import { distanceInMeters, distanceText } from './match-distance';
import { matchLongDay, matchPrice, matchTime, matchWhenLine } from './match-format';
import { openMatchMap } from './match-map';
import { useDeviceLocation } from './use-device-location';
import { useMatchActions } from './useMatchActions';

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

/**
 * "Ver distância": asks for the position only on the press, computes the
 * distance on the device and shows it. The position stays in this
 * component's memory: never sent, stored, logged or put in a URL.
 */
function Distance({ latitude, longitude }: { latitude: number; longitude: number }) {
  const { colors } = useTheme();
  const { location, request } = useDeviceLocation();
  return (
    <View style={styles.actions} testID="match-distance">
      <AppButton
        ariaDisabled={location.status === 'requesting'}
        icon="navigation"
        label={
          location.status === 'requesting'
            ? pt.matches.detail.distanceLocating
            : pt.matches.detail.distance
        }
        onPress={() => {
          if (location.status !== 'requesting') void request();
        }}
        testID="match-distance-button"
        variant="secondary"
      />
      {location.status === 'found' ? (
        <AppStatus
          message={distanceText(distanceInMeters(location, { latitude, longitude }))}
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
      <Text style={[styles.hint, { color: colors.textMuted }]}>
        {pt.matches.detail.distanceHint}
      </Text>
    </View>
  );
}

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

/** One line of a roster: order, name, nickname and position; payment for the organisation. */
function RosterRow({
  entry,
  index,
  manage,
  onMark,
  testID,
}: {
  entry: MatchRosterEntry;
  index: number;
  manage: boolean;
  onMark?: ((entry: MatchRosterEntry, paid: boolean) => void) | undefined;
  testID: string;
}) {
  const { colors } = useTheme();
  const name = entryName(entry);
  const detail = entryDetail(entry);
  const showPayment = manage && typeof entry.paid === 'boolean';
  return (
    <View style={styles.rosterRow} testID={testID}>
      <Text style={[styles.rosterIndex, { color: colors.textMuted }]}>{index + 1}</Text>
      <View style={styles.factText}>
        <Text style={[styles.factValue, { color: colors.text }]}>{name}</Text>
        {detail ? (
          <Text style={[styles.factDetail, { color: colors.textMuted }]}>{detail}</Text>
        ) : null}
        {showPayment ? (
          <View style={styles.payment}>
            <AppIcon
              color={entry.paid ? colors.positive : colors.textMuted}
              name={entry.paid ? 'check-circle' : 'circle'}
              size={16}
            />
            <Text
              style={[styles.factLabel, { color: entry.paid ? colors.positive : colors.textMuted }]}
              testID={`${testID}-paid`}
            >
              {entry.paid ? pt.matches.detail.paid : pt.matches.detail.unpaid}
            </Text>
          </View>
        ) : null}
      </View>
      {showPayment && onMark && entry.profile_id !== null ? (
        <AppButton
          accessibilityLabel={
            entry.paid
              ? pt.matches.detail.markUnpaidLabel(name)
              : pt.matches.detail.markPaidLabel(name)
          }
          label={entry.paid ? pt.matches.detail.markUnpaid : pt.matches.detail.markPaid}
          onPress={() => onMark(entry, !entry.paid)}
          testID={`${testID}-mark`}
          variant="secondary"
        />
      ) : null}
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
  const status = roster.started
    ? pt.matches.detail.started
    : viewer.status === 'starter'
      ? pt.matches.detail.viewerStarter
      : viewer.status === 'waitlist'
        ? pt.matches.detail.viewerWaitlist(viewer.waitlist_position ?? 0)
        : pt.matches.detail.viewerOut;
  return (
    <AppCard testID="match-presence">
      <Text aria-level={2} role="heading" style={[styles.heading, { color: colors.text }]}>
        {pt.matches.detail.presenceHeading}
      </Text>
      <Text style={[styles.factValue, { color: colors.text }]} testID="match-viewer-status">
        {status}
      </Text>
      {viewer.paid !== null ? (
        <Text style={[styles.factDetail, { color: colors.textMuted }]} testID="match-own-payment">
          {pt.matches.detail.ownPaid(viewer.paid)}
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
        <GroupConfirmation title={pt.matches.detail.leaveTitle} testID="match-leave-confirmation">
          <Text style={[styles.factValue, { color: colors.text }]}>
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
          icon="x"
          label={pt.matches.detail.leave}
          onPress={() => {
            setMessage('');
            actions.clearError();
            setConfirming(true);
          }}
          testID="match-leave"
          variant="secondary"
        />
      )}
    </AppCard>
  );
}

function Rosters({
  matchId,
  price,
  profileId,
  roster,
}: {
  matchId: string;
  price: number;
  profileId: string;
  roster: MatchRoster;
}) {
  const { colors } = useTheme();
  const actions = useMatchActions(profileId);
  const [message, setMessage] = useState('');
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
  return (
    <>
      {manage && summary ? (
        <AppCard testID="match-payments">
          <Text aria-level={2} role="heading" style={[styles.heading, { color: colors.text }]}>
            {pt.matches.detail.paymentHeading}
          </Text>
          <Text style={[styles.factValue, { color: colors.text }]} testID="match-payment-summary">
            {pt.matches.detail.paymentSummary(
              summary.paid_count,
              summary.confirmed_count,
              matchPrice(Number(summary.total)),
            )}
          </Text>
          <Text style={[styles.factDetail, { color: colors.textMuted }]}>
            {pt.matches.detail.paymentNote} {matchPrice(price)}.
          </Text>
          <AppStatus message={message} testID="match-payment-result" />
          <AppAlert
            message={actions.error ? matchErrorMessage(actions.error) : ''}
            testID="match-payment-error"
          />
        </AppCard>
      ) : null}
      <AppCard testID="match-confirmed">
        <Text aria-level={2} role="heading" style={[styles.heading, { color: colors.text }]}>
          {pt.matches.detail.confirmedHeading(roster.confirmed_count, roster.field_slots)}
        </Text>
        {roster.confirmed.length === 0 ? (
          <Text style={[styles.factDetail, { color: colors.textMuted }]}>
            {pt.matches.detail.confirmedEmpty}
          </Text>
        ) : null}
        {/* Inside the card, which scrolls with the screen: the list itself does not. */}
        <FlatList
          data={roster.confirmed}
          extraData={[manage, actions.pending]}
          keyExtractor={(entry, index) => entry.profile_id ?? `removed-${index}`}
          renderItem={({ item, index }) => (
            <RosterRow
              entry={item}
              index={index}
              manage={manage}
              onMark={mark}
              testID={`match-confirmed-${index}`}
            />
          )}
          scrollEnabled={false}
        />
      </AppCard>
      <AppCard testID="match-waitlist">
        <Text aria-level={2} role="heading" style={[styles.heading, { color: colors.text }]}>
          {pt.matches.detail.waitlistHeading(roster.waitlist_count)}
        </Text>
        {roster.waitlist.length === 0 ? (
          <Text style={[styles.factDetail, { color: colors.textMuted }]}>
            {pt.matches.detail.waitlistEmpty}
          </Text>
        ) : null}
        <FlatList
          data={roster.waitlist}
          keyExtractor={(entry, index) => entry.profile_id ?? `removed-${index}`}
          renderItem={({ item, index }) => (
            <RosterRow
              entry={item}
              index={index}
              manage={false}
              testID={`match-waitlist-${index}`}
            />
          )}
          scrollEnabled={false}
        />
      </AppCard>
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
    label: pt.matches.detail.back,
    href: '/rachas' as const,
    testID: 'match-back',
  };
  const start = match ? matchTime(match.starts_at, match.timezone) : '';
  // The board shows the real occupancy, confirmed over slots, once it is read.
  const hero =
    match && roster ? (
      <View style={styles.hero}>
        <Text aria-hidden style={[styles.overline, { color: colors.onBandMuted }]}>
          {pt.matches.detail.occupancyOverline}
        </Text>
        <Scoreboard
          accessibilityLabel={pt.matches.detail.occupancy(
            roster.confirmed_count,
            roster.field_slots,
          )}
          groups={[
            { chars: String(roster.confirmed_count).padStart(2, '0') },
            { chars: String(roster.field_slots).padStart(2, '0'), reference: true },
          ]}
          testID="match-scoreboard"
        />
      </View>
    ) : undefined;
  return (
    <AuthenticatedShell
      back={back}
      // Date and time leave the board: a line of text at the top, in the
      // match's own time zone ("Sáb, 18 out · 20:00–22:00").
      description={match ? matchWhenLine(match.starts_at, match.ends_at, match.timezone) : ''}
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
            {match.description ? (
              // Plain Text, never parsed: no link becomes pressable, no markup renders.
              <Fact
                icon="file-text"
                label={pt.matches.detail.about}
                testID="match-fact-description"
                value={match.description}
              />
            ) : null}
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
          {match.latitude !== null && match.longitude !== null ? (
            <Distance latitude={match.latitude} longitude={match.longitude} />
          ) : null}
          {rosterQuery.isPending ? (
            <AsyncNotice kind="loading" message={pt.common.loading} />
          ) : null}
          {rosterQuery.isError ? (
            <AppAlert message={matchErrorMessage(rosterQuery.error)} testID="match-roster-error" />
          ) : null}
          {roster ? (
            <>
              <Presence matchId={matchId} profileId={profile.id} roster={roster} />
              <Rosters
                matchId={matchId}
                price={match.field_price}
                profileId={profile.id}
                roster={roster}
              />
            </>
          ) : null}
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
  heading: { ...typography.title },
  hero: { gap: spacing.ms },
  payment: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  rosterIndex: { ...typography.supportStrong, minWidth: 24, fontVariant: ['tabular-nums'] },
  rosterRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  hint: { ...typography.support },
  overline: { ...typography.overline },
});
