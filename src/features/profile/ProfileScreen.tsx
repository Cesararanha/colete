import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { Session } from '@supabase/supabase-js';

import { AppAlert } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { SectionHeading } from '@/components/ui/SectionHeading';
import { AppError, api, TransportError, type MutationIntent, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { applySessionChange } from '@/lib/private-queries';
import { announceLocalSignOut, reloadAfterSignOut } from '@/lib/session-broadcast';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

import { DataExportCard } from './DataExportCard';
import { DeleteAccountCard } from './DeleteAccountCard';
import { ProfileDataForm } from './ProfileDataForm';
import { profileErrorMessage } from './profile-errors';
import { ProfilePasswordForm } from './ProfilePasswordForm';

export function linkedProviderLabels(session: Session): string[] {
  const identityProviders = (session.user.identities ?? []).map((identity) => identity.provider);
  const metadataProviders = Array.isArray(session.user.app_metadata['providers'])
    ? session.user.app_metadata['providers'].filter(
        (provider): provider is string => typeof provider === 'string',
      )
    : [];
  const providers = [...new Set([...identityProviders, ...metadataProviders])];
  if (providers.length === 0 && typeof session.user.app_metadata['provider'] === 'string') {
    providers.push(session.user.app_metadata['provider']);
  }
  return providers.map((provider) => {
    if (provider === 'email') return pt.profile.provider.email;
    if (provider === 'google') return pt.profile.provider.google;
    return pt.profile.provider.other(provider);
  });
}

export function ProfileScreen({ profile, session }: { profile: OwnProfile; session: Session }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const logoutIntent = useRef<MutationIntent<unknown> | null>(null);
  const logout = useMutation({
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
  const canRetry =
    logout.error instanceof TransportError ||
    (logout.error instanceof AppError && logout.error.retryable);
  const providers = linkedProviderLabels(session);

  return (
    <AuthenticatedShell
      description={pt.profile.description}
      eyebrow={pt.profile.eyebrow}
      title={pt.profile.title}
    >
      <AppCard testID="profile-data-card">
        <SectionHeading
          description={pt.profile.data.description}
          eyebrow={pt.profile.data.eyebrow}
          title={pt.profile.data.title}
        />
        <ProfileDataForm profile={profile} />
      </AppCard>

      <AppCard testID="profile-provider-card">
        <SectionHeading
          description={pt.profile.provider.description}
          eyebrow={pt.profile.provider.eyebrow}
          title={pt.profile.provider.title}
        />
        <View style={styles.providers}>
          {(providers.length === 0 ? [pt.profile.provider.unavailable] : providers).map(
            (provider) => (
              <Text key={provider} style={[styles.provider, { color: colors.text }]}>
                {provider}
              </Text>
            ),
          )}
        </View>
      </AppCard>

      <AppCard testID="profile-password-card">
        <SectionHeading
          description={pt.profile.password.description}
          eyebrow={pt.profile.password.eyebrow}
          title={pt.profile.password.title}
        />
        <ProfilePasswordForm />
      </AppCard>

      <AppCard testID="profile-session-card">
        <SectionHeading
          description={pt.profile.session.description}
          eyebrow={pt.profile.session.eyebrow}
          title={pt.profile.session.title}
        />
        {logout.error === null ? null : <AppAlert message={profileErrorMessage(logout.error)} />}
        <AppButton
          label={logout.isPending ? pt.common.sending : pt.profile.session.logout}
          onPress={() => {
            if (!logout.isPending) logout.mutate();
          }}
          variant="secondary"
        />
        {canRetry ? (
          <AppButton label={pt.common.retry} onPress={() => logout.mutate()} variant="secondary" />
        ) : null}
      </AppCard>

      <DataExportCard email={session.user.email ?? null} />

      <DeleteAccountCard />
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  provider: { fontSize: 16, fontWeight: '700', lineHeight: 24 },
  providers: { gap: spacing.sm },
});
