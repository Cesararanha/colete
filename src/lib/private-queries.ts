import { useQuery, type QueryClient, type QueryFunctionContext } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';

import { AppError, api } from './api';

export const SESSION_QUERY_KEY = ['session'] as const;

/**
 * Every query that reads what only the signed-in person may see lives under
 * this root. The session lifecycle clears the whole root at once, so a new
 * private query is covered by its key, not by a removal list to remember.
 */
export const PRIVATE_QUERY_ROOT = 'private';

export const privateQueryKeys = {
  deletionRequest: [PRIVATE_QUERY_ROOT, 'deletion-request'],
  ownDataExports: [PRIVATE_QUERY_ROOT, 'own-data-exports'],
  ownProfile: [PRIVATE_QUERY_ROOT, 'own-profile'],
} as const;

type PrivateQueryKey = (typeof privateQueryKeys)[keyof typeof privateQueryKeys];

export function usableAccessToken(session: Session | null | undefined): string | null {
  const accessToken = session?.access_token;
  return accessToken === undefined || accessToken === '' ? null : accessToken;
}

/** Clears every cached result and mutation when the authenticated person leaves.
 * Cancellation starts before eviction, so an in-flight private read cannot
 * repopulate the cache after another person signs in on the same client.
 */
export function clearPrivateQueries(queryClient: QueryClient) {
  void queryClient.cancelQueries();
  queryClient.clear();
}

/** Counts the sessions published per cache; a read started before the last one is stale. */
const sessionGenerations = new WeakMap<QueryClient, number>();

function sessionGeneration(queryClient: QueryClient) {
  return sessionGenerations.get(queryClient) ?? 0;
}

/**
 * Applies an Auth state change to the query cache. On sign-out, or when the
 * session now belongs to another person, the private results are gone before
 * the new session is published, so nothing of the previous person can be
 * rendered or refetched after it. Publishing starts a new generation, so a
 * session read still in flight cannot overwrite what was published here.
 */
export function applySessionChange(queryClient: QueryClient, next: Session | null) {
  const previous = queryClient.getQueryData<Session | null>(SESSION_QUERY_KEY);
  const previousUserId = previous?.user.id ?? null;
  const nextUserId = next?.user.id ?? null;
  if (previousUserId !== null && (nextUserId === null || nextUserId !== previousUserId)) {
    clearPrivateQueries(queryClient);
  }
  sessionGenerations.set(queryClient, sessionGeneration(queryClient) + 1);
  queryClient.setQueryData(SESSION_QUERY_KEY, next);
}

/**
 * A session read can resolve after an Auth event has already published a
 * newer session. A read that started before the last published change returns
 * the published session instead of its own result, which may belong to the
 * previous person.
 */
export async function readSessionForCache(
  { client }: Pick<QueryFunctionContext, 'client'>,
  readSession: () => Promise<Session | null> = () => api.getSession(),
) {
  const generation = sessionGeneration(client);
  const session = await readSession();
  if (generation !== sessionGeneration(client)) {
    return client.getQueryData<Session | null>(SESSION_QUERY_KEY) ?? null;
  }
  return session;
}

export function useSessionQuery() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: (context) => readSessionForCache(context),
  });
}

/** The session could not be confirmed when a private read ran, or the server refused it. */
export function isSessionUnavailable(error: unknown) {
  return error instanceof AppError && error.code === 'UNAUTHENTICATED';
}

/**
 * The token is read from Auth when the query runs, never from the render that
 * declared it: a refetch that outlives the session finds no token and sends
 * nothing, instead of reaching PostgREST with only the publishable key.
 */
export async function withCurrentAccessToken<T>(
  fetcher: (accessToken: string) => Promise<T>,
  readSession: () => Promise<Session | null> = () => api.getSession(),
) {
  const accessToken = usableAccessToken(await readSession());
  if (accessToken === null) {
    throw new AppError('UNAUTHENTICATED', 'Entre novamente para continuar.');
  }
  return fetcher(accessToken);
}

/** A query that exists only while a usable session does. */
export function usePrivateQuery<T>(
  queryKey: PrivateQueryKey,
  fetcher: (accessToken: string) => Promise<T>,
) {
  const session = useSessionQuery();
  return useQuery({
    enabled: usableAccessToken(session.data) !== null,
    queryKey,
    queryFn: () => withCurrentAccessToken(fetcher),
  });
}
