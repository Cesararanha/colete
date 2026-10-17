import { afterEach, describe, expect, it, vi } from 'vitest';
import jsQR from 'jsqr';
import { inviteQrMatrix, qrDarkRuns } from './invite-qr';
import {
  consumeInviteFragment,
  hasPendingInvite,
  inviteAppOrigin,
  parseInviteLink,
} from './join-fragment';

const origin = 'https://app.example.invalid';
const token = 'A'.repeat(88);
const link = `${origin}/join#token=${token}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('invitation QR', () => {
  it('uses the explicit native origin even when React Native exposes a window without location', () => {
    vi.stubGlobal('window', {});
    vi.stubEnv('EXPO_PUBLIC_INVITE_ORIGIN', origin);
    expect(inviteAppOrigin()).toBe(origin);
    expect(hasPendingInvite()).toBe(false);
    expect(consumeInviteFragment()).toBeNull();
  });
  it('web always uses its own origin instead of a native build setting', () => {
    vi.stubGlobal('window', { location: { origin } });
    vi.stubEnv('EXPO_PUBLIC_INVITE_ORIGIN', 'https://other.example.invalid');
    expect(inviteAppOrigin()).toBe(origin);
  });
  it('native without a configured origin fails closed', () => {
    vi.stubGlobal('window', {});
    vi.stubEnv('EXPO_PUBLIC_INVITE_ORIGIN', undefined);
    expect(inviteAppOrigin()).toBeNull();
  });
  it.each([
    '',
    'not a URL',
    origin + '/',
    origin + '/join',
    origin + '?x=1',
    origin + '#fragment',
    'https://user:pass@app.example.invalid',
    'http://app.example.invalid',
    'javascript:alert(1)',
    ' ' + origin,
  ])(
    'native rejects malformed or non-HTTPS configured origins %# before opening camera',
    (value) => {
      vi.stubGlobal('window', {});
      vi.stubEnv('EXPO_PUBLIC_INVITE_ORIGIN', value);
      expect(inviteAppOrigin()).toBeNull();
      expect(parseInviteLink(link, inviteAppOrigin())).toBeNull();
    },
  );
  it('an independent decoder reads the exact share link, including the fragment', () => {
    const matrix = inviteQrMatrix(link);
    const scale = 5;
    const size = (matrix.length + 8) * scale;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
    matrix.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (!dark) return;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const offset = (((y + 4) * scale + dy) * size + (x + 4) * scale + dx) * 4;
            pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
          }
      }),
    );
    expect(jsQR(pixels, size, size)?.data === link).toBe(true);
    expect(qrDarkRuns([true, true, false, true, false, false, true])).toEqual([
      { start: 0, length: 2 },
      { start: 3, length: 1 },
      { start: 6, length: 1 },
    ]);
  });
  it('accepts only the expected origin and /join fragment, including encoded tokens', () => {
    expect(parseInviteLink(link, origin) === token).toBe(true);
    expect(parseInviteLink(`${origin}/join#token=${'%41'.repeat(88)}`, origin) === token).toBe(
      true,
    );
    expect(
      parseInviteLink('http://127.0.0.1:4173/join#token=' + token, 'http://127.0.0.1:4173') ===
        token,
    ).toBe(true);
  });
  it.each([
    'https://other.example.invalid/join#token=' + token,
    origin + '/elsewhere#token=' + token,
    origin + '/join?token=' + token,
    origin + '/join?x=1#token=' + token,
    origin + '/join/#token=' + token,
    origin + '/join#token=' + token + '&x=1',
    origin + '/join#token=%E0%A4%A',
    origin + '/join#token=synthetic',
    origin + '/join#token=' + token + '=',
    origin + '/join#token=',
    'https://user:pass@app.example.invalid/join#token=' + token,
    '/join#token=' + token,
    'javascript:alert(1)',
    'some other QR',
    'x'.repeat(2049),
    ' ' + link,
  ])('rejects foreign or malformed input %# without throwing', (value) => {
    expect(parseInviteLink(value, origin) === null).toBe(true);
  });
  it('fails closed without a trusted origin or with an origin containing a path', () => {
    expect(parseInviteLink(link, null)).toBeNull();
    expect(parseInviteLink(link, origin + '/')).toBeNull();
  });
});
