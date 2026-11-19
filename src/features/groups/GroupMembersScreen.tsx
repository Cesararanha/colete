import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, type TextInputInstance, View } from 'react-native';

import { AppAlert, AppProgress, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppIcon } from '@/components/ui/AppIcon';
import { AppTextField } from '@/components/ui/AppTextField';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { api, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { face, typography } from '@/theme/typography';

import { groupErrorMessage } from './group-errors';
import { focusGroupControl, GroupConfirmation } from './GroupConfirmation';
import { useLeaveMissingGroup } from './leave-missing-group';
import { MemberRow } from './MemberRow';
import { useGroupAdministration } from './useGroupAdministration';
import { PhotoAvatar } from '../photos/PhotoAvatar';

export function GroupMembersScreen({ groupId, profile }: { groupId: string; profile: OwnProfile }) {
  const { colors } = useTheme();
  const administration = useGroupAdministration(groupId, profile);
  const { listing, run, error } = administration;
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  // The member whose "…" is open; one at a time.
  const [menu, setMenu] = useState<string | null>(null);
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
  const reasonRef = useRef<TextInputInstance>(null);
  const data = listing.isSuccess ? listing.data : undefined;
  const allowed = data?.group;
  useLeaveMissingGroup(data?.missing === true);
  const validReason = (value: string) => value.trim().length > 0 && [...value.trim()].length <= 500;
  const close = () => {
    const origin = target?.id;
    setTarget(null);
    setReason('');
    setInvalid(false);
    administration.discardIntent();
    if (origin) focusGroupControl(`remove-${origin}`);
  };
  const pending = data?.members.filter((member) => member.status === 'pending') ?? [];
  const active = data?.members.filter((member) => member.status === 'active') ?? [];
  const decide = (member: { profile_id: string; display_name: string }, approve: boolean) => {
    setMessage('');
    void run(`${approve}:${member.profile_id}`, () =>
      api.approveMember(groupId, member.profile_id, approve),
    ).then((success) => {
      if (success) setMessage(pt.groups.members.decided(member.display_name, approve));
    });
  };
  return (
    <AuthenticatedShell
      {...pt.groups.members}
      back={{
        // The parent's name once the server read confirms it (prévia aprovada).
        label: allowed?.name ?? pt.groups.members.back,
        href: `/grupos/${groupId}`,
        testID: 'members-back',
      }}
    >
      {administration.pending ? (
        <AppProgress message={pt.common.loading} testID="administration-progress" />
      ) : null}
      {error ? (
        <AppAlert message={groupErrorMessage(error, true)} testID="administration-error" />
      ) : null}
      {listing.isPending ? <AsyncNotice kind="loading" message={pt.common.loading} /> : null}
      {listing.isError ? (
        // UX-012: a failed read offers its retry, as on the other screens.
        <>
          <AppAlert message={groupErrorMessage(listing.error, true)} />
          <AppButton
            label={pt.common.retry}
            onPress={() => void listing.refetch()}
            testID="administration-retry"
            variant="secondary"
          />
        </>
      ) : null}
      {data && !allowed && !data.missing ? (
        <AppAlert message={pt.groups.errors.notOrganizer} />
      ) : null}
      {allowed ? (
        <View style={styles.sections} testID="group-management-card">
          <AppStatus message={message} testID="member-result" />
          <View style={styles.section}>
            <View style={styles.heading}>
              <Text role="heading" aria-level={2} style={[styles.title, { color: colors.text }]}>
                {pt.groups.members.requests}
              </Text>
              {pending.length > 0 ? (
                <View style={[styles.counter, { backgroundColor: colors.warning }]}>
                  <Text style={[styles.counterText, { color: colors.onWarning }]}>
                    {pending.length}
                  </Text>
                </View>
              ) : null}
            </View>
            {pending.length === 0 ? (
              <Text style={[styles.empty, { color: colors.textMuted }]}>
                {pt.groups.members.empty}
              </Text>
            ) : null}
            {/* The rows scroll with the screen: the list itself does not. */}
            <FlatList
              contentContainerStyle={styles.requests}
              data={pending}
              keyExtractor={(member) => member.profile_id}
              scrollEnabled={false}
              renderItem={({ item: member }) => (
                <View
                  style={[styles.request, { backgroundColor: colors.surface }]}
                  testID={`member-${member.profile_id}`}
                >
                  <PhotoAvatar id={member.profile_id} name={member.display_name} size={44} />
                  <Text style={[styles.requestName, { color: colors.text }]}>
                    {member.display_name}
                  </Text>
                  <View style={styles.decisions}>
                    <RoundButton
                      accessibilityLabel={pt.groups.members.refuseLabel(member.display_name)}
                      icon="x"
                      onPress={() => decide(member, false)}
                      tone="refuse"
                    />
                    <RoundButton
                      accessibilityLabel={pt.groups.members.approveLabel(member.display_name)}
                      icon="check"
                      onPress={() => decide(member, true)}
                      tone="approve"
                    />
                  </View>
                </View>
              )}
            />
          </View>
          <View style={styles.section}>
            <Text role="heading" aria-level={2} style={[styles.title, { color: colors.text }]}>
              {pt.groups.members.inGroup}{' '}
              <Text style={[styles.count, { color: colors.textMuted }]}>{active.length}</Text>
            </Text>
            <View style={[styles.list, { backgroundColor: colors.surface }]}>
              {/* A list, so each MemberRow (listitem) has its parent; the
                  rows scroll with the screen. */}
              <View role="list">
                {active.map((member, index) => {
                  const hasActions = member.role !== 'owner';
                  const open = menu === member.profile_id || target?.id === member.profile_id;
                  return (
                    <MemberRow
                      key={member.profile_id}
                      actions={
                        hasActions ? (
                          <MenuButton
                            expanded={open}
                            label={pt.groups.members.actions(member.display_name)}
                            onPress={() => {
                              // One menu at a time (rev74, BB-030): closing the "…" or
                              // opening another member's also closes the open
                              // confirmation; focus stays here.
                              if (target !== null) {
                                setTarget(null);
                                setReason('');
                                setInvalid(false);
                                administration.discardIntent();
                              }
                              setMenu(open ? null : member.profile_id);
                            }}
                            testID={`member-menu-${member.profile_id}`}
                          />
                        ) : undefined
                      }
                      divider={index > 0}
                      id={member.profile_id}
                      name={member.display_name}
                      role={member.role}
                      testID={`member-${member.profile_id}`}
                    >
                      {hasActions && open ? (
                        <View style={styles.menu} testID={`member-actions-${member.profile_id}`}>
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
                                    setMessage(
                                      pt.groups.members.roleChanged(member.display_name, role),
                                    );
                                });
                              }}
                              variant="outline"
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
                            variant="outline-destructive"
                          />
                        </View>
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
                                  setMenu(null);
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
                    </MemberRow>
                  );
                })}
              </View>
            </View>
          </View>
        </View>
      ) : null}
      <View style={styles.refresh}>
        <AppButton
          testID="management-refresh"
          icon="refresh-cw"
          label={pt.groups.members.refresh}
          onPress={() => void administration.refresh()}
          variant="tertiary"
        />
      </View>
    </AuthenticatedShell>
  );
}

