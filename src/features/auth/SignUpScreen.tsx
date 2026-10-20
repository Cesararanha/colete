import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppNavLink } from '@/components/ui/AppNavLink';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppTextField } from '@/components/ui/AppTextField';
import { AuthShell } from '@/components/ui/AuthShell';
import { api, TransportError } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { spacing } from '@/theme/spacing';

import { useAuthFlowStore } from './auth-flow-store';
import { focusFirstInvalid } from './form-utils';
import { FormAlert } from './FormAlert';
import { authErrorMessage, fieldMessage } from './messages';
import { passwordStrength, signUpSchema, type SignUpValues } from './schemas';

export function SignUpScreen() {
  const setPendingSignup = useAuthFlowStore((state) => state.setPendingSignup);
  const clearPendingSignup = useAuthFlowStore((state) => state.clearPendingSignup);
  // Back on the form, a code asked for earlier is no longer the one waited for.
  useFocusEffect(useCallback(() => clearPendingSignup(), [clearPendingSignup]));
  const {
    control,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<SignUpValues>({
    defaultValues: { confirmPassword: '', email: '', name: '', password: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
    resolver: zodResolver(signUpSchema),
  });
  const password = useWatch({ control, name: 'password' });
  const strength = passwordStrength(password);
  const strengthText = {
    short: pt.auth.signup.strengthShort,
    medium: pt.auth.signup.strengthMedium,
    strong: pt.auth.signup.strengthStrong,
  }[strength];

  const signup = useMutation({
    mutationFn: (values: SignUpValues) =>
      api.signUpWithPassword(values.email, values.password, values.name),
    onSuccess: (_result, values) => {
      setPendingSignup(values.email, values.name);
      router.push('/verificar-codigo');
    },
  });

  const submit = handleSubmit(
    (values) => signup.mutate(values),
    (invalid) => focusFirstInvalid(invalid, setFocus),
  );

  return (
    <AuthShell description={pt.auth.signup.description} title={pt.auth.signup.title}>
      <AppCard>
        {signup.error === null ? null : <FormAlert message={authErrorMessage(signup.error)} />}
        <View style={styles.form}>
          <Controller
            control={control}
            name="name"
            render={({ field }) => (
              <AppTextField
                autoCapitalize="words"
                autoComplete="name"
                error={fieldMessage(errors.name?.message)}
                label={pt.auth.fields.name}
                onBlur={field.onBlur}
                onChangeText={field.onChange}
                ref={field.ref}
                testID="signup-name"
                value={field.value}
              />
            )}
          />
          <Controller
            control={control}
            name="email"
            render={({ field }) => (
              <AppTextField
                autoCapitalize="none"
                autoComplete="email"
                error={fieldMessage(errors.email?.message)}
                inputMode="email"
                keyboardType="email-address"
                label={pt.auth.fields.email}
                onBlur={field.onBlur}
                onChangeText={field.onChange}
                ref={field.ref}
                testID="signup-email"
                value={field.value}
              />
            )}
          />
          <Controller
            control={control}
            name="password"
            render={({ field }) => (
              <AppTextField
                autoCapitalize="none"
                autoComplete="new-password"
                error={fieldMessage(errors.password?.message)}
                hint={`${pt.auth.signup.strengthLabel}: ${strengthText}`}
                label={pt.auth.fields.password}
                onBlur={field.onBlur}
                onChangeText={field.onChange}
                passwordToggleLabel={{
                  hide: pt.auth.fields.hidePassword,
                  show: pt.auth.fields.showPassword,
                }}
                ref={field.ref}
                secureTextEntry
                testID="signup-password"
                value={field.value}
              />
            )}
          />
          <Controller
            control={control}
            name="confirmPassword"
            render={({ field }) => (
              <AppTextField
                autoCapitalize="none"
                autoComplete="new-password"
                error={fieldMessage(errors.confirmPassword?.message)}
                label={pt.auth.fields.confirmPassword}
                onBlur={field.onBlur}
                onChangeText={field.onChange}
                passwordToggleLabel={{
                  hide: pt.auth.fields.hidePassword,
                  show: pt.auth.fields.showPassword,
                }}
                ref={field.ref}
                secureTextEntry
                testID="signup-confirm-password"
                value={field.value}
              />
            )}
          />
          {signup.isPending ? <AppSkeleton lines={2} /> : null}
          <AppButton
            label={signup.isPending ? pt.common.sending : pt.auth.signup.action}
            onPress={submit}
          />
          {signup.error instanceof TransportError ? (
            <AppButton label={pt.common.retry} onPress={submit} variant="secondary" />
          ) : null}
        </View>
      </AppCard>
      <View style={styles.links}>
        <AppNavLink href="/entrar" label={pt.auth.signup.login} />
      </View>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  links: { alignItems: 'center' },
});
