import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INVITE_STORAGE_KEY,
  INVITE_TTL_MS,
  forgetInvite,
  rememberInvite,
  storedInvite,
} from './pending-invite';

const token = 'A'.repeat(88);

function fakeStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('the invitation kept for a sign in', () => {
  it('keeps a well-formed token in this tab only, for at most thirty minutes', () => {
    const sessionStorage = fakeStorage();
    const localStorage = fakeStorage();
    vi.stubGlobal('window', { sessionStorage, localStorage });
    rememberInvite(token, 1_000);
    expect(JSON.parse(sessionStorage.items.get(INVITE_STORAGE_KEY)!)).toEqual({
      token,
      expiresAt: 1_000 + INVITE_TTL_MS,
    });
    expect(localStorage.items.size).toBe(0);
    expect(storedInvite(1_000 + INVITE_TTL_MS - 1)).toBe(token);
    // Expired: not returned, and removed.
    expect(storedInvite(1_000 + INVITE_TTL_MS)).toBeNull();
    expect(sessionStorage.items.has(INVITE_STORAGE_KEY)).toBe(false);
  });

  it('never keeps a malformed token, and drops a tampered or far-future entry', () => {
    const sessionStorage = fakeStorage();
    vi.stubGlobal('window', { sessionStorage });
    for (const value of ['', 'A'.repeat(87), `${'A'.repeat(87)}=`, `${token}x`, 'https://x'])
      rememberInvite(value);
    expect(sessionStorage.items.size).toBe(0);
    for (const raw of [
      '{',
      'null',
      JSON.stringify({ token: 'short', expiresAt: Date.now() + 1_000 }),
      JSON.stringify({ token, expiresAt: '9999' }),
      JSON.stringify({ token, expiresAt: Date.now() + INVITE_TTL_MS * 10 }),
    ]) {
      sessionStorage.items.set(INVITE_STORAGE_KEY, raw);
      expect(storedInvite()).toBeNull();
      expect(sessionStorage.items.has(INVITE_STORAGE_KEY)).toBe(false);
    }
  });

  it('is removed once used, and survives an unavailable storage', () => {
    const sessionStorage = fakeStorage();
    vi.stubGlobal('window', { sessionStorage });
    rememberInvite(token);
    expect(storedInvite()).toBe(token);
    forgetInvite();
    expect(storedInvite()).toBeNull();
    vi.stubGlobal('window', {
      get sessionStorage(): Storage {
        throw new Error('blocked');
      },
    });
    expect(() => rememberInvite(token)).not.toThrow();
    expect(storedInvite()).toBeNull();
    expect(() => forgetInvite()).not.toThrow();
  });

  it('is dropped when the person signs out here or in another tab', async () => {
    vi.resetModules();
    const sessionStorage = fakeStorage();
    let receive: ((event: { data: unknown }) => void) | null = null;
    class Channel {
      set onmessage(handler: (event: { data: unknown }) => void) {
        receive = handler;
      }
      postMessage() {}
      close() {}
    }
    vi.stubGlobal('window', { sessionStorage });
    vi.stubGlobal('BroadcastChannel', Channel);
    const broadcast = await import('./session-broadcast');
    const invite = await import('./pending-invite');
    invite.rememberInvite(token);
    broadcast.announceLocalSignOut();
    expect(invite.storedInvite()).toBeNull();
    invite.rememberInvite(token);
    const onSignOut = vi.fn();
    broadcast.listenForLocalSignOut(onSignOut);
    receive!({ data: 'other' });
    expect(invite.storedInvite()).toBe(token);
    receive!({ data: 'signed-out' });
    expect(invite.storedInvite()).toBeNull();
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
