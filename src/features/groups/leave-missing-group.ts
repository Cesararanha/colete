import { router } from 'expo-router';
import { useEffect } from 'react';

/**
 * A group screen whose fresh read finds no group goes back to Grupos, which
 * says so. Deleted, left and never joined read the same on purpose: the
 * screen does not learn which one it was (0029).
 */
export function useLeaveMissingGroup(missing: boolean) {
  useEffect(() => {
    if (missing) router.replace({ pathname: '/grupos', params: { missing: '1' } });
  }, [missing]);
}
