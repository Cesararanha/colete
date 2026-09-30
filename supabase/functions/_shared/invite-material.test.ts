import { describe, expect, it } from 'vitest';

import {
  InviteMaterialError,
  deriveInviteMaterial,
  inviteKeyV1,
  lookupCodeDigest,
  normaliseInviteCode,
  parseInviteToken,
} from './invite-material.ts';

// VETOR PÚBLICO SINTÉTICO, nunca chave real: bytes 00..1f, nonce 20..2f.
// Os literais também constam no SQL de prova da 0017. A expectativa foi
// calculada independentemente com crypto.hkdfSync/createHmac/createHash.
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const KEY_BASE64URL = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const NONCE = Uint8Array.from({ length: 16 }, (_, index) => index + 32);
const ID = '01890f7e-e948-7c53-b13a-4a36e4b7d21e';
const TOKEN =
  'AYkPfulIfFOxOko25LfSHgABICEiIyQlJicoKSorLC0uLwBkiD3y3keHZQjrN7V9NVqjT_0DhN72hp1weI75F-Dy';
const TOKEN_DIGEST = 'b44d03c9a10a8a4e3b5696ead1bbe81471f3e9eaa2b05ab888161d1c6093c2b9';
const CODE_DIGEST = '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104';

describe('material de convite v1', () => {
  it('fixa bytes, MAC, código, digests e serialização do token', async () => {
    const material = await deriveInviteMaterial(KEY, ID, NONCE);
    expect(material).toEqual({
      inviteId: ID,
      tokenVersion: 1,
      nonceHex: '202122232425262728292a2b2c2d2e2f',
      token: TOKEN,
      tokenDigest: TOKEN_DIGEST,
      code: 'BYKTT-8DMAB',
      codeDigest: CODE_DIGEST,
      macHex: '0064883df2de47876508eb37b57d355aa34ffd0384def6869d70788ef917e0f2',
    });
    expect(await lookupCodeDigest(KEY, ' bYkTT - 8DmAB ')).toBe(CODE_DIGEST);
    expect(await parseInviteToken(KEY, TOKEN)).toEqual({
      inviteId: ID,
      tokenVersion: 1,
      nonceHex: material.nonceHex,
      tokenDigest: TOKEN_DIGEST,
    });
  });

  it('recusa chave, versão, MAC e formato inválidos antes do domínio', async () => {
    expect(inviteKeyV1(KEY_BASE64URL)).toEqual(KEY);
    expect(() => inviteKeyV1(`${KEY_BASE64URL}=`)).toThrow(InviteMaterialError);
    expect(() => inviteKeyV1('AA')).toThrow(InviteMaterialError);
    expect(normaliseInviteCode(' BYKTT-8DMAB ')).toBe('BYKTT8DMAB');
    expect(() => normaliseInviteCode('BYKTT-8DMA0')).toThrow(InviteMaterialError);
    const bytes = Uint8Array.from(atob(TOKEN.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
      char.charCodeAt(0),
    );
    for (const version of [0, 32768]) {
      const changed = bytes.slice();
      changed[16] = version >>> 8;
      changed[17] = version & 255;
      // Re-sign the altered prefix: only the version guard can reject it.
      const hkdf = await crypto.subtle.importKey('raw', KEY, 'HKDF', false, ['deriveBits']);
      const linkKey = await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new TextEncoder().encode('colete/invite/hkdf-salt/v1'),
          info: new TextEncoder().encode('colete/invite/link-mac/v1'),
        },
        hkdf,
        256,
      );
      const macKey = await crypto.subtle.importKey(
        'raw',
        linkKey,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const prefix = new Uint8Array([
        ...new TextEncoder().encode('colete/invite/v1\0'),
        ...changed.slice(0, 34),
      ]);
      changed.set(new Uint8Array(await crypto.subtle.sign('HMAC', macKey, prefix)), 34);
      const malformed = btoa(String.fromCharCode(...changed))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
      await expect(parseInviteToken(KEY, malformed)).rejects.toThrow(InviteMaterialError);
    }
    await expect(parseInviteToken(KEY, `${TOKEN.slice(0, -1)}A`)).rejects.toThrow(
      InviteMaterialError,
    );
    const wrongKey = Uint8Array.from(KEY, (byte) => byte ^ 255);
    await expect(parseInviteToken(wrongKey, TOKEN)).rejects.toThrow(InviteMaterialError);
  });
});
