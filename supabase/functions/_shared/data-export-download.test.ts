import { describe, expect, it, vi } from 'vitest';
import {
  exportDownloadHeaders,
  handleDataExportDownload,
  hasRecentReauthentication,
  isDirectZipObject,
  purgeAfterStream,
} from './data-export-download.ts';

describe('data export download boundary', () => {
  const exportId = '13800000-0000-4000-8000-000000000001';
  const request = () =>
    new Request(`http://localhost/data-exports/${exportId}/content`, {
      headers: { authorization: 'Bearer verified-token' },
    });
  const dependencies = (claims: Record<string, unknown>) => ({
    verifyToken: vi.fn(async () => ({ authUserId: 'auth-user', claims })),
    consume: vi.fn(async () => ({
      storage_path: 'exports/object.zip',
      content_digest: 'a'.repeat(64),
    })),
    openObject: vi.fn(
      async () =>
        new Response('zip', { status: 200, headers: { 'content-type': 'application/zip' } }),
    ),
    enqueuePurge: vi.fn(async () => undefined),
    nowSeconds: () => 1000,
  });

  it('uses an eligible amr timestamp, never token iat', () => {
    expect(
      hasRecentReauthentication({ iat: 999, amr: [{ method: 'password', timestamp: 750 }] }, 1000),
    ).toBe(true);
    expect(
      hasRecentReauthentication({ iat: 999, amr: [{ method: 'password', timestamp: 699 }] }, 1000),
    ).toBe(false);
    expect(hasRecentReauthentication({ iat: 1000 }, 1000)).toBe(false);
    expect(
      hasRecentReauthentication(
        { iat: 1000, amr: [{ method: 'refresh_token', timestamp: 1000 }] },
        1000,
      ),
    ).toBe(false);
  });

  it('fixes attachment, MIME and private no-store without a location capability', () => {
    const headers = exportDownloadHeaders('abc');
    expect(headers.get('content-type')).toBe('application/zip');
    expect(headers.get('content-disposition')).toContain('attachment');
    expect(headers.get('cache-control')).toBe('private, no-store');
    expect(headers.has('location')).toBe(false);
  });

  it('rejects a non-ZIP JSON payload through the complete Edge path', async () => {
    const deps = dependencies({
      aud: 'authenticated',
      session_id: 'session',
      amr: [{ method: 'password', timestamp: 1000 }],
    });
    deps.openObject.mockResolvedValueOnce(
      new Response(JSON.stringify({ signedURL: 'https://storage.invalid/signed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const response = await handleDataExportDownload(request(), deps);
    expect(response.status).toBe(410);
    expect(deps.enqueuePurge).toHaveBeenCalledOnce();
    expect(isDirectZipObject(await deps.openObject.mock.results[0].value)).toBe(false);
  });

  it('observes that the real Storage client never emits a signed URL', async () => {
    let served: ((request: Request) => Promise<Response>) | undefined;
    const signingRequests = vi.fn();
    const storageFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(
          typeof input === 'string' || input instanceof URL ? input.toString() : input.url,
        );
        if (url.pathname.includes('/storage/v1/object/sign/')) {
          signingRequests(url.pathname);
          return new Response(
            JSON.stringify({ signedURL: 'https://storage.invalid/forbidden-capability' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.pathname === '/auth/v1/user') {
          return new Response(JSON.stringify({ id: 'auth-user' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.pathname === '/rest/v1/rpc/consume_data_export') {
          return new Response(
            JSON.stringify({
              storage_path: 'exports/profile/export.zip',
              content_digest: 'a'.repeat(64),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.pathname === '/rest/v1/rpc/enqueue_data_export_purge') {
          return new Response(JSON.stringify({ queued: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.pathname === '/storage/v1/object/data-exports/exports/profile/export.zip') {
          return new Response('zip', {
            status: 200,
            headers: { 'content-type': 'application/zip' },
          });
        }
        throw new Error(`unexpected Edge fetch: ${url.pathname} ${init?.method ?? 'GET'}`);
      },
    );
    vi.stubGlobal('fetch', storageFetch);
    vi.stubGlobal('Deno', {
      env: {
        get: (name: string) =>
          ({
            SUPABASE_URL: 'http://supabase.test',
            SUPABASE_PUBLISHABLE_KEY: 'publishable-test-key',
            SUPABASE_SECRET_KEY: 'secret-test-key',
          })[name],
      },
      serve: (handler: (request: Request) => Promise<Response>) => {
        served = handler;
      },
    });
    vi.resetModules();
    try {
      await import('../data-exports/index.ts');
      expect(served).toBeTypeOf('function');
      const claims = btoa(
        JSON.stringify({
          aud: 'authenticated',
          session_id: 'session',
          amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }],
        }),
      )
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '');
      const response = await served!(
        new Request(`http://localhost/data-exports/${exportId}/content`, {
          headers: { authorization: `Bearer header.${claims}.signature` },
        }),
      );
      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('zip');
      expect(response.headers.has('location')).toBe(false);
      expect(signingRequests).not.toHaveBeenCalled();
      expect(
        storageFetch.mock.calls.filter(([input]) => {
          const url = new URL(
            typeof input === 'string' || input instanceof URL ? input.toString() : input.url,
          );
          return url.pathname === '/storage/v1/object/data-exports/exports/profile/export.zip';
        }),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['missing', undefined],
    ['old', [{ method: 'password', timestamp: 699 }]],
  ])(
    'refuses %s reauthentication through the complete Edge path before CAS',
    async (_name, amr) => {
      const deps = dependencies({
        aud: 'authenticated',
        session_id: 'session',
        ...(amr === undefined ? {} : { amr }),
      });
      const response = await handleDataExportDownload(request(), deps);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'RECENT_REAUTH_REQUIRED' } });
      expect(deps.consume).not.toHaveBeenCalled();
    },
  );

  it('enqueues purge after completion and cancellation', async () => {
    const completed = vi.fn(async () => undefined);
    const bytes = new Uint8Array(
      await new Response(
        purgeAfterStream(new Blob(['zip']).stream() as ReadableStream<Uint8Array>, completed),
      ).arrayBuffer(),
    );
    expect(new TextDecoder().decode(bytes)).toBe('zip');
    expect(completed).toHaveBeenCalledOnce();

    const cancelled = vi.fn(async () => undefined);
    const stream = purgeAfterStream(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1]));
        },
      }),
      cancelled,
    );
    await stream.cancel();
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('enqueues purge when the provider stream errors', async () => {
    const errored = vi.fn(async () => undefined);
    const stream = purgeAfterStream(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('provider stream failed'));
        },
      }),
      errored,
    );
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow('provider stream failed');
    expect(errored).toHaveBeenCalledOnce();
  });
});
