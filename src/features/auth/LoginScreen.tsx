import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
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

import { focusFirstInvalid } from './form-utils';
import { FormAlert } from './FormAlert';
import { authErrorMessage, fieldMessage } from './messages';
import { ProfileCompletionForm } from './ProfileCompletionForm';
import { loginSchema, type LoginValues } from './schemas';

export function LoginScreen() {
  const [completionName, setCompletionName] = useState<string | null>(null);
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
    mutationFn: async (values: LoginValues) => {
      const signedIn = await api.signInWithPassword(values.email, values.password);
      const profile = await api.getOwnProfile();
      return { profile, user: signedIn.user };
    },
    onSuccess: ({ profile, user }) => {
      if (profile !== null) {
        router.replace('/perfil');
        return;
      }
      const metadataName = user.user_metadata['name'];
      setCompletionName(typeof metadataName === 'string' ? metadataName : '');
    },
  });

  const submit = handleSubmit(
    (values) => login.mutate(values),
    (invalid) => focusFirstInvalid(invalid, setFocus),
  );

  if (completionName !== null) {
    return (
      <AuthShell
        description={pt.auth.profile.description}
        eyebrow={pt.auth.profile.eyebrow}
        title={pt.auth.profile.title}
      >
        <AppCard>
          <ProfileCompletionForm
            defaultName={completionName}
            onCompleted={() => router.replace('/perfil')}
          />
        </AppCard>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      description={pt.auth.login.description}
      eyebrow={pt.auth.login.eyebrow}
      title={pt.auth.login.title}
    >
      <AppCard>
        {login.error === null ? null : <FormAlert message={authErrorMessage(login.error)} />}
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
  form: { gap: spacing.md },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'center' },
});
