import { Controller, type Control, type FieldErrors } from 'react-hook-form';
import type { TextInputInstance } from 'react-native';

import { AppTextField } from '@/components/ui/AppTextField';
import type { ProfilePatch } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';

import { fieldMessage } from '../auth/messages';
import { ProfileChoiceField } from './ProfileChoiceField';

export type ProfileTextField = 'name' | 'nickname' | 'shirt_number';

/**
 * The five profile fields, shared by the first access (complete_profile) and
 * the profile edit (update_profile): same components, same schema
 * (profile-schema.ts), same null for an emptied optional field. Name is
 * required; nickname, position, foot and shirt number are optional.
 */
export function ProfileFields({
  control,
  errors,
  onChanged,
  registerInput,
  testIDPrefix,
}: {
  control: Control<ProfilePatch>;
  errors: FieldErrors<ProfilePatch>;
  onChanged: () => void;
  registerInput: (
    name: ProfileTextField,
    formRef: (instance: TextInputInstance | null) => void,
  ) => (instance: TextInputInstance | null) => void;
  testIDPrefix: 'profile' | 'complete-profile';
}) {
  return (
    <>
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
              onChanged();
              field.onChange(value);
            }}
            ref={registerInput('name', field.ref)}
            testID={`${testIDPrefix}-name`}
            value={typeof field.value === 'string' ? field.value : ''}
          />
        )}
      />
      <Controller
        control={control}
        name="nickname"
        render={({ field }) => (
          <AppTextField
            autoCapitalize="words"
            error={fieldMessage(errors.nickname?.message)}
            label={pt.profile.fields.nickname}
            onBlur={field.onBlur}
            onChangeText={(value) => {
              onChanged();
              field.onChange(value === '' ? null : value);
            }}
            ref={registerInput('nickname', field.ref)}
            testID={`${testIDPrefix}-nickname`}
            value={typeof field.value === 'string' ? field.value : ''}
          />
        )}
      />
      <Controller
        control={control}
        name="position"
        render={({ field }) => (
          <ProfileChoiceField
            label={pt.profile.fields.position}
            noneLabel={pt.profile.notInformed}
            onChange={(value) => {
              onChanged();
              field.onChange(value);
            }}
            options={pt.profile.positionOptions}
            testID={`${testIDPrefix}-position`}
            value={field.value}
          />
        )}
      />
      <Controller
        control={control}
        name="dominant_foot"
        render={({ field }) => (
          <ProfileChoiceField
            label={pt.profile.fields.dominantFoot}
            noneLabel={pt.profile.notInformed}
            onChange={(value) => {
              onChanged();
              field.onChange(value);
            }}
            options={pt.profile.footOptions}
            testID={`${testIDPrefix}-dominant-foot`}
            value={field.value}
          />
        )}
      />
      <Controller
        control={control}
        name="shirt_number"
        render={({ field }) => (
          <AppTextField
            error={fieldMessage(errors.shirt_number?.message)}
            inputMode="numeric"
            keyboardType="number-pad"
            label={pt.profile.fields.shirtNumber}
            onBlur={field.onBlur}
            onChangeText={(value) => {
              onChanged();
              field.onChange(value === '' ? null : /^\d+$/u.test(value) ? Number(value) : value);
            }}
            ref={registerInput('shirt_number', field.ref)}
            testID={`${testIDPrefix}-shirt-number`}
            value={
              typeof field.value === 'number'
                ? String(field.value)
                : typeof field.value === 'string'
                  ? field.value
                  : ''
            }
          />
        )}
      />
    </>
  );
}
