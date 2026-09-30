// Material de convite do piloto M2. A chave real vive somente no ambiente da
// Edge. Este módulo nunca envia token ou código ao PostgreSQL.
// docs/25 §§5.1 e 8.1, decisão técnica de 30/09/2026.

const encoder = new TextEncoder();
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SALT = encoder.encode('colete/invite/hkdf-salt/v1');
const DOMAIN = encoder.encode('colete/invite/v1\0');
const INFOS = {
  link: encoder.encode('colete/invite/link-mac/v1'),
  code: encoder.encode('colete/invite/code/v1'),
  lookup: encoder.encode('colete/invite/code-lookup/v1'),
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class InviteMaterialError extends Error {
  constructor() {
    super('Invalid invitation material.');
    this.name = 'InviteMaterialError';
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new InviteMaterialError();
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new InviteMaterialError();
  const padded =
    value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  let decoded: Uint8Array;
  try {
    decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new InviteMaterialError();
  }
  if (base64url(decoded) !== value) throw new InviteMaterialError();
  return decoded;
}

function uuidBytes(value: string): Uint8Array {
  if (!UUID.test(value)) throw new InviteMaterialError();
  return fromHex(value.replaceAll('-', ''));
}

function uuidFromBytes(bytes: Uint8Array): string {
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function versionBytes(version: number): Uint8Array {
  if (!Number.isInteger(version) || version < 1 || version > 32767) {
    throw new InviteMaterialError();
  }
  return Uint8Array.of(version >>> 8, version & 255);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

async function subkey(key: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey('raw', key, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: SALT, info },
      imported,
      256,
    ),
  );
}

async function hmac(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, message));
}

async function sha256(message: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', message));
}

export function inviteKeyV1(encoded: string | undefined): Uint8Array {
  if (encoded === undefined || encoded.includes('=')) throw new InviteMaterialError();
  const key = fromBase64url(encoded);
  if (key.length !== 32) throw new InviteMaterialError();
  return key;
}

export function normaliseInviteCode(value: string): string {
  if (typeof value !== 'string') throw new InviteMaterialError();
  const code = value.toUpperCase().replace(/[\s-]/gu, '');
  if (code.length !== 10 || [...code].some((symbol) => !ALPHABET.includes(symbol))) {
    throw new InviteMaterialError();
  }
  return code;
}

export interface InviteMaterial {
  readonly inviteId: string;
  readonly tokenVersion: 1;
  readonly nonceHex: string;
  readonly token: string;
  readonly tokenDigest: string;
  readonly code: string;
  readonly codeDigest: string;
  readonly macHex: string;
}

export async function deriveInviteMaterial(
  key: Uint8Array,
  inviteId: string,
  nonce: Uint8Array,
): Promise<InviteMaterial> {
  if (key.length !== 32 || nonce.length !== 16) throw new InviteMaterialError();
  const id = uuidBytes(inviteId);
  const version = versionBytes(1);
  const prefix = concat(id, version, nonce);
  const linkKey = await subkey(key, INFOS.link);
  const codeKey = await subkey(key, INFOS.code);
  const lookupKey = await subkey(key, INFOS.lookup);
  const mac = await hmac(linkKey, concat(DOMAIN, prefix));
  const tokenBytes = concat(prefix, mac);
  const codeMac = await hmac(codeKey, concat(id, nonce));
  const top50 = BigInt(`0x${hex(codeMac.slice(0, 7))}`) >> 6n;
  let code = '';
  for (let index = 0; index < 10; index += 1) {
    const shift = BigInt((9 - index) * 5);
    code += ALPHABET[Number((top50 >> shift) & 31n)];
  }
  const digest = await hmac(lookupKey, concat(version, encoder.encode(code)));
  return {
    inviteId,
    tokenVersion: 1,
    nonceHex: hex(nonce),
    token: base64url(tokenBytes),
    tokenDigest: hex(await sha256(tokenBytes)),
    code: `${code.slice(0, 5)}-${code.slice(5)}`,
    codeDigest: hex(digest),
    macHex: hex(mac),
  };
}

export async function makeInviteMaterial(
  key: Uint8Array,
  inviteId = crypto.randomUUID(),
): Promise<InviteMaterial> {
  return deriveInviteMaterial(key, inviteId, crypto.getRandomValues(new Uint8Array(16)));
}

export async function lookupCodeDigest(key: Uint8Array, code: string): Promise<string> {
  if (key.length !== 32) throw new InviteMaterialError();
  const lookupKey = await subkey(key, INFOS.lookup);
  return hex(
    await hmac(lookupKey, concat(versionBytes(1), encoder.encode(normaliseInviteCode(code)))),
  );
}

export async function parseInviteToken(
  key: Uint8Array,
  token: string,
): Promise<{
  inviteId: string;
  tokenVersion: 1;
  nonceHex: string;
  tokenDigest: string;
}> {
  if (key.length !== 32 || typeof token !== 'string') throw new InviteMaterialError();
  const bytes = fromBase64url(token);
  if (bytes.length !== 66) throw new InviteMaterialError();
  const version = bytes[16]! * 256 + bytes[17]!;
  versionBytes(version);
  if (version !== 1) throw new InviteMaterialError();
  const prefix = bytes.slice(0, 34);
  const expected = await hmac(await subkey(key, INFOS.link), concat(DOMAIN, prefix));
  if (!constantTimeEqual(expected, bytes.slice(34))) throw new InviteMaterialError();
  return {
    inviteId: uuidFromBytes(bytes.slice(0, 16)),
    tokenVersion: 1,
    nonceHex: hex(bytes.slice(18, 34)),
    tokenDigest: hex(await sha256(bytes)),
  };
}
