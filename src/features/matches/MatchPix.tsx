// Pix manual do piloto (docs/13 section 1.3.2, `0036`). The organisation
// registers, replaces or removes the match's Pix; an unpaid confirmed player
// sees the amount, the receiver to check in the bank, the copy-and-paste code
// first (wide screens and phones alike) and the QR. The BR Code is built here,
// from what the gateway opened; nothing of it is stored or sent.
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppTextField } from '@/components/ui/AppTextField';
import {
  api,
  AppError,
  type MatchPixInput,
  type MatchRoster,
  type PaymentInstructions,
  type PixKeyType,
} from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { InviteQrCode } from '../groups/InviteQrCode';
import { GroupConfirmation } from '../groups/GroupConfirmation';
import { matchErrorMessage } from './match-errors';
import { matchPrice } from './match-format';
import { pixChangedAt } from './pix-changed';
import { pixBrCode } from './pix-brcode';
import { useMatchActions } from './useMatchActions';

const TYPES: readonly PixKeyType[] = ['cpf', 'cnpj', 'email', 'phone', 'random'];

export function pixQueryKey(profileId: string, matchId: string) {
  return [PRIVATE_QUERY_ROOT, 'matches', profileId, matchId, 'pix'] as const;
}

/** null when the match has no Pix for this reader (PIX_NOT_CONFIGURED). */
async function readPix(matchId: string, signal: AbortSignal) {
  try {
    return await api.getPaymentInstructions(matchId, signal);
  } catch (caught) {
    if (caught instanceof AppError && caught.code === 'PIX_NOT_CONFIGURED') return null;
    throw caught;
  }
}

export function useMatchPix(profileId: string, matchId: string, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: pixQueryKey(profileId, matchId),
    queryFn: ({ signal }) => readPix(matchId, signal),
  });
}

/** The player's block: shown in place of "pague ao organizador" when there is a Pix. */
export function MatchPixPayment({ pix, timezone }: { pix: PaymentInstructions; timezone: string }) {
  const { colors } = useTheme();
  const [copyMessage, setCopyMessage] = useState('');
  // Data the gateway normalised never throws here; anything else must not take
  // the whole match screen down. Nothing of the input is logged.
  const code = useMemo(() => {
    try {
      return pixBrCode({
        key: pix.key,
        receiverName: pix.receiver_name,
        receiverCity: pix.receiver_city,
        amount: pix.amount,
      });
    } catch {
      return null;
    }
  }, [pix]);
  const changed = pixChangedAt(pix, timezone);
  const copy = async () => {
    if (code === null) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopyMessage(pt.pix.copied);
    } catch {
      setCopyMessage(pt.pix.copyFailed);
    }
  };
  return (
    <View style={[styles.box, { backgroundColor: colors.surface }]} testID="match-pix-payment">
      <Text style={[styles.title, { color: colors.text }]} testID="match-pix-pay-title">
        {pt.pix.payTitle(matchPrice(Number(pix.amount)))}
      </Text>
      {changed ? (
        <Text style={[styles.body, { color: colors.critical }]} testID="match-pix-changed">
          {pt.pix.changedAt(changed)}
        </Text>
      ) : null}
      <Text style={[styles.body, { color: colors.text }]} testID="match-pix-check-name">
        {pt.pix.checkName(pix.receiver_name)}
      </Text>
      {code === null ? (
        <Text style={[styles.body, { color: colors.text }]} testID="match-pix-code-unavailable">
          {pt.pix.codeUnavailable}
        </Text>
      ) : (
        <>
          <AppButton
            icon="copy"
            label={pt.pix.copy}
            onPress={() => void copy()}
            testID="match-pix-copy"
          />
          <AppStatus message={copyMessage} testID="match-pix-copy-result" />
          <InviteQrCode label={pt.pix.qr} testID="match-pix-qr" value={code} />
        </>
      )}
      <Text selectable style={[styles.small, { color: colors.textMuted }]} testID="match-pix-key">
        {pt.pix.keyLine(pt.pix.types[pix.type], pix.key)}
      </Text>
      <Text style={[styles.small, { color: colors.textMuted }]} testID="match-pix-set-by">
        {pt.pix.setBy(pix.set_by_name)} {pt.pix.afterPay}
      </Text>
    </View>
  );
}

function fieldError(error: unknown, field: string): string | undefined {
  if (!(error instanceof AppError) || error.code !== 'VALIDATION') return undefined;
  const fields = error.fields ?? {};
  if (!(field in fields)) return undefined;
  return field === 'pix.key' ? pt.pix.errors.key : pt.pix.errors.text;
}

