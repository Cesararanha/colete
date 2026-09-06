import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Controller, type FieldErrors, useForm } from 'react-hook-form';
import { StyleSheet, TextInput, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppTextField } from '@/components/ui/AppTextField';
import {
  AppError,
  api,
  TransportError,
  type MutationIntent,
  type OwnProfile,
  type ProfilePatch,
} from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { profilePatchSchema } from '@/lib/profile-schema';
import { spacing } from '@/theme/spacing';

import { fieldMessage } from '../auth/messages';
import { ProfileChoiceField } from './ProfileChoiceField';
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

export function ProfileDataForm({ profile }: { profile: OwnProfile }) {
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
      queryClient.setQueryData(['own-profile'], result.current);
      reset(formValues(result.current));
      await queryClient.invalidateQueries({ queryKey: ['own-profile'] });
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
      {update.isSuccess ? <AppStatus message={pt.profile.data.saved} /> : null}
      <Controller
        control={control}
        name="name"
        render={({ field }) => (
          <AppTextField
            autoCapitalize="words"
            autoComplete="name"
            error={fieldMessage(errors.name?.message)}
            label={pt.profile.fields.name}
            onBlur={field.onBlur}
            onChangeText={(value) => {
              changed();
              field.onChange(value);
            }}
            ref={registerInput('name', field.ref)}
            testID="profile-name"
            value={typeof field.value === 'string' ? field.value : ''}
          />
        )}
      />
      <Controller
        control={control}
        name="nickname"
        render={({ field }) => (
          <View style={styles.optionalField}>
            <AppTextField
              autoCapitalize="words"
              error={fieldMessage(errors.nickname?.message)}
              label={pt.profile.fields.nickname}
              onBlur={field.onBlur}
              onChangeText={(value) => {
                changed();
                field.onChange(value);
              }}
              ref={registerInput('nickname', field.ref)}
              testID="profile-nickname"
              value={typeof field.value === 'string' ? field.value : ''}
            />
            <AppButton
              label={pt.profile.clear.nickname}
              onPress={() => {
                changed();
                field.onChange(null);
              }}
              variant="secondary"
            />
          </View>
        )}
      />
      <Controller
        control={control}
        name="position"
        render={({ field }) => (
          <ProfileChoiceField
            clearLabel={pt.profile.clear.position}
            hint={pt.profile.fields.positionHint}
            label={pt.profile.fields.position}
            onChange={(value) => {
              changed();
              field.onChange(value);
            }}
            options={pt.profile.positionOptions}
            value={field.value}
          />
        )}
      />
      <Controller
        control={control}
        name="dominant_foot"
        render={({ field }) => (
          <ProfileChoiceField
            clearLabel={pt.profile.clear.dominantFoot}
            label={pt.profile.fields.dominantFoot}
            onChange={(value) => {
              changed();
              field.onChange(value);
            }}
            options={pt.profile.footOptions}
            value={field.value}
          />
        )}
      />
      <Controller
        control={control}
        name="shirt_number"
        render={({ field }) => (
          <View style={styles.optionalField}>
            <AppTextField
              error={fieldMessage(errors.shirt_number?.message)}
              inputMode="numeric"
              keyboardType="number-pad"
              label={pt.profile.fields.shirtNumber}
              onBlur={field.onBlur}
              onChangeText={(value) => {
                changed();
                field.onChange(/^\d+$/u.test(value) ? Number(value) : value);
              }}
              ref={registerInput('shirt_number', field.ref)}
              testID="profile-shirt-number"
              value={typeof field.value === 'number' ? String(field.value) : ''}
            />
            <AppButton
              label={pt.profile.clear.shirtNumber}
              onPress={() => {
                changed();
                field.onChange(null);
              }}
              variant="secondary"
            />
          </View>
        )}
      />
      {update.isPending ? <AppSkeleton lines={2} /> : null}
      <AppButton
        label={update.isPending ? pt.common.sending : pt.profile.data.save}
        onPress={submit}
        testID="save-profile"
      />
      {canRetry && intent !== null ? (
        <AppButton
          label={pt.common.retry}
          onPress={() => update.mutate(intent)}
          variant="secondary"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  optionalField: { gap: spacing.sm },
});
