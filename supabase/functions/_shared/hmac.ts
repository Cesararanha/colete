// The idempotency HMAC of docs/13-contratos-funcoes.md section 0.1 and
// docs/10-schema-db.md section 9.1.
//
// The key never leaves this module: it is read from the environment, used, and
// never returned, logged or attached to an error. The HMAC detects a replay
// with divergent input and keeps a dump from brute-forcing digests of
// low-entropy input. It authenticates nobody and authorises nothing.

import { canonicaliseToBytes } from './jcs.ts';

const DOMAIN = 'colete/idempotency/v1';

/** Resolves the raw key bytes for a version. */
export type KeyResolver = (version: number) => Uint8Array | undefined;

export class MissingKeyError extends Error {
  constructor(version: number) {
    // The version is safe to name; the key is not, and never appears here.
    super(`no idempotency HMAC key for version ${version}`);
    this.name = 'MissingKeyError';
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * HMAC-SHA-256(key[version],
 *   UTF8("colete/idempotency/v1") || 0x00 || UTF8(operation) || 0x00 || JCS(input))
 */
export async function computeIdempotencyHmac(
  resolveKey: KeyResolver,
  hashKeyVersion: number,
  operation: string,
  input: unknown,
): Promise<string> {
  const key = resolveKey(hashKeyVersion);
  if (key === undefined || key.length === 0) {
    throw new MissingKeyError(hashKeyVersion);
  }

  const encoder = new TextEncoder();
  const message = concat([
    encoder.encode(DOMAIN),
    new Uint8Array([0x00]),
    encoder.encode(operation),
    new Uint8Array([0x00]),
    canonicaliseToBytes(input),
  ]);

  const imported = await crypto.subtle.importKey(
    'raw',
    key as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', imported, message as unknown as ArrayBuffer);
  return toHex(new Uint8Array(signature));
}

/**
 * Builds a resolver over the IDEMPOTENCY_HMAC_KEY_V<n> variables. The shape is
 * versioned because hash_key_version is persisted for exactly this reason:
 * adding a V2 is adding an environment variable, not editing this path.
 */
export function keyResolverFromEnvironment(
  read: (name: string) => string | undefined,
  versions: readonly number[] = [1],
): KeyResolver {
  const keys = new Map<number, Uint8Array>();
  for (const version of versions) {
    const raw = read(`IDEMPOTENCY_HMAC_KEY_V${version}`);
    if (raw === undefined || raw.length === 0) continue;
    if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) {
      throw new Error(`IDEMPOTENCY_HMAC_KEY_V${version} is not hexadecimal`);
    }
    const bytes = new Uint8Array(raw.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16);
    }
    keys.set(version, bytes);
  }
  return (version) => keys.get(version);
}