/** The organisation's section: what is registered, and the form to set or replace it. */
export function MatchPixManager({
  matchId,
  profileId,
  roster,
  pix,
  pendingRefund,
}: {
  matchId: string;
  profileId: string;
  roster: MatchRoster;
  pix: PaymentInstructions | null;
  /** A refund_due line locks the Pix as a payment does (0036). */
  pendingRefund: boolean;
}) {
  const { colors } = useTheme();
  const actions = useMatchActions(profileId);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [message, setMessage] = useState('');
  const [form, setForm] = useState<MatchPixInput>({
    type: 'cpf',
    key: '',
    receiver_name: '',
    receiver_city: '',
  });
  if (!roster.viewer.can_manage || roster.canceled) return null;
  const summary = roster.payment_summary;
  // The server decides; this only explains why the buttons would be refused.
  // Without a Pix the client cannot know whether the match ever had one, so the
  // hint for adding states the rule instead of a refusal.
  const realPayment = (summary !== null && summary.paid_count > 0) || pendingRefund;
  const lockedHint = realPayment && pix !== null;
  const lockedAddHint = realPayment && pix === null;
  const run = (key: string, value: MatchPixInput | null) => {
    void actions
      .run(key, () => api.setMatchPix(matchId, value))
      .then((result) => {
        if (!result) return;
        setEditing(false);
        setRemoving(false);
        setMessage(value === null ? pt.pix.removed : pt.pix.saved);
      });
  };
  const open = () => {
    if (actions.pending) return;
    actions.discardIntent();
    actions.clearError();
    setMessage('');
    setRemoving(false);
    setForm({
      type: pix?.type ?? 'cpf',
      key: '',
      receiver_name: pix?.receiver_name ?? '',
      receiver_city: pix?.receiver_city ?? '',
    });
    setEditing(true);
  };
  const error = actions.error;
  const generalError =
    error instanceof AppError && error.code === 'VALIDATION' && error.fields ? '' : error;
  return (
    <View style={styles.section} testID="match-pix">
      <Text role="heading" aria-level={2} style={[typography.section, { color: colors.text }]}>
        {pt.pix.title}
      </Text>
      {pix ? (
        <View testID="match-pix-current">
          <Text style={[styles.body, { color: colors.text }]} selectable>
            {pt.pix.current(pt.pix.types[pix.type], pix.key)}
          </Text>
          <Text style={[styles.small, { color: colors.textMuted }]}>
            {pt.pix.receiver(pix.receiver_name, pix.receiver_city)}
          </Text>
          <Text style={[styles.small, { color: colors.textMuted }]}>
            {pt.pix.setBy(pix.set_by_name)}
          </Text>
        </View>
      ) : (
        <Text style={[styles.small, { color: colors.textMuted }]} testID="match-pix-none">
          {pt.pix.none}
        </Text>
      )}
      {lockedHint ? (
        <Text style={[styles.small, { color: colors.textMuted }]} testID="match-pix-locked">
          {pt.pix.lockedNote}
        </Text>
      ) : null}
      {lockedAddHint ? (
        <Text style={[styles.small, { color: colors.textMuted }]} testID="match-pix-locked-add">
          {pt.pix.lockedAddNote}
        </Text>
      ) : null}
      <AppStatus message={message} testID="match-pix-result" />
      <AppAlert
        message={generalError ? matchErrorMessage(generalError, 'manage') : ''}
        testID="match-pix-error"
      />
      {editing ? (
        <View style={styles.form} testID="match-pix-form">
          <View
            aria-label={pt.pix.typeGroup}
            role="group"
            style={styles.types}
            testID="match-pix-types"
          >
            {TYPES.map((type) => (
              <AppButton
                compact
                key={type}
                label={pt.pix.types[type]}
                onPress={() => setForm((current) => ({ ...current, type }))}
                pressed={form.type === type}
                testID={`match-pix-type-${type}`}
                variant="outline"
              />
            ))}
          </View>
          <AppTextField
            autoCapitalize="none"
            autoCorrect={false}
            error={fieldError(error, 'pix.key')}
            label={pt.pix.key}
            onChangeText={(key) => setForm((current) => ({ ...current, key }))}
            testID="match-pix-key-input"
            value={form.key}
          />
          <AppTextField
            autoCapitalize="characters"
            error={fieldError(error, 'pix.receiver_name')}
            hint={pt.pix.receiverNameHint}
            label={pt.pix.receiverName}
            maxLength={25}
            onChangeText={(receiver_name) => setForm((current) => ({ ...current, receiver_name }))}
            testID="match-pix-name-input"
            value={form.receiver_name}
          />
          <AppTextField
            autoCapitalize="characters"
            error={fieldError(error, 'pix.receiver_city')}
            hint={pt.pix.receiverCityHint}
            label={pt.pix.receiverCity}
            maxLength={15}
            onChangeText={(receiver_city) => setForm((current) => ({ ...current, receiver_city }))}
            testID="match-pix-city-input"
            value={form.receiver_city}
          />
          <View style={styles.actions}>
            <AppButton
              ariaDisabled={actions.pending}
              label={pt.pix.save}
              onPress={() =>
                run(
                  `set:${form.type}:${form.key}:${form.receiver_name}:${form.receiver_city}`,
                  form,
                )
              }
              testID="match-pix-save"
            />
            <AppButton
              label={pt.pix.back}
              onPress={() => setEditing(false)}
              testID="match-pix-back"
              variant="tertiary"
            />
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          <AppButton
            compact
            label={pix ? pt.pix.change : pt.pix.add}
            onPress={open}
            testID="match-pix-open"
            variant="outline"
          />
          {pix ? (
            <AppButton
              compact
              label={pt.pix.remove}
              onPress={() => {
                actions.discardIntent();
                actions.clearError();
                setMessage('');
                setRemoving(true);
              }}
              testID="match-pix-remove"
              variant="outline-destructive"
            />
          ) : null}
        </View>
      )}
      {removing && !editing ? (
        <GroupConfirmation title={pt.pix.removeTitle} testID="match-pix-remove-confirmation">
          <Text style={[styles.body, { color: colors.text }]}>{pt.pix.removeBody}</Text>
          <View style={styles.actions}>
            <AppButton
              ariaDisabled={actions.pending}
              label={pt.pix.remove}
              onPress={() => run('remove', null)}
              testID="match-pix-remove-confirm"
              variant="destructive"
            />
            <AppButton
              label={pt.pix.back}
              onPress={() => setRemoving(false)}
              testID="match-pix-remove-back"
              variant="tertiary"
            />
          </View>
        </GroupConfirmation>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm, marginTop: spacing.lg },
  box: { borderRadius: radius.field, gap: spacing.sm, padding: spacing.md },
  title: { ...typography.bodyStrong },
  body: { ...typography.body },
  small: { ...typography.support, fontSize: 14, lineHeight: 20 },
  form: { gap: spacing.md },
  types: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
