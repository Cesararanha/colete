import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';

import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { AppError, api, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import {
  applySessionChange,
  isSessionUnavailable,
  privateQueryKeys,
  usePrivateQuery,
  useSessionQuery,
} from '@/lib/private-queries';
import { announceLocalSignOut } from '@/lib/session-broadcast';

import { deletionProtocolStore } from '../profile/deletion-protocol';
import { DeletionShellScreen } from '../profile/DeletionShellScreen';
import { ProfileScreen } from '../profile/ProfileScreen';
import { ProfileCompletionScreen } from './ProfileCompletionScreen';

type AuthGateProps = {
  renderAuthenticated?: (profile: OwnProfile, session: Session) => ReactNode;
  page?: { title: string; eyebrow: string; description: string };
};

function LoadingGate({ page }: { page: AuthGateProps['page'] }) {
  return (
    <AuthenticatedShell
      description={page?.description ?? pt.profile.description}
      eyebrow={page?.eyebrow ?? pt.profile.eyebrow}
      title={page?.title ?? pt.profile.title}
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
export function AuthGateScreen({ renderAuthenticated, page }: AuthGateProps = {}) {
  const queryClient = useQueryClient();
  const storedProtocol = useSyncExternalStore(
    deletionProtocolStore.subscribe,
    deletionProtocolStore.getSnapshot,
    deletionProtocolStore.getSnapshot,
  );
  const session = useSessionQuery();
  const currentSession = session.data ?? null;
  const deletion = usePrivateQuery(privateQueryKeys.deletionRequest, (accessToken) =>
    api.getOwnDeletionRequest(accessToken),
  );
  const profile = usePrivateQuery(privateQueryKeys.ownProfile, (accessToken) =>
    api.getOwnProfile(accessToken),
  );

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

  const leave = () => {
    deletionProtocolStore.clear();
    void api
      .signOutLocally()
      .catch(() => undefined)
      .then(async () => {
        applySessionChange(queryClient, null);
        if (Platform.OS === 'web') {
          announceLocalSignOut();
          window.location.replace('/entrar');
        } else {
          router.dismissAll();
          router.replace('/entrar');
        }
      });
  };

  if (session.isPending) return <LoadingGate page={page} />;

  if (currentSession === null) {
    if (storedProtocol !== null) {
      return <DeletionShellScreen onLeave={leave} protocol={storedProtocol} request={null} />;
    }
    return <LoadingGate page={page} />;
  }

  if (profile.isPending || deletion.isPending) return <LoadingGate page={page} />;

  if (
    deletion.error instanceof AppError &&
    deletion.error.code === 'UNAUTHENTICATED' &&
    storedProtocol !== null
  ) {
    return <DeletionShellScreen onLeave={leave} protocol={storedProtocol} request={null} />;
  }

  const queryError = session.error ?? deletion.error ?? profile.error;
  if (queryError !== null) {
    const sessionUnavailable = isSessionUnavailable(queryError);
    return (
      <AuthenticatedShell
        description={page?.description ?? pt.profile.description}
        eyebrow={page?.eyebrow ?? pt.profile.eyebrow}
        title={page?.title ?? pt.profile.title}
      >
        <AsyncNotice
          action={() => {
            void session.refetch();
            void deletion.refetch();
            void profile.refetch();
          }}
          actionLabel={pt.common.retry}
          kind="network"
          message={sessionUnavailable ? pt.common.sessionBody : pt.common.networkBody}
          title={sessionUnavailable ? pt.common.sessionTitle : pt.common.networkTitle}
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

  return (
    renderAuthenticated?.(profile.data, currentSession) ?? (
      <ProfileScreen profile={profile.data} session={currentSession} />
    )
  );
}
