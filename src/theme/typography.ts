import { Platform } from 'react-native';

const systemFontStack = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const fontFamily = {
  regular: Platform.OS === 'web' ? `Manrope_400Regular, ${systemFontStack}` : 'System',
  semibold: Platform.OS === 'web' ? `Manrope_600SemiBold, ${systemFontStack}` : 'System',
  extraBold: Platform.OS === 'web' ? `Manrope_800ExtraBold, ${systemFontStack}` : 'System',
} as const;

export const typography = {
  display: {
    fontFamily: fontFamily.extraBold,
    fontSize: 40,
    fontWeight: Platform.OS === 'web' ? '400' : '800',
    lineHeight: 48,
  },
  title: {
    fontFamily: fontFamily.extraBold,
    fontSize: 28,
    fontWeight: Platform.OS === 'web' ? '400' : '800',
    lineHeight: 36,
  },
  section: {
    fontFamily: fontFamily.extraBold,
    fontSize: 20,
    fontWeight: Platform.OS === 'web' ? '400' : '800',
    lineHeight: 28,
  },
  body: {
    fontFamily: fontFamily.regular,
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 24,
  },
  caption: {
    fontFamily: fontFamily.semibold,
    fontSize: 13,
    fontWeight: Platform.OS === 'web' ? '400' : '700',
    lineHeight: 18,
  },
} as const;
