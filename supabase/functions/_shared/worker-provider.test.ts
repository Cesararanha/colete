import { afterEach, describe, expect, it, vi } from 'vitest';

describe('worker provider HTTP classification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('turns a Storage 429 into retryable effect completion', async () => {
    let served: ((request: Request) => Promise<Response>) | undefined;
    const completions: Array<Record<string, unknown>> = [];
    const effect = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      kind: 'delete_storage_object',
      resource_type: 'profile_avatar',
      resource_id: 'bbbbbbbb-0000-4000-8000-000000000002',
      dedupe_key: 'delete_storage_object:profile_avatar:fixture',
      attempts: 1,
      lease_token: 'cccccccc-0000-4000-8000-000000000003',
      lease_until: '2099-09-21T01:00:00.000Z',
    };

    vi.stubGlobal('Deno', {
      env: {
        get: (name: string) =>
          ({
            SUPABASE_URL: 'http://supabase.test',
            SUPABASE_SECRET_KEY: 'sb_secret_test',
            WORKER_CRON_SECRET: 'cron-test',
          })[name],
      },
      serve: (handler: (request: Request) => Promise<Response>) => {
        served = handler;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === 'string' || input instanceof URL ? input.toString() : input.url,
        );
        if (url.pathname === '/rest/v1/rpc/worker_begin_job') {
          return Response.json({
            acquired: true,
            run_id: 1,
            job_name: 'process_external_effects',
            scheduled_for: '2026-09-21T00:00:00.000Z',
            soft_deadline_seconds: 120,
            max_effects: 1,
          });
        }
        if (url.pathname === '/rest/v1/rpc/worker_acquire_external_effect') {
          return Response.json(effect);
        }
        if (url.pathname === '/rest/v1/rpc/worker_get_deletion_effect_target') {
          return Response.json({
            action: 'storage',
            bucket: 'avatars',
            path: 'profiles/avatar.webp',
          });
        }
        if (url.pathname === '/storage/v1/object/avatars/profiles/avatar.webp') {
          expect(init?.method).toBe('HEAD');
          return new Response(null, { status: 200 });
        }
        if (url.pathname === '/storage/v1/object/avatars') {
          expect(init?.method).toBe('DELETE');
          return new Response(null, { status: 429 });
        }
        if (url.pathname === '/rest/v1/rpc/worker_complete_external_effect') {
          completions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Response.json({ status: 'failed_retryable' });
        }
        if (url.pathname === '/rest/v1/rpc/worker_finish_job') {
          return Response.json({ status: 'succeeded' });
        }
        throw new Error(`unexpected worker fetch: ${url.pathname}`);
      }),
    );

    await import('../worker/index.ts');
    expect(served).toBeTypeOf('function');
    const response = await served!(
      new Request('http://localhost/worker/process_external_effects', {
        method: 'POST',
        headers: { Authorization: 'Bearer cron-test' },
      }),
    );

    expect(response.status).toBe(200);
    expect(completions).toEqual([
      {
        p_effect_id: effect.id,
        p_lease_token: effect.lease_token,
        p_result: 'retryable_failure',
        p_error_code: 'STORAGE_UNAVAILABLE',
      },
    ]);
  });
});
