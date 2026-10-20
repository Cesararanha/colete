import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PENDING_SIGNUP_STORAGE_KEY,
  PENDING_SIGNUP_TTL_MS,
  forgetPendingSignup,
  keepPendingSignup,
  keptPendingSignup,
} from './pending-signup';

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

describe('the sign up waiting for its code (rev84 P1)', () => {
  it('keeps only the e-mail and the resend time, in this tab, while the code is valid', () => {
    const sessionStorage = fakeStorage();
    const localStorage = fakeStorage();
    vi.stubGlobal('window', { sessionStorage, localStorage });
    keepPendingSignup({ email: 'pessoa@colete.test', resendAvailableAt: 61_000 }, 1_000);
    expect(JSON.parse(sessionStorage.items.get(PENDING_SIGNUP_STORAGE_KEY)!)).toEqual({
      email: 'pessoa@colete.test',
      resendAvailableAt: 61_000,
      expiresAt: 1_000 + PENDING_SIGNUP_TTL_MS,
    });
    expect(localStorage.items.size).toBe(0);
    expect(keptPendingSignup(1_000 + PENDING_SIGNUP_TTL_MS - 1)).toEqual({
      email: 'pessoa@colete.test',
      resendAvailableAt: 61_000,
    });
    expect(keptPendingSignup(1_000 + PENDING_SIGNUP_TTL_MS)).toBeNull();
    expect(sessionStorage.items.has(PENDING_SIGNUP_STORAGE_KEY)).toBe(false);
  });

  it('drops a malformed, tampered or far-future entry, and survives a blocked storage', () => {
    const sessionStorage = fakeStorage();
    vi.stubGlobal('window', { sessionStorage });
    for (const raw of [
      '{',
      'null',
      JSON.stringify({ email: '', resendAvailableAt: null, expiresAt: Date.now() + 1_000 }),
      JSON.stringify({ email: 'a@b.c', resendAvailableAt: '1', expiresAt: Date.now() + 1_000 }),
      JSON.stringify({ email: 'a@b.c', resendAvailableAt: null, expiresAt: Date.now() * 2 }),
    ]) {
      sessionStorage.items.set(PENDING_SIGNUP_STORAGE_KEY, raw);
      expect(keptPendingSignup()).toBeNull();
      expect(sessionStorage.items.size).toBe(0);
    }
    keepPendingSignup({ email: 'a@b.c', resendAvailableAt: null });
    forgetPendingSignup();
    expect(keptPendingSignup()).toBeNull();
    vi.stubGlobal('window', {
      get sessionStorage(): Storage {
        throw new Error('blocked');
      },
    });
    expect(() => keepPendingSignup({ email: 'a@b.c', resendAvailableAt: null })).not.toThrow();
    expect(keptPendingSignup()).toBeNull();
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
    const signup = await import('./pending-signup');
    signup.keepPendingSignup({ email: 'a@b.c', resendAvailableAt: null });
    broadcast.announceLocalSignOut();
    expect(signup.keptPendingSignup()).toBeNull();
    signup.keepPendingSignup({ email: 'a@b.c', resendAvailableAt: null });
    broadcast.listenForLocalSignOut(() => undefined);
    receive!({ data: 'signed-out' });
    expect(signup.keptPendingSignup()).toBeNull();
  });
});
