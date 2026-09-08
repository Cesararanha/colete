import { Platform } from 'react-native';

const fontFamily =
  Platform.OS === 'web'
    ? 'Manrope, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    : 'System';

export const typography = {
  display: {
    fontFamily,
    fontSize: 40,
    fontWeight: '800',
    lineHeight: 48,
  },
  title: {
    fontFamily,
    fontSize: 28,
    fontWeight: '800',
    lineHeight: 36,
  },
  section: {
    fontFamily,
    fontSize: 20,
    fontWeight: '800',
    lineHeight: 28,
  },
  body: {
    fontFamily,
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 24,
  },
  caption: {
    fontFamily,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
  },
} as const;
