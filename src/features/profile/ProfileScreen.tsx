import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { Session } from '@supabase/supabase-js';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { Avatar } from '@/components/ui/Avatar';
import { AppError, api, TransportError, type MutationIntent, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { applySessionChange } from '@/lib/private-queries';
import { announceLocalSignOut, reloadAfterSignOut } from '@/lib/session-broadcast';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { face, typography } from '@/theme/typography';

import { focusGroupControl, GroupConfirmation } from '../groups/GroupConfirmation';
import { ProfileDataForm } from './ProfileDataForm';
import { profileErrorMessage } from './profile-errors';
import { ProfileLinkRow } from './ProfileLinkRow';
import { profileStats } from './profile-view';

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

  // Prévia aprovada: avatar, name and nickname on top; the account's e-mail
  // stays under them (Ajustes do teste), not as a hint.
  const stats = profileStats(profile);
  const intro = (
    <View style={styles.intro}>
      <Avatar id={profile.id} name={profile.name} size={96} />
      <Text
        aria-level={1}
        role="heading"
        style={[styles.name, { color: colors.text }]}
        testID="profile-value-name"
      >
        {profile.name}
      </Text>
      {/* An absent nickname is said in words, as every absent value. */}
      <Text style={[styles.nickname, { color: colors.textMuted }]}>
        {profile.nickname ? '“' : ''}
        <Text testID="profile-value-nickname">{profile.nickname ?? pt.profile.empty.nickname}</Text>
        {profile.nickname ? '”' : ''}
      </Text>
      {email === null ? null : (
        <Text style={[styles.account, { color: colors.textMuted }]} testID="profile-account">
          {pt.profile.account.signedInAs(email)}
        </Text>
      )}
    </View>
  );

  return (
    <AuthenticatedShell
      back={{
        label: pt.profile.back,
        href: '/grupos',
        // Back to the tab the avatar was opened from (Tabs backBehavior
        // "history"); straight to Grupos when the profile was opened by URL.
        onPress: () => (router.canGoBack() ? router.back() : router.navigate('/grupos')),
        testID: 'profile-back',
      }}
      description=""
      intro={intro}
      title={pt.profile.title}
      trailing={
        mode === 'read' ? (
          <AppButton
            compact
            label={pt.profile.data.edit}
            onPress={() => {
              setSaved(false);
              setMode('edit');
            }}
            testID="edit-profile"
            variant="outline"
          />
        ) : null
      }
    >
      <View testID="profile-data-card">
        {mode === 'read' ? (
          <View
            accessibilityLabel={pt.profile.data.title}
            ref={readRef}
            style={styles.summary}
            tabIndex={-1}
            testID="profile-summary"
          >
            {saved ? <AppStatus message={pt.profile.data.saved} /> : null}
            <View style={styles.stats}>
              {stats.map((stat) => (
                <View key={stat.key} style={[styles.stat, { backgroundColor: colors.surface }]}>
                  <Text style={[styles.statLabel, { color: colors.textMuted }]}>{stat.label}</Text>
                  <Text
                    style={[
                      stat.key === 'shirt-number' && !stat.empty ? styles.shirt : styles.statValue,
                      { color: stat.empty ? colors.textMuted : colors[stat.tone] },
                    ]}
                    testID={`profile-value-${stat.key}`}
                  >
                    {stat.value}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : (
          <View style={[styles.card, { backgroundColor: colors.surface }]}>
            <Text aria-level={2} role="heading" style={[styles.cardTitle, { color: colors.text }]}>
              {pt.profile.data.title}
            </Text>
            <ProfileDataForm
              onCancel={closeEditor}
              onSaved={() => {
                setSaved(true);
                closeEditor();
              }}
              profile={profile}
            />
          </View>
        )}
      </View>

      <View
        style={[styles.links, { backgroundColor: colors.surface }]}
        testID="profile-settings-card"
      >
        <ProfileLinkRow
          href="/perfil/senha"
          icon="lock"
          testID="profile-password-link"
          title={pt.profile.settings.password}
        />
        <View style={[styles.divider, { backgroundColor: colors.divider }]} />
        <ProfileLinkRow
          href="/perfil/privacidade"
          icon="shield"
          testID="profile-privacy-link"
          title={pt.profile.settings.privacy}
        />
      </View>

      <View style={styles.logout} testID="profile-logout-card">
        {logout.error === null ? null : <AppAlert message={profileErrorMessage(logout.error)} />}
        {confirmingLogout ? (
          <GroupConfirmation
            level={2}
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
            variant="outline-destructive"
          />
        )}
      </View>
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  account: { ...typography.support, textAlign: 'center' },
  accountBody: { ...typography.body },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, minWidth: 0 },
  card: { borderRadius: radius.row, gap: spacing.md, padding: spacing.md },
  cardTitle: { ...typography.section },
  divider: { height: 1, marginLeft: 46 },
  intro: { alignItems: 'center', gap: 10, minWidth: 0, paddingTop: spacing.ms },
  links: { borderRadius: radius.row, overflow: 'hidden' },
  logout: { gap: spacing.sm, paddingTop: spacing.md },
  name: { ...typography.heading, fontSize: 26, lineHeight: 30, textAlign: 'center' },
  nickname: { ...typography.body, fontSize: 16, lineHeight: 22, textAlign: 'center' },
  shirt: { ...face('condensed'), fontSize: 26, fontVariant: ['tabular-nums'], lineHeight: 28 },
  stat: {
    alignItems: 'center',
    borderRadius: radius.field + 2,
    flexBasis: 90,
    flexGrow: 1,
    gap: 2,
    justifyContent: 'center',
    minWidth: 0,
    padding: spacing.ms,
  },
  statLabel: { ...typography.captionStrong, textAlign: 'center' },
  statValue: { ...typography.bodyStrong, ...face('bold'), textAlign: 'center' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  summary: { gap: spacing.sm, minWidth: 0 },
});
