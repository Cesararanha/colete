import { forgetInvite } from './pending-invite';

const CHANNEL_NAME = 'colete-session-lifecycle';

/**
 * The message has no account identifier or credential. Whoever signs out on
 * this device also drops an invitation kept for a sign in (lib/pending-invite).
 */
export function announceLocalSignOut() {
  forgetInvite();
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage('signed-out');
  channel.close();
}

export function listenForLocalSignOut(onSignOut: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (event.data !== 'signed-out') return;
    forgetInvite();
    onSignOut();
  };
  return () => channel.close();
}

// Auth SIGNED_OUT, the manual action and the broadcast may all run before
// the browser unloads. Discard this document once, including its private heap.
let signOutNavigationStarted = false;

export function reloadAfterSignOut() {
  if (signOutNavigationStarted) return;
  signOutNavigationStarted = true;
  window.location.replace('/entrar');
}
