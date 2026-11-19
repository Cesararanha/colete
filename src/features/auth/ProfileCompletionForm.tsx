import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { StyleSheet, type TextInputInstance, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppError, api, TransportError, type MutationIntent, type ProfilePatch } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { privateQueryKeys } from '@/lib/private-queries';
import { profilePatchSchema } from '@/lib/profile-schema';
import { spacing } from '@/theme/spacing';

import { ProfileFields } from '../profile/ProfileFields';
import { focusFirstInvalid } from './form-utils';
import { FormAlert } from './FormAlert';
import { authErrorMessage } from './messages';
import { completionInput } from './profile-completion';

// The edit rules, plus the one thing the first access adds: a name.
const completionSchema = profilePatchSchema.superRefine((values, context) => {
  if (values.name === undefined) {
    context.addIssue({ code: 'custom', message: 'name_length', path: ['name'] });
  }
});

export function ProfileCompletionForm({
  defaultName = '',
  onCompleted,
}: {
  defaultName?: string;
  onCompleted: () => void;
}) {
  const queryClient = useQueryClient();
  const intent = useRef<MutationIntent<unknown> | null>(null);
  const [lastValues, setLastValues] = useState<ProfilePatch | null>(null);
  const {
    control,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<ProfilePatch>({
    defaultValues: {
      dominant_foot: null,
      name: defaultName,
      nickname: null,
      position: null,
      shirt_number: null,
    },
    mode: 'onBlur',
    reValidateMode: 'onChange',
    resolver: zodResolver(completionSchema),
    // focusFirstInvalid moves the focus; React Hook Form's own later refocus
    // would take it back from a radio the person already moved to.
    shouldFocusError: false,
  });

  const completion = useMutation({
    mutationFn: async (values: ProfilePatch) => {
      setLastValues(values);
      intent.current ??= api.completeProfile(completionInput(values));
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
  // react-hook-form keeps its own refs for setFocus; nothing else to track.
  const registerInput =
    (_name: string, formRef: (instance: TextInputInstance | null) => void) =>
    (instance: TextInputInstance | null) =>
      formRef(instance);

  return (
    <View style={styles.form}>
      {completion.error === null ? null : (
        <FormAlert message={authErrorMessage(completion.error)} testID="profile-completion-error" />
      )}
      <ProfileFields
        control={control}
        errors={errors}
        onChanged={() => {
          intent.current = null;
        }}
        registerInput={registerInput}
        testIDPrefix="complete-profile"
      />
      {completion.isPending ? <AppSkeleton lines={2} /> : null}
      <AppButton
        label={completion.isPending ? pt.common.sending : pt.auth.profile.action}
        onPress={submit}
        testID="complete-profile-submit"
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
