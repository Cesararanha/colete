import { canonicalise } from './jcs.ts';
import { WorkerEffectError } from './worker.ts';
import type { EffectHandler, ExternalEffect } from './worker.ts';

const encoder = new TextEncoder();
const MAX_BYTES = 50 * 1024 * 1024;
const FIXED_DOS_DATE = 0x21; // 1980-01-01
const FIXED_DOS_TIME = 0;

export interface ExportSnapshot {
  snapshot_at: string;
  profile: Record<string, unknown>;
  auth: Record<string, unknown>;
  policy_acceptances: Array<Record<string, unknown>>;
  privacy_requests: Array<Record<string, unknown>>;
  data_exports: Array<Record<string, unknown>>;
  groups: Array<Record<string, unknown>>;
}

export type ExportBuildTarget =
  | { action: 'none' | 'purge' }
  | {
      action: 'build';
      path: string;
      auth_user_id: string;
      /** The titular's current photo (0030), outside the snapshot: its path never enters a JSON. */
      photo?: { bucket: 'avatars'; path: string } | null;
      snapshot: Omit<ExportSnapshot, 'auth'>;
    };

export interface ExportRpc {
  getBuildTarget(effectId: string, leaseToken: string): Promise<ExportBuildTarget>;
  publish(effectId: string, leaseToken: string, path: string, digest: string): Promise<void>;
  enqueuePurge(exportId: string): Promise<void>;
}

export interface ExportStorage {
  read(path: string): Promise<Uint8Array | null>;
  upload(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface ExportAuth {
  projection(authUserId: string): Promise<Record<string, unknown>>;
}

/** Reads the titular's own photo from its private bucket, or null when it is absent. */
export interface ExportPhotos {
  read(bucket: 'avatars', path: string): Promise<Uint8Array | null>;
}

/** The fixed name of the titular's photo inside the ZIP (0030). */
export const EXPORT_PHOTO_NAME = 'profile-photo.jpg';

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], subject: string) {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new WorkerEffectError(`${subject}_ALLOWLIST_VIOLATION`, true);
  }
}

export function validateExportSnapshot(snapshot: ExportSnapshot): void {
  exactKeys(
    snapshot as unknown as Record<string, unknown>,
    [
      'snapshot_at',
      'profile',
      'auth',
      'policy_acceptances',
      'privacy_requests',
      'data_exports',
      'groups',
    ],
    'EXPORT',
  );
  exactKeys(
    snapshot.profile,
    [
      'id',
      'name',
      'nickname',
      'position',
      'dominant_foot',
      'shirt_number',
      'account_status',
      'created_at',
    ],
    'PROFILE',
  );
  exactKeys(snapshot.auth, ['email', 'providers'], 'AUTH');
  for (const row of snapshot.policy_acceptances) {
    exactKeys(row, ['document_type', 'version', 'source', 'accepted_at'], 'POLICY');
  }
  for (const row of snapshot.privacy_requests) {
    exactKeys(row, ['kind', 'status', 'response', 'opened_at', 'resolved_at'], 'PRIVACY');
  }
  for (const row of snapshot.data_exports) {
    exactKeys(
      row,
      ['id', 'status', 'created_at', 'ready_at', 'expires_at', 'downloaded_at', 'purged_at'],
      'DATA_EXPORT',
    );
  }
  // docs/25 §3.4: uma entrada por membership própria. Membros terceiros,
  // digest, nonce, token e localizador de foto não têm chave aqui.
  for (const row of snapshot.groups) {
    exactKeys(
      row,
      [
        'group_id',
        'group_name',
        'role',
        'status',
        'is_monthly',
        'joined_at',
        'removed_at',
        'removal_count',
      ],
      'GROUP',
    );
  }
}

function u16(value: number): Uint8Array {
  return Uint8Array.of(value & 255, (value >>> 8) & 255);
}

