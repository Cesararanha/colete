import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppIcon, type IconName } from '@/components/ui/AppIcon';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { LiveRefresh, ReadNotice } from '@/components/ui/LiveRefresh';
import { Chip, type ChipTone } from '@/components/ui/Chip';
import { groupAppearance } from '@/components/ui/group-icon';
import { OccupancyBar } from '@/components/ui/OccupancyBar';
import {
  api,
  AppError,
  type MatchEditOutcome,
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
import { queryClient } from '@/lib/query-client';
import { useLiveInterval } from '@/lib/use-live-interval';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { face, typography } from '@/theme/typography';

import { focusGroupControl, GroupConfirmation } from '../groups/GroupConfirmation';
import { GroupPhotoIcon, PhotoAvatar } from '../photos/PhotoAvatar';
import { unratedAmong } from '../ratings/rating-format';
import { useGroupRatings } from '../ratings/rating-queries';
import { matchErrorMessage } from './match-errors';
import { collectorNames, paymentNotice } from './payment-notice';
import { distanceInMeters, distanceText } from './match-distance';
import { endsNextDay } from './match-card-state';
import { deviceTimeZone } from './match-form';
import { matchDateTitle, matchPrice, matchTimeRange } from './match-format';
import { openMatchMap } from './match-map';
import { deviceDiffers, zoneLabel } from './match-zone';
import { matchTeamsQueryKey, MatchTeamsSection } from './MatchTeams';
import { MatchPixManager, MatchPixPayment, useMatchPix } from './MatchPix';
import { MatchRefunds } from './MatchRefunds';
import {
  AddMatchPlayer,
  RemoveMatchPlayer,
  usePlayerManagementFeedback,
} from './MatchPlayerManagement';
import { entryDetail, entryName } from './roster-entry';
import { useDeviceLocation } from './use-device-location';
import { useMatchActions } from './useMatchActions';

/** The state of the viewer on the board (prévia aprovada); the detail knows the waitlist position. */
function viewerChip(
  roster: MatchRoster,
): { tone: ChipTone; label: string; icon?: IconName } | null {
  if (roster.canceled) return { label: pt.matches.detail.canceledChip, tone: 'critical' };
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
      {/* Canceled: the count stays as history, dimmed; no open slots to announce. */}
      <OccupancyBar
        color={roster.canceled ? colors.digitDim : colors.digit}
        height={8}
        ratio={roster.confirmed_count / Math.max(1, roster.field_slots)}
        track={colors.scoreTileTop}
      />
      {roster.canceled ? null : (
        <Text style={[styles.boardFoot, { color: colors.digitDim }]} testID="match-board-summary">
          {pt.matches.detail.openSummary(open, roster.waitlist_count)}
        </Text>
      )}
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
  // A canceled match takes no "Vou jogar" and no "Desistir" (0028); the chip says why.
  const closed = roster.started || roster.canceled;
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
      {roster.started && !roster.canceled ? (
        <Text style={[styles.small, { color: colors.textMuted }]} testID="match-viewer-status">
          {pt.matches.detail.started}
        </Text>
      ) : null}
      <AppStatus message={message} testID="match-presence-result" />
      <AppAlert
        message={actions.error ? matchErrorMessage(actions.error) : ''}
        testID="match-presence-error"
      />
      {closed ? null : viewer.status === 'out' ? (
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
  removal,
  entry,
  locked,
  manage,
  onMark,
  ownPaid,
  saving,
  testID,
  waiting,
}: {
  removal: React.ReactNode;
  entry: MatchRosterEntry;
  /** A canceled match keeps its marks as they are: they show, but do not change. */
  locked: boolean;
  manage: boolean;
  onMark: (entry: MatchRosterEntry, paid: boolean) => void;
  /** The viewer's own payment, which a player sees only on their own line. */
  ownPaid: boolean | null;
  /** This row's mark is being saved. */
  saving: boolean;
  testID: string;
  /** Another row's mark is being saved: this one waits, and says why (HX-002). */
  waiting: boolean;
}) {
  const { colors } = useTheme();
  const name = entryName(entry);
  const detail = entryDetail(entry);
  // The organisation sees every line; a player only their own (viewer.paid).
  const paid =
    manage && typeof entry.paid === 'boolean' ? entry.paid : entry.is_viewer ? ownPaid : null;
  const canMark = manage && !locked && typeof entry.paid === 'boolean' && entry.profile_id !== null;
  return (
    <View style={[styles.entry, { backgroundColor: colors.surface }]} testID={testID}>
      <View style={styles.line}>
        <PhotoAvatar id={entry.account_removed ? null : entry.profile_id} name={name} size={36} />
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
            ariaDisabled={saving || waiting}
            compact
            describedBy={saving || waiting ? PAYMENT_WAIT_ID : undefined}
            label={
              saving
                ? pt.matches.detail.marking
                : entry.paid
                  ? pt.matches.detail.markUnpaid
                  : pt.matches.detail.markPaid
            }
            onPress={() => onMark(entry, !entry.paid)}
            testID={`${testID}-mark`}
            variant="outline"
          />
        </View>
      ) : null}
      {removal}
    </View>
  );
}

