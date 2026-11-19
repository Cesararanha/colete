import type { Metadata } from 'expo-router/server';
import { useLayoutEffect, useState } from 'react';

import { AuthGateScreen } from '@/features/auth/AuthGateScreen';
import { JoinGroupScreen } from '@/features/groups/JoinGroupScreen';
import { consumeInviteFragment } from '@/features/groups/join-fragment';
import { pt } from '@/lib/i18n/pt';

function AuthenticatedJoinRoute() {
  const [token, setToken] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (typeof window === 'undefined' || !window.location) return;
    const capture = () => {
      const captured = consumeInviteFragment();
      if (captured !== null) queueMicrotask(() => setToken(captured));
    };
    window.addEventListener('colete:invite-fragment', capture);
    capture();
    return () => window.removeEventListener('colete:invite-fragment', capture);
  }, []);
  return <JoinGroupScreen key={token ?? ''} initialToken={token} />;
}

export default function JoinGroupRoute() {
  return (
    <AuthGateScreen page={pt.groups.join} renderAuthenticated={() => <AuthenticatedJoinRoute />} />
  );
}

export function generateMetadata(): Metadata {
  return { title: pt.app.pageTitle(pt.groups.join.title) };
}
