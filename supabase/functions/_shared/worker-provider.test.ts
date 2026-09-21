import { afterEach, describe, expect, it, vi } from 'vitest';

const probeEffect = {
  id: 'aaaaaaaa-0000-4000-8000-000000000021',
  kind: 'delete_data_export',
  resource_type: 'data_export',
  resource_id: 'bbbbbbbb-0000-4000-8000-000000000022',
  dedupe_key: 'delete_data_export:classification-fixture',
  attempts: 1,
  lease_token: 'cccccccc-0000-4000-8000-000000000023',
  lease_until: '2099-09-21T01:00:00.000Z',
};

type ProbeScenario = {
  expectedCode: string | null;
  expectedMethods: string[];
  expectedResult: 'succeeded' | 'permanent_failure' | 'retryable_failure';
  respond: (method: string) => Promise<Response> | Response;
};

async function runProbeScenario(scenario: ProbeScenario) {
  let served: ((request: Request) => Promise<Response>) | undefined;
  const completions: Array<Record<string, unknown>> = [];
  const confirmations: Array<Record<string, unknown>> = [];
  const storageMethods: string[] = [];

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
        return Response.json(probeEffect);
      }
      if (url.pathname === '/rest/v1/rpc/worker_get_deletion_effect_target') {
        return Response.json({
          action: 'storage',
          bucket: 'data-exports',
          path: 'exports/profile/export.zip',
        });
      }
      if (url.pathname === '/storage/v1/object/data-exports/exports/profile/export.zip') {
        const method = init?.method ?? 'GET';
        const descriptor = new Headers(init?.headers).has('range') ? `${method}+range` : method;
        storageMethods.push(descriptor);
        return scenario.respond(descriptor);
      }
      if (url.pathname === '/rest/v1/rpc/worker_confirm_deletion_effect') {
        confirmations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ status: 'confirmed' });
      }
      if (url.pathname === '/rest/v1/rpc/worker_complete_external_effect') {
        completions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ status: 'recorded' });
      }
      if (url.pathname === '/rest/v1/rpc/worker_finish_job') {
        return Response.json({ status: 'succeeded' });
      }
      throw new Error(`unexpected worker fetch: ${url.pathname}`);
    }),
  );

  await import('../worker/index.ts');
  const response = await served!(
    new Request('http://localhost/worker/process_external_effects', {
      method: 'POST',
      headers: { Authorization: 'Bearer cron-test' },
    }),
  );

  expect(response.status).toBe(200);
  expect(storageMethods).toEqual(scenario.expectedMethods);
  expect(confirmations).toHaveLength(scenario.expectedResult === 'succeeded' ? 1 : 0);
  expect(completions).toEqual([
    {
      p_effect_id: probeEffect.id,
      p_lease_token: probeEffect.lease_token,
      p_result: scenario.expectedResult,
      p_error_code: scenario.expectedCode,
    },
  ]);
}

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

  it('reads a Storage 400 whose body says not_found as reconciled absence', async () => {
    let served: ((request: Request) => Promise<Response>) | undefined;
    const completions: Array<Record<string, unknown>> = [];
    const confirmations: Array<Record<string, unknown>> = [];
    const storageMethods: string[] = [];
    const effect = {
      id: 'aaaaaaaa-0000-4000-8000-000000000011',
      kind: 'delete_data_export',
      resource_type: 'data_export',
      resource_id: 'bbbbbbbb-0000-4000-8000-000000000012',
      dedupe_key: 'delete_data_export:fixture',
      attempts: 1,
      lease_token: 'cccccccc-0000-4000-8000-000000000013',
      lease_until: '2099-09-21T01:00:00.000Z',
    };
    const notFound = () =>
      Response.json(
        { statusCode: '404', error: 'not_found', message: 'Object not found' },
        { status: 400 },
      );

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
            bucket: 'data-exports',
            path: 'exports/profile/export.zip',
          });
        }
        if (url.pathname === '/storage/v1/object/data-exports/exports/profile/export.zip') {
          storageMethods.push(
            `${init?.method ?? 'GET'}${init?.headers && 'range' in init.headers ? '+range' : ''}`,
          );
          // HEAD carries no body: the local Storage answers a bare 400.
          if (init?.method === 'HEAD') return new Response(null, { status: 400 });
          return notFound();
        }
        if (url.pathname === '/rest/v1/rpc/worker_confirm_deletion_effect') {
          confirmations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Response.json({ status: 'confirmed' });
        }
        if (url.pathname === '/rest/v1/rpc/worker_complete_external_effect') {
          completions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Response.json({ status: 'succeeded' });
        }
        if (url.pathname === '/rest/v1/rpc/worker_finish_job') {
          return Response.json({ status: 'succeeded' });
        }
        throw new Error(`unexpected worker fetch: ${url.pathname}`);
      }),
    );

    await import('../worker/index.ts');
    const response = await served!(
      new Request('http://localhost/worker/process_external_effects', {
        method: 'POST',
        headers: { Authorization: 'Bearer cron-test' },
      }),
    );

    expect(response.status).toBe(200);
    expect(storageMethods).toEqual(['HEAD', 'GET+range']);
    expect(confirmations).toEqual([{ p_effect_id: effect.id, p_lease_token: effect.lease_token }]);
    expect(completions).toEqual([
      {
        p_effect_id: effect.id,
        p_lease_token: effect.lease_token,
        p_result: 'succeeded',
        p_error_code: null,
      },
    ]);
  });

  it.each([
    {
      name: '404 as reconciled absence',
      expectedCode: null,
      expectedMethods: ['HEAD'],
      expectedResult: 'succeeded' as const,
      respond: () => new Response(null, { status: 404 }),
    },
    {
      name: '400 error:not_found as reconciled absence after a ranged probe',
      expectedCode: null,
      expectedMethods: ['HEAD', 'GET+range'],
      expectedResult: 'succeeded' as const,
      respond: (method: string) =>
        method === 'HEAD'
          ? new Response(null, { status: 400 })
          : Response.json({ error: 'not_found' }, { status: 400 }),
    },
    {
      name: '400 statusCode:404 as reconciled absence after a ranged probe',
      expectedCode: null,
      expectedMethods: ['HEAD', 'GET+range'],
      expectedResult: 'succeeded' as const,
      respond: (method: string) =>
        method === 'HEAD'
          ? new Response(null, { status: 400 })
          : Response.json({ statusCode: '404' }, { status: 400 }),
    },
    {
      name: '400 permission_denied as a permanent failure',
      expectedCode: 'STORAGE_UNAVAILABLE',
      expectedMethods: ['HEAD', 'GET+range'],
      expectedResult: 'permanent_failure' as const,
      respond: (method: string) =>
        method === 'HEAD'
          ? new Response(null, { status: 400 })
          : Response.json({ error: 'permission_denied' }, { status: 400 }),
    },
    ...[401, 403, 429, 500].map((status) => ({
      name: `${status} as a retryable failure`,
      expectedCode: 'STORAGE_UNAVAILABLE',
      expectedMethods: ['HEAD'],
      expectedResult: 'retryable_failure' as const,
      respond: () => new Response(null, { status }),
    })),
    {
      name: 'a network failure as retryable',
      expectedCode: 'EXTERNAL_PROVIDER_FAILURE',
      expectedMethods: ['HEAD'],
      expectedResult: 'retryable_failure' as const,
      respond: () => Promise.reject(new TypeError('network unavailable')),
    },
    {
      name: 'an unknown thrown value as retryable',
      expectedCode: 'EXTERNAL_PROVIDER_FAILURE',
      expectedMethods: ['HEAD'],
      expectedResult: 'retryable_failure' as const,
      respond: () => Promise.reject({ kind: 'unknown-provider-failure' }),
    },
  ])('classifies Storage $name', async (scenario) => {
    await runProbeScenario(scenario);
  });
});
