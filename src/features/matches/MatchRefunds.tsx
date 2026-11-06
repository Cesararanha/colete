import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppTextField } from '@/components/ui/AppTextField';
import { AppError, api, type ManagedMatchRefund, type MatchRoster } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { focusGroupControl, GroupConfirmation } from '../groups/GroupConfirmation';
import { matchErrorMessage } from './match-errors';
import { matchPrice } from './match-format';
import { zoneLabel } from './match-zone';
import { refundInstant } from './refund-date';
import { useMatchActions } from './useMatchActions';

export function MatchRefunds({
  matchId,
  profileId,
  timezone,
  price,
  matchLabel,
  roster,
  refunds,
}: {
  matchId: string;
  profileId: string;
  timezone: string;
  price: number;
  matchLabel: string;
  roster: MatchRoster;
  refunds: ManagedMatchRefund[];
}) {
  const { colors } = useTheme();
  const actions = useMatchActions(profileId);
  const [confirming, setConfirming] = useState<{
    id: string;
    kind: 'mark' | 'correct' | 'payment';
  } | null>(null);
  const [date, setDate] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);
  const focusRefund = useRef<string | null>(null);
  const manage = roster.viewer.can_manage;
  // After the commit that closes the confirmation and enables the row's button: an
  // ariaDisabled AppButton is another element on the web, and focus on it would be lost.
  useEffect(() => {
    const target = focusRefund.current;
    if (target === null || actions.pending) return;
    if (refunds.some((refund) => refund.id === target)) {
      focusRefund.current = null;
      focusGroupControl(`refund-${target}`);
      return;
    }
    // A row the refreshed list did not bring: focus stays on the page's own control.
    const fallback = setTimeout(() => {
      focusRefund.current = null;
      focusGroupControl('match-refresh-button');
    }, 1000);
    return () => clearTimeout(fallback);
  }, [confirming, actions.pending, refunds]);
  const paymentsToRecord = roster.canceled
    ? roster.confirmed.filter(
        (entry) =>
          entry.profile_id !== null &&
          !entry.account_removed &&
          entry.can_record_canceled_payment === true,
      )
    : [];
  if (!manage || (refunds.length === 0 && paymentsToRecord.length === 0)) return null;
  const confirmationTarget = confirming
    ? confirming.kind === 'payment'
      ? roster.confirmed.find((entry) => entry.profile_id === confirming.id)
      : refunds.find((refund) => refund.id === confirming.id)
    : undefined;
  const confirmationAmount =
    confirming?.kind === 'payment'
      ? price
      : refunds.find((refund) => refund.id === confirming?.id)?.amount;
  const confirm = () => {
    if (!confirming || actions.pending) return;
    const target = confirming;
    const refund = refunds.find((r) => r.id === target.id);
    const instant =
      target.kind !== 'payment' && refund ? refundInstant(date, timezone, refund.created_at) : null;
    if (target.kind !== 'payment' && instant === null) {
      setInvalid(true);
      return;
    }
    void actions
      .run(`${target.kind}:${target.id}:${date}`, () =>
        target.kind === 'mark'
          ? api.markRefunded(matchId, target.id, instant ?? undefined)
          : target.kind === 'correct'
            ? api.correctRefund(matchId, target.id, instant ?? undefined)
            : api.recordCanceledMatchPayment(matchId, target.id),
      )
      .then((result) => {
        if (result) {
          focusRefund.current = target.kind === 'payment' ? result.outcome.refund_id : target.id;
          setConfirming(null);
          setSaved(true);
        }
      });
  };
  const ask = (id: string, kind: 'mark' | 'correct' | 'payment') => {
    if (actions.pending) return;
    actions.discardIntent();
    actions.clearError();
    setSaved(false);
    setDate('');
    setInvalid(false);
    setConfirming({ id, kind });
  };
  return (
    <View style={styles.section} testID="match-refunds">
      <Text role="heading" aria-level={2} style={[typography.section, { color: colors.text }]}>
        {pt.refunds.title}
      </Text>
      <Text style={{ color: colors.textMuted }}>{pt.refunds.warning}</Text>
      <Text testID="match-refunds-total" style={{ color: colors.text }}>
        {pt.refunds.total(
          matchPrice(
            refunds
              .filter((r) => r.status === 'refund_due')
              .reduce((sum, r) => sum + Number(r.amount), 0),
          ),
        )}
      </Text>
      {refunds.map((refund) => (
        <View
          key={refund.id}
          style={[styles.row, { backgroundColor: colors.surface }]}
          testID={`refund-row-${refund.id}`}
        >
          <Text style={{ color: colors.text }}>
            {refund.account_removed
              ? pt.matches.detail.removedAccount
              : (refund.nickname ?? refund.name)}{' '}
            · {matchPrice(Number(refund.amount))}
          </Text>
          <Text testID={`refund-status-${refund.id}`} style={{ color: colors.text }}>
            {refund.status === 'refund_due' ? pt.refunds.due : pt.refunds.recorded}
          </Text>
          {refund.refunded_at ? (
            <Text style={{ color: colors.textMuted }}>
              {new Intl.DateTimeFormat('pt-BR', {
                timeZone: timezone,
                dateStyle: 'short',
                timeStyle: 'short',
              }).format(new Date(refund.refunded_at))}
            </Text>
          ) : null}
          <AppButton
            ariaDisabled={actions.pending}
            label={refund.status === 'refund_due' ? pt.refunds.mark : pt.refunds.correct}
            testID={`refund-${refund.id}`}
            variant="outline"
            onPress={() => ask(refund.id, refund.status === 'refund_due' ? 'mark' : 'correct')}
          />
        </View>
      ))}
      {paymentsToRecord.map((entry) => (
        <AppButton
          key={entry.profile_id}
          ariaDisabled={actions.pending}
          label={`${pt.refunds.recordPayment}: ${entry.nickname ?? entry.name}`}
          testID={`canceled-payment-${entry.profile_id}`}
          variant="outline"
          onPress={() => ask(entry.profile_id!, 'payment')}
        />
      ))}
      <AppAlert
        message={
          actions.error instanceof AppError &&
          actions.error.code === 'VALIDATION' &&
          confirming?.kind !== 'payment'
            ? pt.refunds.invalidDate
            : actions.error
              ? matchErrorMessage(actions.error)
              : ''
        }
        testID="match-refund-error"
      />
      <AppStatus message={saved ? pt.refunds.saved : ''} testID="match-refund-result" />
      {confirming ? (
        <GroupConfirmation
          level={3}
          title={
            confirming.kind === 'correct'
              ? pt.refunds.correct
              : confirming.kind === 'payment'
                ? pt.refunds.confirmPayment
                : pt.refunds.mark
          }
          testID="refund-confirmation"
        >
          <Text style={{ color: colors.text }}>
            {confirmationTarget?.account_removed
              ? pt.matches.detail.removedAccount
              : (confirmationTarget?.nickname ?? confirmationTarget?.name)}
            {' · '}
            {confirmationAmount === undefined ? '' : matchPrice(Number(confirmationAmount))}
            {' · '}
            {matchLabel}
          </Text>
          <Text style={{ color: colors.text }}>
            {confirming.kind === 'correct'
              ? pt.refunds.confirmCorrect
              : confirming.kind === 'payment'
                ? pt.refunds.confirmLate
                : pt.refunds.confirmMark}
          </Text>
          {confirming.kind !== 'payment' ? (
            <AppTextField
              label={pt.refunds.date}
              hint={pt.refunds.dateHint(zoneLabel(timezone, new Date()))}
              value={date}
              onChangeText={(value) => {
                setDate(value);
                actions.discardIntent();
                setInvalid(false);
              }}
              error={invalid ? pt.refunds.invalidDate : undefined}
              testID="refund-date"
            />
          ) : null}
          <AppButton
            ariaDisabled={actions.pending}
            label={pt.refunds.confirm}
            onPress={confirm}
            testID="refund-confirm"
          />
          <AppButton
            ariaDisabled={actions.pending}
            label={pt.matches.detail.cancel}
            variant="secondary"
            onPress={() => {
              if (actions.pending) return;
              const control =
                confirming.kind === 'payment'
                  ? `canceled-payment-${confirming.id}`
                  : `refund-${confirming.id}`;
              setConfirming(null);
              setInvalid(false);
              actions.discardIntent();
              actions.clearError();
              focusGroupControl(control);
            }}
            testID="refund-cancel"
          />
        </GroupConfirmation>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  row: { gap: spacing.sm, padding: spacing.md, borderRadius: 12 },
});
