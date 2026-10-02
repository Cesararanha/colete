const CHANNEL_NAME = 'colete-session-lifecycle';

/** The message has no account identifier or credential. */
export function announceLocalSignOut() {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.postMessage('signed-out');
  channel.close();
}

export function listenForLocalSignOut(onSignOut: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (event.data === 'signed-out') onSignOut();
  };
  return () => channel.close();
}