/** The text that says which mark is being saved; every mark button points to it meanwhile. */
const PAYMENT_WAIT_ID = 'match-payment-wait';

/** Beyond this many confirmed, the list opens with the first ones and "Ver os N confirmados". */
const COLLAPSED = 5;

/**
 * Fatia 1.1 (D63-G): how the person who plays pays. Who collects comes from
 * get_group_members, which every active member already reads (never the
 * match's created_by, which is history); it is read only while the
 * instruction shows.
 */
function PaymentNoticeBlock({
  groupId,
  matchId,
  price,
  profileId,
  roster,
  timezone,
}: {
  groupId: string;
  matchId: string;
  price: number;
  profileId: string;
  roster: MatchRoster;
  timezone: string;
}) {
  const { colors } = useTheme();
  const asked =
    paymentNotice({
      status: roster.viewer.status,
      paid: roster.viewer.paid,
      canManage: roster.viewer.can_manage,
      canceled: roster.canceled,
      collectors: '',
    })?.kind === 'pay';
  // Pix manual (0036): the gateway decides again who reads; a match without
  // Pix keeps the instruction of slice 1.1.
  const pix = useMatchPix(profileId, matchId, asked);
  const members = useQuery({
    enabled: asked,
    queryKey: [PRIVATE_QUERY_ROOT, 'group-members', profileId, groupId],
    queryFn: ({ signal }) => api.getGroupMembers(groupId, signal),
  });
  const notice = paymentNotice({
    status: roster.viewer.status,
    paid: roster.viewer.paid,
    canManage: roster.viewer.can_manage,
    canceled: roster.canceled,
    collectors: collectorNames(members.data),
  });
  const ownRefundNotice =
    !roster.viewer.can_manage && roster.viewer.refunds?.length ? (
      <View
        style={styles.payNotice}
        testID={notice === null ? 'match-pay-notice' : 'match-own-refunds'}
      >
        {roster.viewer.refunds.map((refund) => (
          <Text
            key={refund.id}
            style={{ color: colors.text }}
            testID={`match-own-refund-${refund.id}`}
          >
            {refund.status === 'refund_due' ? pt.refunds.due : pt.refunds.refunded} ·{' '}
            {matchPrice(Number(refund.amount))}
          </Text>
        ))}
      </View>
    ) : null;
  if (notice === null) return ownRefundNotice;
  // While the Pix is read, show neither block: the generic instruction would
  // be replaced a moment later.
  if (notice.kind === 'pay' && pix.isLoading) return ownRefundNotice;
  if (notice.kind === 'pay' && pix.data) {
    return (
      <>
        {ownRefundNotice}
        <MatchPixPayment pix={pix.data} timezone={timezone} />
      </>
    );
  }
  return (
    <>
      {ownRefundNotice}
      {notice.kind === 'pay' ? <ReadNotice query={pix} /> : null}
      <View
        style={[styles.payNotice, { backgroundColor: colors.surface }]}
        testID="match-pay-notice"
      >
        <AppIcon
          color={notice.kind === 'paid' ? colors.positive : colors.textMuted}
          name={notice.kind === 'paid' ? 'check-circle' : 'credit-card'}
          size={20}
        />
        <View style={styles.payNoticeBody}>
          <Text
            style={[styles.payNoticeTitle, { color: colors.text }]}
            testID="match-pay-notice-title"
          >
            {notice.kind === 'paid'
              ? pt.matches.detail.paidNotice
              : pt.matches.detail.payTo(notice.collectors)}
          </Text>
          {notice.kind === 'pay' ? (
            <Text
              style={[styles.small, { color: colors.textMuted }]}
              testID="match-pay-notice-note"
            >
              {pt.matches.detail.payNote(matchPrice(price))}
            </Text>
          ) : null}
        </View>
      </View>
    </>
  );
}

