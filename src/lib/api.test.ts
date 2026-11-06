import { describe, expect, it, vi } from 'vitest';

import { createClient } from '@supabase/supabase-js';

import { AppError, createApiClient, TransportError } from './api';
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

  it.each([
    { status: 429, authCode: undefined },
    { status: 429, authCode: 'over_request_rate_limit' },
    { status: 400, authCode: 'over_email_send_rate_limit' },
  ])('classifies an Auth rate limit safely ($status / $authCode)', async ({ status, authCode }) => {
    const sdk = createClient('http://127.0.0.1:54321', 'sb_publishable_synthetic', {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        fetch: async () =>
          new Response(
            JSON.stringify({
              msg: 'RAW_SERVER_SENTINEL',
              ...(authCode === undefined ? {} : { error_code: authCode }),
            }),
            { status, headers: { 'content-type': 'application/json' } },
          ),
      },
    });
    const client = createApiClient({ supabase: sdk as ColeteSupabaseClient });
    await expect(
      client.signInWithPassword('synthetic@colete.test', 'Synthetic-2026'),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
      ...(authCode === undefined ? {} : { authCode }),
    });
  });

  it('keeps network and server failures as TransportError even with a rate-limit code', async () => {
    for (const status of [undefined, 0, 503]) {
      const client = createApiClient({
        supabase: {
          auth: {
            signInWithPassword: async () => ({
              data: { session: null, user: null },
              error: { status, code: 'over_request_rate_limit', message: 'RAW_SERVER_SENTINEL' },
            }),
          },
        } as unknown as ColeteSupabaseClient,
      });
      await expect(
        client.signInWithPassword('synthetic@colete.test', 'Synthetic-2026'),
      ).rejects.toBeInstanceOf(TransportError);
    }
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
    await client.setGroupAppearance('group', 'flame', 'lilac').execute();
    expect(calls.map((call) => call.url)).toEqual(
      [
        'approve_member',
        'remove_member',
        'set_role',
        'rename_group',
        'transfer_ownership',
        'set_group_appearance',
      ].map((name) => `http://local.test/functions/v1/groups/${name}`),
    );
    expect(calls.map((call) => call.body)).toEqual([
      { request_id: REQUEST_ID, group_id: 'group', profile_id: 'target', approve: true },
      { request_id: REQUEST_ID, group_id: 'group', profile_id: 'target', reason: 'reason' },
      { request_id: REQUEST_ID, group_id: 'group', profile_id: 'target', role: 'organizer' },
      { request_id: REQUEST_ID, group_id: 'group', name: 'New name' },
      { request_id: REQUEST_ID, group_id: 'group', new_owner_id: 'target' },
      { request_id: REQUEST_ID, group_id: 'group', icon: 'flame', color: 'lilac' },
    ]);
  });
  it('sends the edit and the cancellation of a match to the groups gateway, without the group', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const client = createApiClient({
      fetch: (async (url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url: String(url), body });
        return success({
          data: { outcome: { group_id: 'group', match_id: 'match', logical_result: 'done' } },
          request_id: body.request_id,
        });
      }) as typeof fetch,
      supabase: authenticatedSupabase(),
      supabaseConfig: { url: 'http://local.test', publishableKey: 'sb_publishable_test' },
      uuid: () => REQUEST_ID,
    });
    const config = {
      description: null,
      starts_at: '2026-10-21T22:00:00.000Z',
      ends_at: '2026-10-21T23:30:00.000Z',
      timezone: 'America/Sao_Paulo',
      location_name: 'Arena',
      location_address: null,
      latitude: null,
      longitude: null,
      field_slots: 14,
      field_price: '25.00',
    };
    await client.updateMatch('match', config).execute();
    await client.cancelMatch('match').execute();
    expect(calls).toEqual([
      {
        url: 'http://local.test/functions/v1/groups/update_match',
        body: { request_id: REQUEST_ID, match_id: 'match', config },
      },
      {
        url: 'http://local.test/functions/v1/groups/cancel_match',
        body: { request_id: REQUEST_ID, match_id: 'match' },
      },
    ]);
  });
  it('sends a rating with the rated member as a business target, and reads the ratings', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const client = createApiClient({
      fetch: (async (url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url: String(url), body });
        return success({ data: { group_id: 'group' }, request_id: body.request_id ?? REQUEST_ID });
      }) as typeof fetch,
      supabase: authenticatedSupabase(),
      supabaseConfig: { url: 'http://local.test', publishableKey: 'sb_publishable_test' },
      uuid: () => REQUEST_ID,
    });
    await client.setRating('group', 'member', 4).execute();
    await client.setRatingsVisibility('group', 'members').execute();
    await client.setRatingsVisibility('group', 'private').execute();
    await client.getGroupRatings('group');
    await client.getMyRating('group');
    expect(calls).toEqual([
      {
        url: 'http://local.test/functions/v1/groups/set_rating',
        body: { request_id: REQUEST_ID, group_id: 'group', profile_id: 'member', stars: 4 },
      },
      {
        url: 'http://local.test/functions/v1/groups/set_ratings_visibility',
        body: {
          request_id: REQUEST_ID,
          group_id: 'group',
          visibility: 'members',
          confirm_members_visibility: true,
        },
      },
      {
        url: 'http://local.test/functions/v1/groups/set_ratings_visibility',
        body: {
          request_id: REQUEST_ID,
          group_id: 'group',
          visibility: 'private',
          confirm_members_visibility: false,
        },
      },
      {
        url: 'http://local.test/functions/v1/groups/get_group_ratings',
        body: { group_id: 'group' },
      },
      { url: 'http://local.test/functions/v1/groups/get_my_rating', body: { group_id: 'group' } },
    ]);
  });
  it('sends a canceled match payment with the paid member as a business target', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const client = createApiClient({
      fetch: (async (url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url: String(url), body });
        return success({
          data: {
            outcome: {
              group_id: 'group',
              match_id: 'match',
              refund_id: 'refund',
              logical_result: 'canceled_payment_recorded',
            },
          },
          request_id: body.request_id,
        });
      }) as typeof fetch,
      supabase: authenticatedSupabase(),
      supabaseConfig: { url: 'http://local.test', publishableKey: 'sb_publishable_test' },
      uuid: () => REQUEST_ID,
    });

    await client.recordCanceledMatchPayment('match', 'member').execute();

    expect(calls).toEqual([
      {
        url: 'http://local.test/functions/v1/groups/record_canceled_match_payment',
        body: { request_id: REQUEST_ID, match_id: 'match', profile_id: 'member' },
      },
    ]);
  });
  it('sends the draw with the match and the number of teams only, and reads the teams', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const client = createApiClient({
      fetch: (async (url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url: String(url), body });
        return success({
          data: String(url).endsWith('/draw_teams')
            ? { outcome: { group_id: 'group', match_id: 'match', logical_result: 'teams_drawn' } }
            : { match_id: 'match', can_draw: false, team_count: null, stale: false, teams: [] },
          request_id: body.request_id ?? REQUEST_ID,
        });
      }) as typeof fetch,
      supabase: authenticatedSupabase(),
      supabaseConfig: { url: 'http://local.test', publishableKey: 'sb_publishable_test' },
      uuid: () => REQUEST_ID,
    });
    await client.drawTeams('match', 3, true).execute();
    await client.getMatchTeams('match');
    expect(calls).toEqual([
      {
        url: 'http://local.test/functions/v1/groups/draw_teams',
        body: {
          request_id: REQUEST_ID,
          match_id: 'match',
          team_count: 3,
          confirm_unequal_sizes: true,
        },
      },
      { url: 'http://local.test/functions/v1/groups/get_match_teams', body: { match_id: 'match' } },
    ]);
  });
  it('sends the deletion of a group to the groups gateway with the group alone', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const client = createApiClient({
      fetch: (async (url, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url: String(url), body });
        return success({
          data: { outcome: { group_id: 'group', logical_result: 'group_deleted' } },
          request_id: body.request_id,
        });
      }) as typeof fetch,
      supabase: authenticatedSupabase(),
      supabaseConfig: { url: 'http://local.test', publishableKey: 'sb_publishable_test' },
      uuid: () => REQUEST_ID,
    });
    await expect(client.deleteGroup('group').execute()).resolves.toEqual({
      outcome: { group_id: 'group', logical_result: 'group_deleted' },
    });
    expect(calls).toEqual([
      {
        url: 'http://local.test/functions/v1/groups/delete_group',
        body: { request_id: REQUEST_ID, group_id: 'group' },
      },
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

describe('lib/api Edge reads', () => {
  const MATCH_ID = '0190d1c2-0000-7000-8000-000000000001';
  // What the Edge runtime itself answers when a function never responds.
  const runtimeFailure = (status: number, code: string) =>
    new Response(JSON.stringify({ code, message: 'Function exited due to an error' }), {
      headers: { 'content-type': 'application/json' },
      status,
    });
  const teams = { match_id: MATCH_ID, teams: [], stale: false, can_draw: false };
  const reader = (fetcher: ReturnType<typeof vi.fn>, sleep = vi.fn(async () => undefined)) =>
    createApiClient({
      fetch: fetcher as unknown as typeof fetch,
      sleep,
      supabase: authenticatedSupabase(),
      supabaseConfig: { publishableKey: 'sb_publishable_test', url: 'http://local.test' },
    });

  it('reads again when the runtime retired the worker mid-request (polimento final)', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(runtimeFailure(500, 'WORKER_ERROR'))
      .mockResolvedValueOnce(runtimeFailure(546, 'WORKER_LIMIT'))
      .mockResolvedValueOnce(success({ data: teams, request_id: REQUEST_ID }));
    await expect(reader(fetcher, sleep).getMatchTeams(MATCH_ID)).resolves.toEqual(teams);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[150], [300]]);
  });

  it('gives up after the same bounded retries as a mutation', async () => {
    const fetcher = vi.fn(async () => runtimeFailure(503, 'BOOT_ERROR'));
    await expect(reader(fetcher).getMatchTeams(MATCH_ID)).rejects.toBeInstanceOf(TransportError);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('answers at once for the gateway envelope, a refusal or a network failure', async () => {
    const internal = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'INTERNAL', message: 'x' }, request_id: REQUEST_ID }),
          { status: 500 },
        ),
    );
    await expect(reader(internal).getMatchTeams(MATCH_ID)).rejects.toBeInstanceOf(TransportError);
    expect(internal).toHaveBeenCalledTimes(1);
    const refused = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'NOT_FOUND', message: 'not found' },
            request_id: REQUEST_ID,
          }),
          { status: 404 },
        ),
    );
    await expect(reader(refused).getMatchTeams(MATCH_ID)).rejects.toBeInstanceOf(AppError);
    expect(refused).toHaveBeenCalledTimes(1);
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(reader(offline).getMatchTeams(MATCH_ID)).rejects.toBeInstanceOf(TransportError);
    expect(offline).toHaveBeenCalledTimes(1);
  });

  it('does not read again once the screen gave the read up', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      controller.abort();
      return runtimeFailure(500, 'WORKER_ERROR');
    });
    const client = reader(fetcher);
    await expect(client.getMatchTeams(MATCH_ID, controller.signal)).rejects.toBeInstanceOf(
      TransportError,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
