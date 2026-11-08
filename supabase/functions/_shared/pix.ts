// Pix manual of the pilot (0036, noite/plano-pix-manual.md version 3): the
// organiser's Pix key is validated and normalised here, the idempotency HMAC is
// computed over that open normalised form, and only then is the key sealed with
// AES-256-GCM under PIX_KEY_ENC_KEY_V1. The database never sees the open key.
//
// Nothing in this file echoes a key, a name or a city: validation reasons are
// fixed texts (AGENTS section 2).

import { GatewayError, defaultMessage, validation } from './errors.ts';

export const PIX_KEY_TYPES = ['cpf', 'cnpj', 'email', 'phone', 'random'] as const;
export type PixKeyType = (typeof PIX_KEY_TYPES)[number];

export interface OpenPix {
  readonly type: PixKeyType;
  readonly key: string;
  readonly receiver_name: string;
  readonly receiver_city: string;
}

export interface SealedPix {
  readonly type: PixKeyType;
  readonly ciphertext: string;
  readonly key_version: number;
  readonly last4: string;
  readonly receiver_name: string;
  readonly receiver_city: string;
}

export const PIX_KEY_VERSION = 1;
export const RECEIVER_NAME_MAX = 25;
export const RECEIVER_CITY_MAX = 15;
// Field 26 of the BR Code holds at most 99 characters: GUI subfield (4 + 14)
// plus the key subfield header (4) leaves 77 for the key.
export const PIX_KEY_MAX = 77;

const PIX_FIELDS = ['type', 'key', 'receiver_name', 'receiver_city'] as const;

function cpfValid(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const check = (length: number): number => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * (length + 1 - index);
    }
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
}

// Numeric and alphanumeric CNPJ (Receita Federal, from July 2026): each of the
// twelve base positions is worth its ASCII code minus 48; the two check digits
// stay numeric and use the classic weights.
function cnpjValid(value: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false;
  const values = [...value].map((char) => char.charCodeAt(0) - 48);
  const check = (length: number): number => {
    const weights =
      length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += (values[index] ?? 0) * weights[index]!;
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return check(12) === values[12] && check(13) === values[13];
}

/** The key in the form the BR Code and the HMAC use. Throws a fixed reason. */
export function normalisePixKey(type: PixKeyType, raw: string): string {
  const trimmed = raw.normalize('NFC').trim();
  switch (type) {
    case 'cpf': {
      const digits = trimmed.replace(/[.\-\s]/g, '');
      if (!cpfValid(digits)) throw validation('pix.key', 'invalid cpf');
      return digits;
    }
    case 'cnpj': {
      const compact = trimmed.replace(/[.\-/\s]/g, '').toUpperCase();
      if (!cnpjValid(compact)) throw validation('pix.key', 'invalid cnpj');
      return compact;
    }
    case 'phone': {
      const digits = trimmed.replace(/[\s().\-]/g, '');
      const withoutPlus = digits.startsWith('+') ? digits.slice(1) : digits;
      if (!/^\d+$/.test(withoutPlus)) throw validation('pix.key', 'invalid phone');
      const national =
        withoutPlus.startsWith('55') && (withoutPlus.length === 12 || withoutPlus.length === 13)
          ? withoutPlus.slice(2)
          : withoutPlus;
      // DDD 11 to 99, then 8 digits (landline) or 9 starting with 9 (mobile).
      if (!/^[1-9][1-9](\d{8}|9\d{8})$/.test(national))
        throw validation('pix.key', 'invalid phone');
      return `+55${national}`;
    }
    case 'email': {
      const email = trimmed.toLowerCase();
      if (
        email.length > PIX_KEY_MAX ||
        !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
          email,
        )
      ) {
        throw validation('pix.key', 'invalid email');
      }
      return email;
    }
    case 'random': {
      const uuid = trimmed.toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
        throw validation('pix.key', 'invalid random key');
      }
      return uuid;
    }
  }
}

