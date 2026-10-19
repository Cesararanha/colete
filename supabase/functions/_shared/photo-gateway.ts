// Profile and group photos (0030, docs/13 section 5.0.9), served by the groups
// gateway. The database decides the object path; this module turns it into a
// signed upload URL, holds the uploaded bytes to the photo rule before the
// swap, and signs the short-lived read URLs of the photos the database says
// the actor may see. Storage is injected, so every step but the network runs
// in a test.
//
// What leaves here: the signed upload URL of the actor's own session, and
// signed read URLs. Never a bare path, a bucket listing, the service key or a
// URL that outlives the rule that issued it.

import {
  GatewayError,
  defaultMessage,
  fromDatabaseError,
  httpStatusFor,
  validation,
  type ErrorCode,
} from './errors.ts';
import { CANONICAL_VERSION, HASH_KEY_VERSION, type ActorContext } from './gateway.ts';
import { computeIdempotencyHmac, type KeyResolver } from './hmac.ts';
import {
  PHOTO_CONTENT_TYPE,
  PHOTO_MAX_BYTES,
  PHOTO_MAX_SIDE,
  inspectJpeg,
  type PhotoRefusal,
} from './photo-image.ts';

export const PHOTO_OPERATIONS = [
  'begin_photo_upload',
  'set_profile_photo',
  'remove_profile_photo',
  'set_group_photo',
  'remove_group_photo',
  'get_photo_urls',
] as const;
export type PhotoOperation = (typeof PHOTO_OPERATIONS)[number];
export function isPhotoOperation(value: string): value is PhotoOperation {
  return (PHOTO_OPERATIONS as readonly string[]).includes(value);
}

/** Read URLs live five minutes; the app refreshes them before that. */
export const PHOTO_READ_SECONDS = 300;
/** At most this many subjects of each kind per read. */
export const PHOTO_READ_LIMIT = 100;
// A signed upload URL must die at least this long before the database
// reclaims its session, so no object can arrive after the reclaim.
const RECLAIM_MARGIN_SECONDS = 60;

export type PhotoBucket = 'avatars' | 'group-photos';

export interface PhotoStorage {
  /** A signed upload URL for exactly this object, without upsert. */
  signUpload(bucket: PhotoBucket, path: string): Promise<{ url: string; token: string }>;
  /** The stored bytes, or null when no object is there. Never more than `limit` + 1 bytes. */
  read(bucket: PhotoBucket, path: string, limit: number): Promise<Uint8Array | null>;
  remove(bucket: PhotoBucket, path: string): Promise<void>;
  /** Signed read URLs, relative to the Storage API root (`/object/sign/...`). */
  signRead(
    bucket: PhotoBucket,
    paths: readonly string[],
    seconds: number,
  ): Promise<{ path: string; signedURL: string | null }[]>;
}

export interface PhotoDependencies {
  readonly actor: ActorContext;
  readonly resolveKey: KeyResolver;
  readonly callRpc: (
    name: string,
    parameters: Record<string, unknown>,
  ) => Promise<{
    data?: unknown;
    error?: { message?: string | null; code?: string | null } | null;
  }>;
  readonly storage: PhotoStorage;
  /** Seconds since the epoch; injected so the expiry fence can be tested. */
  readonly now?: () => number;
}

