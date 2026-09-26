import { isCancelledError, QueryClient } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { AppError, TransportError } from './api';
import {
  applySessionChange,
  isSessionUnavailable,
  privateQueryKeys,
  readSessionForCache,
  SESSION_QUERY_KEY,
  withCurrentAccessToken,
} from './private-queries';

function sessionFor(userId: string, accessToken = `token-of-${userId}`) {
  return { access_token: accessToken, user: { id: userId } } as unknown as Session;
}

function signedInClient(userId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_QUERY_KEY, sessionFor(userId));
  client.setQueryData(privateQueryKeys.ownProfile, { id: `profile-of-${userId}` });
  client.setQueryData(privateQueryKeys.deletionRequest, null);
  client.setQueryData(privateQueryKeys.ownDataExports, [{ id: `export-of-${userId}` }]);
  client.setQueryData(['public-catalog'], ['kept']);
  return client;
}

function privateQueries(client: QueryClient) {
  return client.getQueryCache().findAll({ queryKey: ['private'] });
}

describe('lib/private-queries session lifecycle', () => {
  it('drops every private result on sign-out and keeps what is not private', () => {
    const client = signedInClient('user-a');
    expect(privateQueries(client)).toHaveLength(3);

    applySessionChange(client, null);

    expect(privateQueries(client)).toEqual([]);
    expect(client.getQueryData(privateQueryKeys.ownDataExports)).toBeUndefined();
    expect(client.getQueryData(SESSION_QUERY_KEY)).toBeNull();
    expect(client.getQueryData(['public-catalog'])).toEqual(['kept']);
  });

  it('drops the previous person when the session changes owner without a sign-out', () => {
    const client = signedInClient('user-a');

    applySessionChange(client, sessionFor('user-b'));

    expect(privateQueries(client)).toEqual([]);
    expect(client.getQueryData<Session>(SESSION_QUERY_KEY)?.user.id).toBe('user-b');
  });

  it('keeps private results across a token refresh of the same person', () => {
    const client = signedInClient('user-a');

    applySessionChange(client, sessionFor('user-a', 'refreshed-token'));

    expect(client.getQueryData(privateQueryKeys.ownDataExports)).toEqual([
      { id: 'export-of-user-a' },
    ]);
  });

  it('cancels a private fetch in flight so its result never lands after sign-out', async () => {
    const client = signedInClient('user-a');
    client.removeQueries({ queryKey: privateQueryKeys.ownDataExports });
    let resolveFetch: (rows: unknown[]) => void = () => undefined;
    const inFlight = client
      .fetchQuery({
        queryKey: privateQueryKeys.ownDataExports,
        queryFn: () =>
          new Promise<unknown[]>((resolve) => {
            resolveFetch = resolve;
          }),
      })
      .then(
        () => 'resolved',
        (error: unknown) => (isCancelledError(error) ? 'cancelled' : 'rejected'),
      );

    applySessionChange(client, null);
    resolveFetch([{ id: 'export-of-user-a' }]);

    await expect(inFlight).resolves.toBe('cancelled');
    expect(client.getQueryData(privateQueryKeys.ownDataExports)).toBeUndefined();
    expect(privateQueries(client)).toEqual([]);
  });
});

describe('lib/private-queries session reads', () => {
  function pendingRead() {
    let resolveRead: (session: Session | null) => void = () => undefined;
    const read = () =>
      new Promise<Session | null>((resolve) => {
        resolveRead = resolve;
      });
    return { read, resolve: (session: Session | null) => resolveRead(session) };
  }

  it('never lets a read started before a published change overwrite it', async () => {
    const client = signedInClient('user-a');
    const pending = pendingRead();
    const inFlight = client.fetchQuery({
      queryKey: SESSION_QUERY_KEY,
      queryFn: (context) => readSessionForCache(context, pending.read),
    });

    applySessionChange(client, sessionFor('user-b'));
    pending.resolve(sessionFor('user-a'));
    await inFlight;

    expect(client.getQueryData<Session>(SESSION_QUERY_KEY)?.user.id).toBe('user-b');
  });

  it('never lets a stale read bring a session back after sign-out', async () => {
    const client = signedInClient('user-a');
    const pending = pendingRead();
    const inFlight = client.fetchQuery({
      queryKey: SESSION_QUERY_KEY,
      queryFn: (context) => readSessionForCache(context, pending.read),
    });

    applySessionChange(client, null);
    pending.resolve(sessionFor('user-a'));
    await inFlight;

    expect(client.getQueryData(SESSION_QUERY_KEY)).toBeNull();
  });

  it('keeps the result of a read started after the last published change', async () => {
    const client = signedInClient('user-a');
    applySessionChange(client, sessionFor('user-b'));

    await client.fetchQuery({
      queryKey: SESSION_QUERY_KEY,
      queryFn: (context) => readSessionForCache(context, async () => sessionFor('user-c')),
    });

    expect(client.getQueryData<Session>(SESSION_QUERY_KEY)?.user.id).toBe('user-c');
  });
});

describe('lib/private-queries session unavailable', () => {
  it('tells an unconfirmed session apart from a network failure', () => {
    expect(isSessionUnavailable(new AppError('UNAUTHENTICATED', 'x'))).toBe(true);
    expect(isSessionUnavailable(new TransportError())).toBe(false);
    expect(isSessionUnavailable(new AppError('FORBIDDEN', 'x'))).toBe(false);
  });
});

describe('lib/private-queries call-time token', () => {
  it('sends nothing when the session is gone by the time the query runs', async () => {
    const fetcher = vi.fn(async () => 'rows');

    await expect(withCurrentAccessToken(fetcher, async () => null)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('passes the token Auth holds at call time, not one captured earlier', async () => {
    const fetcher = vi.fn(async (accessToken: string) => accessToken);

    await expect(
      withCurrentAccessToken(fetcher, async () => sessionFor('user-a', 'current-token')),
    ).resolves.toBe('current-token');
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('current-token');
  });
});
