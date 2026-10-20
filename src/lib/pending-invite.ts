/**
 * The invitation of a /join link, kept for this tab while the person signs in
 * or creates the account, so that a reload on any step still ends on the
 * group's page. Only this tab's sessionStorage, never localStorage, the URL,
 * history or a cache; at most INVITE_TTL_MS; removed once used. The inline
 * script of app/+html.tsx writes the same key with the same shape.
 */
export const INVITE_STORAGE_KEY = 'colete:invite';
export const INVITE_TTL_MS = 30 * 60 * 1000;

// The current link is exactly 66 bytes, base64url without padding (88 symbols).
export const INVITE_TOKEN_SOURCE = '^[A-Za-z0-9_-]{88}$';
const INVITE_TOKEN = new RegExp(INVITE_TOKEN_SOURCE, 'u');

function tabStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function isInviteToken(value: string): boolean {
  return INVITE_TOKEN.test(value);
}

export function rememberInvite(token: string, now = Date.now()) {
  const storage = tabStorage();
  if (storage === null || !isInviteToken(token)) return;
  try {
    storage.setItem(INVITE_STORAGE_KEY, JSON.stringify({ token, expiresAt: now + INVITE_TTL_MS }));
  } catch {
    // Without storage the invitation still lives in page memory, as before.
  }
}

/** The kept invitation, if still valid. An expired or malformed entry is removed. */
export function storedInvite(now = Date.now()): string | null {
  const storage = tabStorage();
  if (storage === null) return null;
  try {
    const raw = storage.getItem(INVITE_STORAGE_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown } | null;
    if (
      typeof value?.token === 'string' &&
      isInviteToken(value.token) &&
      typeof value.expiresAt === 'number' &&
      value.expiresAt > now &&
      value.expiresAt <= now + INVITE_TTL_MS
    )
      return value.token;
  } catch {
    // Malformed: removed below.
  }
  forgetInvite();
  return null;
}

export function forgetInvite() {
  try {
    tabStorage()?.removeItem(INVITE_STORAGE_KEY);
  } catch {
    // Nothing kept, or nothing reachable.
  }
}
