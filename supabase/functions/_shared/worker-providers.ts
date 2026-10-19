import type { DeletionProviders } from './deletion.ts';
import type { ExportAuth, ExportPhotos, ExportStorage } from './data-export.ts';
import { providerHttpError } from './worker.ts';

export function providerHeaders(secretKey: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: secretKey };
  // Legacy service_role keys are JWTs and belong in both headers. Modern
  // sb_secret keys authenticate through apikey; sending one as Bearer makes
  // Storage/Auth try to parse a non-JWT compact token.
  if (!secretKey.startsWith('sb_secret_')) {
    headers.Authorization = `Bearer ${secretKey}`;
  }
  return headers;
}

export function encodedObjectPath(bucket: string, path: string): string {
  return [bucket, ...path.split('/')].map(encodeURIComponent).join('/');
}

/**
 * Storage encodes a missing object either as HTTP 404 or, in the versions
 * shipped with the local stack, as HTTP 400 whose JSON body carries
 * `statusCode: "404"` or `error: "not_found"`. Both are the reconciled
 * absence of docs/22 section 3.4; a 400 that says anything else stays a
 * permanent provider refusal. HEAD has no body, so `exists` re-probes a 400
 * with a one-byte ranged GET before trusting the status alone.
 */
export async function isStorageObjectMissing(response: Response): Promise<boolean> {
  if (response.status === 404) return true;
  if (response.status !== 400) return false;
  const body = (await response.json().catch(() => undefined)) as
    { error?: unknown; statusCode?: unknown } | undefined;
  return body?.error === 'not_found' || body?.statusCode === '404';
}

export function createDeletionProviders(supabaseUrl: string, secretKey: string): DeletionProviders {
  const headers = providerHeaders(secretKey);
  return {
    storage: {
      exists: async (bucket: string, path: string) => {
        const objectUrl = `${supabaseUrl}/storage/v1/object/${encodedObjectPath(bucket, path)}`;
        const response = await fetch(objectUrl, { method: 'HEAD', headers });
        if (response.status === 404) return false;
        if (response.ok) return true;
        if (response.status === 400) {
          const probe = await fetch(objectUrl, { headers: { ...headers, range: 'bytes=0-0' } });
          if (probe.ok || probe.status === 416) return true;
          if (await isStorageObjectMissing(probe)) return false;
          throw providerHttpError('STORAGE_UNAVAILABLE', probe.status);
        }
        throw providerHttpError('STORAGE_UNAVAILABLE', response.status);
      },
      remove: async (bucket: string, path: string) => {
        const response = await fetch(
          `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}`,
          {
            method: 'DELETE',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ prefixes: [path] }),
          },
        );
        if (!response.ok && response.status !== 404) {
          throw providerHttpError('STORAGE_UNAVAILABLE', response.status);
        }
      },
    },
    auth: {
      exists: async (authUserId: string) => {
        const response = await fetch(
          `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(authUserId)}`,
          { headers },
        );
        if (response.status === 404) return false;
        if (response.ok) return true;
        throw providerHttpError('AUTH_UNAVAILABLE', response.status);
      },
      remove: async (authUserId: string) => {
        const response = await fetch(
          `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(authUserId)}`,
          { method: 'DELETE', headers },
        );
        if (!response.ok && response.status !== 404) {
          throw providerHttpError('AUTH_UNAVAILABLE', response.status);
        }
      },
    },
  };
}

export function createExportProviders(
  supabaseUrl: string,
  secretKey: string,
): { auth: ExportAuth; storage: ExportStorage; photos: ExportPhotos } {
  const headers = providerHeaders(secretKey);
  const objectUrl = (path: string) =>
    `${supabaseUrl}/storage/v1/object/${encodedObjectPath('data-exports', path)}`;
  return {
    photos: {
      read: async (bucket, path) => {
        const response = await fetch(
          `${supabaseUrl}/storage/v1/object/${encodedObjectPath(bucket, path)}`,
          { headers },
        );
        if (response.ok) return new Uint8Array(await response.arrayBuffer());
        if (await isStorageObjectMissing(response)) return null;
        throw providerHttpError('STORAGE_UNAVAILABLE', response.status);
      },
    },
    storage: {
      read: async (path: string) => {
        const response = await fetch(objectUrl(path), { headers });
        if (response.ok) return new Uint8Array(await response.arrayBuffer());
        if (await isStorageObjectMissing(response)) return null;
        throw providerHttpError('STORAGE_UNAVAILABLE', response.status);
      },
      upload: async (path: string, bytes: Uint8Array) => {
        const response = await fetch(objectUrl(path), {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/zip',
            'cache-control': 'no-store',
            'x-upsert': 'false',
          },
          body: bytes,
        });
        if (!response.ok) throw providerHttpError('STORAGE_UPLOAD_FAILED', response.status);
      },
      remove: async (path: string) => {
        const response = await fetch(`${supabaseUrl}/storage/v1/object/data-exports`, {
          method: 'DELETE',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ prefixes: [path] }),
        });
        if (!response.ok && response.status !== 404) {
          throw providerHttpError('STORAGE_UNAVAILABLE', response.status);
        }
      },
    },
    auth: {
      projection: async (authUserId: string) => {
        const response = await fetch(
          `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(authUserId)}`,
          { headers },
        );
        if (!response.ok) throw providerHttpError('AUTH_UNAVAILABLE', response.status);
        const user = (await response.json()) as {
          email_confirmed_at?: unknown;
          identities?: Array<{ provider?: unknown }>;
        };
        const providers = [
          ...new Set(
            (user.identities ?? [])
              .map((identity) => identity.provider)
              .filter((provider): provider is string => typeof provider === 'string'),
          ),
        ].sort();
        const raw = user as typeof user & { email?: unknown };
        return {
          email:
            typeof user.email_confirmed_at === 'string' && typeof raw.email === 'string'
              ? raw.email
              : null,
          providers,
        };
      },
    },
  };
}