interface Result {
  status: number;
  body: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/;
const INTERNAL_KEYS = new Set([
  'p_actor_auth_user_id',
  'p_actor_session_id',
  'p_input_hmac',
  'p_canonical_version',
  'p_hash_key_version',
  'actor_auth_user_id',
  'actor_session_id',
  'auth_user_id',
  'session_id',
  'profile_id',
  'path',
  'bucket',
]);
const BODY_KEYS: Record<PhotoOperation, readonly string[]> = {
  begin_photo_upload: ['request_id', 'target', 'group_id'],
  set_profile_photo: ['request_id', 'upload_id'],
  remove_profile_photo: ['request_id'],
  set_group_photo: ['request_id', 'group_id', 'upload_id'],
  remove_group_photo: ['request_id', 'group_id'],
  get_photo_urls: ['profile_ids', 'group_ids', 'self'],
};

function record(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validation('body', 'must be an object');
  }
  return body as Record<string, unknown>;
}
function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw validation(
        key,
        INTERNAL_KEYS.has(key) ? 'belongs to the internal call' : 'unknown key',
      );
    }
  }
}
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw validation(field, 'must be a canonical lowercase UUID');
  }
  return value;
}
function uuidList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw validation(field, 'must be an array');
  if (value.length > PHOTO_READ_LIMIT) {
    throw validation(field, `must hold at most ${PHOTO_READ_LIMIT} IDs`);
  }
  // Set-like: order and repetition do not change the answer.
  return [...new Set(value.map((item, index) => uuid(item, `${field}[${index}]`)))].sort();
}
function failure(code: ErrorCode, requestId: string, fields?: Record<string, string>): Result {
  return {
    status: httpStatusFor(code),
    body: {
      error: { code, message: defaultMessage(code), ...(fields === undefined ? {} : { fields }) },
      request_id: requestId,
    },
  };
}
async function rpc(
  deps: PhotoDependencies,
  name: string,
  parameters: Record<string, unknown>,
): Promise<unknown> {
  const result = await deps.callRpc(name, parameters);
  if (result.error !== undefined && result.error !== null) throw fromDatabaseError(result.error);
  return result.data;
}
function actorParameters(actor: ActorContext): Record<string, unknown> {
  return { p_actor_auth_user_id: actor.authUserId, p_actor_session_id: actor.sessionId };
}
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function bucketOf(value: unknown): PhotoBucket {
  if (value === 'avatars' || value === 'group-photos') return value;
  throw new Error('invalid photo bucket');
}
function pathOf(value: unknown): string {
  if (typeof value !== 'string' || !PATH.test(value)) throw new Error('invalid photo path');
  return value;
}

/** The `exp` claim of a token Storage itself just issued; never trusted for anything else. */
export function tokenExpiry(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const padded = payload.replaceAll('-', '+').replaceAll('_', '/');
    const claims = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp : undefined;
  } catch {
    return undefined;
  }
}

const REFUSAL_FIELDS: Record<PhotoRefusal | 'missing', string> = {
  missing: 'was not uploaded',
  empty: 'is empty',
  too_large: `must be at most ${PHOTO_MAX_BYTES} bytes`,
  not_jpeg: 'must be a JPEG image',
  truncated: 'must be a complete JPEG image',
  metadata: 'must not carry camera or location metadata',
  dimensions: `must be at most ${PHOTO_MAX_SIDE} pixels on its longer side`,
  trailing_data: 'must end at the end of the image',
};

/**
 * Before the swap: the stored object of the actor's own open session must
 * pass the photo rule. A refused object is deleted at once; its session stays
 * open until the database reclaims it, so a second upload to the same signed
 * URL is reclaimed too. No session (already used, expired, someone else's)
 * skips the check, and the swap RPC answers: NOT_FOUND for a new call, the
 * recorded outcome for a replay.
 */
async function checkUploadedPhoto(deps: PhotoDependencies, uploadId: string): Promise<void> {
  const target = asObject(
    await rpc(deps, 'get_photo_upload_target', {
      ...actorParameters(deps.actor),
      p_upload_id: uploadId,
    }),
  );
  if (target === undefined) return;
  const bucket = bucketOf(target['bucket']);
  const path = pathOf(target['path']);
  const bytes = await deps.storage.read(bucket, path, PHOTO_MAX_BYTES);
  if (bytes === null) throw validation('photo', REFUSAL_FIELDS.missing);
  const inspection = inspectJpeg(bytes);
  if (!inspection.ok) {
    await deps.storage.remove(bucket, path);
    throw validation('photo', REFUSAL_FIELDS[inspection.reason]);
  }
}

