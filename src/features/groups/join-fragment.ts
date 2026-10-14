type InviteWindow = Window & { __COLETE_INVITE_TOKEN__?: string };

export function hasPendingInvite(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  const page = window as InviteWindow;
  return (
    typeof page.__COLETE_INVITE_TOKEN__ === 'string' ||
    (window.location.pathname === '/join' && window.location.hash.startsWith('#token='))
  );
}

/** Consume the fragment synchronously, before the join screen makes a request. */
export function consumeInviteFragment(): string | null {
  if (typeof window === 'undefined' || !window.location) return null;
  const page = window as InviteWindow;
  const captured = page.__COLETE_INVITE_TOKEN__;
  delete page.__COLETE_INVITE_TOKEN__;
  if (typeof captured === 'string') return captured === '' ? null : captured;
  if (!window.location.hash) return null;
  const fragment = window.location.hash;
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + window.location.search,
  );
  if (!fragment.startsWith('#token=')) return null;
  try {
    return decodeURIComponent(fragment.slice(7));
  } catch {
    return null;
  }
}

/** QR input is untrusted. Never navigate to it or include it in an error. */
export function parseInviteLink(value: string, expectedOrigin: string | null): string | null {
  if (expectedOrigin === null || value.length > 2048 || value !== value.trim()) return null;
  try {
    const origin = new URL(expectedOrigin);
    const link = new URL(value);
    if (
      !['https:', 'http:'].includes(origin.protocol) ||
      origin.origin !== expectedOrigin ||
      link.origin !== expectedOrigin ||
      link.username !== '' ||
      link.password !== '' ||
      link.pathname !== '/join' ||
      link.search !== '' ||
      !link.hash.startsWith('#token=')
    )
      return null;
    const token = decodeURIComponent(link.hash.slice(7));
    // The current link is exactly 66 bytes, base64url without padding (88 symbols).
    return /^[A-Za-z0-9_-]{88}$/u.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** Native builds must explicitly name the same public origin used by the Edge. */
export function inviteAppOrigin(): string | null {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  const configured = process.env.EXPO_PUBLIC_INVITE_ORIGIN;
  if (!configured) return null;
  try {
    const origin = new URL(configured);
    return origin.protocol === 'https:' && origin.origin === configured ? configured : null;
  } catch {
    return null;
  }
}
