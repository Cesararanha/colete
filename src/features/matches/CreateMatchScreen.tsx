import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppCheckbox } from '@/components/ui/AppCheckbox';
import { AppIcon } from '@/components/ui/AppIcon';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppTextField } from '@/components/ui/AppTextField';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import {
  AppError,
  TransportError,
  api,
  type GroupSummary,
  type MatchOutcome,
  type MutationIntent,
  type OwnProfile,
} from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT, withCurrentAccessToken } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { groupErrorMessage } from '../groups/group-errors';
import { coordinatesText } from './match-format';
import { matchConfigFromForm, type MatchFormErrors, type MatchFormValues } from './match-form';
import { useDeviceLocation } from './use-device-location';

const EMPTY: MatchFormValues = {
  date: '',
  startTime: '',
  endTime: '',
  locationName: '',
  locationAddress: '',
  slots: '',
  price: '',
};

function matchErrorMessage(error: unknown): string {
  if (error instanceof AppError && error.code === 'TIME_ORDER') {
    return pt.matches.create.errors.timeOrder;
  }
  if (error instanceof AppError && error.code === 'PRICE_INVALID') {
    return pt.matches.create.errors.priceInvalid;
  }
  return groupErrorMessage(error, true);
}

/** A real radio group: one choice, the chosen one marked by an icon too, not colour alone. */
function GroupChoice({
  error,
  groups,
  onChange,
  value,
}: {
  error: string | undefined;
  groups: GroupSummary[];
  onChange: (groupId: string) => void;
  value: string | undefined;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.choice}>
      <Text nativeID="match-group-label" style={[styles.label, { color: colors.text }]}>
        {pt.matches.create.group}
      </Text>
      <Text style={[styles.hint, { color: colors.textMuted }]}>{pt.matches.create.groupHint}</Text>
      <View aria-labelledby="match-group-label" role="radiogroup" style={styles.options}>
        {groups.map((group) => {
          const checked = group.id === value;
          return (
            <Pressable
              accessibilityLabel={group.name}
              aria-checked={checked}
              key={group.id}
              onPress={() => onChange(group.id)}
              role="radio"
              style={[
                styles.option,
                {
                  backgroundColor: checked ? colors.surfaceRaised : colors.surface,
                  borderColor: checked ? colors.indicator : colors.fieldBorder,
                },
              ]}
              testID={`match-group-${group.id}`}
            >
              <AppIcon color={colors.text} name={checked ? 'check-circle' : 'circle'} size={20} />
              <Text style={[styles.optionText, { color: colors.text }]}>{group.name}</Text>
            </Pressable>
          );
        })}
      </View>
      {error ? <AppAlert message={error} testID="match-group-error" /> : null}
    </View>
  );
}

