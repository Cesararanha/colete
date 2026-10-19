import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppIcon } from '@/components/ui/AppIcon';
import { AppTextField } from '@/components/ui/AppTextField';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { GroupIcon } from '@/components/ui/GroupIcon';
import { groupAppearance } from '@/components/ui/group-icon';
import {
  AppError,
  TransportError,
  api,
  type AddressResult,
  type AddressSearch,
  type GroupSummary,
  type MatchConfig,
  type MatchEditOutcome,
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
import { DESCRIPTION_MAX, descriptionLength } from './match-description';
import { matchErrorMessage } from './match-errors';
import {
  formValuesFromMatch,
  matchConfigFromForm,
  nextDayNotice,
  type ConfirmedPlace,
  type MatchFormErrors,
  type MatchFormValues,
} from './match-form';
import { maskDate, maskMoney, maskTime } from './match-masks';
import { serverErrorTarget } from './match-server-errors';

const EMPTY: MatchFormValues = {
  date: '',
  startTime: '',
  endTime: '',
  locationName: '',
  locationAddress: '',
  description: '',
  slots: '',
  price: '',
};

/** The order the person meets the fields: the first invalid one gets the focus. */
const FIELD_ORDER: readonly (keyof MatchFormValues)[] = [
  'date',
  'startTime',
  'endTime',
  'locationName',
  'locationAddress',
  'description',
  'slots',
  'price',
];

const MASKS: Partial<Record<keyof MatchFormValues, (value: string) => string>> = {
  date: maskDate,
  startTime: maskTime,
  endTime: maskTime,
  price: maskMoney,
};

/** Brings a control into view and gives it the focus: a field, or the notice at the top. */
function focusControl(input: TextInput | null | undefined, testId: string) {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    element?.scrollIntoView({ block: 'center' });
    element?.focus({ preventScroll: true });
    return;
  }
  input?.focus();
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

/**
 * The address search results: up to five places to choose from and, under
 * them, the LocationIQ credit (a link to its site) and the OpenStreetMap
 * attribution. The search itself goes through the Edge on the press of
 * "Buscar"; the app never calls the search service.
 */
function AddressResults({
  onChoose,
  search,
}: {
  onChoose: (result: AddressResult) => void;
  search: AddressSearch;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={[styles.results, { borderColor: colors.fieldBorder }]}
      testID="match-address-results"
    >
      {search.unavailable ? (
        <AppAlert
          message={pt.matches.create.searchUnavailable}
          testID="match-address-unavailable"
        />
      ) : search.results.length === 0 ? (
        <Text style={[styles.hint, { color: colors.textMuted }]} testID="match-address-empty">
          {pt.matches.create.searchEmpty}
        </Text>
      ) : (
        <>
          <Text
            nativeID="match-address-results-label"
            style={[styles.label, { color: colors.text }]}
          >
            {pt.matches.create.searchResults}
          </Text>
          <View aria-labelledby="match-address-results-label" role="list" style={styles.options}>
            {search.results.map((result, index) => (
              <View key={`${result.label}-${index}`} role="listitem">
                <Pressable
                  accessibilityLabel={pt.matches.create.choose(result.label)}
                  accessibilityRole="button"
                  onPress={() => onChoose(result)}
                  style={({ pressed }) => [
                    styles.option,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.fieldBorder,
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                  testID={`match-address-result-${index}`}
                >
                  <AppIcon color={colors.textMuted} name="map-pin" size={20} />
                  <Text style={[styles.optionText, { color: colors.text }]}>{result.label}</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </>
      )}
      <View style={styles.credits}>
        <Link
          accessibilityLabel={pt.matches.create.searchCreditLabel}
          accessibilityRole="link"
          href="https://locationiq.com"
          rel="noopener noreferrer"
          style={styles.credit}
          target="_blank"
          testID="match-search-credit"
        >
          <Text style={[styles.creditText, { color: colors.link }]}>
            {pt.matches.create.searchCredit}
          </Text>
        </Link>
        <Text style={[styles.attribution, { color: colors.textMuted }]} testID="match-attribution">
          {pt.matches.create.attribution}
        </Text>
      </View>
    </View>
  );
}

/**
 * Criar racha, and the same form for "Editar" (0028): opened with
 * `editMatchId`, it reads the match and its roster from the detail's cache,
 * fills every field once, keeps the group fixed and saves the whole form with
 * update_match. The start and end the match already has stay valid as they
 * are; the slots cannot go below the confirmed.
 */
export function CreateMatchScreen({
  editMatchId,
  initialGroupId,
  profile,
}: {
  editMatchId?: string | undefined;
  initialGroupId?: string | undefined;
  profile: OwnProfile;
}) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const editing = editMatchId !== undefined;
  const intent = useRef<MutationIntent<MatchOutcome> | null>(null);
  const editIntent = useRef<MutationIntent<MatchEditOutcome> | null>(null);
  const inputs = useRef<Partial<Record<keyof MatchFormValues, TextInput | null>>>({});
  const [values, setValues] = useState<MatchFormValues>(EMPTY);
  const [errors, setErrors] = useState<MatchFormErrors>({});
  const [formError, setFormError] = useState('');
  const [chosenGroup, setChosenGroup] = useState<string | undefined>();
  const [groupError, setGroupError] = useState<string | undefined>();
  const [place, setPlace] = useState<ConfirmedPlace>(null);
  const [search, setSearch] = useState<AddressSearch | undefined>();
  const [searchError, setSearchError] = useState('');

  // The detail's own reads, under the same keys: opening "Editar" from the
  // detail costs no new request, and saving refreshes both.
  const edited = useQuery({
    enabled: editing,
    queryKey: [PRIVATE_QUERY_ROOT, 'matches', profile.id, editMatchId],
    queryFn: ({ signal }) => api.getMatch(editMatchId ?? '', signal),
  });
  const editedRoster = useQuery({
    enabled: editing && edited.data != null,
    queryKey: [PRIVATE_QUERY_ROOT, 'matches', profile.id, editMatchId, 'roster'],
    queryFn: ({ signal }) => api.getMatchRoster(editMatchId ?? '', signal),
  });
  const match = edited.data ?? undefined;
  const prefilled = useRef(false);
  useEffect(() => {
    if (!editing || match === undefined || prefilled.current) return;
    prefilled.current = true;
    const filled = formValuesFromMatch(match);
    setValues(filled.values);
    setPlace(filled.place);
  }, [editing, match]);

  const eligible = useQuery({
    enabled: !editing,
    queryKey: [PRIVATE_QUERY_ROOT, 'groups', 'organizing', profile.id],
    queryFn: () =>
      withCurrentAccessToken(async (token) =>
        (await api.getOwnGroups(profile.id, token)).filter(
          (group) => group.role === 'owner' || group.role === 'organizer',
        ),
      ),
  });
  const groups = eligible.data ?? [];
  // Opened from a group, the match always belongs to that group: the form
  // shows only its name, never the selector. A group the person cannot
  // organise gets a refusal, not a choice of other groups. Without a group
  // (the Agenda), the selector stays.
  const fromGroup = initialGroupId !== undefined;
  const fixedGroup = fromGroup ? groups.find((group) => group.id === initialGroupId) : undefined;
  const groupId = fromGroup
    ? fixedGroup?.id
    : chosenGroup !== undefined && groups.some((group) => group.id === chosenGroup)
      ? chosenGroup
      : groups.length === 1
        ? groups[0]?.id
        : undefined;
  const fixedUnavailable = fromGroup && eligible.isSuccess && groups.length > 0 && !fixedGroup;
  // "Now" is read once per read of the match, as on the detail.
  const ended = useMemo(
    () => match !== undefined && new Date(match.ends_at).getTime() <= new Date().getTime(),
    [match],
  );
  // Why the edit cannot open, read from the same projections the server checks again.
  const editRefusal = !editing
    ? undefined
    : edited.isSuccess && match === undefined
      ? pt.matches.detail.missing
      : match?.canceled
        ? pt.matches.detail.errors.canceled
        : ended
          ? pt.matches.detail.errors.done
          : editedRoster.data && !editedRoster.data.viewer.can_manage
            ? pt.matches.detail.errors.notOrganizerManage
            : undefined;
  const editReady =
    editing && match !== undefined && editedRoster.data !== undefined && editRefusal === undefined;

  const searching = useMutation({
    mutationFn: (query: string) => api.searchAddress(query),
    onSuccess: (result) => setSearch(result),
    onError: (error) => {
      setSearch(undefined);
      setSearchError(
        error instanceof AppError && error.code === 'RATE_LIMITED'
          ? pt.matches.create.searchRateLimited
          : error instanceof AppError && error.code === 'VALIDATION'
            ? pt.matches.create.searchShort
            : groupErrorMessage(error, true),
      );
    },
  });

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
      // The refusal lands on the field it is about, or in the notice at the
      // top; either way the focus goes there.
      showServerError(serverErrorTarget(error, (cause) => groupErrorMessage(cause, true)));
    },
  });

  const showServerError = (target: { field?: keyof MatchFormValues; message: string }) => {
    if (target.field !== undefined) {
      const field = target.field;
      setErrors((current) => ({ ...current, [field]: target.message }));
      requestAnimationFrame(() => focusControl(inputs.current[field], `match-${field}`));
    } else {
      setFormError(target.message);
      requestAnimationFrame(() => focusControl(null, 'match-create-error-box'));
    }
  };

  const saving = useMutation({
    mutationFn: async (config: MatchConfig) => {
      editIntent.current ??= api.updateMatch(editMatchId ?? '', config);
      return editIntent.current.execute();
    },
    onSuccess: async () => {
      editIntent.current = null;
      await queryClient.invalidateQueries({ queryKey: [PRIVATE_QUERY_ROOT, 'matches'] });
      // Back to the detail under the modal, which reads the saved match again.
      if (router.canDismiss()) router.dismiss();
      else router.replace(`/rachas/${editMatchId ?? ''}`);
    },
    onError: async (error) => {
      if (!(error instanceof TransportError || (error instanceof AppError && error.retryable))) {
        editIntent.current = null;
      }
      if (error instanceof AppError && error.code === 'SLOTS_BELOW_CONFIRMED') {
        // Someone confirmed meanwhile: the count under "Vagas" is today's.
        const fresh = await editedRoster.refetch();
        showServerError({
          field: 'slots',
          message: pt.matches.create.errors.slotsBelow(fresh.data?.confirmed_count ?? 0),
        });
        return;
      }
      showServerError(serverErrorTarget(error, (cause) => matchErrorMessage(cause, 'manage')));
    },
  });

  // Any edit is a new intent: the next submission gets a new request_id.
  const update = (field: keyof MatchFormValues) => (typed: string) => {
    intent.current = null;
    editIntent.current = null;
    const value = MASKS[field]?.(typed) ?? typed;
    setValues((current) => ({ ...current, [field]: value }));
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
    if (field === 'locationAddress') {
      // The coordinates belong to the chosen result, not to text typed after it.
      setPlace(null);
      setSearchError('');
    }
  };

  const runSearch = () => {
    if (searching.isPending) return;
    setSearchError('');
    setSearch(undefined);
    const query = values.locationAddress.replace(/\s+/gu, ' ').trim();
    if ([...query].length < 3) {
      setSearchError(pt.matches.create.searchShort);
      return;
    }
    searching.mutate(query);
  };

  const choose = (result: AddressResult) => {
    intent.current = null;
    editIntent.current = null;
    setValues((current) => ({
      ...current,
      locationAddress: [...result.label].slice(0, 160).join(''),
    }));
    setErrors(({ locationAddress: _cleared, ...rest }) => rest);
    setPlace({ latitude: result.latitude, longitude: result.longitude });
    setSearch(undefined);
  };

  const focusGroup = () =>
    requestAnimationFrame(() => focusControl(null, `match-group-${groups[0]?.id ?? ''}`));

  const saveEdit = () => {
    if (saving.isPending || match === undefined || editedRoster.data === undefined) return;
    setFormError('');
    const result = matchConfigFromForm(values, place, new Date(), undefined, {
      kept: { startsAt: match.starts_at, endsAt: match.ends_at },
      confirmed: editedRoster.data.confirmed_count,
    });
    if ('errors' in result) {
      setErrors(result.errors);
      const first = FIELD_ORDER.find((name) => result.errors[name] !== undefined);
      if (first !== undefined) {
        requestAnimationFrame(() => focusControl(inputs.current[first], `match-${first}`));
      }
      return;
    }
    setErrors({});
    saving.mutate(result.config);
  };

  const submit = () => {
    if (editing) {
      saveEdit();
      return;
    }
    if (creation.isPending) return;
    setFormError('');
    const result = matchConfigFromForm(values, place);
    const missingGroup = groupId === undefined;
    setGroupError(missingGroup ? pt.matches.create.errors.group : undefined);
    if ('errors' in result) {
      setErrors(result.errors);
      const first = FIELD_ORDER.find((name) => result.errors[name] !== undefined);
      if (missingGroup) focusGroup();
      else if (first !== undefined) {
        requestAnimationFrame(() => focusControl(inputs.current[first], `match-${first}`));
      }
      return;
    }
    setErrors({});
    if (missingGroup) {
      focusGroup();
      return;
    }
    creation.mutate([groupId, result.config]);
  };

  const close = () =>
    router.canDismiss()
      ? router.dismiss()
      : router.replace(editing ? `/rachas/${editMatchId}` : '/rachas');
  const pending = editing ? saving.isPending : creation.isPending;
  const page = editing
    ? { title: pt.matches.create.editTitle, description: '' }
    : pt.matches.create;
  const showForm = editing ? editReady : groups.length > 0 && !fixedUnavailable;
  const field = (
    name: keyof MatchFormValues,
    label: string,
    options: {
      hint?: string | undefined;
      keyboardType?: 'default' | 'number-pad';
      maxLength?: number;
      multiline?: boolean;
      placeholder?: string;
    } = {},
  ) => (
    <AppTextField
      error={errors[name]}
      hint={options.hint}
      keyboardType={options.keyboardType ?? 'default'}
      label={label}
      {...(options.maxLength === undefined ? {} : { maxLength: options.maxLength })}
      multiline={options.multiline ?? false}
      onChangeText={update(name)}
      placeholder={options.placeholder}
      ref={(input) => {
        inputs.current[name] = input;
      }}
      testID={`match-${name}`}
      value={values[name]}
    />
  );
  const nextDay = nextDayNotice(values.startTime, values.endTime);

  return (
    <AuthenticatedShell
      closeModal={{ label: pt.matches.create.close, onPress: close, testID: 'match-create-close' }}
      {...page}
    >
      {(editing ? edited.isPending || (match && editedRoster.isPending) : eligible.isPending) ? (
        <AsyncNotice kind="loading" message={pt.common.loading} />
      ) : null}
      {editing && (edited.isError || editedRoster.isError) ? (
        <AsyncNotice
          kind="network"
          title={pt.common.networkTitle}
          message={pt.common.networkBody}
          actionLabel={pt.common.retry}
          action={() => {
            void edited.refetch();
            void editedRoster.refetch();
          }}
        />
      ) : null}
      {editRefusal !== undefined ? (
        <AsyncNotice
          action={close}
          actionLabel={pt.matches.detail.back}
          kind="empty"
          message={editRefusal}
          title={pt.matches.create.editUnavailableTitle}
        />
      ) : null}
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
      {fixedUnavailable ? (
        <AsyncNotice
          action={() => router.replace('/grupos')}
          actionLabel={pt.matches.create.groups}
          kind="empty"
          message={pt.matches.create.groupUnavailable}
          title={pt.matches.create.groupUnavailableTitle}
        />
      ) : null}
      {showForm ? (
        <AppCard testID="create-match-card">
          <View tabIndex={-1} testID="match-create-error-box">
            <AppAlert message={formError} testID="match-create-error" />
          </View>
          {editing && match ? (
            <View style={styles.choice} testID="match-fixed-group">
              <Text style={[styles.label, { color: colors.text }]}>
                {pt.matches.create.groupFixed}
              </Text>
              <View style={styles.fixed}>
                <GroupIcon
                  appearance={groupAppearance(match.group_icon, match.group_color)}
                  size={20}
                />
                <Text style={[styles.optionText, { color: colors.text }]}>{match.group_name}</Text>
              </View>
            </View>
          ) : fixedGroup ? (
            <View style={styles.choice} testID="match-fixed-group">
              <Text style={[styles.label, { color: colors.text }]}>
                {pt.matches.create.groupFixed}
              </Text>
              <View style={styles.fixed}>
                <GroupIcon appearance={fixedGroup.appearance} size={20} />
                <Text style={[styles.optionText, { color: colors.text }]}>{fixedGroup.name}</Text>
              </View>
            </View>
          ) : fromGroup || editing ? null : (
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
          )}
          {field('date', pt.matches.create.date, {
            keyboardType: 'number-pad',
            maxLength: 10,
            placeholder: 'DD/MM/AAAA',
          })}
          <View style={styles.pair}>
            <View style={styles.pairItem}>
              {field('startTime', pt.matches.create.start, {
                keyboardType: 'number-pad',
                maxLength: 5,
                placeholder: 'HH:MM',
              })}
            </View>
            <View style={styles.pairItem}>
              {field('endTime', pt.matches.create.end, {
                hint: nextDay,
                keyboardType: 'number-pad',
                maxLength: 5,
                placeholder: 'HH:MM',
              })}
            </View>
          </View>
          {field('locationName', pt.matches.create.place)}
          <View style={styles.address}>
            {field('locationAddress', pt.matches.create.address)}
            <AppButton
              accessibilityLabel={pt.matches.create.searchLabel}
              ariaDisabled={searching.isPending}
              icon="search"
              label={searching.isPending ? pt.matches.create.searching : pt.matches.create.search}
              onPress={runSearch}
              testID="match-address-search"
              variant="secondary"
            />
            <AppAlert message={searchError} testID="match-address-error" />
            {search ? <AddressResults onChoose={choose} search={search} /> : null}
            {place ? (
              <View style={styles.chosen} testID="match-address-chosen">
                <AppStatus message={pt.matches.create.chosen} />
                <AppButton
                  label={pt.matches.create.clearChosen}
                  onPress={() => {
                    intent.current = null;
                    editIntent.current = null;
                    setPlace(null);
                  }}
                  testID="match-address-clear"
                  variant="tertiary"
                />
              </View>
            ) : null}
          </View>
          <View style={styles.description}>
            {field('description', pt.matches.create.descriptionLabel, {
              multiline: true,
            })}
            <Text
              style={[
                styles.counter,
                {
                  color:
                    descriptionLength(values.description) > DESCRIPTION_MAX
                      ? colors.critical
                      : colors.textMuted,
                },
              ]}
              testID="match-description-counter"
            >
              {pt.matches.create.descriptionCounter(
                descriptionLength(values.description),
                DESCRIPTION_MAX,
              )}
            </Text>
          </View>
          <View style={styles.pair}>
            <View style={styles.pairItem}>
              {field('slots', pt.matches.create.slots, {
                keyboardType: 'number-pad',
                maxLength: 2,
              })}
            </View>
            <View style={styles.pairItem}>
              {field('price', pt.matches.create.price, {
                hint: pt.matches.create.priceHint,
                keyboardType: 'number-pad',
                placeholder: 'R$ 0,00',
              })}
            </View>
          </View>
          <AppButton
            ariaDisabled={pending}
            label={
              editing
                ? pending
                  ? pt.matches.create.saving
                  : pt.matches.create.save
                : pending
                  ? pt.matches.create.submitting
                  : pt.matches.create.submit
            }
            onPress={submit}
            testID="match-create-submit"
          />
        </AppCard>
      ) : null}
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  address: { gap: spacing.sm },
  attribution: { ...typography.support },
  choice: { gap: spacing.sm },
  chosen: { gap: spacing.xs },
  counter: { ...typography.support, alignSelf: 'flex-end' },
  credit: {
    alignItems: 'center',
    borderRadius: radius.field,
    justifyContent: 'center',
    minHeight: size.target,
    minWidth: size.target,
    paddingHorizontal: spacing.sm,
  },
  creditText: { ...typography.support, textDecorationLine: 'underline' },
  credits: { alignItems: 'flex-end' },
  description: { gap: spacing.xs },
  fixed: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: size.target },
  hint: { ...typography.support },
  label: { ...typography.supportStrong },
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
  results: { borderRadius: radius.row, borderWidth: 1, gap: spacing.sm, padding: spacing.md },
});