/**
 * Receiver name and city as the BR Code carries them: no accents, upper case,
 * only A-Z, 0-9 and single spaces, cut to the limit after normalising.
 */
export function normaliseReceiverText(raw: string, max: number, field: string): string {
  const plain = raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = plain.slice(0, max).trim();
  if (cut.length === 0) throw validation(field, 'must contain letters or digits');
  return cut;
}

/** The pix field of set_match_pix: null removes, an object sets. */
export function normalisePix(value: unknown): OpenPix | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw validation('pix', 'must be an object or null');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(PIX_FIELDS as readonly string[]).includes(key)) throw validation('pix', 'unknown key');
  }
  for (const key of PIX_FIELDS) {
    if (typeof record[key] !== 'string') throw validation(`pix.${key}`, 'must be a string');
  }
  const type = record['type'] as string;
  if (!(PIX_KEY_TYPES as readonly string[]).includes(type)) {
    throw validation('pix.type', 'must be one of the allowed values');
  }
  return {
    type: type as PixKeyType,
    key: normalisePixKey(type as PixKeyType, record['key'] as string),
    receiver_name: normaliseReceiverText(
      record['receiver_name'] as string,
      RECEIVER_NAME_MAX,
      'pix.receiver_name',
    ),
    receiver_city: normaliseReceiverText(
      record['receiver_city'] as string,
      RECEIVER_CITY_MAX,
      'pix.receiver_city',
    ),
  };
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** PIX_KEY_ENC_KEY_V1: exactly 32 random bytes, base64url. */
export function pixKeyFromEnvironment(read: (name: string) => string | undefined): Uint8Array {
  const raw = read('PIX_KEY_ENC_KEY_V1');
  if (raw === undefined || raw.length === 0) throw new Error('PIX_KEY_ENC_KEY_V1 is missing');
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('PIX_KEY_ENC_KEY_V1 is not base64url');
  const bytes = fromBase64Url(raw);
  if (bytes.length !== 32) throw new Error('PIX_KEY_ENC_KEY_V1 must hold 32 bytes');
  return bytes;
}

// The additional data binds a ciphertext to its version, its key type and its
// match: a ciphertext copied to another match, or relabelled, fails the tag.
function additionalData(type: PixKeyType, matchId: string): Uint8Array {
  return new TextEncoder().encode(`colete:pix:v${PIX_KEY_VERSION}|${type}|${matchId}`);
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export type PixSealer = (pix: OpenPix, matchId: string) => Promise<SealedPix>;
export type PixOpener = (
  type: PixKeyType,
  ciphertext: string,
  keyVersion: number,
  matchId: string,
) => Promise<string>;

export function pixSealer(raw: Uint8Array): PixSealer {
  return async (pix, matchId) => {
    const key = await importKey(raw);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: additionalData(pix.type, matchId) as BufferSource,
        },
        key,
        new TextEncoder().encode(pix.key) as BufferSource,
      ),
    );
    const envelope = new Uint8Array(nonce.length + sealed.length);
    envelope.set(nonce, 0);
    envelope.set(sealed, nonce.length);
    return {
      type: pix.type,
      ciphertext: toBase64(envelope),
      key_version: PIX_KEY_VERSION,
      last4: pix.key.slice(-4),
      receiver_name: pix.receiver_name,
      receiver_city: pix.receiver_city,
    };
  };
}

export function pixOpener(raw: Uint8Array): PixOpener {
  return async (type, ciphertext, keyVersion, matchId) => {
    if (keyVersion !== PIX_KEY_VERSION) throw new Error('unknown Pix key version');
    const envelope = fromBase64(ciphertext);
    const key = await importKey(raw);
    const open = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: envelope.slice(0, 12) as BufferSource,
        additionalData: additionalData(type, matchId) as BufferSource,
      },
      key,
      envelope.slice(12) as BufferSource,
    );
    return new TextDecoder().decode(open);
  };
}

export function pixUnavailable(): GatewayError {
  return new GatewayError('INTERNAL', defaultMessage('INTERNAL'));
}
