import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppCheckbox } from '@/components/ui/AppCheckbox';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { SectionHeading } from '@/components/ui/SectionHeading';
import {
  AppError,
  api,
  TransportError,
  type AccountDeletionResult,
  type MutationIntent,
} from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { deletionRequestProjectionSchema } from '@/lib/privacy-schema';
import { privateQueryKeys } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { deletionProtocolStore } from './deletion-protocol';
import { profileErrorMessage } from './profile-errors';

export function DeleteAccountCard() {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<'intro' | 'summary'>('intro');
  const [confirmed, setConfirmed] = useState(false);
  const [checkboxError, setCheckboxError] = useState<string | undefined>(undefined);
  const summaryRef = useRef<View>(null);
  const requirementId = `deletion-requirement-${useId().replace(/[^A-Za-z0-9_-]/gu, '')}`;
  const checkboxRef = useRef<View>(null);
  const [intent, setIntent] = useState<MutationIntent<AccountDeletionResult> | null>(null);

  const deletion = useMutation({
    mutationFn: (command: MutationIntent<AccountDeletionResult>) => command.execute(),
    onSuccess: async (result) => {
      setIntent(null);
      const parsed = deletionRequestProjectionSchema.safeParse(result.current);
      if (parsed.success) {
        deletionProtocolStore.store({ id: parsed.data.id, requested_at: parsed.data.requested_at });
        queryClient.setQueryData(privateQueryKeys.deletionRequest, parsed.data);
      }
      // The profile row is hidden by RLS from this commit on; the gate reads the
      // deletion projection and renders the restricted shell.
      queryClient.setQueryData(privateQueryKeys.ownProfile, null);
      await queryClient.invalidateQueries({ queryKey: privateQueryKeys.deletionRequest });
    },
    onError: async (error) => {
      if (error instanceof AppError && !error.retryable) setIntent(null);
      if (error instanceof AppError && error.code === 'DELETION_ALREADY_PENDING') {
        await queryClient.invalidateQueries({ queryKey: privateQueryKeys.deletionRequest });
        queryClient.setQueryData(privateQueryKeys.ownProfile, null);
      }
    },
  });

  useEffect(() => {
    if (step === 'summary') summaryRef.current?.focus();
  }, [step]);

  const confirm = () => {
    if (deletion.isPending) return;
    if (!confirmed) {
      checkboxRef.current?.focus();
      setCheckboxError(pt.privacy.deletion.checkboxRequired);
      return;
    }
    const command = intent ?? api.deleteAccount();
    setIntent(command);
    deletion.mutate(command);
  };
  const canRetry =
    deletion.error instanceof TransportError ||
    (deletion.error instanceof AppError && deletion.error.retryable);

  return (
    <AppCard testID="profile-deletion-card">
      <SectionHeading
        description={pt.privacy.deletion.description}
        eyebrow={pt.privacy.deletion.eyebrow}
        title={pt.privacy.deletion.title}
      />
      <View style={styles.list}>
        {[
          pt.privacy.deletion.intro.anonymization,
          pt.privacy.deletion.intro.immediateLoss,
          pt.privacy.deletion.intro.asyncCleanup,
          pt.privacy.deletion.intro.blockers,
        ].map((line) => (
          <Text key={line} style={[styles.body, { color: colors.textMuted }]}>
            {line}
          </Text>
        ))}
      </View>

      {step === 'intro' ? (
        <View style={styles.actions}>
          <AppButton
            label={pt.privacy.deletion.start}
            onPress={() => {
              deletion.reset();
              setStep('summary');
            }}
            testID="deletion-start"
            variant="destructive"
          />
        </View>
      ) : (
        <View
          ref={summaryRef}
          style={[
            styles.summary,
            { backgroundColor: colors.background, borderColor: colors.critical },
          ]}
          tabIndex={-1}
          testID="deletion-summary"
        >
          <Text aria-level={3} role="heading" style={[styles.summaryTitle, { color: colors.text }]}>
            {pt.privacy.deletion.summaryTitle}
          </Text>
          <Text style={[styles.body, { color: colors.text }]}>{pt.privacy.deletion.summary}</Text>
          <Text nativeID={requirementId} style={[styles.body, { color: colors.textMuted }]}>
            {pt.privacy.deletion.requirement}
          </Text>
          <AppCheckbox
            checked={confirmed}
            error={checkboxError}
            label={pt.privacy.deletion.checkbox}
            onChange={(next) => {
              setCheckboxError(undefined);
              setConfirmed(next);
            }}
            ref={checkboxRef}
            testID="deletion-confirm-checkbox"
          />
          {deletion.error === null ? null : (
            <AppAlert message={profileErrorMessage(deletion.error)} testID="deletion-error" />
          )}
          {deletion.isPending ? <AppSkeleton lines={1} /> : null}
          <View style={styles.actions}>
            <AppButton
              describedBy={requirementId}
              label={deletion.isPending ? pt.common.sending : pt.privacy.deletion.confirm}
              onPress={confirm}
              testID="deletion-confirm"
              variant="destructive"
            />
            {canRetry && intent !== null ? (
              <AppButton
                label={pt.common.retry}
                onPress={confirm}
                testID="deletion-retry"
                variant="secondary"
              />
            ) : null}
            <AppButton
              label={pt.privacy.deletion.back}
              onPress={() => {
                if (deletion.isPending) return;
                setConfirmed(false);
                setCheckboxError(undefined);
                deletion.reset();
                setStep('intro');
              }}
              testID="deletion-back"
              variant="secondary"
            />
          </View>
        </View>
      )}
    </AppCard>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    minWidth: 0,
    width: '100%',
  },
  body: { ...typography.support },
  list: { gap: spacing.sm },
  summary: {
    borderRadius: radius.field,
    borderWidth: 2,
    gap: spacing.sm,
    minWidth: 0,
    padding: spacing.md,
    width: '100%',
  },
  summaryTitle: { ...typography.title },
});
