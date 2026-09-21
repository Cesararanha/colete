import { handleDataExportDownload } from '../_shared/data-export-download.ts';
import { isErrorCode } from '../_shared/errors.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve: (handler: (request: Request) => Promise<Response>) => unknown;
};

const env = (name: string, fallback?: string) => {
  const value = Deno.env.get(name) ?? (fallback === undefined ? undefined : Deno.env.get(fallback));
  if (value === undefined || value.length === 0) throw new Error('MISSING_CONFIGURATION');
  return value;
};
const SUPABASE_URL = env('SUPABASE_URL');
const PUBLISHABLE_KEY = env('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY');
const SECRET_KEY = env('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
function claimsFromVerifiedToken(token: string): Record<string, unknown> | undefined {
  try {
    const payload = token.split('.')[1];
    if (payload === undefined) return undefined;
    const normalized = payload.replaceAll('-', '+').replaceAll('_', '/');
    return JSON.parse(atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4))) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

async function rpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SECRET_KEY,
      Authorization: `Bearer ${SECRET_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({}))) as { message?: unknown };
    const message = typeof failure.message === 'string' ? failure.message : '';
    throw isErrorCode(message) ? new Error(message) : new Error('INTERNAL');
  }
  return (await response.json()) as T;
}

Deno.serve((request) =>
  handleDataExportDownload(request, {
    verifyToken: async (token) => {
      const authResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
        redirect: 'error',
      }).catch(() => undefined);
      if (authResponse === undefined || !authResponse.ok) return undefined;
      const user = (await authResponse.json()) as { id?: unknown };
      const claims = claimsFromVerifiedToken(token);
      if (typeof user.id !== 'string' || claims === undefined) return undefined;
      return { authUserId: user.id, claims };
    },
    consume: ({ actorAuthUserId, actorSessionId, exportId }) =>
      rpc('consume_data_export', {
        p_actor_auth_user_id: actorAuthUserId,
        p_actor_session_id: actorSessionId,
        p_export_id: exportId,
      }),
    openObject: (storagePath) => {
      const encodedPath = storagePath.split('/').map(encodeURIComponent).join('/');
      return fetch(`${SUPABASE_URL}/storage/v1/object/data-exports/${encodedPath}`, {
        headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
        redirect: 'error',
      }).catch(() => undefined);
    },
    enqueuePurge: (exportId) =>
      rpc('enqueue_data_export_purge', { p_export_id: exportId }).then(() => undefined),
  }),
);