/** ✕ and ✓ of a request: a real 44 px round button named "Recusar/Aprovar <nome>". */
function RoundButton({
  accessibilityLabel,
  icon,
  onPress,
  tone,
}: {
  accessibilityLabel: string;
  icon: 'check' | 'x';
  onPress: () => void;
  tone: 'approve' | 'refuse';
}) {
  const { colors } = useTheme();
  const approve = tone === 'approve';
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={[
        styles.round,
        approve
          ? { backgroundColor: colors.positive }
          : { borderColor: colors.fieldBorder, borderWidth: 1 },
      ]}
    >
      <AppIcon
        color={approve ? colors.onPositive : colors.critical}
        name={icon}
        size={approve ? 20 : 18}
      />
    </Pressable>
  );
}

/** The "…" of a member row: opens that member's actions below the row. */
function MenuButton({
  expanded,
  label,
  onPress,
  testID,
}: {
  expanded: boolean;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      aria-expanded={expanded}
      onPress={onPress}
      style={styles.round}
      testID={testID}
    >
      <AppIcon color={colors.textMuted} name="more-horizontal" size={20} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { ...typography.body },
  count: { ...typography.row, fontSize: 18 },
  counter: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 22,
    justifyContent: 'center',
    minWidth: 22,
    paddingHorizontal: 7,
  },
  counterText: { ...typography.chip, ...face('bold') },
  decisions: { flexDirection: 'row', gap: spacing.ms },
  empty: { ...typography.support },
  heading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  list: { borderRadius: radius.row, overflow: 'hidden' },
  menu: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  refresh: { alignItems: 'flex-start', marginLeft: -spacing.md },
  request: {
    alignItems: 'center',
    borderRadius: radius.row,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.ms,
    padding: spacing.ms,
  },
  requestName: { ...typography.bodyStrong, flex: 1, fontSize: 16, lineHeight: 22, minWidth: 0 },
  requests: { gap: 10 },
  round: {
    alignItems: 'center',
    borderRadius: radius.pill,
    height: size.compact,
    justifyContent: 'center',
    width: size.compact,
  },
  section: { gap: 10 },
  sections: { gap: spacing.lg },
  title: { ...typography.cardTitle },
});
