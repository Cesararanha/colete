// Transport policy only. A permitted origin still needs the unchanged bearer
// authentication and database authorization of the wrapped production handler.
import { defaultMessage } from './errors.ts';

export const BROWSER_REQUEST_HEADERS = ['authorization', 'apikey', 'content-type', 'x-client-info'];
const MAX_AGE_SECONDS = '600';
type ReadEnvironment = (name: string) => string | undefined;
type Handler = (request: Request) => Response | Promise<Response>;

function exactOrigin(value: string, local: boolean): boolean {
  if (value.includes('*')) return false;
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username !== '' || url.password !== '') return false;
    return (
      url.protocol === 'https:' ||
      (local && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

export function allowedBrowserOrigins(read: ReadEnvironment): ReadonlySet<string> {
  const raw = read('APP_ALLOWED_ORIGINS');
  if (raw === undefined || raw.trim() === '') return new Set();
  const local = read('COLETE_LOCAL_STACK') === 'true';
  const origins = raw.split(',').map((origin) => origin.trim());
  // One malformed entry invalidates the whole configuration. No partial list,
  // implicit local origin, wildcard or origin derived from client headers.
  if (origins.some((origin) => !exactOrigin(origin, local))) return new Set();
  return new Set(origins);
}

function varyOrigin(headers: Headers): void {
  const values = (headers.get('vary') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.some((value) => value.toLowerCase() === 'origin')) values.push('Origin');
  headers.set('vary', values.join(', '));
}

export function withBrowserCors(
  handler: Handler,
  read: ReadEnvironment,
  methods: readonly string[],
): Handler {
  return async (request) => {
    const origin = request.headers.get('origin');
    const permitted = origin !== null && allowedBrowserOrigins(read).has(origin);
    const preflight = request.method === 'OPTIONS';
    const requestedMethod = request.headers.get('access-control-request-method') ?? '';
    const rawHeaders = request.headers.get('access-control-request-headers');
    const requestedHeaders =
      rawHeaders === null ? [] : rawHeaders.split(',').map((value) => value.trim().toLowerCase());
    const validPreflight =
      methods.includes(requestedMethod) &&
      requestedHeaders.every((value) => BROWSER_REQUEST_HEADERS.includes(value));

    let response: Response;
    if (preflight) {
      // Never invoke authentication, JSON parsing, limiter or idempotency.
      response = new Response(null, { status: 204 });
    } else {
      try {
        response = await handler(request);
      } catch {
        // Unexpected failures must remain readable from an approved browser,
        // without exposing the exception, input, credential or provider reply.
        response = new Response(
          JSON.stringify({
            error: { code: 'INTERNAL', message: defaultMessage('INTERNAL') },
            request_id: '',
          }),
          {
            status: 500,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            },
          },
        );
      }
    }
    const headers = new Headers(response.headers);
    varyOrigin(headers);
    if (permitted && (!preflight || validPreflight)) {
      headers.set('access-control-allow-origin', origin);
      headers.set('access-control-allow-methods', methods.join(', '));
      headers.set('access-control-allow-headers', BROWSER_REQUEST_HEADERS.join(', '));
      headers.set('access-control-max-age', MAX_AGE_SECONDS);
      // Content-Type is CORS-safelisted. Retry-After is read from the JSON
      // envelope in api.ts, so no non-safelisted response header is exposed.
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
