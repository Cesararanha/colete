import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppTextField } from '@/components/ui/AppTextField';
import { api, type ManagedMatchRefund, type MatchRoster } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { focusGroupControl, GroupConfirmation } from '../groups/GroupConfirmation';
import { matchErrorMessage } from './match-errors';
import { matchPrice } from './match-format';
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
  const manage = roster.viewer.can_manage;
  if (!manage) return null;
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
          ? api.markRefunded(matchId, target.id, instant!)
          : target.kind === 'correct'
            ? api.correctRefund(matchId, target.id, instant!)
            : api.recordCanceledMatchPayment(matchId, target.id),
      )
      .then((result) => {
        if (result) {
          setConfirming(null);
          setSaved(true);
          if (target.kind === 'payment') {
            // Wait for the confirmation to close and the refreshed row to render.
            requestAnimationFrame(() => {
              const control = `refund-${result.outcome.refund_id}`;
              focusGroupControl(
                typeof document !== 'undefined' &&
                  document.querySelector(`[data-testid="${control}"]`)
                  ? control
                  : 'match-refresh-button',
              );
            });
          } else {
            focusGroupControl(`refund-${target.id}`);
          }
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
            {refund.status === 'refund_due' ? pt.refunds.due : pt.refunds.refunded}
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
      {roster.canceled
        ? roster.confirmed
            .filter(
              (entry) =>
                entry.profile_id !== null &&
                !entry.account_removed &&
                entry.can_record_canceled_payment === true,
            )
            .map((entry) => (
              <AppButton
                key={entry.profile_id}
                ariaDisabled={actions.pending}
                label={`${pt.refunds.recordPayment}: ${entry.nickname ?? entry.name}`}
                testID={`canceled-payment-${entry.profile_id}`}
                variant="outline"
                onPress={() => ask(entry.profile_id!, 'payment')}
              />
            ))
        : null}
      <AppAlert
        message={actions.error ? matchErrorMessage(actions.error) : ''}
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
              hint={pt.refunds.dateHint(timezone)}
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
              actions.discardIntent();
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
