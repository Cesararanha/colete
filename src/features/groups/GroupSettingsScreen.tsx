import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppTextField } from '@/components/ui/AppTextField';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { api, AppError, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';

import { groupErrorMessage } from './group-errors';
import { groupNameSchema } from './group-name-schema';
import { focusGroupControl, GroupConfirmation } from './GroupConfirmation';
import { useGroupAdministration } from './useGroupAdministration';

export function GroupSettingsScreen({
  groupId,
  profile,
}: {
  groupId: string;
  profile: OwnProfile;
}) {
  const { colors } = useTheme();
  const administration = useGroupAdministration(groupId, profile);
  const { listing, run, error } = administration;
  const data = listing.isSuccess ? listing.data : undefined;
  const group = data?.group;
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [message, setMessage] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    setFocus,
    setError,
    reset,
    formState: { errors },
  } = useForm<{ name: string }>({
    defaultValues: { name: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });
  const confirmedName = group?.name;
  useEffect(() => {
    if (confirmedName !== undefined) reset({ name: confirmedName });
  }, [confirmedName, reset]);
  const cancel = () => {
    const id = target?.id;
    setTarget(null);
    setStep(1);
    administration.discardIntent();
    if (id) focusGroupControl(`transfer-${id}`);
  };
  return (
    <AuthenticatedShell {...pt.groups.settings}>
      {administration.pending ? <AppStatus message={pt.common.loading} /> : null}
      {message ? <AppStatus message={message} /> : null}
      {error ? (
        <AppAlert message={groupErrorMessage(error, true)} testID="administration-error" />
      ) : null}
      {listing.isPending ? <AsyncNotice kind="loading" message={pt.common.loading} /> : null}
      {listing.isError ? <AppAlert message={groupErrorMessage(listing.error, true)} /> : null}
      {data && !group ? <AppAlert message={pt.groups.errors.notOrganizer} /> : null}
      <AppButton
        label={pt.groups.members.refresh}
        testID="settings-refresh"
        onPress={() => void administration.refresh()}
      />
      {group ? (
        <AppCard testID="group-settings-card">
          <Text style={[styles.body, { color: colors.text }]} testID="confirmed-group-name">
            {group.name}
          </Text>
          <Text testID="settings-role" style={[styles.body, { color: colors.text }]}>
            {group.role === 'owner' ? pt.groups.list.owner : pt.groups.list.organizer}
          </Text>
          <Text role="heading" aria-level={2} style={[styles.heading, { color: colors.text }]}>
            {pt.groups.create.name}
          </Text>
          <Controller
            control={control}
            name="name"
            rules={{
              validate: (value) => {
                return groupNameSchema.safeParse(value).success || pt.groups.create.invalid;
              },
            }}
            render={({ field }) => (
              <AppTextField
                ref={field.ref}
                label={pt.groups.create.name}
                hint={pt.groups.create.hint}
                error={errors.name?.message}
                value={field.value}
                onBlur={field.onBlur}
                onChangeText={(value) => {
                  field.onChange(value);
                  administration.discardIntent();
                }}
                testID="rename-group-name"
              />
            )}
          />
          <AppButton
            label={pt.groups.settings.rename}
            testID="rename-group-submit"
            onPress={handleSubmit(
              async ({ name }) => {
                setMessage(null);
                const success = await run(
                  `rename:${name}`,
                  () => api.renameGroup(groupId, name),
                  (caught) => {
                    if (caught instanceof AppError && caught.code === 'VALIDATION') {
                      setError('name', { message: pt.groups.create.invalid });
                      setFocus('name');
                    }
                  },
                );
                if (success) setMessage(pt.groups.settings.renamed);
              },
              () => setFocus('name'),
            )}
          />
          {group.role === 'owner' ? (
            <>
              <Text role="heading" aria-level={2} style={[styles.heading, { color: colors.text }]}>
                {pt.groups.settings.transfer}
              </Text>
              <Text style={[styles.body, { color: colors.text }]}>{pt.groups.settings.choose}</Text>
              {!data.members.some(
                (member) => member.status === 'active' && member.role !== 'owner',
              ) ? (
                <Text style={[styles.body, { color: colors.text }]}>
                  {pt.groups.settings.empty}
                </Text>
              ) : null}
              {data.members
                .filter((member) => member.status === 'active' && member.role !== 'owner')
                .map((member) => (
                  <View key={member.profile_id}>
                    <AppButton
                      label={pt.groups.settings.select(member.display_name)}
                      testID={`transfer-${member.profile_id}`}
                      onPress={() => {
                        setTarget({ id: member.profile_id, name: member.display_name });
                        setStep(1);
                        administration.discardIntent();
                      }}
                      variant="secondary"
                    />
                    {target?.id === member.profile_id ? (
                      <GroupConfirmation
                        key={step}
                        title={
                          step === 1
                            ? pt.groups.settings.first(target.name)
                            : pt.groups.settings.second(target.name)
                        }
                        testID={`transfer-confirmation-${step}`}
                      >
                        <Text style={[styles.body, { color: colors.text }]}>
                          {pt.groups.settings.warning(group.membershipRole)}
                        </Text>
                        <AppButton
                          label={step === 1 ? pt.groups.settings.next : pt.groups.settings.confirm}
                          onPress={() => {
                            if (step === 1) setStep(2);
                            else
                              void run(`transfer:${target.id}`, () =>
                                api.transferOwnership(groupId, target.id),
                              ).then((success) => {
                                if (success) {
                                  setTarget(null);
                                  setStep(1);
                                  setMessage(pt.groups.settings.transferred(target.name));
                                  focusGroupControl('settings-refresh');
                                }
                              });
                          }}
                          variant={step === 1 ? 'primary' : 'destructive'}
                        />
                        <AppButton
                          label={pt.groups.members.cancel}
                          onPress={cancel}
                          variant="secondary"
                        />
                      </GroupConfirmation>
                    ) : null}
                  </View>
                ))}
            </>
          ) : null}
        </AppCard>
      ) : null}
    </AuthenticatedShell>
  );
}
const styles = StyleSheet.create({
  body: { fontSize: 16, lineHeight: 24 },
  heading: { fontSize: 22, lineHeight: 30, fontWeight: '700' },
});
