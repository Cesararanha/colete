import { describe, expect, it } from 'vitest';

import { InvalidAuthUserIdError, bootstrapActorKey } from './bootstrap.ts';

const GOLDEN = 'bootstrap:21409156bb1cbd9d8cadf3814edcf230153e3378c09dc03ebf5ed8940c9c4d3a';

describe('the bootstrap actor', () => {
  it('reproduces the published golden vector', async () => {
    await expect(bootstrapActorKey('01890f7e-e948-7c53-b13a-4a36e4b7d21e')).resolves.toBe(GOLDEN);
  });

  it('hashes the sixteen bytes, not the text of the UUID', async () => {
    // Hashing the text of the hyphenless form would be the easy mistake, and it
    // produces a different digest, so the vector above is what rules it out.
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('01890f7ee9487c53b13a4a36e4b7d21e'),
    );
    const asText = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    expect(GOLDEN).not.toBe(`bootstrap:${asText}`);
  });

  it('requires a canonical lowercase UUID', async () => {
    await expect(bootstrapActorKey('01890F7E-E948-7C53-B13A-4A36E4B7D21E')).rejects.toBeInstanceOf(
      InvalidAuthUserIdError,
    );
    await expect(bootstrapActorKey('not-a-uuid')).rejects.toBeInstanceOf(InvalidAuthUserIdError);
    await expect(bootstrapActorKey('01890f7ee9487c53b13a4a36e4b7d21e')).rejects.toBeInstanceOf(
      InvalidAuthUserIdError,
    );
  });
});
