import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppTextField } from '@/components/ui/AppTextField';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { api, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { groupErrorMessage } from './group-errors';
import { focusGroupControl, GroupConfirmation } from './GroupConfirmation';
import { useGroupAdministration } from './useGroupAdministration';

export function GroupMembersScreen({ groupId, profile }: { groupId: string; profile: OwnProfile }) {
  const { colors } = useTheme();
  const administration = useGroupAdministration(groupId, profile);
  const { listing, run, error } = administration;
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (message && typeof document !== 'undefined') {
      const result = document.querySelector<HTMLElement>('[data-testid="member-result"]');
      result?.setAttribute('tabindex', '-1');
      result?.focus();
    }
  }, [message]);
  const reasonRef = useRef<TextInput>(null);
  const data = listing.isSuccess ? listing.data : undefined;
  const allowed = data?.group;
  const validReason = (value: string) => value.trim().length > 0 && [...value.trim()].length <= 500;
  const close = () => {
    const origin = target?.id;
    setTarget(null);
    setReason('');
    setInvalid(false);
    administration.discardIntent();
    if (origin) focusGroupControl(`remove-${origin}`);
  };
  return (
    <AuthenticatedShell {...pt.groups.members}>
      {administration.pending ? <AppStatus message={pt.common.loading} /> : null}
      {error ? (
        <AppAlert message={groupErrorMessage(error, true)} testID="administration-error" />
      ) : null}
      {listing.isPending ? <AsyncNotice kind="loading" message={pt.common.loading} /> : null}
      {listing.isError ? <AppAlert message={groupErrorMessage(listing.error, true)} /> : null}
      {data && !allowed ? <AppAlert message={pt.groups.errors.notOrganizer} /> : null}
      <AppButton
        testID="management-refresh"
        label={pt.groups.members.refresh}
        onPress={() => void administration.refresh()}
      />
      {allowed ? (
        <AppCard testID="group-management-card">
          <Text style={[styles.body, { color: colors.text }]}>{allowed.name}</Text>
          <AppStatus message={message} testID="member-result" />
          <Text role="heading" aria-level={2} style={[styles.heading, { color: colors.text }]}>
            {pt.groups.detail.pendingMembers}
          </Text>
          {!data.members.some((member) => member.status === 'pending') ? (
            <Text style={[styles.body, { color: colors.text }]}>{pt.groups.members.empty}</Text>
          ) : null}
          {data.members
            .filter((member) => member.status === 'pending')
            .map((member) => (
              <View
                key={member.profile_id}
                testID={`member-${member.profile_id}`}
                style={styles.row}
              >
                <Text style={[styles.body, { color: colors.text }]}>{member.display_name}</Text>
                {[true, false].map((approve) => (
                  <AppButton
                    key={String(approve)}
                    variant={approve ? 'primary' : 'secondary'}
                    accessibilityLabel={`${approve ? 'Aprovar' : 'Recusar'} ${member.display_name}`}
                    label={approve ? pt.groups.members.approve : pt.groups.members.refuse}
                    onPress={() => {
                      setMessage('');
                      void run(`${approve}:${member.profile_id}`, () =>
                        api.approveMember(groupId, member.profile_id, approve),
                      ).then((success) => {
                        if (success)
                          setMessage(pt.groups.members.decided(member.display_name, approve));
                      });
                    }}
                  />
                ))}
              </View>
            ))}
          <Text role="heading" aria-level={2} style={[styles.heading, { color: colors.text }]}>
            {pt.groups.detail.members}
          </Text>
          {data.members
            .filter((member) => member.status === 'active')
            .map((member) => (
              <View
                key={member.profile_id}
                testID={`member-${member.profile_id}`}
                style={styles.row}
              >
                <Text style={[styles.body, { color: colors.text }]}>
                  {member.display_name} ·{' '}
                  {member.role === 'owner'
                    ? pt.groups.list.owner
                    : member.role === 'organizer'
                      ? pt.groups.list.organizer
                      : pt.groups.detail.player}
                </Text>
                {member.role !== 'owner' ? (
                  <>
                    {allowed.role === 'owner' ? (
                      <AppButton
                        label={
                          member.role === 'player'
                            ? pt.groups.members.promote
                            : pt.groups.members.demote
                        }
                        accessibilityLabel={`${member.role === 'player' ? 'Promover' : 'Rebaixar'} ${member.display_name} a ${member.role === 'player' ? 'organizador' : 'jogador'}`}
                        testID={`role-${member.profile_id}`}
                        onPress={() => {
                          const role = member.role === 'player' ? 'organizer' : 'player';
                          setMessage('');
                          void run(`${role}:${member.profile_id}`, () =>
                            api.setMemberRole(groupId, member.profile_id, role),
                          ).then((success) => {
                            if (success)
                              setMessage(pt.groups.members.roleChanged(member.display_name, role));
                          });
                        }}
                        variant="secondary"
                      />
                    ) : null}
                    <AppButton
                      label={pt.groups.members.remove}
                      accessibilityLabel={`Expulsar ${member.display_name}`}
                      testID={`remove-${member.profile_id}`}
                      onPress={() => {
                        setTarget({ id: member.profile_id, name: member.display_name });
                        setReason('');
                        setInvalid(false);
                        administration.discardIntent();
                      }}
                      variant="destructive"
                    />
                  </>
                ) : null}
                {target?.id === member.profile_id ? (
                  <GroupConfirmation
                    title={pt.groups.members.removeTitle(target.name)}
                    testID="remove-confirmation"
                  >
                    <Text style={[styles.body, { color: colors.text }]}>
                      {pt.groups.members.removeBody}
                    </Text>
                    <AppTextField
                      ref={reasonRef}
                      label={pt.groups.members.reason}
                      hint={pt.groups.members.reasonHint}
                      value={reason}
                      error={invalid ? pt.groups.members.reasonInvalid : undefined}
                      onBlur={() => setInvalid(!validReason(reason))}
                      onChangeText={(value) => {
                        setReason(value);
                        if (invalid) setInvalid(!validReason(value));
                        administration.discardIntent();
                      }}
                      testID="remove-reason"
                      multiline
                    />
                    <AppButton
                      label={pt.groups.members.confirmRemove}
                      onPress={() => {
                        if (!validReason(reason)) {
                          setInvalid(true);
                          reasonRef.current?.focus();
                          return;
                        }
                        setMessage('');
                        void run(`remove:${target.id}:${reason}`, () =>
                          api.removeMember(groupId, target.id, reason),
                        ).then((success) => {
                          if (success) {
                            setMessage(pt.groups.members.removed(target.name));
                            setTarget(null);
                            setReason('');
                          }
                        });
                      }}
                      variant="destructive"
                    />
                    <AppButton
                      label={pt.groups.members.cancel}
                      onPress={close}
                      variant="secondary"
                    />
                  </GroupConfirmation>
                ) : null}
              </View>
            ))}
        </AppCard>
      ) : null}
    </AuthenticatedShell>
  );
}
const styles = StyleSheet.create({
  body: { ...typography.body },
  heading: { ...typography.title },
  row: { gap: spacing.sm, marginBottom: spacing.md },
});
