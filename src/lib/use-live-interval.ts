import { useIsFocused } from 'expo-router';

import { liveInterval } from './live-refresh';

/**
 * The refetchInterval of a screen's read (HX-003): every 30 s while this
 * screen is in front and the session holds; nothing under another screen.
 */
export function useLiveInterval() {
  const focused = useIsFocused();
  return (query: { state: { error: unknown } }) => liveInterval(focused, query.state.error);
}
