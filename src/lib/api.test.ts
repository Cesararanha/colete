import { describe, expect, it, vi } from 'vitest';

import { AppError, createApiClient } from './api';
import type { ColeteSupabaseClient } from './supabase';

const REQUEST_ID = '01890f7e-e948-7c53-b13a-4a36e4b7d21e';

function authenticatedSupabase() {
  return {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: 'local-test-access-token' } },
        error: null,
      })),
    },
  } as unknown as ColeteSupabaseClient;
}

function success(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}

describe('lib/api identity mutations', () => {
  it('keeps untouched profile fields absent from the wire payload', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      success({ data: { ok: true }, request_id: REQUEST_ID }),
    );
    const client = createApiClient({
      fetch: fetcher as typeof fetch,
      supabase: authenticatedSupabase(),
      supabaseConfig: { publishableKey: 'sb_publishable_test', url: 'http://local.test' },
      uuid: () => REQUEST_ID,
    });

    await client.updateProfile({ nickname: 'Capitã' }).execute();

    const init = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      patch: { nickname: 'Capitã' },
      request_id: REQUEST_ID,
    });
  });

  it('preserves an explicit null that clears an optional profile field on the wire', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      success({ data: { ok: true }, request_id: REQUEST_ID }),
    );
    const client = createApiClient({
      fetch: fetcher as typeof fetch,
      supabase: authenticatedSupabase(),
      supabaseConfig: { publishableKey: 'sb_publishable_test', url: 'http://local.test' },
      uuid: () => REQUEST_ID,
    });

    await client.updateProfile({ nickname: null }).execute();

    const init = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      patch: { nickname: null },
      request_id: REQUEST_ID,
    });
  });

  it('rejects an optional text made only of spaces before anything reaches the wire', () => {
    const fetcher = vi.fn();
    const client = createApiClient({
      fetch: fetcher,
      supabase: authenticatedSupabase(),
      supabaseConfig: { publishableKey: 'sb_publishable_test', url: 'http://local.test' },
      uuid: () => REQUEST_ID,
    });

    expect(() => client.updateProfile({ nickname: '   ' })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' }),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['input_hmac', 'hash_key_version', 'auth_user_id', 'profile_id', 'session_id'])(
    'refuses the internal-only field %s before transport',
    (field) => {
      const fetcher = vi.fn();
      const client = createApiClient({
        fetch: fetcher,
        supabase: authenticatedSupabase(),
        supabaseConfig: { publishableKey: 'sb_publishable_test', url: 'http://local.test' },
        uuid: () => REQUEST_ID,
      });

      expect(() => client.updateProfile({ [field]: 'forbidden' } as never)).toThrowError(AppError);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('creates one request_id per intent and preserves it in retry', async () => {
    const seenBodies: unknown[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { request_id: string };
      seenBodies.push(body);
      return success({ data: { ok: true }, request_id: body.request_id });
    });
    const ids = [REQUEST_ID, '01890f7e-e948-7c53-b13a-4a36e4b7d22e'];
    const client = createApiClient({
      fetch: fetcher as typeof fetch,
      supabase: authenticatedSupabase(),
      supabaseConfig: { publishableKey: 'sb_publishable_test', url: 'http://local.test' },
      uuid: () => ids.shift() ?? REQUEST_ID,
    });

    const first = client.updateProfile({ nickname: 'Ana' });
    const second = client.updateProfile({ nickname: 'Bia' });
    await first.execute();
    await first.retry();

    expect(first.requestId).toBe(REQUEST_ID);
    expect(second.requestId).not.toBe(first.requestId);
    expect(seenBodies).toEqual([
      { patch: { nickname: 'Ana' }, request_id: REQUEST_ID },
      { patch: { nickname: 'Ana' }, request_id: REQUEST_ID },
    ]);
  });

  it('serializes an intent once before mutable input can change', async () => {
    const bodies: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return success({ data: { ok: true }, request_id: REQUEST_ID });
    });
    const client = createApiClient({
      fetch: fetcher as typeof fetch,
      supabase: authenticatedSupabase(),
      supabaseConfig: { publishableKey: 'sb_publishable_test', url: 'http://local.test' },
      uuid: () => REQUEST_ID,
    });
    const patch: { nickname: string } = { nickname: 'Ana' };
    const intent = client.updateProfile(patch);

    patch.nickname = 'Bia';
    await intent.execute();
    patch.nickname = 'Clara';
    await intent.retry();

    expect(bodies).toEqual([
      JSON.stringify({ request_id: REQUEST_ID, patch: { nickname: 'Ana' } }),
      JSON.stringify({ request_id: REQUEST_ID, patch: { nickname: 'Ana' } }),
    ]);
  });

  it('automatically retries transport failure with the same request_id', async () => {
    const bodies: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new TypeError('network unavailable');
      return success({ data: { ok: true }, request_id: REQUEST_ID });
    });
    const client = createApiClient({
      fetch: fetcher as typeof fetch,
      sleep: async () => undefined,
      supabase: authenticatedSupabase(),
      supabaseConfig: { publishableKey: 'sb_publishable_test', url: 'http://local.test' },
      uuid: () => REQUEST_ID,
    });

    await client.updateProfile({ nickname: 'Ana' }).execute();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it('never automatically retries a business error', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'VALIDATION', message: 'fallback' },
            request_id: REQUEST_ID,
          }),
          { status: 422 },
        ),
    );
    const client = createApiClient({
      fetch: fetcher as typeof fetch,
      sleep: async () => undefined,
      supabase: authenticatedSupabase(),
      supabaseConfig: { publishableKey: 'sb_publishable_test', url: 'http://local.test' },
      uuid: () => REQUEST_ID,
    });

    await expect(client.updateProfile({ nickname: 'Ana' }).execute()).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never automatically retries a malformed 4xx response', async () => {
    const fetcher = vi.fn(async () => new Response('not-json', { status: 422 }));
    const client = createApiClient({
      fetch: fetcher as typeof fetch,
      sleep: async () => undefined,
      supabase: authenticatedSupabase(),
      supabaseConfig: { publishableKey: 'sb_publishable_test', url: 'http://local.test' },
      uuid: () => REQUEST_ID,
    });

    await expect(client.updateProfile({ nickname: 'Ana' }).execute()).rejects.toMatchObject({
      name: 'NonRetryableResponseError',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('automatically retries a malformed 5xx response', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('not-json', { status: 503 }))
      .mockResolvedValueOnce(success({ data: { ok: true }, request_id: REQUEST_ID }));
    const client = createApiClient({
      fetch: fetcher as typeof fetch,
      sleep: async () => undefined,
      supabase: authenticatedSupabase(),
      supabaseConfig: { publishableKey: 'sb_publishable_test', url: 'http://local.test' },
      uuid: () => REQUEST_ID,
    });

    await expect(client.updateProfile({ nickname: 'Ana' }).execute()).resolves.toEqual({
      ok: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('treats INTERNAL as a transport failure and retries automatically', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: 'INTERNAL', message: 'fallback' },
            request_id: REQUEST_ID,
          }),
          { status: 500 },
        ),
      )
      .mockResolvedValueOnce(success({ data: { ok: true }, request_id: REQUEST_ID }));
    const client = createApiClient({
      fetch: fetcher as typeof fetch,
      sleep: async () => undefined,
      supabase: authenticatedSupabase(),
      supabaseConfig: { publishableKey: 'sb_publishable_test', url: 'http://local.test' },
      uuid: () => REQUEST_ID,
    });

    await expect(client.updateProfile({ nickname: 'Ana' }).execute()).resolves.toEqual({
      ok: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('marks IDEMPOTENCY_WAIT_TIMEOUT retryable and reuses the request_id consciously', async () => {
    const bodies: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            error: { code: 'IDEMPOTENCY_WAIT_TIMEOUT', message: 'still running' },
            request_id: REQUEST_ID,
          }),
          { status: 503 },
        );
      }
      return success({ data: { ok: true }, request_id: REQUEST_ID });
    });
    const client = createApiClient({
      fetch: fetcher as typeof fetch,
      sleep: async () => undefined,
      supabase: authenticatedSupabase(),
      supabaseConfig: { publishableKey: 'sb_publishable_test', url: 'http://local.test' },
      uuid: () => REQUEST_ID,
    });
    const intent = client.updateProfile({ nickname: 'Ana' });

    await expect(intent.execute()).rejects.toMatchObject({
      code: 'IDEMPOTENCY_WAIT_TIMEOUT',
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(intent.retry()).resolves.toEqual({ ok: true });
    expect(bodies[0]).toBe(bodies[1]);
  });
});

