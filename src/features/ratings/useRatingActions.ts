import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { AppError, TransportError, type MutationIntent } from '@/lib/api';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';

import { ratingsKey } from './rating-queries';

/**
 * One rating mutation at a time, like useMatchActions: a retryable failure
 * keeps the same intent (same request_id); any other answer discards it.
 * Success and refusal both re-read the group's ratings.
 */
export function useRatingActions(profileId: string, groupId: string) {
  const client = useQueryClient();
  const alive = useRef(true);
  const busy = useRef(false);
  const intent = useRef<{ key: string; command: MutationIntent<unknown> } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; error: unknown } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      intent.current = null;
    };
  }, []);
  const refresh = () => client.invalidateQueries({ queryKey: ratingsKey(profileId, groupId) });
  // A changed rating makes the drawn teams of the group's matches stale for the
  // organisers (0032): their cached teams are read again (rev82, BB-014).
  const refreshTeams = () =>
    client.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === PRIVATE_QUERY_ROOT &&
        queryKey[1] === 'matches' &&
        queryKey[2] === profileId &&
        queryKey[4] === 'teams',
    });
  async function run<T>(key: string, command: () => MutationIntent<T>): Promise<T | undefined> {
    if (busy.current) return undefined;
    busy.current = true;
    setPending(key);
    setError(null);
    try {
      if (intent.current?.key !== key) {
        intent.current = { key, command: command() as MutationIntent<unknown> };
      }
      const result = (await intent.current.command.execute()) as T;
      intent.current = null;
      await refreshTeams();
      if (alive.current) await refresh();
      return alive.current ? result : undefined;
    } catch (caught) {
      const retryable =
        caught instanceof TransportError || (caught instanceof AppError && caught.retryable);
      if (!retryable) intent.current = null;
      if (alive.current) {
        setError({ key, error: caught });
        if (caught instanceof AppError && caught.code !== 'IDEMPOTENCY_WAIT_TIMEOUT') {
          await refresh();
        }
      }
      return undefined;
    } finally {
      busy.current = false;
      if (alive.current) setPending(null);
    }
  }
  return { run, pending, error, clearError: () => setError(null) };
}
