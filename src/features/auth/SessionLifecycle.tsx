import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '@/lib/api';
import { applySessionChange } from '@/lib/private-queries';
import { listenForLocalSignOut } from '@/lib/session-broadcast';
import { isSmokeMode } from '@/lib/runtime';

/**
 * The one Auth subscription of the app, mounted at the root so that it lives
 * as long as the query cache does. A gate-level subscription missed every
 * change made while the gate was unmounted: a sign-in on /entrar left a fresh
 * `null` session in the cache, and the gate sent the person back to /entrar.
 * The smoke build has no Supabase configuration and no session to follow.
 */
export function SessionLifecycle() {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isSmokeMode()) return undefined;
    const stopListening = listenForLocalSignOut(() => {
      applySessionChange(queryClient, null);
      window.location.replace('/entrar');
    });
    const subscription = api.onAuthStateChange((event, nextSession) => {
      if (event === 'INITIAL_SESSION') return;
      applySessionChange(queryClient, nextSession);
    });
    return () => {
      stopListening();
      subscription.unsubscribe();
    };
  }, [queryClient]);

  return null;
}