function Rosters({
  hasTeams,
  ended,
  groupId,
  matchId,
  price,
  profileId,
  roster,
  timezone,
}: {
  hasTeams: boolean;
  /** The match is over (passed to the teams, which may no longer be drawn). */
  ended: boolean;
  groupId: string;
  matchId: string;
  /** The price per player, for the payment instruction. */
  price: number;
  profileId: string;
  roster: MatchRoster | undefined;
  timezone: string;
}) {
  const { colors } = useTheme();
  const actions = useMatchActions(profileId);
  // The organization sees how many confirmed still have no rating (0031): the
  // draw will not run without them. Players never get this read.
  const ratings = useGroupRatings(
    profileId,
    groupId,
    roster?.viewer.can_manage === true && !roster.canceled,
  );
  const [message, setMessage] = useState('');
  const {
    error: playerError,
    feedback: setPlayerError,
    beginAttempt: beginPlayerAttempt,
    rosterRef,
  } = usePlayerManagementFeedback();
  // The lists retain the refusal when its action/row disappears. Cancellation
  // supersedes an earlier start refusal; new intents and dismissal clear it.
  const canceled = roster?.canceled ?? true;
  const playerErrorMessage =
    playerError instanceof AppError && playerError.code === 'MATCH_STARTED' && canceled
      ? ''
      : playerError instanceof AppError && playerError.code === 'NOT_FOUND'
        ? pt.matchPlayers.unavailable
        : playerError instanceof AppError && playerError.code === 'FORBIDDEN'
          ? pt.matchPlayers.self
          : playerError
            ? matchErrorMessage(playerError)
            : '';
  const [expanded, setExpanded] = useState(false);
  // One mark at a time (the hook runs one action): the row being saved says
  // so, and the others wait with the reason instead of ignoring the press (HX-002).
  const [saving, setSaving] = useState<{ id: string; name: string } | null>(null);
  const feedback = (
    <>
      <AppAlert message={playerErrorMessage} testID="match-player-error" />
      {playerErrorMessage ? (
        <AppButton
          label={pt.matchPlayers.dismiss}
          testID="match-player-error-dismiss"
          variant="tertiary"
          onPress={() => {
            setPlayerError(null);
            focusGroupControl('match-refresh-button');
          }}
        />
      ) : null}
    </>
  );
  // Keep the management feedback and its pending focus restoration while the
  // screen waits for a roster that includes the cancellation.
  if (!roster) return <>{feedback}</>;
  const manage = roster.viewer.can_manage;
  const summary = roster.payment_summary;
  const unrated = unratedAmong(
    ratings.data?.members,
    roster.confirmed.map((entry) => entry.profile_id),
  );
  const mark = (entry: MatchRosterEntry, paid: boolean) => {
    if (entry.profile_id === null || saving !== null || actions.pending) return;
    const target = entry.profile_id;
    setMessage('');
    setSaving({ id: target, name: entryName(entry) });
    void actions
      .run<MatchPaymentResult>(`pay:${target}:${paid}`, () =>
        api.setMatchPayment(matchId, target, paid),
      )
      .then((result) => {
        if (result) setMessage(pt.matches.detail.marked(entryName(entry), paid));
      })
      .finally(() => setSaving(null));
  };
  const collapsible = roster.confirmed.length > COLLAPSED + 1;
  const shown = collapsible && !expanded ? roster.confirmed.slice(0, COLLAPSED) : roster.confirmed;
  return (
    <>
      {feedback}
      <AddMatchPlayer
        groupId={groupId}
        matchId={matchId}
        profileId={profileId}
        roster={roster}
        onFeedback={setPlayerError}
        onAttempt={beginPlayerAttempt}
      />
      <View ref={rosterRef} style={styles.section} testID="match-confirmed">
        <View style={styles.sectionHead}>
          <Text aria-level={2} role="heading" style={[styles.heading, { color: colors.text }]}>
            {pt.matches.detail.confirmedTitle}
          </Text>
          {manage && summary && !roster.canceled ? (
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
        <PaymentNoticeBlock
          groupId={groupId}
          matchId={matchId}
          price={price}
          profileId={profileId}
          roster={roster}
          timezone={timezone}
        />
        {unrated > 0 ? (
          <View style={styles.unrated}>
            <AppButton
              compact
              icon="star"
              label={pt.ratings.unrated(unrated)}
              onPress={() => router.push(`/grupos/${groupId}/notas`)}
              testID="match-unrated"
              variant="outline"
            />
          </View>
        ) : null}
        {saving ? (
          <Text
            accessibilityLiveRegion="polite"
            nativeID={PAYMENT_WAIT_ID}
            style={[styles.small, { color: colors.textMuted }]}
            testID={PAYMENT_WAIT_ID}
          >
            {pt.matches.detail.markWait(saving.name)}
          </Text>
        ) : null}
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
          extraData={[manage, actions.pending, roster.viewer.paid, roster.canceled, saving]}
          keyExtractor={(entry, index) => entry.profile_id ?? `removed-${index}`}
          renderItem={({ item, index }) => (
            <ConfirmedRow
              removal={
                manage && !roster.started && !roster.canceled ? (
                  <RemoveMatchPlayer
                    entry={item}
                    matchId={matchId}
                    profileId={profileId}
                    hasTeams={hasTeams}
                    groupId={groupId}
                    onFeedback={setPlayerError}
                    onAttempt={beginPlayerAttempt}
                  />
                ) : null
              }
              entry={item}
              locked={roster.canceled}
              manage={manage && !roster.canceled}
              onMark={mark}
              ownPaid={roster.canceled ? null : roster.viewer.paid}
              saving={saving !== null && saving.id === item.profile_id}
              testID={`match-confirmed-${index}`}
              waiting={saving !== null && saving.id !== item.profile_id}
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
      <MatchTeamsSection ended={ended} matchId={matchId} profileId={profileId} roster={roster} />
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
                <PhotoAvatar
                  id={item.account_removed ? null : item.profile_id}
                  name={name}
                  size={36}
                />
                <Text style={[styles.rowName, { color: colors.text }]}>
                  {name}
                  {detail ? (
                    <Text style={[styles.rowDetail, { color: colors.textMuted }]}> · {detail}</Text>
                  ) : null}
                </Text>
                {manage && !roster.started && !roster.canceled ? (
                  <RemoveMatchPlayer
                    entry={item}
                    matchId={matchId}
                    profileId={profileId}
                    hasTeams={hasTeams}
                    groupId={groupId}
                    onFeedback={setPlayerError}
                    onAttempt={beginPlayerAttempt}
                  />
                ) : null}
              </View>
            );
          }}
          scrollEnabled={false}
        />
      </View>
    </>
  );
}

/**
 * "Cancelar racha" at the end of the detail, for whoever may create matches
 * in the group, as the destructive action of the screen (like "Sair da
 * conta"): the confirmation opens in place and names the date. Final: there
 * is no undo. After it, only the result stays here; the chip on the board
 * says "Cancelado".
 */
function CancelMatch({
  date,
  manageable,
  matchId,
  profileId,
  roster,
  price,
}: {
  roster: MatchRoster;
  price: number;
  date: string;
  /** False once the match is canceled or over; the result of this screen's own cancel stays. */
  manageable: boolean;
  matchId: string;
  profileId: string;
}) {
  const { colors } = useTheme();
  const actions = useMatchActions(profileId);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!confirming && restoreFocus.current) {
      restoreFocus.current = false;
      focusGroupControl('match-cancel');
    }
  }, [confirming]);
  const cancel = () => {
    void actions
      .run<MatchEditOutcome>('cancel', () => api.cancelMatch(matchId))
      .then((result) => {
        if (result) {
          setDone(true);
          setConfirming(false);
        }
      });
  };
  if (!manageable && !done) return null;
  return (
    <View style={styles.manage} testID="match-cancel-section">
      <AppStatus
        message={done ? pt.matches.detail.canceledResult : ''}
        testID="match-cancel-result"
      />
      <AppAlert
        message={actions.error ? matchErrorMessage(actions.error, 'manage') : ''}
        testID="match-cancel-error"
      />
      {done || !manageable ? null : confirming ? (
        <GroupConfirmation
          level={2}
          title={pt.matches.detail.cancelMatchTitle(date)}
          testID="match-cancel-confirmation"
        >
          <Text style={{ color: colors.text }}>{pt.refunds.warning}</Text>
          {roster.confirmed
            .filter((entry) => entry.paid)
            .map((entry, index) => (
              <Text style={{ color: colors.text }} key={entry.profile_id ?? index}>
                {entryName(entry)} · {pt.refunds.due} · {matchPrice(price)}
              </Text>
            ))}
          {roster.confirmed.some((entry) => entry.paid) ? (
            <Text style={{ color: colors.text }} testID="match-cancel-refunds-total">
              {pt.refunds.total(
                matchPrice(roster.confirmed.filter((entry) => entry.paid).length * price),
              )}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <AppButton
              ariaDisabled={actions.pending}
              label={
                actions.pending ? pt.matches.detail.canceling : pt.matches.detail.confirmCancelMatch
              }
              onPress={() => {
                if (!actions.pending) cancel();
              }}
              testID="match-cancel-confirm"
              variant="destructive"
            />
            <AppButton
              label={pt.matches.detail.keepMatch}
              onPress={() => {
                if (actions.pending) return;
                restoreFocus.current = true;
                actions.clearError();
                actions.discardIntent();
                setConfirming(false);
              }}
              testID="match-cancel-keep"
              variant="secondary"
            />
          </View>
        </GroupConfirmation>
      ) : (
        <AppButton
          label={pt.matches.detail.cancelMatch}
          onPress={() => {
            actions.clearError();
            setConfirming(true);
          }}
          testID="match-cancel"
          variant="outline-destructive"
        />
      )}
    </View>
  );
}

export function MatchDetailScreen({ matchId, profile }: { matchId: string; profile: OwnProfile }) {
  const { colors } = useTheme();
  const refetchInterval = useLiveInterval();
  const detail = useQuery({
    queryKey: [PRIVATE_QUERY_ROOT, 'matches', profile.id, matchId],
    queryFn: ({ signal }) => api.getMatch(matchId, signal),
    refetchInterval,
  });
  const match = detail.data ?? undefined;
  const rosterQuery = useQuery({
    // Both reads use the route ID and check membership on the server.
    enabled: detail.isPending || match !== undefined,
    queryKey: [PRIVATE_QUERY_ROOT, 'matches', profile.id, matchId, 'roster'],
    queryFn: ({ signal }) => api.getMatchRoster(matchId, signal),
    refetchInterval,
  });
  const { data: rosterData, refetch: refetchRoster } = rosterQuery;
  const needsCanceledRoster = match?.canceled === true && rosterData?.canceled === false;
  const roster = match === undefined || needsCanceledRoster ? undefined : rosterData;
  useEffect(() => {
    // The roster can arrive from before a cancellation already seen by the detail.
    if (needsCanceledRoster) void refetchRoster();
  }, [matchId, needsCanceledRoster, refetchRoster]);
  // The teams' state, for "Atualizado às": MatchTeams reads them on its own
  // interval; this observer never reads, it only follows (rev89 P3-3).
  const teamsQuery = useQuery({
    enabled: false,
    queryKey: matchTeamsQueryKey(profile.id, matchId),
    queryFn: ({ signal }) => api.getMatchTeams(matchId, signal),
  });
  const pixQuery = useMatchPix(
    profile.id,
    matchId,
    roster?.viewer.can_manage === true && !roster.canceled,
  );
  const refundsQuery = useQuery({
    enabled: roster?.viewer.can_manage === true,
    queryKey: [PRIVATE_QUERY_ROOT, 'matches', profile.id, matchId, 'refunds'],
    queryFn: ({ signal }) => api.getMatchRefunds(matchId, signal),
    refetchInterval,
  });
  // Whoever may create matches in the group edits and cancels it, until it
  // ends (0028). The server decides again on every call.
  // "Now" is read once per read of the match: it moves only when the match does.
  const ended = useMemo(
    () => match !== undefined && new Date(match.ends_at).getTime() <= new Date().getTime(),
    [match],
  );
  const manageable =
    match !== undefined &&
    roster !== undefined &&
    roster.viewer.can_manage &&
    !match.canceled &&
    !roster.canceled &&
    !ended;
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
      {deviceDiffers(match.timezone, new Date(match.starts_at), deviceTimeZone()) ? (
        <Text style={[styles.zone, { color: colors.textMuted }]} testID="match-fact-zone">
          {pt.matches.zone(zoneLabel(match.timezone, new Date(match.starts_at)))}
        </Text>
      ) : null}
      <View style={styles.group} testID="match-fact-group">
        <GroupPhotoIcon
          appearance={groupAppearance(match.group_icon, match.group_color)}
          groupId={match.group_id}
          size={16}
        />
        <Text style={[styles.small, styles.groupName, { color: colors.textMuted }]}>
          {match.group_name}
        </Text>
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
      {...(manageable
        ? {
            trailing: (
              <AppButton
                accessibilityLabel={pt.matches.detail.editLabel}
                compact
                label={pt.matches.detail.edit}
                onPress={() =>
                  router.push({ pathname: '/editar-racha', params: { matchId: match.id } })
                }
                testID="match-edit"
                variant="outline"
              />
            ),
          }
        : {})}
    >
      {detail.isPending ? <AsyncNotice kind="loading" message={pt.common.loading} /> : null}
      <ReadNotice query={detail} />
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
          <LiveRefresh
            queries={[
              detail,
              rosterQuery,
              teamsQuery,
              ...(roster?.viewer.can_manage ? [refundsQuery] : []),
            ]}
            // The teams below read under the same key, so "Atualizar" reads them too;
            // and who collects (rev91 P2-3). Without the payment instruction the read
            // here is disabled and refetchQueries skips it, unless the same group's
            // detail is still mounted in the Grupos tab, which keeps it enabled
            // (conf91 N1): one harmless read per tap, of a list that person already reads.
            refresh={() =>
              Promise.all([
                queryClient.refetchQueries({
                  queryKey: [PRIVATE_QUERY_ROOT, 'matches', profile.id, matchId],
                }),
                queryClient.refetchQueries({
                  queryKey: [PRIVATE_QUERY_ROOT, 'group-members', profile.id, match.group_id],
                }),
              ])
            }
            testID="match-refresh"
          />
          <Place match={match} />
          {rosterQuery.isPending || (needsCanceledRoster && !rosterQuery.isError) ? (
            <AsyncNotice kind="loading" message={pt.common.loading} />
          ) : null}
          {/* Over a list already shown, a failed read is said in LiveRefresh (rev89 P3-2). */}
          {rosterQuery.isError && roster === undefined ? (
            <>
              <AppAlert
                message={matchErrorMessage(rosterQuery.error)}
                testID="match-roster-error"
              />
              <AppButton
                label={pt.common.retry}
                onPress={() => void rosterQuery.refetch()}
                testID="match-roster-retry"
                variant="secondary"
              />
            </>
          ) : null}
          {roster ? <Presence matchId={matchId} profileId={profile.id} roster={roster} /> : null}
          {rosterData ? (
            <Rosters
              key={matchId}
              hasTeams={teamsQuery.data?.team_count != null}
              ended={ended}
              groupId={match.group_id}
              matchId={matchId}
              price={Number(match.field_price)}
              profileId={profile.id}
              roster={roster}
              timezone={match.timezone}
            />
          ) : null}
          {roster ? (
            <>
              {roster.viewer.can_manage && !roster.canceled ? (
                <>
                  <ReadNotice query={pixQuery} />
                  {pixQuery.isSuccess ? (
                    <MatchPixManager
                      matchId={matchId}
                      pendingRefund={
                        refundsQuery.data?.some((refund) => refund.status === 'refund_due') ?? false
                      }
                      pix={pixQuery.data}
                      profileId={profile.id}
                      roster={roster}
                    />
                  ) : null}
                </>
              ) : null}
              {roster.viewer.can_manage ? (
                <>
                  <ReadNotice query={refundsQuery} />
                  {refundsQuery.data ? (
                    <MatchRefunds
                      matchId={matchId}
                      profileId={profile.id}
                      timezone={match.timezone}
                      price={Number(match.field_price)}
                      matchLabel={`${match.location_name} · ${matchDateTitle(match.starts_at, match.timezone)}`}
                      roster={roster}
                      refunds={refundsQuery.data}
                    />
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
          {/* Keep the cancellation result mounted while the roster catches up. */}
          {rosterData?.viewer.can_manage ? (
            <CancelMatch
              roster={rosterData}
              price={Number(match.field_price)}
              date={matchDateTitle(match.starts_at, match.timezone)}
              manageable={manageable}
              matchId={matchId}
              profileId={profile.id}
            />
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
  // A row item shrinks below its longest word only with minWidth 0, so it wraps.
  groupName: { flexShrink: 1, minWidth: 0 },
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
  manage: { gap: spacing.sm, paddingTop: spacing.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, minWidth: 0 },
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
  payNotice: {
    alignItems: 'flex-start',
    borderRadius: radius.row,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
  },
  payNoticeBody: { flex: 1, gap: spacing.xs, minWidth: 0 },
  payNoticeTitle: { ...typography.bodyStrong },
  unrated: { alignItems: 'flex-start' },
  title: { ...typography.heading },
  when: { ...typography.bodyStrong },
  zone: { ...typography.caption },
});
