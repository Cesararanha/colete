import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppTextField } from '@/components/ui/AppTextField';
import { api } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { spacing } from '@/theme/spacing';

import { focusFirstInvalid } from '../auth/form-utils';
import { fieldMessage } from '../auth/messages';
import { newPasswordSchema, type NewPasswordValues } from '../auth/schemas';
import { profileErrorMessage } from './profile-errors';

export function ProfilePasswordForm() {
  const {
    control,
    formState: { errors },
    handleSubmit,
    reset,
    setFocus,
  } = useForm<NewPasswordValues>({
    defaultValues: { confirmPassword: '', password: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
    resolver: zodResolver(newPasswordSchema),
  });
  const password = useMutation({
    mutationFn: ({ password: nextPassword }: NewPasswordValues) => api.updatePassword(nextPassword),
    onSuccess: () => reset(),
  });
  const submit = handleSubmit(
    (values) => password.mutate(values),
    (invalid) => focusFirstInvalid(invalid, setFocus),
  );

  return (
    <View style={styles.form}>
      {password.error === null ? null : <AppAlert message={profileErrorMessage(password.error)} />}
      {password.isSuccess ? <AppStatus message={pt.profile.password.saved} /> : null}
      <Controller
        control={control}
        name="password"
        render={({ field }) => (
          <AppTextField
            autoCapitalize="none"
            autoComplete="new-password"
            error={fieldMessage(errors.password?.message)}
            label={pt.profile.password.newPassword}
            onBlur={field.onBlur}
            onChangeText={(value) => {
              password.reset();
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
        control={control}
        name="confirmPassword"
        render={({ field }) => (
          <AppTextField
            autoCapitalize="none"
            autoComplete="new-password"
            error={fieldMessage(errors.confirmPassword?.message)}
            label={pt.profile.password.confirmPassword}
            onBlur={field.onBlur}
            onChangeText={(value) => {
              password.reset();
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
      {password.isPending ? <AppSkeleton lines={2} /> : null}
      <AppButton
        label={password.isPending ? pt.common.sending : pt.profile.password.action}
        onPress={() => {
          if (!password.isPending) void submit();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({ form: { gap: spacing.md, minWidth: 0, width: '100%' } });
