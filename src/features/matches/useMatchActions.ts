import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { AppError, TransportError, type MutationIntent } from '@/lib/api';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';

/**
 * One match mutation at a time. A retryable failure keeps the same intent, so
 * a second press resends the same request_id instead of starting a new one;
 * any other answer discards it. Success and refusal both re-read the match.
 */
export function useMatchActions(profileId: string) {
  const client = useQueryClient();
  const alive = useRef(true);
  const busy = useRef(false);
  const intent = useRef<{ key: string; command: MutationIntent<unknown> } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      intent.current = null;
    };
  }, []);
  const refresh = () =>
    client.invalidateQueries({ queryKey: [PRIVATE_QUERY_ROOT, 'matches', profileId] });
  async function run<T>(key: string, command: () => MutationIntent<T>): Promise<T | undefined> {
    if (busy.current) return undefined;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      if (intent.current?.key !== key) {
        intent.current = { key, command: command() as MutationIntent<unknown> };
      }
      const result = (await intent.current.command.execute()) as T;
      intent.current = null;
      if (alive.current) await refresh();
      return alive.current ? result : undefined;
    } catch (caught) {
      const retryable =
        caught instanceof TransportError || (caught instanceof AppError && caught.retryable);
      if (!retryable) intent.current = null;
      if (alive.current) {
        setError(caught);
        // NOT_FOUND/NOT_MEMBER: a re-read would unmount the match (get_match
        // now answers NOT_FOUND too) and take the explanation with it.
        if (
          caught instanceof AppError &&
          !['IDEMPOTENCY_WAIT_TIMEOUT', 'NOT_FOUND', 'NOT_MEMBER'].includes(caught.code)
        ) {
          await refresh();
        }
      }
      return undefined;
    } finally {
      busy.current = false;
      if (alive.current) setPending(false);
    }
  }
  return {
    run,
    pending,
    error,
    clearError: () => setError(null),
    discardIntent: () => {
      intent.current = null;
    },
  };
}
