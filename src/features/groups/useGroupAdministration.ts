import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import {
  api,
  AppError,
  TransportError,
  type GroupOutcome,
  type MutationIntent,
  type OwnProfile,
} from '@/lib/api';
import { PRIVATE_QUERY_ROOT, withCurrentAccessToken } from '@/lib/private-queries';

export function useGroupAdministration(groupId: string, profile: OwnProfile) {
  const client = useQueryClient();
  const alive = useRef(true);
  const busy = useRef(false);
  const intent = useRef<{ key: string; command: MutationIntent<GroupOutcome> } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      intent.current = null;
    };
  }, []);
  const listing = useQuery({
    queryKey: [PRIVATE_QUERY_ROOT, 'group-administration', profile.id, groupId],
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const group = await withCurrentAccessToken((token) =>
        api.getGroupDetail(groupId, profile.id, token),
      );
      if (signal.aborted) throw new TransportError();
      // No group at all (deleted, left, never joined) is not the same as a
      // group this person cannot organise: the screen goes back to Grupos.
      if (!group) return { group: null, members: [], missing: true };
      if (!['owner', 'organizer'].includes(group.role))
        return { group: null, members: [], missing: false };
      const members = await api.getGroupMembers(groupId, signal);
      // Use the authority in the final server read, including a concurrent demotion.
      const own = members.find((member) => member.profile_id === profile.id);
      if (!own || own.status !== 'active' || !['owner', 'organizer'].includes(own.role))
        return { group: null, members: [], missing: false };
      return { group: { ...group, role: own.role }, members, missing: false };
    },
  });
  const refresh = async () => {
    // Discard projections of the previous authority before any fresh server read.
    await client.cancelQueries({ queryKey: [PRIVATE_QUERY_ROOT] });
    for (const key of ['groups', 'group-detail', 'group-members', 'group-invites']) {
      client.removeQueries({ queryKey: [PRIVATE_QUERY_ROOT, key] });
    }
    const fresh = await listing.refetch();
    return !fresh.isError;
  };
  const run = async (
    key: string,
    command: () => MutationIntent<GroupOutcome>,
    onError?: (error: unknown) => void,
  ) => {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (intent.current?.key !== key) intent.current = { key, command: command() };
      await intent.current.command.execute();
      intent.current = null;
      if (!alive.current) return false;
      const refreshed = await refresh();
      return refreshed && alive.current;
    } catch (caught) {
      if (!(
        caught instanceof TransportError ||
        (caught instanceof AppError &&
          (caught.retryable || ['RATE_LIMITED', 'RATE_LIMIT_UNAVAILABLE'].includes(caught.code)))
      ))
        intent.current = null;
      if (alive.current) {
        setError(caught);
        onError?.(caught);
      }
      if (
        alive.current &&
        caught instanceof AppError &&
        !['RATE_LIMITED', 'RATE_LIMIT_UNAVAILABLE', 'IDEMPOTENCY_WAIT_TIMEOUT'].includes(
          caught.code,
        )
      )
        await refresh();
      return false;
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  };
  return {
    listing,
    run,
    refresh,
    pending,
    error,
    discardIntent: () => {
      intent.current = null;
    },
  };
}
