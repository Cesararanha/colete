import { describe, expect, it } from 'vitest';

import { MissingKeyError, computeIdempotencyHmac, keyResolverFromEnvironment } from './hmac.ts';

// docs/13-contratos-funcoes.md section 0.1 publishes this as the test key: the
// bytes 0x00 through 0x1f. It is a test key and nothing else. The real one
// lives in the vault and never reaches this repository.
const TEST_KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const GOLDEN = '5974c4e8c2434e4d150f2f2199180b3228c869f80e72dabc0f25218132595ee4';

function testKey(): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = i;
  return bytes;
}

describe('the idempotency HMAC', () => {
  it('reproduces the published golden vector', async () => {
    const mac = await computeIdempotencyHmac(() => testKey(), 1, 'join_match', {
      list_kind: 'field',
      match_id: '01890f7e-e948-7c53-b13a-4a36e4b7d21e',
    });
    expect(mac).toBe(GOLDEN);
  });

  it('reaches the same vector when the members arrive reordered', async () => {
    const mac = await computeIdempotencyHmac(() => testKey(), 1, 'join_match', {
      match_id: '01890f7e-e948-7c53-b13a-4a36e4b7d21e',
      list_kind: 'field',
    });
    expect(mac).toBe(GOLDEN);
  });

  it('separates the operation from the input, so one cannot be read as the other', async () => {
    const a = await computeIdempotencyHmac(() => testKey(), 1, 'join_match', { a: 1 });
    const b = await computeIdempotencyHmac(() => testKey(), 1, 'join_matc', { a: 1 });
    expect(a).not.toBe(b);
  });

  it('gives an absent member and an explicit null different digests', async () => {
    const absent = await computeIdempotencyHmac(() => testKey(), 1, 'update_profile', {
      patch: {},
    });
    const explicit = await computeIdempotencyHmac(() => testKey(), 1, 'update_profile', {
      patch: { nickname: null },
    });
    expect(absent).not.toBe(explicit);
  });

  it('refuses to sign when the key version is unknown', async () => {
    await expect(
      computeIdempotencyHmac(() => undefined, 2, 'join_match', {}),
    ).rejects.toBeInstanceOf(MissingKeyError);
  });

  it('names only the version when a key is missing, never a key', async () => {
    const thrown = await computeIdempotencyHmac(() => undefined, 9, 'join_match', {}).catch(
      (error: unknown) => error as Error,
    );
    expect(thrown.message).toBe('no idempotency HMAC key for version 9');
    expect(thrown.message).not.toContain(TEST_KEY_HEX);
  });

  it('resolves keys by version from the environment', async () => {
    const resolve = keyResolverFromEnvironment(
      (name) => (name === 'IDEMPOTENCY_HMAC_KEY_V1' ? TEST_KEY_HEX : undefined),
      [1, 2],
    );
    expect(resolve(1)).toEqual(testKey());
    // A version with no variable resolves to nothing rather than to version 1.
    expect(resolve(2)).toBeUndefined();
    const mac = await computeIdempotencyHmac(resolve, 1, 'join_match', {
      list_kind: 'field',
      match_id: '01890f7e-e948-7c53-b13a-4a36e4b7d21e',
    });
    expect(mac).toBe(GOLDEN);
  });

  it('rejects a key that is not hexadecimal instead of hashing its text', () => {
    expect(() => keyResolverFromEnvironment(() => 'not-hex', [1])).toThrow(/not hexadecimal/);
  });
});
