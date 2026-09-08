import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppNavLink } from '@/components/ui/AppNavLink';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppTextField } from '@/components/ui/AppTextField';
import { AuthShell } from '@/components/ui/AuthShell';
import { api, AppError, TransportError } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { spacing } from '@/theme/spacing';
import { useTheme } from '@/theme/ThemeProvider';

import { focusFirstInvalid } from './form-utils';
import { FormAlert } from './FormAlert';
import { fieldMessage, loginErrorMessage } from './messages';
import { loginSchema, type LoginValues } from './schemas';

export function LoginScreen() {
  const { colors } = useTheme();
  const {
    control,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<LoginValues>({
    defaultValues: { email: '', password: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
    resolver: zodResolver(loginSchema),
  });

  const login = useMutation({
    mutationFn: (values: LoginValues) => api.signInWithPassword(values.email, values.password),
    onSuccess: () => router.replace('/perfil'),
  });

  const submit = handleSubmit(
    (values) => login.mutate(values),
    (invalid) => focusFirstInvalid(invalid, setFocus),
  );
  const credentialsRejected =
    login.error instanceof AppError && login.error.code === 'UNAUTHENTICATED';

  return (
    <AuthShell
      description={pt.auth.login.description}
      eyebrow={pt.auth.login.eyebrow}
      title={pt.auth.login.title}
    >
      <AppCard>
        {login.error === null ? null : (
          <View style={styles.loginError}>
            <FormAlert message={loginErrorMessage(login.error)} />
            {credentialsRejected ? (
              <Text style={[styles.credentialsSupport, { color: colors.textMuted }]}>
                {pt.auth.login.credentialsSupport}
              </Text>
            ) : null}
          </View>
        )}
        <View style={styles.form}>
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
                testID="login-email"
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
                autoComplete="current-password"
                error={fieldMessage(errors.password?.message)}
                label={pt.auth.fields.password}
                onBlur={field.onBlur}
                onChangeText={field.onChange}
                passwordToggleLabel={{
                  hide: pt.auth.fields.hidePassword,
                  show: pt.auth.fields.showPassword,
                }}
                ref={field.ref}
                secureTextEntry
                testID="login-password"
                value={field.value}
              />
            )}
          />
          {login.isPending ? <AppSkeleton lines={2} /> : null}
          <AppButton
            label={login.isPending ? pt.common.sending : pt.auth.login.action}
            onPress={submit}
          />
          {login.error instanceof TransportError ? (
            <AppButton label={pt.common.retry} onPress={submit} variant="secondary" />
          ) : null}
        </View>
      </AppCard>
      <View style={styles.links}>
        <AppNavLink href="/esqueci-senha" label={pt.auth.login.forgot} />
        <AppNavLink href="/criar-conta" label={pt.auth.login.signup} />
      </View>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  credentialsSupport: { fontSize: 14, lineHeight: 20 },
  form: { gap: spacing.md },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'center' },
  loginError: { gap: spacing.xs },
});