describe('lib/api authentication boundaries', () => {
  it('uses the gate session token for the deletion projection', async () => {
    const getSession = vi.fn();
    const setHeader = vi.fn(async () => ({ data: [], error: null, status: 200 }));
    const rpc = vi.fn(() => ({ setHeader }));
    const client = createApiClient({
      supabase: { auth: { getSession }, rpc } as unknown as ColeteSupabaseClient,
    });

    await expect(client.getOwnDeletionRequest('session-from-gate')).resolves.toBeNull();

    expect(rpc).toHaveBeenCalledExactlyOnceWith('get_own_deletion_request');
    expect(setHeader).toHaveBeenCalledExactlyOnceWith('Authorization', 'Bearer session-from-gate');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('sends the caller token with the export projection, never the implicit session', async () => {
    const getSession = vi.fn();
    const setHeader = vi.fn(async () => ({ data: [], error: null, status: 200 }));
    const rpc = vi.fn(() => ({ setHeader }));
    const client = createApiClient({
      supabase: { auth: { getSession }, rpc } as unknown as ColeteSupabaseClient,
    });

    await expect(client.getOwnDataExports('session-from-query')).resolves.toEqual([]);

    expect(rpc).toHaveBeenCalledExactlyOnceWith('get_own_data_exports');
    expect(setHeader).toHaveBeenCalledExactlyOnceWith('Authorization', 'Bearer session-from-query');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('keeps a genuinely invalid gate session terminal', async () => {
    const setHeader = vi.fn(async () => ({
      data: null,
      error: { message: 'invalid JWT' },
      status: 401,
    }));
    const rpc = vi.fn(() => ({ setHeader }));
    const client = createApiClient({
      supabase: { rpc } as unknown as ColeteSupabaseClient,
    });

    await expect(client.getOwnDeletionRequest('invalid-session')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'invalid JWT',
    });
    expect(setHeader).toHaveBeenCalledTimes(1);
  });

  it('keeps the Supabase Auth error code on the refusal it raises', async () => {
    const updateUser = vi.fn(async () => ({
      data: { user: null },
      error: { code: 'same_password', message: 'New password should be different', status: 422 },
    }));
    const signInWithPassword = vi.fn(async () => ({
      data: { session: null, user: null },
      error: { code: 'invalid_credentials', message: 'Invalid login credentials', status: 400 },
    }));
    const client = createApiClient({
      supabase: { auth: { signInWithPassword, updateUser } } as unknown as ColeteSupabaseClient,
    });

    await expect(client.updatePassword('Frase-segura-2026')).rejects.toMatchObject({
      authCode: 'same_password',
      code: 'VALIDATION',
    });
    await expect(client.signInWithPassword('a@colete.test', 'x')).rejects.toMatchObject({
      authCode: 'invalid_credentials',
      code: 'UNAUTHENTICATED',
    });
  });

  it('signs out only the current session', async () => {
    const signOut = vi.fn(async () => ({ error: null }));
    const client = createApiClient({
      supabase: { auth: { signOut } } as unknown as ColeteSupabaseClient,
    });

    await client.signOutLocally();

    expect(signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
  });
});

describe('UI-B group targets and transport', () => {
  it('sends each business target exclusively to its contracted group endpoint', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const client = createApiClient({
      fetch: (async (url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url: String(url), body });
        return success({
          data: { outcome: { group_id: 'group', logical_result: 'done' } },
          request_id: body.request_id,
        });
      }) as typeof fetch,
      supabase: authenticatedSupabase(),
      supabaseConfig: { url: 'http://local.test', publishableKey: 'sb_publishable_test' },
      uuid: () => REQUEST_ID,
    });
    await client.approveMember('group', 'target', true).execute();
    await client.removeMember('group', 'target', 'reason').execute();
    await client.setMemberRole('group', 'target', 'organizer').execute();
    await client.renameGroup('group', 'New name').execute();
    await client.transferOwnership('group', 'target').execute();
    expect(calls.map((call) => call.url)).toEqual(
      ['approve_member', 'remove_member', 'set_role', 'rename_group', 'transfer_ownership'].map(
        (name) => `http://local.test/functions/v1/groups/${name}`,
      ),
    );
    expect(calls.map((call) => call.body)).toEqual([
      { request_id: REQUEST_ID, group_id: 'group', profile_id: 'target', approve: true },
      { request_id: REQUEST_ID, group_id: 'group', profile_id: 'target', reason: 'reason' },
      { request_id: REQUEST_ID, group_id: 'group', profile_id: 'target', role: 'organizer' },
      { request_id: REQUEST_ID, group_id: 'group', name: 'New name' },
      { request_id: REQUEST_ID, group_id: 'group', new_owner_id: 'target' },
    ]);
  });
  it('does not relax rejection of nested actor fields inside a business target', () => {
    const client = createApiClient({ fetch: vi.fn() });
    expect(() =>
      client.approveMember('group', { actor_auth_user_id: 'forged' } as never, true),
    ).toThrowError(AppError);
    expect(() =>
      client.removeMember('group', 'target', { input_hmac: 'forged' } as never),
    ).toThrowError(AppError);
  });
});