async function signReadUrls(
  deps: PhotoDependencies,
  rows: readonly { subject_id: string; bucket: PhotoBucket; object_path: string }[],
  bucket: PhotoBucket,
): Promise<Record<string, string>> {
  const wanted = rows.filter((row) => row.bucket === bucket);
  if (wanted.length === 0) return {};
  const signed = await deps.storage.signRead(
    bucket,
    wanted.map((row) => row.object_path),
    PHOTO_READ_SECONDS,
  );
  const byPath = new Map(signed.map((entry) => [entry.path, entry.signedURL]));
  const urls: Record<string, string> = {};
  for (const row of wanted) {
    const url = byPath.get(row.object_path);
    // A photo whose object is missing is shown as no photo.
    if (typeof url === 'string' && url.startsWith('/object/sign/')) {
      urls[row.subject_id] = `/storage/v1${url}`;
    }
  }
  return urls;
}

export async function dispatchPhoto(
  deps: PhotoDependencies,
  operation: PhotoOperation,
  body: unknown,
): Promise<Result> {
  let requestId = crypto.randomUUID();
  try {
    const input = record(body);
    if (
      operation !== 'get_photo_urls' &&
      typeof input['request_id'] === 'string' &&
      UUID.test(input['request_id'])
    ) {
      requestId = input['request_id'];
    }
    onlyKeys(input, BODY_KEYS[operation]);

    if (operation === 'get_photo_urls') {
      const profileIds = uuidList(input['profile_ids'] ?? [], 'profile_ids');
      const groupIds = uuidList(input['group_ids'] ?? [], 'group_ids');
      // The own photo is asked by this flag, never by the own ID: no request
      // body carries the caller's identifiers (docs/22 section 6).
      const self = input['self'] ?? false;
      if (typeof self !== 'boolean') throw validation('self', 'must be a boolean');
      const raw = await rpc(deps, 'get_visible_photos', {
        ...actorParameters(deps.actor),
        p_profile_ids: profileIds,
        p_group_ids: groupIds,
        p_self: self,
      });
      if (!Array.isArray(raw)) throw new Error('invalid visible photos');
      let selfRows = 0;
      const rows = raw.map((item) => {
        const row = asObject(item);
        const subject = row?.['subject_id'];
        const kind = row?.['kind'];
        const requested =
          kind === 'self'
            ? self && (selfRows += 1) === 1
            : kind === 'profile'
              ? profileIds.includes(subject as string)
              : kind === 'group' && groupIds.includes(subject as string);
        if (
          row === undefined ||
          typeof subject !== 'string' ||
          !UUID.test(subject) ||
          !requested ||
          (kind !== 'group') !== (row['bucket'] === 'avatars')
        ) {
          throw new Error('invalid visible photo');
        }
        return {
          kind: kind as 'self' | 'profile' | 'group',
          subject_id: subject,
          bucket: bucketOf(row['bucket']),
          object_path: pathOf(row['object_path']),
        };
      });
      const ownRows = rows
        .filter((row) => row.kind === 'self')
        .map((row) => ({ ...row, subject_id: 'self' }));
      const data = {
        expires_in: PHOTO_READ_SECONDS,
        self: (await signReadUrls(deps, ownRows, 'avatars'))['self'] ?? null,
        profiles: await signReadUrls(
          deps,
          rows.filter((row) => row.kind === 'profile'),
          'avatars',
        ),
        groups: await signReadUrls(deps, rows, 'group-photos'),
      };
      return { status: 200, body: { data, request_id: requestId } };
    }

    requestId = uuid(input['request_id'], 'request_id');
    let canonicalInput: Record<string, unknown>;
    let extras: Record<string, unknown>;
    switch (operation) {
      case 'begin_photo_upload': {
        const target = input['target'];
        if (target !== 'profile' && target !== 'group') {
          throw validation('target', 'must be profile or group');
        }
        // The group is required for a group photo and absent for a profile
        // photo; null is not a third spelling of absence.
        const groupId =
          target === 'group'
            ? uuid(input['group_id'], 'group_id')
            : Object.hasOwn(input, 'group_id')
              ? (() => {
                  throw validation('group_id', 'is only for a group photo');
                })()
              : null;
        canonicalInput = { target, group_id: groupId };
        extras = { p_target: target, p_group_id: groupId };
        break;
      }
      case 'set_profile_photo': {
        const uploadId = uuid(input['upload_id'], 'upload_id');
        canonicalInput = { upload_id: uploadId };
        extras = { p_upload_id: uploadId };
        break;
      }
      case 'remove_profile_photo':
        canonicalInput = {};
        extras = {};
        break;
      case 'set_group_photo': {
        const groupId = uuid(input['group_id'], 'group_id');
        const uploadId = uuid(input['upload_id'], 'upload_id');
        canonicalInput = { group_id: groupId, upload_id: uploadId };
        extras = { p_group_id: groupId, p_upload_id: uploadId };
        break;
      }
      case 'remove_group_photo': {
        const groupId = uuid(input['group_id'], 'group_id');
        canonicalInput = { group_id: groupId };
        extras = { p_group_id: groupId };
        break;
      }
    }

    if (operation === 'set_profile_photo' || operation === 'set_group_photo') {
      await checkUploadedPhoto(deps, String(extras['p_upload_id']));
    }

    const data = asObject(
      await rpc(deps, operation, {
        ...actorParameters(deps.actor),
        p_request_id: requestId,
        p_input_hmac: await computeIdempotencyHmac(
          deps.resolveKey,
          HASH_KEY_VERSION,
          operation,
          canonicalInput,
        ),
        p_canonical_version: CANONICAL_VERSION,
        p_hash_key_version: HASH_KEY_VERSION,
        ...extras,
      }),
    );
    if (data === undefined) throw new Error('invalid photo result');
    if (operation !== 'begin_photo_upload') {
      return { status: 200, body: { data, request_id: requestId } };
    }

    // The session's path and deadlines stay here; only its signed URL leaves.
    const current = asObject(data['current']);
    let upload: Record<string, unknown> | null = null;
    if (current !== undefined) {
      const bucket = bucketOf(current['bucket']);
      const path = pathOf(current['path']);
      const reclaimAfter = Date.parse(String(current['reclaim_after'])) / 1000;
      const signed = await deps.storage.signUpload(bucket, path);
      const expiresAt = tokenExpiry(signed.token);
      const now = deps.now?.() ?? Date.now() / 1000;
      if (
        expiresAt === undefined ||
        !Number.isFinite(reclaimAfter) ||
        expiresAt <= now ||
        expiresAt > reclaimAfter - RECLAIM_MARGIN_SECONDS ||
        !signed.url.startsWith(`/object/upload/sign/${bucket}/${path}?token=`)
      ) {
        // A URL that could outlive the reclaim would let an object arrive
        // after it. Fail closed instead of handing it out.
        throw new Error('signed upload URL outlives the session');
      }
      upload = {
        upload_id: current['upload_id'],
        url: `/storage/v1${signed.url}`,
        expires_at: new Date(expiresAt * 1000).toISOString(),
        content_type: PHOTO_CONTENT_TYPE,
        max_bytes: PHOTO_MAX_BYTES,
        max_side: PHOTO_MAX_SIDE,
      };
    }
    return {
      status: 200,
      body: { data: { outcome: data['outcome'], upload }, request_id: requestId },
    };
  } catch (thrown) {
    if (thrown instanceof GatewayError) return failure(thrown.code, requestId, thrown.fields);
    return failure('INTERNAL', requestId);
  }
}
