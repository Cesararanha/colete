import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useEffect } from 'react';

import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { api } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';

import { ProfileScreen } from '../profile/ProfileScreen';
import { ProfileCompletionScreen } from './ProfileCompletionScreen';

export function AuthGateScreen() {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: () => api.getSession() });
  const profile = useQuery({
    enabled: session.data !== null && session.data !== undefined,
    queryKey: ['own-profile'],
    queryFn: () => api.getOwnProfile(),
  });

  useEffect(() => {
    const subscription = api.onAuthStateChange((_event, nextSession) => {
      queryClient.setQueryData(['session'], nextSession);
      if (nextSession === null) queryClient.removeQueries({ queryKey: ['own-profile'] });
    });
    return () => subscription.unsubscribe();
  }, [queryClient]);

  useEffect(() => {
    if (session.isSuccess && session.data === null) router.replace('/entrar');
  }, [session.data, session.isSuccess]);

  if (session.isPending || (session.data !== null && profile.isPending)) {
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

  const queryError = session.error ?? profile.error;
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

  if (session.data === null || session.data === undefined) {
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

  if (profile.data === null || profile.data === undefined) {
    const metadataName = session.data.user.user_metadata['name'];
    return (
      <ProfileCompletionScreen
        defaultName={typeof metadataName === 'string' ? metadataName : ''}
        onCompleted={() => void profile.refetch()}
      />
    );
  }

  return <ProfileScreen profile={profile.data} session={session.data} />;
}
