import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useRef } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, View } from 'react-native';
import { z } from '../../lib/zod';

import { AppAlert } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppTextField } from '@/components/ui/AppTextField';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AppError, TransportError, api, type GroupOutcome, type MutationIntent } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';
import { spacing } from '@/theme/spacing';

import { groupErrorMessage } from './group-errors';
import { groupCreationSchema as schema } from './group-name-schema';

type Values = z.infer<typeof schema>;

export function CreateGroupScreen() {
  const queryClient = useQueryClient();
  const intent = useRef<MutationIntent<GroupOutcome> | null>(null);
  const {
    control,
    handleSubmit,
    setFocus,
    setError,
    formState: { errors },
  } = useForm<Values>({
    defaultValues: { name: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
    resolver: zodResolver(schema),
  });
  const creation = useMutation({
    mutationFn: async (values: Values) => {
      intent.current ??= api.createGroup(values.name);
      return intent.current.execute();
    },
    onSuccess: async (result) => {
      intent.current = null;
      await queryClient.invalidateQueries({ queryKey: [PRIVATE_QUERY_ROOT, 'groups'] });
      router.replace(`/grupos/${result.outcome.group_id}/convites`);
    },
    onError: (error) => {
      if (error instanceof AppError && error.code === 'VALIDATION') {
        setError('name', { message: pt.groups.create.invalid });
        setFocus('name');
      }
      if (!(error instanceof TransportError || (error instanceof AppError && error.retryable))) {
        intent.current = null;
      }
    },
  });
  const submit = handleSubmit(
    (values) => creation.mutate(values),
    () => setFocus('name'),
  );
  return (
    <AuthenticatedShell {...pt.groups.create}>
      <AppCard testID="create-group-card">
        {creation.error &&
        !(creation.error instanceof AppError && creation.error.code === 'VALIDATION') ? (
          <AppAlert message={groupErrorMessage(creation.error)} />
        ) : null}
        <Controller
          control={control}
          name="name"
          render={({ field }) => (
            <AppTextField
              label={pt.groups.create.name}
              hint={pt.groups.create.hint}
              error={errors.name?.message}
              value={field.value}
              onBlur={field.onBlur}
              onChangeText={(value) => {
                intent.current = null;
                field.onChange(value);
              }}
              ref={field.ref}
              autoCapitalize="words"
              testID="group-name"
            />
          )}
        />
        {creation.isPending ? <AppSkeleton lines={2} /> : null}
        <View style={styles.actions}>
          <AppButton
            label={pt.groups.create.submit}
            onPress={submit}
            testID="create-group-submit"
          />
        </View>
      </AppCard>
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({ actions: { gap: spacing.sm } });