export function CreateMatchScreen({
  initialGroupId,
  profile,
}: {
  initialGroupId?: string | undefined;
  profile: OwnProfile;
}) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const intent = useRef<MutationIntent<MatchOutcome> | null>(null);
  const [values, setValues] = useState<MatchFormValues>(EMPTY);
  const [errors, setErrors] = useState<MatchFormErrors>({});
  const [chosenGroup, setChosenGroup] = useState<string | undefined>(initialGroupId);
  const [groupError, setGroupError] = useState<string | undefined>();
  const [keepLocation, setKeepLocation] = useState(false);
  const { location, request, clear } = useDeviceLocation();

  const eligible = useQuery({
    queryKey: [PRIVATE_QUERY_ROOT, 'groups', 'organizing', profile.id],
    queryFn: () =>
      withCurrentAccessToken(async (token) =>
        (await api.getOwnGroups(profile.id, token)).filter(
          (group) => group.role === 'owner' || group.role === 'organizer',
        ),
      ),
  });
  const groups = eligible.data ?? [];
  const groupId =
    chosenGroup !== undefined && groups.some((group) => group.id === chosenGroup)
      ? chosenGroup
      : groups.length === 1
        ? groups[0]?.id
        : undefined;

  const creation = useMutation({
    mutationFn: async (input: Parameters<typeof api.createMatch>) => {
      intent.current ??= api.createMatch(...input);
      return intent.current.execute();
    },
    onSuccess: async (result) => {
      intent.current = null;
      await queryClient.invalidateQueries({ queryKey: [PRIVATE_QUERY_ROOT, 'matches'] });
      // Close the modal first, then open the match in the existing tabs: a
      // replace would stack a second tabs navigator on the root stack.
      if (router.canDismiss()) router.dismiss();
      router.navigate(`/rachas/${result.outcome.match_id}`);
    },
    onError: (error) => {
      if (!(error instanceof TransportError || (error instanceof AppError && error.retryable))) {
        intent.current = null;
      }
    },
  });

  // Any edit is a new intent: the next submission gets a new request_id.
  const update = (field: keyof MatchFormValues) => (value: string) => {
    intent.current = null;
    setValues((current) => ({ ...current, [field]: value }));
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const found = location.status === 'found' ? location : undefined;
  const submit = () => {
    const place =
      found && keepLocation ? { latitude: found.latitude, longitude: found.longitude } : null;
    const result = matchConfigFromForm(values, place);
    setGroupError(groupId === undefined ? pt.matches.create.errors.group : undefined);
    if ('errors' in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    if (groupId === undefined) return;
    creation.mutate([groupId, result.config]);
  };

  const close = () => (router.canDismiss() ? router.dismiss() : router.replace('/rachas'));
  const field = (
    name: keyof MatchFormValues,
    label: string,
    options: {
      hint?: string;
      keyboardType?: 'default' | 'number-pad' | 'decimal-pad' | 'numbers-and-punctuation';
      placeholder?: string;
    } = {},
  ) => (
    <AppTextField
      error={errors[name]}
      hint={options.hint}
      keyboardType={options.keyboardType ?? 'default'}
      label={label}
      onChangeText={update(name)}
      placeholder={options.placeholder}
      testID={`match-${name}`}
      value={values[name]}
    />
  );

  return (
    <AuthenticatedShell
      closeModal={{ label: pt.matches.create.close, onPress: close, testID: 'match-create-close' }}
      {...pt.matches.create}
    >
      {eligible.isPending ? <AsyncNotice kind="loading" message={pt.common.loading} /> : null}
      {eligible.isError ? (
        <AsyncNotice
          kind="network"
          title={pt.common.networkTitle}
          message={pt.common.networkBody}
          actionLabel={pt.common.retry}
          action={() => void eligible.refetch()}
        />
      ) : null}
      {eligible.isSuccess && groups.length === 0 ? (
        <AsyncNotice
          action={() => router.replace('/grupos')}
          actionLabel={pt.matches.create.groups}
          kind="empty"
          message={pt.matches.create.noGroups}
          title={pt.matches.create.noGroupsTitle}
        />
      ) : null}
      {groups.length > 0 ? (
        <AppCard testID="create-match-card">
          {creation.error ? (
            <AppAlert message={matchErrorMessage(creation.error)} testID="match-create-error" />
          ) : null}
          <GroupChoice
            error={groupError}
            groups={groups}
            onChange={(id) => {
              intent.current = null;
              setChosenGroup(id);
              setGroupError(undefined);
            }}
            value={groupId}
          />
          {field('date', pt.matches.create.date, {
            hint: pt.matches.create.dateHint,
            keyboardType: 'numbers-and-punctuation',
            placeholder: 'DD/MM/AAAA',
          })}
          <View style={styles.pair}>
            <View style={styles.pairItem}>
              {field('startTime', pt.matches.create.start, {
                hint: pt.matches.create.timeHint,
                keyboardType: 'numbers-and-punctuation',
                placeholder: 'HH:MM',
              })}
            </View>
            <View style={styles.pairItem}>
              {field('endTime', pt.matches.create.end, {
                keyboardType: 'numbers-and-punctuation',
                placeholder: 'HH:MM',
              })}
            </View>
          </View>
          {field('locationName', pt.matches.create.place, { hint: pt.matches.create.placeHint })}
          {field('locationAddress', pt.matches.create.address)}
          <View style={styles.location}>
            <AppButton
              icon="crosshair"
              label={
                location.status === 'requesting'
                  ? pt.matches.create.locating
                  : pt.matches.create.locate
              }
              onPress={() => {
                intent.current = null;
                setKeepLocation(false);
                void request();
              }}
              testID="match-locate"
              variant="secondary"
            />
            {location.status === 'denied' ? (
              <AppAlert message={pt.matches.create.locationDenied} testID="match-location-denied" />
            ) : null}
            {location.status === 'unavailable' ? (
              <AppAlert
                message={pt.matches.create.locationUnavailable}
                testID="match-location-unavailable"
              />
            ) : null}
            {found ? (
              <View
                style={[styles.found, { borderColor: colors.fieldBorder }]}
                testID="match-location-found"
              >
                <AppStatus
                  message={pt.matches.create.located(
                    coordinatesText(found.latitude, found.longitude),
                  )}
                />
                <AppCheckbox
                  checked={keepLocation}
                  label={pt.matches.create.confirmLocation}
                  onChange={(checked) => {
                    intent.current = null;
                    setKeepLocation(checked);
                  }}
                  testID="match-location-confirm"
                />
                <AppButton
                  label={pt.matches.create.discardLocation}
                  onPress={() => {
                    intent.current = null;
                    setKeepLocation(false);
                    clear();
                  }}
                  testID="match-location-discard"
                  variant="tertiary"
                />
              </View>
            ) : null}
          </View>
          <View style={styles.pair}>
            <View style={styles.pairItem}>
              {field('slots', pt.matches.create.slots, { keyboardType: 'number-pad' })}
            </View>
            <View style={styles.pairItem}>
              {field('price', pt.matches.create.price, {
                hint: pt.matches.create.priceHint,
                keyboardType: 'decimal-pad',
              })}
            </View>
          </View>
          {creation.isPending ? <AppSkeleton lines={2} /> : null}
          <AppButton
            label={pt.matches.create.submit}
            onPress={submit}
            testID="match-create-submit"
          />
        </AppCard>
      ) : null}
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  choice: { gap: spacing.sm },
  found: { borderRadius: radius.row, borderWidth: 1, gap: spacing.sm, padding: spacing.md },
  hint: { ...typography.support },
  label: { ...typography.supportStrong },
  location: { gap: spacing.sm },
  option: {
    alignItems: 'center',
    borderRadius: radius.row,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: size.target,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  optionText: { ...typography.body, flex: 1, minWidth: 0 },
  options: { gap: spacing.sm },
  pair: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  pairItem: { flexBasis: 160, flexGrow: 1, minWidth: 0 },
});
