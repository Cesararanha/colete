import { describe, expect, it, vi } from 'vitest';
import { allowedBrowserOrigins, BROWSER_REQUEST_HEADERS, withBrowserCors } from './browser-cors';

const ORIGIN = 'https://colete.example.invalid';
const environment =
  (origins: string | undefined, local = false) =>
  (name: string) =>
    name === 'APP_ALLOWED_ORIGINS'
      ? origins
      : name === 'COLETE_LOCAL_STACK'
        ? String(local)
        : undefined;
const request = (origin: string | undefined, method = 'POST', headers = {}, body?: string) =>
  new Request('https://api.example.invalid/identity/complete_profile', {
    method,
    ...(body === undefined ? {} : { body }),
    headers: { ...(origin === undefined ? {} : { Origin: origin }), ...headers },
  });

function cors(response: Response) {
  return Object.fromEntries(
    [...response.headers].filter(([name]) => name.startsWith('access-control')),
  );
}

describe('browser CORS transport', () => {
  it.each([
    undefined,
    '',
    ' ',
    '*',
    'https://*.example.invalid',
    `${ORIGIN},*`,
    `${ORIGIN}/`,
    `${ORIGIN}/path`,
    `${ORIGIN}?query`,
    `${ORIGIN}#hash`,
    'https://user:pass@example.invalid',
    'null',
    'http://localhost:4173',
    `${ORIGIN},`,
    `,${ORIGIN}`,
    `${ORIGIN},,https://other.example.invalid`,
    `${ORIGIN},https://co lete.example.invalid`,
  ])('fails closed for invalid config %s', (value) => {
    expect(allowedBrowserOrigins(environment(value))).toEqual(new Set());
  });
  it('accepts only explicitly listed HTTPS origins and local loopback in local mode', () => {
    expect(
      allowedBrowserOrigins(environment(` ${ORIGIN}, https://other.example.invalid `)),
    ).toEqual(new Set([ORIGIN, 'https://other.example.invalid']));
    expect(
      allowedBrowserOrigins(environment('http://localhost:4500,http://127.0.0.1:6000', true)).size,
    ).toBe(2);
    expect(allowedBrowserOrigins(environment('http://192.168.1.2:4173', true)).size).toBe(0);
    expect(allowedBrowserOrigins(environment(undefined, true)).size).toBe(0);
  });
  it('handles preflight before the real handler without authentication or effects', async () => {
    const handler = vi.fn(async () => new Response(null, { status: 401 }));
    const response = await withBrowserCors(handler, environment(ORIGIN), ['POST'])(
      request(
        ORIGIN,
        'OPTIONS',
        {
          Authorization: 'Bearer valid-local-fixture',
          'content-type': 'application/json',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Authorization, Apikey, Content-Type, X-Client-Info',
        },
        JSON.stringify({ request_id: 'preflight-fixture', name: 'No effects' }),
      ),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(handler).not.toHaveBeenCalled();
    expect(cors(response)).toEqual({
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': BROWSER_REQUEST_HEADERS.join(', '),
      'access-control-max-age': '600',
    });
    expect(response.headers.get('vary')).toBe('Origin');
  });
  it.each([
    ['https://sub.colete.example.invalid', 'POST', 'apikey'],
    [`${ORIGIN}:8443`, 'POST', 'apikey'],
    ['http://colete.example.invalid', 'POST', 'apikey'],
    [`${ORIGIN}.evil.com`, 'POST', 'apikey'],
    ['https://COLETE.example.invalid', 'POST', 'apikey'],
    ['HTTPS://colete.example.invalid', 'POST', 'apikey'],
    [`${ORIGIN}.`, 'POST', 'apikey'],
    [`${ORIGIN}, https://evil.example.invalid`, 'POST', 'apikey'],
    ['null', 'POST', 'apikey'],
    [ORIGIN, 'post', 'apikey'],
    [undefined, 'POST', 'apikey'],
    [ORIGIN, 'DELETE', 'apikey'],
    [ORIGIN, 'POST', 'x-unexpected'],
    [ORIGIN, '', 'apikey'],
    [ORIGIN, 'POST', 'apikey,'],
  ])('refuses preflight %s %s %s', async (origin, method, header) => {
    const handler = vi.fn();
    const response = await withBrowserCors(handler, environment(ORIGIN), ['POST'])(
      request(origin, 'OPTIONS', {
        'Access-Control-Request-Method': method!,
        'Access-Control-Request-Headers': header!,
      }),
    );
    expect(response.status).toBe(204);
    expect(cors(response)).toEqual({});
    expect(handler).not.toHaveBeenCalled();
  });
  it.each([200, 401, 403, 404, 409, 410, 422, 429, 500, 503])(
    'preserves HTTP %i, body and existing headers with CORS',
    async (status) => {
      const response = await withBrowserCors(
        () =>
          new Response('unchanged', {
            status,
            headers: {
              Vary: 'Accept-Encoding',
              'Cache-Control': 'private, no-store',
              'Retry-After': '60',
            },
          }),
        environment(ORIGIN),
        ['POST'],
      )(request(ORIGIN));
      expect(response.status).toBe(status);
      expect(await response.text()).toBe('unchanged');
      expect(response.headers.get('vary')).toBe('Accept-Encoding, Origin');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('retry-after')).toBe('60');
      expect(cors(response)).toEqual({
        'access-control-allow-origin': ORIGIN,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': BROWSER_REQUEST_HEADERS.join(', '),
        'access-control-max-age': '600',
      });
    },
  );
  it('does not treat CORS as authorization or alter a denied-origin real response', async () => {
    const handler = vi.fn(() => new Response('denied by auth', { status: 401 }));
    const response = await withBrowserCors(handler, environment(ORIGIN), ['POST'])(
      request('https://evil.example.invalid'),
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(response.status).toBe(401);
    expect(cors(response)).toEqual({});
  });
  it.each([
    'https://evil.example.invalid',
    'https://COLETE.example.invalid',
    'HTTPS://colete.example.invalid',
    `${ORIGIN}.`,
    `${ORIGIN}, https://evil.example.invalid`,
    'null',
  ])('keeps a real 200 unreadable to denied origin %s', async (origin) => {
    const handler = vi.fn(() => new Response('private success', { status: 200 }));
    const response = await withBrowserCors(handler, environment(ORIGIN), ['POST'])(request(origin));
    expect(handler).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('private success');
    expect(cors(response)).toEqual({});
  });
  it('rejects repeated Origin headers instead of selecting the first', async () => {
    const repeated = request(ORIGIN, 'OPTIONS', { 'Access-Control-Request-Method': 'POST' });
    repeated.headers.append('Origin', 'https://evil.example.invalid');
    const response = await withBrowserCors(vi.fn(), environment(ORIGIN), ['POST'])(repeated);
    expect(cors(response)).toEqual({});
  });
  it('makes unexpected errors readable without leaking the exception', async () => {
    const response = await withBrowserCors(
      () => {
        throw new Error('private provider fixture');
      },
      environment(ORIGIN),
      ['GET'],
    )(request(ORIGIN, 'GET'));
    expect(response.status).toBe(500);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(await response.text()).not.toContain('private provider fixture');
  });
});
