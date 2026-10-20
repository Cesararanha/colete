/**
 * The e-mail of a sign up waiting for its code, kept for this tab so that a
 * reload of "Verificar código" (the person went to the e-mail app and came
 * back) still offers the code field. Only the address and when the next code
 * may be asked for: never the code, the password or the name. Only this tab's
 * sessionStorage, for as long as the code is valid (otp_expiry, 3600 s; a
 * resend starts it again), and removed when the code is accepted, when the
 * person goes back to the sign-up form and when anyone signs out here.
 */
export const PENDING_SIGNUP_STORAGE_KEY = 'colete:pending-signup';
export const PENDING_SIGNUP_TTL_MS = 60 * 60 * 1000;

export type PendingSignup = { email: string; resendAvailableAt: number | null };

function tabStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function keepPendingSignup(signup: PendingSignup, now = Date.now()) {
  const storage = tabStorage();
  if (storage === null || signup.email.trim() === '') return;
  try {
    storage.setItem(
      PENDING_SIGNUP_STORAGE_KEY,
      JSON.stringify({ ...signup, expiresAt: now + PENDING_SIGNUP_TTL_MS }),
    );
  } catch {
    // Without storage the sign up still lives in page memory, as before.
  }
}

/** The kept sign up, if its code may still be valid. Anything else is removed. */
export function keptPendingSignup(now = Date.now()): PendingSignup | null {
  const storage = tabStorage();
  if (storage === null) return null;
  try {
    const raw = storage.getItem(PENDING_SIGNUP_STORAGE_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as {
      email?: unknown;
      resendAvailableAt?: unknown;
      expiresAt?: unknown;
    } | null;
    if (
      typeof value?.email === 'string' &&
      value.email.trim() !== '' &&
      (value.resendAvailableAt === null || typeof value.resendAvailableAt === 'number') &&
      typeof value.expiresAt === 'number' &&
      value.expiresAt > now &&
      value.expiresAt <= now + PENDING_SIGNUP_TTL_MS
    )
      return { email: value.email, resendAvailableAt: value.resendAvailableAt };
  } catch {
    // Malformed: removed below.
  }
  forgetPendingSignup();
  return null;
}

export function forgetPendingSignup() {
  try {
    tabStorage()?.removeItem(PENDING_SIGNUP_STORAGE_KEY);
  } catch {
    // Nothing kept, or nothing reachable.
  }
}
