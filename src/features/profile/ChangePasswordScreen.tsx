import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, Text, View } from 'react-native';
import type { Session } from '@supabase/supabase-js';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppTextField } from '@/components/ui/AppTextField';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { api, TransportError } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { backTo } from '@/lib/navigation';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { focusFirstInvalid } from '../auth/form-utils';
import { ProfileBackLink } from './ProfileBackLink';
import { authErrorMessage, fieldMessage } from '../auth/messages';
import {
  newPasswordSchema,
  otpSchema,
  type NewPasswordValues,
  type OtpValues,
} from '../auth/schemas';

type Stage = 'start' | 'code' | 'password' | 'complete';

/**
 * Changing the password from inside the app is the recovery flow of
 * "Esqueci minha senha" (decisão humana de 14/10/2026), fixed to the account's
 * own e-mail: the same three Auth calls in the same order — send the recovery
 * code, verify it, then set the new password. There is no direct change
 * without the code.
 */
export function ChangePasswordScreen({ session }: { session: Session }) {
  const { colors } = useTheme();
  const email = session.user.email ?? null;
  const [stage, setStage] = useState<Stage>('start');
  const completeRef = useRef<View>(null);
  const otpForm = useForm<OtpValues>({
    defaultValues: { code: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
    resolver: zodResolver(otpSchema),
  });
  const passwordForm = useForm<NewPasswordValues>({
    defaultValues: { confirmPassword: '', password: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
    resolver: zodResolver(newPasswordSchema),
  });

  const send = useMutation({
    mutationFn: (address: string) => api.requestPasswordOtp(address),
    onSuccess: () => {
      otpForm.reset();
      setStage('code');
    },
  });
  const verify = useMutation({
    mutationFn: ({ code }: OtpValues) => api.verifyEmailOtp(email ?? '', code, 'recovery'),
    onSuccess: () => setStage('password'),
  });
  const update = useMutation({
    mutationFn: ({ password }: NewPasswordValues) => api.updatePassword(password),
    onSuccess: () => {
      passwordForm.reset();
      setStage('complete');
    },
  });

  useEffect(() => {
    if (stage === 'code') otpForm.setFocus('code');
    if (stage === 'password') passwordForm.setFocus('password');
    if (stage === 'complete') completeRef.current?.focus();
  }, [otpForm, passwordForm, stage]);

  const cancel = () => backTo('/perfil');
  const shell = (children: ReactNode) => (
    <AuthenticatedShell
      description={pt.profile.passwordChange.description}
      title={pt.profile.passwordChange.title}
    >
      <ProfileBackLink label={pt.profile.passwordChange.back} />
      {children}
    </AuthenticatedShell>
  );

  if (email === null) {
    return shell(
      <AsyncNotice
        action={cancel}
        actionLabel={pt.profile.passwordChange.back}
        kind="empty"
        message={pt.profile.passwordChange.noEmailBody}
        title={pt.profile.passwordChange.noEmailTitle}
      />,
    );
  }

  const sendCode = () => {
    if (!send.isPending) send.mutate(email);
  };
  const submitCode = otpForm.handleSubmit(
    (values) => verify.mutate(values),
    (invalid) => focusFirstInvalid(invalid, otpForm.setFocus),
  );
  const submitPassword = passwordForm.handleSubmit(
    (values) => update.mutate(values),
    (invalid) => focusFirstInvalid(invalid, passwordForm.setFocus),
  );

  return shell(
    <AppCard testID="password-change-card">
      {stage === 'start' ? (
        <View style={styles.form}>
          <Text style={[styles.destination, { color: colors.text }]} testID="password-destination">
            {pt.profile.passwordChange.destination(email)}
          </Text>
          {send.error === null ? null : <AppAlert message={authErrorMessage(send.error)} />}
          {send.isPending ? <AppSkeleton lines={1} /> : null}
          <View style={styles.actions}>
            <AppButton
              icon="mail"
              label={send.isPending ? pt.common.sending : pt.profile.passwordChange.send}
              onPress={sendCode}
              testID="password-send-code"
            />
            {send.error instanceof TransportError ? (
              <AppButton label={pt.common.retry} onPress={sendCode} variant="secondary" />
            ) : null}
            <AppButton
              label={pt.profile.passwordChange.cancel}
              onPress={cancel}
              variant="secondary"
            />
          </View>
        </View>
      ) : null}

      {stage === 'code' ? (
        <View style={styles.form}>
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.status, { color: colors.text }]}
            testID="password-code-sent"
          >
            {pt.profile.passwordChange.sent(email)}
          </Text>
          {verify.error === null ? null : <AppAlert message={authErrorMessage(verify.error)} />}
          {send.error === null ? null : <AppAlert message={authErrorMessage(send.error)} />}
          <Controller
            control={otpForm.control}
            name="code"
            render={({ field }) => (
              <AppTextField
                autoComplete="one-time-code"
                error={fieldMessage(otpForm.formState.errors.code?.message)}
                inputMode="numeric"
                keyboardType="number-pad"
                label={pt.auth.fields.code}
                maxLength={6}
                onBlur={field.onBlur}
                onChangeText={(value) => {
                  verify.reset();
                  field.onChange(value.replace(/\D/gu, ''));
                }}
                ref={field.ref}
                testID="password-code"
                value={field.value}
              />
            )}
          />
          {verify.isPending ? <AppSkeleton lines={1} /> : null}
          <View style={styles.actions}>
            <AppButton
              label={verify.isPending ? pt.common.sending : pt.profile.passwordChange.verify}
              onPress={() => {
                if (!verify.isPending) void submitCode();
              }}
              testID="password-verify-code"
            />
            {verify.error instanceof TransportError ? (
              <AppButton
                label={pt.common.retry}
                onPress={() => void submitCode()}
                variant="secondary"
              />
            ) : null}
            <AppButton
              label={pt.auth.otp.resend}
              onPress={sendCode}
              testID="password-resend-code"
              variant="secondary"
            />
            <AppButton
              label={pt.profile.passwordChange.cancel}
              onPress={cancel}
              variant="tertiary"
            />
          </View>
        </View>
      ) : null}

      {stage === 'password' ? (
        <View style={styles.form}>
          <AppStatus message={pt.profile.passwordChange.verified} />
          {update.error === null ? null : <AppAlert message={authErrorMessage(update.error)} />}
          <Controller
            control={passwordForm.control}
            name="password"
            render={({ field }) => (
              <AppTextField
                autoCapitalize="none"
                autoComplete="new-password"
                error={fieldMessage(passwordForm.formState.errors.password?.message)}
                label={pt.profile.passwordChange.newPassword}
                onBlur={field.onBlur}
                onChangeText={(value) => {
                  update.reset();
                  field.onChange(value);
                }}
                passwordToggleLabel={{
                  hide: pt.auth.fields.hidePassword,
                  show: pt.auth.fields.showPassword,
                }}
                ref={field.ref}
                secureTextEntry
                testID="profile-new-password"
                value={field.value}
              />
            )}
          />
          <Controller
            control={passwordForm.control}
            name="confirmPassword"
            render={({ field }) => (
              <AppTextField
                autoCapitalize="none"
                autoComplete="new-password"
                error={fieldMessage(passwordForm.formState.errors.confirmPassword?.message)}
                label={pt.profile.passwordChange.confirmPassword}
                onBlur={field.onBlur}
                onChangeText={(value) => {
                  update.reset();
                  field.onChange(value);
                }}
                passwordToggleLabel={{
                  hide: pt.auth.fields.hidePassword,
                  show: pt.auth.fields.showPassword,
                }}
                ref={field.ref}
                secureTextEntry
                testID="profile-confirm-password"
                value={field.value}
              />
            )}
          />
          {update.isPending ? <AppSkeleton lines={1} /> : null}
          <View style={styles.actions}>
            <AppButton
              label={update.isPending ? pt.common.sending : pt.profile.passwordChange.save}
              onPress={() => {
                if (!update.isPending) void submitPassword();
              }}
              testID="password-save"
            />
            {update.error instanceof TransportError ? (
              <AppButton
                label={pt.common.retry}
                onPress={() => void submitPassword()}
                variant="secondary"
              />
            ) : null}
          </View>
        </View>
      ) : null}

      {stage === 'complete' ? (
        <View ref={completeRef} style={styles.form} tabIndex={-1} testID="password-complete">
          <AppStatus message={pt.profile.passwordChange.saved} />
          <View style={styles.actions}>
            <AppButton
              icon="arrow-left"
              label={pt.profile.passwordChange.back}
              onPress={cancel}
              variant="secondary"
            />
          </View>
        </View>
      ) : null}
    </AppCard>,
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, minWidth: 0, width: '100%' },
  destination: { ...typography.bodyStrong },
  form: { gap: spacing.md, minWidth: 0, width: '100%' },
  status: { ...typography.support },
});
