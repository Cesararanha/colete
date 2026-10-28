// HX-003: what a screen that reads by itself says about its last reading,
// and when it reads.

import { isSessionUnavailable } from './private-queries';
import { LIVE_REFRESH_MS } from './query-client';

export type LiveQuery = {
  data: unknown;
  dataUpdatedAt: number;
  error: unknown;
  isError: boolean;
  isFetching: boolean;
  isStale: boolean;
  refetch: () => Promise<unknown>;
};

/** "14:32", the device's own clock: it says when this screen last read. */
export function updatedAt(
  queries: readonly Pick<LiveQuery, 'dataUpdatedAt'>[],
): string | undefined {
  const read = queries.map((query) => query.dataUpdatedAt).filter((at) => at > 0);
  if (read.length === 0) return undefined;
  // The oldest of the screen's reads: the screen is as fresh as its stalest part.
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
  }).format(new Date(Math.min(...read)));
}

/**
 * Every LIVE_REFRESH_MS, but only while the screen is the one in front: a tab
 * or a screen left mounted under another does not read (rev89 P2-1). A session
 * the server refused stops it too, instead of a refusal every 30 s (rev89 P3-1).
 */
export function liveInterval(focused: boolean, error: unknown): number | false {
  return focused && !isSessionUnavailable(error) ? LIVE_REFRESH_MS : false;
}

/**
 * The large notice of a failed read: the session one whenever the session
 * fails; the network one only when there is nothing on the screen yet. A read
 * that fails over data already shown is said in LiveRefresh (rev89 P3-2).
 */
export function readProblem(
  query: Pick<LiveQuery, 'data' | 'error' | 'isError'>,
): 'session' | 'network' | undefined {
  if (!query.isError) return undefined;
  if (isSessionUnavailable(query.error)) return 'session';
  // null is a read that found nothing ("Racha não encontrado"): nothing on the screen (conf89 N1).
  return query.data == null ? 'network' : undefined;
}

/** A read failed while the screen still shows the one before it (not the session: that has its notice). */
export function refreshFailed(
  queries: readonly Pick<LiveQuery, 'data' | 'error' | 'isError'>[],
): boolean {
  return queries.some(
    (query) => query.isError && query.data != null && !isSessionUnavailable(query.error),
  );
}
