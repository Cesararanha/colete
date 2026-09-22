import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';

import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { AppError, api } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';

import { DELETION_REQUEST_QUERY_KEY } from '../profile/DeleteAccountCard';
import { deletionProtocolStore } from '../profile/deletion-protocol';
import { DeletionShellScreen } from '../profile/DeletionShellScreen';
import { ProfileScreen } from '../profile/ProfileScreen';
import { ProfileCompletionScreen } from './ProfileCompletionScreen';

function LoadingGate() {
  return (
    <AuthenticatedShell
      description={pt.profile.description}
      eyebrow={pt.profile.eyebrow}
      title={pt.profile.title}
    >
      <AsyncNotice kind="loading" message={pt.common.loading} />
    </AuthenticatedShell>
  );
}

/**
 * Gate order of docs/22 sections 4 and 6: session, then the deletion
 * projection, then the profile. A pending deletion hides the profile row by
 * RLS, so "no profile" alone never means "complete your profile"; and once
 * Auth is gone the locally kept protocol still renders the restricted shell
 * instead of a login redirect, without recreating any session.
 */
export function AuthGateScreen() {
  const queryClient = useQueryClient();
  const storedProtocol = useSyncExternalStore(
    deletionProtocolStore.subscribe,
    deletionProtocolStore.getSnapshot,
    deletionProtocolStore.getSnapshot,
  );
  const session = useQuery({ queryKey: ['session'], queryFn: () => api.getSession() });
  const hasSession = session.data !== null && session.data !== undefined;
  const deletion = useQuery({
    enabled: hasSession,
    queryKey: DELETION_REQUEST_QUERY_KEY,
    queryFn: () => api.getOwnDeletionRequest(),
  });
  const profile = useQuery({
    enabled: hasSession,
    queryKey: ['own-profile'],
    queryFn: () => api.getOwnProfile(),
  });

  useEffect(() => {
    const subscription = api.onAuthStateChange((_event, nextSession) => {
      queryClient.setQueryData(['session'], nextSession);
      if (nextSession === null) {
        queryClient.removeQueries({ queryKey: ['own-profile'] });
        queryClient.removeQueries({ queryKey: DELETION_REQUEST_QUERY_KEY });
      }
    });
    return () => subscription.unsubscribe();
  }, [queryClient]);

  useEffect(() => {
    if (session.isSuccess && session.data === null && storedProtocol === null) {
      router.replace('/entrar');
    }
  }, [session.data, session.isSuccess, storedProtocol]);

  const deletionRequest = deletion.data ?? null;
  useEffect(() => {
    if (deletionRequest === null) return;
    deletionProtocolStore.store({
      id: deletionRequest.id,
      requested_at: deletionRequest.requested_at,
    });
  }, [deletionRequest]);

  const currentProfile = profile.data ?? null;
  useEffect(() => {
    if (currentProfile !== null) deletionProtocolStore.clear();
  }, [currentProfile]);

  const currentSession = session.data ?? null;
  const leave = () => {
    deletionProtocolStore.clear();
    void api
      .signOutLocally()
      .catch(() => undefined)
      .then(async () => {
        await queryClient.resetQueries();
        router.replace('/entrar');
      });
  };

  if (session.isPending) return <LoadingGate />;

  if (currentSession === null) {
    if (storedProtocol !== null) {
      return <DeletionShellScreen onLeave={leave} protocol={storedProtocol} request={null} />;
    }
    return <LoadingGate />;
  }

  if (profile.isPending || deletion.isPending) return <LoadingGate />;

  if (
    deletion.error instanceof AppError &&
    deletion.error.code === 'UNAUTHENTICATED' &&
    storedProtocol !== null
  ) {
    return <DeletionShellScreen onLeave={leave} protocol={storedProtocol} request={null} />;
  }

  const queryError = session.error ?? deletion.error ?? profile.error;
  if (queryError !== null) {
    return (
      <AuthenticatedShell
        description={pt.profile.description}
        eyebrow={pt.profile.eyebrow}
        title={pt.profile.title}
      >
        <AsyncNotice
          action={() => {
            void session.refetch();
            void deletion.refetch();
            void profile.refetch();
          }}
          actionLabel={pt.common.retry}
          kind="network"
          message={pt.common.networkBody}
          title={pt.common.networkTitle}
        />
      </AuthenticatedShell>
    );
  }

  if (deletionRequest !== null) {
    return (
      <DeletionShellScreen
        onLeave={leave}
        onRefresh={() => void deletion.refetch()}
        protocol={{ id: deletionRequest.id, requested_at: deletionRequest.requested_at }}
        refreshing={deletion.isFetching}
        request={deletionRequest}
      />
    );
  }

  if (profile.data === null || profile.data === undefined) {
    if (storedProtocol !== null) {
      return (
        <DeletionShellScreen
          onLeave={leave}
          onRefresh={() => void deletion.refetch()}
          protocol={storedProtocol}
          refreshing={deletion.isFetching}
          request={null}
        />
      );
    }
    const metadataName = currentSession.user.user_metadata['name'];
    return (
      <ProfileCompletionScreen
        defaultName={typeof metadataName === 'string' ? metadataName : ''}
        onCompleted={() => void profile.refetch()}
      />
    );
  }

  return <ProfileScreen profile={profile.data} session={currentSession} />;
}
