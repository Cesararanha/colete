import type { ViewStyle } from 'react-native';

import type { ThemeMode } from './colors';

// docs/29 §4: shadow only in the light theme; the dark theme separates by layer.
export function raisedShadow(mode: ThemeMode): ViewStyle {
  return mode === 'light'
    ? { boxShadow: '0px 1px 2px rgba(13, 22, 48, 0.05), 0px 6px 20px rgba(13, 22, 48, 0.05)' }
    : {};
}

export function navigationShadow(mode: ThemeMode): ViewStyle {
  return mode === 'light' ? { boxShadow: '0px -10px 30px rgba(13, 22, 48, 0.06)' } : {};
}
