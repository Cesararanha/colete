import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppTextField } from '@/components/ui/AppTextField';
import { AppError, TransportError, api, type GroupOutcome, type MutationIntent } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { deleteConfirmed } from './group-delete';
import { focusGroupControl, GroupConfirmation } from './GroupConfirmation';
import { groupErrorMessage } from './group-errors';

/**
 * "Apagar grupo" at the end of Configurações, for the owner only, as the
 * destructive action of the screen (like "Cancelar racha"). The confirmation
 * opens in place, names the group and unlocks only when its name is typed.
 * Final: there is no undo, and Grupos says "Grupo apagado." afterwards.
 */
export function DeleteGroup({
  groupId,
  name,
  onGone,
}: {
  groupId: string;
  name: string;
  /** A refusal that means the group is no longer there: read it again. */
  onGone: () => void;
}) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const intent = useRef<MutationIntent<GroupOutcome> | null>(null);
  const restoreFocus = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const confirmed = deleteConfirmed(typed, name);
  const removal = useMutation({
    mutationFn: () => {
      intent.current ??= api.deleteGroup(groupId);
      return intent.current.execute();
    },
    onSuccess: async () => {
      intent.current = null;
      // The group and its matches leave every cached read of this person.
      await queryClient.cancelQueries({ queryKey: [PRIVATE_QUERY_ROOT] });
      for (const key of ['group-detail', 'group-members', 'group-invites', 'group-administration'])
        queryClient.removeQueries({ queryKey: [PRIVATE_QUERY_ROOT, key] });
      await queryClient.invalidateQueries({ queryKey: [PRIVATE_QUERY_ROOT, 'groups'] });
      await queryClient.invalidateQueries({ queryKey: [PRIVATE_QUERY_ROOT, 'matches'] });
      router.replace({ pathname: '/grupos', params: { deleted: '1' } });
    },
    onError: (error) => {
      if (!(error instanceof TransportError || (error instanceof AppError && error.retryable)))
        intent.current = null;
      if (error instanceof AppError && error.code === 'NOT_FOUND') onGone();
    },
  });
  useEffect(() => {
    if (!confirming && restoreFocus.current) {
      restoreFocus.current = false;
      focusGroupControl('group-delete');
    }
  }, [confirming]);
  const submit = () => {
    if (confirmed && !removal.isPending) removal.mutate();
  };
  return (
    <View style={styles.section} testID="group-delete-section">
      <AppAlert
        message={removal.error ? groupErrorMessage(removal.error, true) : ''}
        testID="group-delete-error"
      />
      {confirming ? (
        <GroupConfirmation
          level={2}
          title={pt.groups.settings.deleteTitle(name)}
          testID="group-delete-confirmation"
        >
          <Text style={[styles.body, { color: colors.text }]}>{pt.groups.settings.deleteBody}</Text>
          <AppTextField
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            label={pt.groups.settings.deleteName}
            onChangeText={(value) => {
              setTyped(value);
              intent.current = null;
            }}
            onSubmitEditing={submit}
            testID="group-delete-name"
            value={typed}
          />
          <View style={styles.actions}>
            <AppButton
              ariaDisabled={!confirmed || removal.isPending}
              icon="trash-2"
              label={removal.isPending ? pt.groups.settings.deleting : pt.groups.settings.delete}
              onPress={submit}
              testID="group-delete-confirm"
              variant="destructive"
            />
            <AppButton
              label={pt.groups.members.cancel}
              onPress={() => {
                if (removal.isPending) return;
                restoreFocus.current = true;
                intent.current = null;
                removal.reset();
                setTyped('');
                setConfirming(false);
              }}
              testID="group-delete-keep"
              variant="secondary"
            />
          </View>
        </GroupConfirmation>
      ) : (
        <AppButton
          icon="trash-2"
          label={pt.groups.settings.delete}
          onPress={() => {
            removal.reset();
            setConfirming(true);
          }}
          testID="group-delete"
          variant="outline-destructive"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm },
  body: { ...typography.body },
  section: { gap: spacing.sm, paddingTop: spacing.md },
});