function u32(value: number): Uint8Array {
  return Uint8Array.of(
    value & 255,
    (value >>> 8) & 255,
    (value >>> 16) & 255,
    (value >>> 24) & 255,
  );
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

interface Entry {
  name: string;
  bytes: Uint8Array;
}

async function zipStore(entries: readonly Entry[]): Promise<Uint8Array> {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const header = join([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(FIXED_DOS_TIME),
      u16(FIXED_DOS_DATE),
      u32(crc),
      u32(entry.bytes.length),
      u32(entry.bytes.length),
      u16(name.length),
      u16(0),
      name,
    ]);
    local.push(header, entry.bytes);
    central.push(
      join([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(FIXED_DOS_TIME),
        u16(FIXED_DOS_DATE),
        u32(crc),
        u32(entry.bytes.length),
        u32(entry.bytes.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += header.length + entry.bytes.length;
  }
  const centralBytes = join(central);
  const end = join([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBytes.length),
    u32(offset),
    u16(0),
  ]);
  return join([...local, centralBytes, end]);
}

export async function buildDataExport(
  snapshot: ExportSnapshot,
  photo: Uint8Array | null = null,
): Promise<{
  bytes: Uint8Array;
  digest: string;
  names: string[];
}> {
  validateExportSnapshot(snapshot);
  const json = (value: unknown) => encoder.encode(`${canonicalise(value)}\n`);
  const base: Entry[] = [
    {
      name: 'LEIA-ME.txt',
      bytes: encoder.encode(
        'Exportação Colete v1. Este arquivo é pessoal, temporário e de download único.\n' +
          'Não inclui credenciais, tokens, Pix, comprovantes, fingerprints, URLs internas, logs ou dados de terceiros.\n',
      ),
    },
    { name: 'auth.json', bytes: json(snapshot.auth) },
    { name: 'data-exports.json', bytes: json(snapshot.data_exports) },
    { name: 'groups.json', bytes: json(snapshot.groups) },
    { name: 'policy-acceptances.json', bytes: json(snapshot.policy_acceptances) },
    { name: 'privacy-requests.json', bytes: json(snapshot.privacy_requests) },
    { name: 'profile.json', bytes: json(snapshot.profile) },
    // docs/22 §5.1: a fixed-name entry, enumerated in the manifest, only when
    // the titular has a photo. The other entries keep their bytes.
    ...(photo === null ? [] : [{ name: EXPORT_PHOTO_NAME, bytes: photo }]),
  ].sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const files = [];
  for (const entry of base) {
    files.push({ name: entry.name, size: entry.bytes.length, sha256: await sha256(entry.bytes) });
  }
  const manifest: Entry = {
    name: 'manifest.json',
    bytes: json({ version: 'colete-export-v1', snapshot_at: snapshot.snapshot_at, files }),
  };
  const entries = [...base, manifest].sort((left, right) =>
    left.name.localeCompare(right.name, 'en'),
  );
  const bytes = await zipStore(entries);
  if (bytes.length > MAX_BYTES) throw new WorkerEffectError('DATA_EXPORT_TOO_LARGE', true);
  return { bytes, digest: await sha256(bytes), names: entries.map((entry) => entry.name) };
}

export function dataExportBuildHandler(
  rpc: ExportRpc,
  storage: ExportStorage,
  auth: ExportAuth,
  photos?: ExportPhotos,
): EffectHandler {
  return async (effect: ExternalEffect) => {
    const target = await rpc.getBuildTarget(effect.id, effect.lease_token);
    if (target.action === 'none') return;
    if (target.action === 'purge') {
      await rpc.enqueuePurge(effect.resource_id);
      return;
    }
    const authProjection = await auth.projection(target.auth_user_id);
    let photo: Uint8Array | null = null;
    if (target.photo !== undefined && target.photo !== null) {
      if (photos === undefined) throw new WorkerEffectError('EXPORT_PHOTO_UNAVAILABLE', true);
      photo = await photos.read(target.photo.bucket, target.photo.path);
      // The photo was swapped between the snapshot and this read. The next
      // attempt reads the new one; an export never leaves it out silently.
      if (photo === null) throw new WorkerEffectError('EXPORT_PHOTO_UNAVAILABLE');
    }
    const artifact = await buildDataExport({ ...target.snapshot, auth: authProjection }, photo);
    const existing = await storage.read(target.path);
    if (existing !== null) {
      const existingDigest = await sha256(existing);
      if (existingDigest !== artifact.digest) {
        await storage.remove(target.path);
      } else {
        await rpc.publish(effect.id, effect.lease_token, target.path, artifact.digest);
        return;
      }
    }
    await storage.upload(target.path, artifact.bytes);
    const stored = await storage.read(target.path);
    if (stored === null || (await sha256(stored)) !== artifact.digest) {
      if (stored !== null) await storage.remove(target.path);
      throw new WorkerEffectError('DATA_EXPORT_DIGEST_MISMATCH');
    }
    await rpc.publish(effect.id, effect.lease_token, target.path, artifact.digest);
  };
}
