// The Storage calls behind photos (0030): sign an upload for one object, read
// one object with a byte ceiling, delete one object and sign short read URLs.
// Each call names its bucket and object; there is no listing and no generic
// passthrough. The key is the service role's and never leaves the process.

import type { PhotoBucket, PhotoStorage } from './photo-gateway.ts';
import { encodedObjectPath, isStorageObjectMissing, providerHeaders } from './worker-providers.ts';
import { providerHttpError } from './worker.ts';

async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    return new Uint8Array(limit + 1);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    // One byte past the ceiling is enough to refuse; the rest is never read.
    if (total > limit) {
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export function createPhotoStorage(supabaseUrl: string, secretKey: string): PhotoStorage {
  const headers = providerHeaders(secretKey);
  const objectUrl = (bucket: PhotoBucket, path: string) =>
    `${supabaseUrl}/storage/v1/object/${encodedObjectPath(bucket, path)}`;
  return {
    signUpload: async (bucket, path) => {
      // No x-upsert: the signed URL creates the object once and never
      // replaces it.
      const response = await fetch(
        `${supabaseUrl}/storage/v1/object/upload/sign/${encodedObjectPath(bucket, path)}`,
        { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' },
      );
      if (!response.ok) throw providerHttpError('STORAGE_UNAVAILABLE', response.status);
      const body = (await response.json()) as { url?: unknown; token?: unknown };
      if (typeof body.url !== 'string' || typeof body.token !== 'string') {
        throw new Error('STORAGE_UNAVAILABLE');
      }
      return { url: body.url, token: body.token };
    },
    read: async (bucket, path, limit) => {
      const response = await fetch(objectUrl(bucket, path), { headers });
      if (response.ok) return readCapped(response, limit);
      if (await isStorageObjectMissing(response)) return null;
      throw providerHttpError('STORAGE_UNAVAILABLE', response.status);
    },
    remove: async (bucket, path) => {
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
    signRead: async (bucket, paths, seconds) => {
      const response = await fetch(
        `${supabaseUrl}/storage/v1/object/sign/${encodeURIComponent(bucket)}`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ expiresIn: seconds, paths }),
        },
      );
      if (!response.ok) throw providerHttpError('STORAGE_UNAVAILABLE', response.status);
      const body = (await response.json()) as { path?: unknown; signedURL?: unknown }[];
      if (!Array.isArray(body)) throw new Error('STORAGE_UNAVAILABLE');
      return body.map((entry) => ({
        path: typeof entry.path === 'string' ? entry.path : '',
        signedURL: typeof entry.signedURL === 'string' ? entry.signedURL : null,
      }));
    },
  };
}
