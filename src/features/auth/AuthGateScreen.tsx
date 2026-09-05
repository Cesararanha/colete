import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { AuthShell } from '@/components/ui/AuthShell';
import { AppError, api, TransportError, type MutationIntent } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

import { FormAlert } from './FormAlert';
import { authErrorMessage } from './messages';
import { ProfileCompletionForm } from './ProfileCompletionForm';

export function AuthGateScreen() {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: () => api.getSession() });
  const profile = useQuery({
    enabled: session.data !== null && session.data !== undefined,
    queryKey: ['own-profile'],
    queryFn: () => api.getOwnProfile(),
  });

  useEffect(() => {
    const subscription = api.onAuthStateChange(() => {
      void queryClient.invalidateQueries({ queryKey: ['session'] });
      void queryClient.invalidateQueries({ queryKey: ['own-profile'] });
    });
    return () => subscription.unsubscribe();
  }, [queryClient]);

  useEffect(() => {
    if (session.isSuccess && session.data === null) router.replace('/entrar');
  }, [session.data, session.isSuccess]);

  if (session.isPending || (session.data !== null && profile.isPending)) {
    return (
      <AuthShell
        description={pt.common.loading}
        eyebrow={pt.auth.shell.eyebrow}
        title={pt.app.name}
      >
        <AsyncNotice kind="loading" message={pt.common.loading} />
      </AuthShell>
    );
  }

  const queryError = session.error ?? profile.error;
  if (queryError !== null) {
    return (
      <AuthShell
        description={pt.common.networkBody}
        eyebrow={pt.auth.shell.eyebrow}
        title={pt.app.name}
      >
        <AsyncNotice
          action={() => {
            void session.refetch();
            void profile.refetch();
          }}
          actionLabel={pt.common.retry}
          kind="network"
          message={pt.common.networkBody}
          title={pt.common.networkTitle}
        />
      </AuthShell>
    );
  }

  if (session.data === null || session.data === undefined) {
    return (
      <AuthShell
        description={pt.common.loading}
        eyebrow={pt.auth.shell.eyebrow}
        title={pt.app.name}
      >
        <AsyncNotice kind="loading" message={pt.common.loading} />
      </AuthShell>
    );
  }

  if (profile.data === null || profile.data === undefined) {
    const metadataName = session.data.user.user_metadata['name'];
    return (
      <AuthShell
        description={pt.auth.profile.description}
        eyebrow={pt.auth.profile.eyebrow}
        title={pt.auth.profile.title}
      >
        <AppCard>
          <ProfileCompletionForm
            defaultName={typeof metadataName === 'string' ? metadataName : ''}
            onCompleted={() => void profile.refetch()}
          />
        </AppCard>
      </AuthShell>
    );
  }

  return <AuthenticatedReady profileName={profile.data.name} />;
}

function AuthenticatedReady({ profileName }: { profileName: string }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const intent = useRef<MutationIntent<unknown> | null>(null);
  const logout = useMutation({
    mutationFn: async () => {
      intent.current ??= api.revokeCurrentSession();
      await intent.current.execute();
      await api.signOutLocally();
    },
    onSuccess: async () => {
      intent.current = null;
      await queryClient.resetQueries();
      router.replace('/entrar');
    },
  });
  const canRetry =
    logout.error instanceof TransportError ||
    (logout.error instanceof AppError && logout.error.retryable);

  return (
    <AuthShell
      description={pt.auth.ready.description}
      eyebrow={pt.auth.ready.eyebrow}
      title={pt.auth.ready.title}
    >
      <AppCard testID="authenticated-ready">
        <View style={styles.ready}>
          <Text style={[styles.label, { color: colors.textMuted }]}>
            {pt.auth.ready.profileLabel}
          </Text>
          <Text style={[styles.name, { color: colors.text }]}>{profileName}</Text>
          {logout.error === null ? null : <FormAlert message={authErrorMessage(logout.error)} />}
          <AppButton
            label={logout.isPending ? pt.common.sending : pt.auth.ready.signOut}
            onPress={() => logout.mutate()}
            variant="secondary"
          />
          {canRetry ? (
            <AppButton
              label={pt.common.retry}
              onPress={() => logout.mutate()}
              variant="secondary"
            />
          ) : null}
        </View>
      </AppCard>
    </AuthShell>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 14, fontWeight: '700', lineHeight: 20 },
  name: { fontSize: 24, fontWeight: '900', lineHeight: 30 },
  ready: { gap: spacing.md },
});
