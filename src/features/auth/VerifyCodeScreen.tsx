import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppTextField } from '@/components/ui/AppTextField';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { AuthShell } from '@/components/ui/AuthShell';
import { AppError, api, TransportError, type MutationIntent } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

import { useAuthFlowStore } from './auth-flow-store';
import { focusFirstInvalid } from './form-utils';
import { FormAlert } from './FormAlert';
import { authErrorMessage, fieldMessage } from './messages';
import { ProfileCompletionForm } from './ProfileCompletionForm';
import { otpSchema, type OtpValues } from './schemas';

export function VerifyCodeScreen() {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const pendingEmail = useAuthFlowStore((state) => state.pendingEmail);
  const pendingName = useAuthFlowStore((state) => state.pendingName);
  const resendAvailableAt = useAuthFlowStore((state) => state.resendAvailableAt);
  const setResendAvailableAt = useAuthFlowStore((state) => state.setResendAvailableAt);
  const clearPendingSignup = useAuthFlowStore((state) => state.clearPendingSignup);
  const [now, setNow] = useState(0);
  const [needsCompletion, setNeedsCompletion] = useState(false);
  const [completionError, setCompletionError] = useState<unknown>(null);
  const completionIntent = useRef<MutationIntent<unknown> | null>(null);
  const {
    control,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<OtpValues>({
    defaultValues: { code: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
    resolver: zodResolver(otpSchema),
  });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const finishProfile = async (name: string) => {
    completionIntent.current ??= api.completeProfile({ name });
    const result = await completionIntent.current.execute();
    await queryClient.invalidateQueries({ queryKey: ['own-profile'] });
    clearPendingSignup();
    router.replace('/');
    return result;
  };

  const verification = useMutation({
    mutationFn: async ({ code }: OtpValues) => {
      if (pendingEmail === null) throw new AppError('VALIDATION', pt.auth.errors.validation);
      const verified = await api.verifyEmailOtp(pendingEmail, code, 'signup');
      const profile = await api.getOwnProfile();
      if (profile !== null) {
        clearPendingSignup();
        router.replace('/');
        return;
      }

      const metadataName = verified.user?.user_metadata['name'];
      const name = pendingName ?? (typeof metadataName === 'string' ? metadataName : '');
      if (name.trim().length < 2) {
        setNeedsCompletion(true);
        return;
      }
      try {
        await finishProfile(name);
      } catch (error) {
        setCompletionError(error);
      }
    },
  });

  const resend = useMutation({
    mutationFn: async () => {
      if (pendingEmail === null) throw new AppError('VALIDATION', pt.auth.errors.validation);
      await api.resendSignupOtp(pendingEmail);
    },
    onSuccess: () => setResendAvailableAt(Date.now() + 60_000),
  });

  const submit = handleSubmit(
    (values) => verification.mutate(values),
    (invalid) => focusFirstInvalid(invalid, setFocus),
  );
  const retryCompletion = async () => {
    if (completionIntent.current === null) return;
    setCompletionError(null);
    try {
      await completionIntent.current.retry();
      await queryClient.invalidateQueries({ queryKey: ['own-profile'] });
      clearPendingSignup();
      router.replace('/');
    } catch (error) {
      setCompletionError(error);
    }
  };

  if (pendingEmail === null) {
    return (
      <AuthShell
        description={pt.auth.otp.description}
        eyebrow={pt.auth.otp.eyebrow}
        title={pt.auth.otp.title}
      >
        <AsyncNotice
          action={() => router.replace('/criar-conta')}
          actionLabel={pt.auth.otp.missingAction}
          kind="empty"
          message={pt.auth.otp.missingBody}
          title={pt.auth.otp.missingTitle}
        />
      </AuthShell>
    );
  }

  if (needsCompletion) {
    return (
      <AuthShell
        description={pt.auth.profile.description}
        eyebrow={pt.auth.profile.eyebrow}
        title={pt.auth.profile.title}
      >
        <AppCard>
          <ProfileCompletionForm
            defaultName={pendingName ?? ''}
            onCompleted={() => {
              clearPendingSignup();
              router.replace('/');
            }}
          />
        </AppCard>
      </AuthShell>
    );
  }

  const canResend = resendAvailableAt === null || now >= resendAvailableAt;
  const resendTime = new Date(resendAvailableAt ?? now).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <AuthShell
      description={pt.auth.otp.description}
      eyebrow={pt.auth.otp.eyebrow}
      title={pt.auth.otp.title}
    >
      <AppCard>
        <Text style={[styles.destination, { color: colors.text }]}>
          {pt.auth.otp.destination(pendingEmail)}
        </Text>
        {verification.error === null ? null : (
          <FormAlert message={authErrorMessage(verification.error)} />
        )}
        {completionError === null ? null : (
          <FormAlert message={authErrorMessage(completionError)} />
        )}
        {resend.error === null ? null : <FormAlert message={authErrorMessage(resend.error)} />}
        {resend.isSuccess ? (
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.status, { color: colors.positive }]}
          >
            {pt.auth.otp.resent}
          </Text>
        ) : null}
        <View style={styles.form}>
          <Controller
            control={control}
            name="code"
            render={({ field }) => (
              <AppTextField
                autoComplete="one-time-code"
                error={fieldMessage(errors.code?.message)}
                inputMode="numeric"
                keyboardType="number-pad"
                label={pt.auth.fields.code}
                maxLength={6}
                onBlur={field.onBlur}
                onChangeText={(value) => field.onChange(value.replace(/\D/gu, ''))}
                ref={field.ref}
                testID="signup-otp"
                value={field.value}
              />
            )}
          />
          {verification.isPending ? <AppSkeleton lines={2} /> : null}
          <AppButton
            label={verification.isPending ? pt.common.sending : pt.auth.otp.action}
            onPress={submit}
          />
          {completionError instanceof TransportError ||
          (completionError instanceof AppError && completionError.retryable) ? (
            <AppButton label={pt.common.retry} onPress={retryCompletion} variant="secondary" />
          ) : null}
          {canResend ? (
            <AppButton
              label={pt.auth.otp.resend}
              onPress={() => resend.mutate()}
              variant="secondary"
            />
          ) : (
            <Text style={[styles.status, { color: colors.textMuted }]}>
              {pt.auth.otp.resendAt(resendTime)}
            </Text>
          )}
        </View>
      </AppCard>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  destination: { fontSize: 15, fontWeight: '700', lineHeight: 22 },
  form: { gap: spacing.md },
  status: { fontSize: 14, lineHeight: 20 },
});
