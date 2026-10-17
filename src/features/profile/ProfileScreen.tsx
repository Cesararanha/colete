import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { Session } from '@supabase/supabase-js';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { AppError, api, TransportError, type MutationIntent, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { applySessionChange } from '@/lib/private-queries';
import { announceLocalSignOut, reloadAfterSignOut } from '@/lib/session-broadcast';
import { useTheme } from '@/theme/ThemeProvider';
import { size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { focusGroupControl, GroupConfirmation } from '../groups/GroupConfirmation';
import { ProfileDataForm } from './ProfileDataForm';
import { profileErrorMessage } from './profile-errors';
import { ProfileLinkRow } from './ProfileLinkRow';
import { profileSummary } from './profile-view';

function useLogout() {
  const queryClient = useQueryClient();
  const logoutIntent = useRef<MutationIntent<unknown> | null>(null);
  return useMutation({
    mutationFn: async () => {
      logoutIntent.current ??= api.revokeCurrentSession();
      await logoutIntent.current.execute();
      await api.signOutLocally();
    },
    onSuccess: async () => {
      logoutIntent.current = null;
      applySessionChange(queryClient, null);
      if (Platform.OS === 'web') {
        announceLocalSignOut();
        reloadAfterSignOut();
      } else {
        router.dismissAll();
        router.replace('/entrar');
      }
    },
  });
}

export function ProfileScreen({ profile, session }: { profile: OwnProfile; session: Session }) {
  const { colors } = useTheme();
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [saved, setSaved] = useState(false);
  const readRef = useRef<View>(null);
  const returnFocus = useRef(false);
  const logout = useLogout();
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  // Cancelling unmounts the focused control: focus returns to "Sair da conta".
  const restoreLogoutFocus = useRef(false);
  useEffect(() => {
    if (!confirmingLogout && restoreLogoutFocus.current) {
      restoreLogoutFocus.current = false;
      focusGroupControl('profile-logout');
    }
  }, [confirmingLogout]);
  const canRetryLogout =
    logout.error instanceof TransportError ||
    (logout.error instanceof AppError && logout.error.retryable);
  const email = session.user.email ?? null;

  // Leaving the edit mode returns focus to the summary it replaced.
  useEffect(() => {
    if (mode !== 'read' || !returnFocus.current) return;
    returnFocus.current = false;
    readRef.current?.focus();
  }, [mode]);
  const closeEditor = () => {
    returnFocus.current = true;
    setMode('read');
  };

  // The account line stays at the top; signing out is the last, separate and
  // destructive action of the page, behind a confirmation (Ajustes do teste).
  const account =
    email === null ? undefined : (
      <Text style={[styles.accountEmail, { color: colors.onBandMuted }]} testID="profile-account">
        {pt.profile.account.signedInAs(email)}
      </Text>
    );

  return (
    <AuthenticatedShell
      description={pt.profile.description}
      {...(account === undefined ? {} : { hero: account })}
      title={pt.profile.title}
    >
      <AppCard testID="profile-data-card">
        <View style={styles.cardHeader}>
          <View style={styles.cardHeading}>
            <SectionHeading
              eyebrow={pt.profile.data.eyebrow}
              title={pt.profile.data.title}
              {...(mode === 'edit' ? { description: pt.profile.data.editDescription } : {})}
            />
          </View>
          {mode === 'read' ? (
            <AppButton
              icon="edit-2"
              label={pt.profile.data.edit}
              onPress={() => {
                setSaved(false);
                setMode('edit');
              }}
              testID="edit-profile"
              variant="secondary"
            />
          ) : null}
        </View>

        {mode === 'read' ? (
          <View
            accessibilityLabel={pt.profile.data.title}
            ref={readRef}
            style={styles.summary}
            tabIndex={-1}
            testID="profile-summary"
          >
            {saved ? <AppStatus message={pt.profile.data.saved} /> : null}
            {profileSummary(profile).map((row) => (
              <View key={row.key} style={styles.row}>
                <Text style={[styles.rowLabel, { color: colors.textMuted }]}>{row.label}</Text>
                <Text
                  style={[
                    row.empty ? styles.rowEmpty : styles.rowValue,
                    { color: row.empty ? colors.textMuted : colors.text },
                  ]}
                  testID={`profile-value-${row.key}`}
                >
                  {row.value}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <ProfileDataForm
            onCancel={closeEditor}
            onSaved={() => {
              setSaved(true);
              closeEditor();
            }}
            profile={profile}
          />
        )}
      </AppCard>

      <AppCard testID="profile-settings-card">
        <SectionHeading eyebrow={pt.profile.settings.eyebrow} title={pt.profile.settings.title} />
        <View style={styles.links}>
          <ProfileLinkRow
            hint={
              email === null
                ? pt.profile.settings.passwordHintNoEmail
                : pt.profile.settings.passwordHint(email)
            }
            href="/perfil/senha"
            icon="key"
            testID="profile-password-link"
            title={pt.profile.settings.password}
          />
          <ProfileLinkRow
            hint={pt.profile.settings.privacyHint}
            href="/perfil/privacidade"
            icon="shield"
            testID="profile-privacy-link"
            title={pt.profile.settings.privacy}
          />
        </View>
      </AppCard>

      <AppCard testID="profile-logout-card">
        {logout.error === null ? null : <AppAlert message={profileErrorMessage(logout.error)} />}
        {confirmingLogout ? (
          <GroupConfirmation
            title={pt.profile.account.logoutTitle}
            testID="profile-logout-confirmation"
          >
            <Text style={[styles.accountBody, { color: colors.text }]}>
              {pt.profile.account.logoutBody}
            </Text>
            <View style={styles.actions}>
              <AppButton
                icon="log-out"
                label={logout.isPending ? pt.common.sending : pt.profile.account.logoutConfirm}
                onPress={() => {
                  if (!logout.isPending) logout.mutate();
                }}
                testID="profile-logout-confirm"
                variant="destructive"
              />
              <AppButton
                label={pt.profile.account.logoutCancel}
                onPress={() => {
                  if (logout.isPending) return;
                  logout.reset();
                  restoreLogoutFocus.current = true;
                  setConfirmingLogout(false);
                }}
                testID="profile-logout-cancel"
                variant="secondary"
              />
              {canRetryLogout ? (
                <AppButton
                  label={pt.common.retry}
                  onPress={() => logout.mutate()}
                  variant="secondary"
                />
              ) : null}
            </View>
          </GroupConfirmation>
        ) : (
          <AppButton
            icon="log-out"
            label={pt.profile.account.logout}
            onPress={() => setConfirmingLogout(true)}
            testID="profile-logout"
            variant="destructive"
          />
        )}
      </AppCard>
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  accountBody: { ...typography.body },
  accountEmail: { ...typography.support },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, minWidth: 0 },
  cardHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    justifyContent: 'space-between',
    minWidth: 0,
  },
  cardHeading: { flexBasis: 200, flexGrow: 1, minWidth: 0 },
  links: { gap: spacing.xs },
  row: {
    alignItems: 'baseline',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    justifyContent: 'space-between',
    minHeight: size.target,
    paddingVertical: spacing.sm,
  },
  rowEmpty: { ...typography.body, flexShrink: 1, textAlign: 'right' },
  rowLabel: { ...typography.support, flexShrink: 0 },
  rowValue: { ...typography.bodyStrong, flexShrink: 1, textAlign: 'right' },
  summary: { gap: 0, minWidth: 0 },
});
