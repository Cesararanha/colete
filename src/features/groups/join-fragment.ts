type InviteWindow = Window & { __COLETE_INVITE_TOKEN__?: string };

export function hasPendingInvite(): boolean {
  if (typeof window === 'undefined') return false;
  const page = window as InviteWindow;
  return (
    typeof page.__COLETE_INVITE_TOKEN__ === 'string' ||
    (window.location.pathname === '/join' && window.location.hash.startsWith('#token='))
  );
}

/** Consume the fragment synchronously, before the join screen makes a request. */
export function consumeInviteFragment(): string | null {
  if (typeof window === 'undefined') return null;
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
