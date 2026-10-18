import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { type FieldErrors, useForm } from 'react-hook-form';
import { StyleSheet, TextInput, View } from 'react-native';

import { AppAlert } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import {
  AppError,
  api,
  TransportError,
  type MutationIntent,
  type OwnProfile,
  type ProfilePatch,
} from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { privateQueryKeys } from '@/lib/private-queries';
import { profilePatchSchema } from '@/lib/profile-schema';
import { spacing } from '@/theme/spacing';

import { ProfileFields } from './ProfileFields';
import { profileErrorMessage } from './profile-errors';

const profileKeys = ['name', 'nickname', 'position', 'dominant_foot', 'shirt_number'] as const;

function formValues(profile: OwnProfile): ProfilePatch {
  return {
    dominant_foot: profile.dominant_foot,
    name: profile.name,
    nickname: profile.nickname,
    position: profile.position,
    shirt_number: profile.shirt_number,
  };
}

export function changedProfilePatch(
  values: ProfilePatch,
  dirty: Partial<Record<(typeof profileKeys)[number], boolean>>,
): ProfilePatch {
  const patch: ProfilePatch = {};
  for (const key of profileKeys) {
    if (dirty[key] === true) Object.assign(patch, { [key]: values[key] });
  }
  return profilePatchSchema.parse(patch);
}

/**
 * The edit mode of the profile card. Same schema, same dirty-field patch and
 * the same idempotent update command as before; only the way in (Edit) and
 * out (Save or Cancel) is new. An emptied optional field is sent as null, the
 * value the old "clear" buttons wrote.
 */
export function ProfileDataForm({
  onCancel,
  onSaved,
  profile,
}: {
  onCancel: () => void;
  onSaved: (current: OwnProfile) => void;
  profile: OwnProfile;
}) {
  const queryClient = useQueryClient();
  const inputRefs = useRef<Partial<Record<'name' | 'nickname' | 'shirt_number', TextInput>>>({});
  const [focusRequest, setFocusRequest] = useState<{
    sequence: number;
    target: 'name' | 'nickname' | 'shirt_number';
  } | null>(null);
  const [intent, setIntent] = useState<MutationIntent<{
    outcome: { logical_result: 'profile_updated' };
    current: OwnProfile;
  }> | null>(null);
  const {
    control,
    formState: { dirtyFields, errors },
    handleSubmit,
    reset,
  } = useForm<ProfilePatch>({
    defaultValues: formValues(profile),
    mode: 'onBlur',
    reValidateMode: 'onChange',
    resolver: zodResolver(profilePatchSchema),
  });

  const update = useMutation({
    mutationFn: async (
      command: MutationIntent<{
        outcome: { logical_result: 'profile_updated' };
        current: OwnProfile;
      }>,
    ) => command.execute(),
    onSuccess: async (result) => {
      setIntent(null);
      // update_profile answers the profile fields, not its id: keep the cached
      // id (the avatar's tone depends on it) until the refetch below lands.
      queryClient.setQueryData<OwnProfile | null>(privateQueryKeys.ownProfile, (previous) =>
        previous ? { ...previous, ...result.current } : result.current,
      );
      reset(formValues(result.current));
      onSaved(result.current);
      await queryClient.invalidateQueries({ queryKey: privateQueryKeys.ownProfile });
    },
  });

  const changed = () => {
    setIntent(null);
    update.reset();
  };
  const registerInput =
    (name: 'name' | 'nickname' | 'shirt_number', formRef: (instance: TextInput | null) => void) =>
    (instance: TextInput | null) => {
      formRef(instance);
      if (instance === null) delete inputRefs.current[name];
      else inputRefs.current[name] = instance;
    };
  const focusInvalidInput = (invalid: FieldErrors<ProfilePatch>) => {
    const first = profileKeys.find((key) => invalid[key] !== undefined);
    if (first === 'name' || first === 'nickname' || first === 'shirt_number') {
      setFocusRequest((current) => ({
        sequence: (current?.sequence ?? 0) + 1,
        target: first,
      }));
    }
  };
  useEffect(() => {
    if (focusRequest === null) return;
    inputRefs.current[focusRequest.target]?.focus();
  }, [focusRequest]);
  // Opening the edit mode moves focus to its first field.
  useEffect(() => {
    inputRefs.current.name?.focus();
  }, []);
  const submit = handleSubmit((values) => {
    const patch = changedProfilePatch(values, dirtyFields);
    const command = api.updateProfile(patch);
    setIntent(command);
    update.mutate(command);
  }, focusInvalidInput);
  const canRetry =
    update.error instanceof TransportError ||
    (update.error instanceof AppError && update.error.retryable);

  return (
    <View style={styles.form}>
      {update.error === null ? null : <AppAlert message={profileErrorMessage(update.error)} />}
      <ProfileFields
        control={control}
        errors={errors}
        onChanged={changed}
        registerInput={registerInput}
        testIDPrefix="profile"
      />
      {update.isPending ? <AppSkeleton lines={2} /> : null}
      <View style={styles.actions}>
        <AppButton
          label={update.isPending ? pt.common.sending : pt.profile.data.save}
          onPress={() => {
            if (!update.isPending) void submit();
          }}
          testID="save-profile"
        />
        <AppButton
          label={pt.profile.data.cancel}
          onPress={() => {
            if (update.isPending) return;
            reset(formValues(profile));
            update.reset();
            setIntent(null);
            onCancel();
          }}
          testID="cancel-profile-edit"
          variant="secondary"
        />
        {canRetry && intent !== null ? (
          <AppButton
            label={pt.common.retry}
            onPress={() => update.mutate(intent)}
            variant="secondary"
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, minWidth: 0, width: '100%' },
  form: { gap: spacing.md, minWidth: 0, width: '100%' },
});
