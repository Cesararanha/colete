import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppNavLink } from '@/components/ui/AppNavLink';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppTextField } from '@/components/ui/AppTextField';
import { AuthShell } from '@/components/ui/AuthShell';
import { api, TransportError } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

import { focusFirstInvalid } from './form-utils';
import { FormAlert } from './FormAlert';
import { authErrorMessage, fieldMessage } from './messages';
import {
  forgotEmailSchema,
  newPasswordSchema,
  otpSchema,
  type ForgotEmailValues,
  type NewPasswordValues,
  type OtpValues,
} from './schemas';

type Stage = 'code' | 'complete' | 'email' | 'password';

export function ForgotPasswordScreen() {
  const { colors } = useTheme();
  const [stage, setStage] = React.useState<Stage>('email');
  const [email, setEmail] = React.useState('');
  const emailForm = useForm<ForgotEmailValues>({
    defaultValues: { email: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
    resolver: zodResolver(forgotEmailSchema),
  });
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
    mutationFn: ({ email: address }: ForgotEmailValues) => api.requestPasswordOtp(address),
    onSuccess: (_result, values) => {
      setEmail(values.email);
      setStage('code');
    },
  });
  const verify = useMutation({
    mutationFn: ({ code }: OtpValues) => api.verifyEmailOtp(email, code, 'recovery'),
    onSuccess: () => setStage('password'),
  });
  const update = useMutation({
    mutationFn: ({ password }: NewPasswordValues) => api.updatePassword(password),
    onSuccess: () => setStage('complete'),
  });

  const title = pt.auth.forgot.title;
  return (
    <AuthShell
      description={pt.auth.forgot.description}
      eyebrow={pt.auth.forgot.eyebrow}
      title={title}
    >
      <AppCard>
        {stage === 'email' ? (
          <View style={styles.form}>
            {send.error === null ? null : <FormAlert message={authErrorMessage(send.error)} />}
            <Controller
              control={emailForm.control}
              name="email"
              render={({ field }) => (
                <AppTextField
                  autoCapitalize="none"
                  autoComplete="email"
                  error={fieldMessage(emailForm.formState.errors.email?.message)}
                  inputMode="email"
                  keyboardType="email-address"
                  label={pt.auth.fields.email}
                  onBlur={field.onBlur}
                  onChangeText={field.onChange}
                  ref={field.ref}
                  testID="recovery-email"
                  value={field.value}
                />
              )}
            />
            {send.isPending ? <AppSkeleton lines={2} /> : null}
            <AppButton
              label={send.isPending ? pt.common.sending : pt.auth.forgot.sendAction}
              onPress={emailForm.handleSubmit(
                (values) => send.mutate(values),
                (invalid) => focusFirstInvalid(invalid, emailForm.setFocus),
              )}
            />
            {send.error instanceof TransportError ? (
              <AppButton
                label={pt.common.retry}
                onPress={emailForm.handleSubmit((values) => send.mutate(values))}
                variant="secondary"
              />
            ) : null}
          </View>
        ) : null}

        {stage === 'code' ? (
          <View style={styles.form}>
            <Text accessibilityLiveRegion="polite" style={[styles.status, { color: colors.text }]}>
              {pt.auth.forgot.sent}
            </Text>
            {verify.error === null ? null : <FormAlert message={authErrorMessage(verify.error)} />}
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
                  onChangeText={(value) => field.onChange(value.replace(/\D/gu, ''))}
                  ref={field.ref}
                  value={field.value}
                />
              )}
            />
            {verify.isPending ? <AppSkeleton lines={2} /> : null}
            <AppButton
              label={verify.isPending ? pt.common.sending : pt.auth.forgot.verifyAction}
              onPress={otpForm.handleSubmit(
                (values) => verify.mutate(values),
                (invalid) => focusFirstInvalid(invalid, otpForm.setFocus),
              )}
            />
            {verify.error instanceof TransportError ? (
              <AppButton
                label={pt.common.retry}
                onPress={otpForm.handleSubmit(
                  (values) => verify.mutate(values),
                  (invalid) => focusFirstInvalid(invalid, otpForm.setFocus),
                )}
                variant="secondary"
              />
            ) : null}
          </View>
        ) : null}

        {stage === 'password' ? (
          <View style={styles.form}>
            <Text accessibilityLiveRegion="polite" style={[styles.status, { color: colors.text }]}>
              {pt.auth.forgot.verified}
            </Text>
            {update.error === null ? null : <FormAlert message={authErrorMessage(update.error)} />}
            <Controller
              control={passwordForm.control}
              name="password"
              render={({ field }) => (
                <AppTextField
                  autoComplete="new-password"
                  error={fieldMessage(passwordForm.formState.errors.password?.message)}
                  label={pt.auth.fields.password}
                  onBlur={field.onBlur}
                  onChangeText={field.onChange}
                  passwordToggleLabel={{
                    hide: pt.auth.fields.hidePassword,
                    show: pt.auth.fields.showPassword,
                  }}
                  ref={field.ref}
                  secureTextEntry
                  value={field.value}
                />
              )}
            />
            <Controller
              control={passwordForm.control}
              name="confirmPassword"
              render={({ field }) => (
                <AppTextField
                  autoComplete="new-password"
                  error={fieldMessage(passwordForm.formState.errors.confirmPassword?.message)}
                  label={pt.auth.fields.confirmPassword}
                  onBlur={field.onBlur}
                  onChangeText={field.onChange}
                  passwordToggleLabel={{
                    hide: pt.auth.fields.hidePassword,
                    show: pt.auth.fields.showPassword,
                  }}
                  ref={field.ref}
                  secureTextEntry
                  value={field.value}
                />
              )}
            />
            {update.isPending ? <AppSkeleton lines={2} /> : null}
            <AppButton
              label={update.isPending ? pt.common.sending : pt.auth.forgot.updateAction}
              onPress={passwordForm.handleSubmit(
                (values) => update.mutate(values),
                (invalid) => focusFirstInvalid(invalid, passwordForm.setFocus),
              )}
            />
            {update.error instanceof TransportError ? (
              <AppButton
                label={pt.common.retry}
                onPress={passwordForm.handleSubmit(
                  (values) => update.mutate(values),
                  (invalid) => focusFirstInvalid(invalid, passwordForm.setFocus),
                )}
                variant="secondary"
              />
            ) : null}
          </View>
        ) : null}

        {stage === 'complete' ? (
          <View style={styles.form}>
            <Text
              accessibilityLiveRegion="polite"
              style={[styles.status, { color: colors.positive }]}
            >
              {pt.auth.forgot.complete}
            </Text>
            <AppNavLink href="/entrar" label={pt.auth.forgot.backToLogin} />
          </View>
        ) : null}
      </AppCard>
      {stage === 'email' ? <AppNavLink href="/entrar" label={pt.auth.forgot.backToLogin} /> : null}
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  status: { fontSize: 15, lineHeight: 22 },
});
