import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppTextField } from '@/components/ui/AppTextField';
import { AppError, api, TransportError, type MutationIntent } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { privateQueryKeys } from '@/lib/private-queries';
import { spacing } from '@/theme/spacing';

import { focusFirstInvalid } from './form-utils';
import { FormAlert } from './FormAlert';
import { authErrorMessage, fieldMessage } from './messages';
import { profileSchema, type ProfileValues } from './schemas';

export function ProfileCompletionForm({
  defaultName = '',
  onCompleted,
}: {
  defaultName?: string;
  onCompleted: () => void;
}) {
  const queryClient = useQueryClient();
  const intent = useRef<MutationIntent<unknown> | null>(null);
  const [lastValues, setLastValues] = useState<ProfileValues | null>(null);
  const {
    control,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<ProfileValues>({
    defaultValues: { name: defaultName },
    mode: 'onBlur',
    reValidateMode: 'onChange',
    resolver: zodResolver(profileSchema),
  });

  const completion = useMutation({
    mutationFn: async (values: ProfileValues) => {
      setLastValues(values);
      intent.current ??= api.completeProfile({ name: values.name });
      return intent.current.execute();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: privateQueryKeys.ownProfile });
      onCompleted();
    },
  });

  const submit = handleSubmit(
    (values) => completion.mutate(values),
    (invalid) => focusFirstInvalid(invalid, setFocus),
  );
  const canRetry =
    completion.error instanceof TransportError ||
    (completion.error instanceof AppError && completion.error.retryable);

  return (
    <View style={styles.form}>
      {completion.error === null ? null : (
        <FormAlert message={authErrorMessage(completion.error)} testID="profile-completion-error" />
      )}
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
            onChangeText={(value) => {
              intent.current = null;
              field.onChange(value);
            }}
            ref={field.ref}
            returnKeyType="done"
            testID="complete-profile-name"
            value={field.value}
          />
        )}
      />
      {completion.isPending ? <AppSkeleton lines={2} /> : null}
      <AppButton
        label={completion.isPending ? pt.common.sending : pt.auth.profile.action}
        onPress={submit}
      />
      {canRetry && lastValues !== null ? (
        <AppButton
          label={pt.common.retry}
          onPress={() => completion.mutate(lastValues)}
          variant="secondary"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({ form: { gap: spacing.md } });
