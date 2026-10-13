import { Platform, type TextStyle } from 'react-native';

/**
 * Bundled faces, one file per weight (docs/29 §4). On the web each family is a
 * stack ending in the system font, so text renders at once with the right
 * weight while Barlow loads; `font-synthesis: none` in +html keeps the browser
 * from faking bold on top of an already bold face. Native gets the family
 * name alone: there a weight on a single-face family would be synthesized.
 */
export const fontFamilies = {
  regular: 'Barlow_400Regular',
  semibold: 'Barlow_600SemiBold',
  bold: 'Barlow_700Bold',
  condensed: 'BarlowCondensed_700Bold',
} as const;

const systemFallback = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

type Face = keyof typeof fontFamilies;
const weights: Record<Face, TextStyle['fontWeight']> = {
  regular: '400',
  semibold: '600',
  bold: '700',
  condensed: '700',
};

export function face(name: Face): TextStyle {
  return Platform.OS === 'web'
    ? { fontFamily: `${fontFamilies[name]}, ${systemFallback}`, fontWeight: weights[name] }
    : { fontFamily: fontFamilies[name] };
}

export const typography = {
  scoreboard: { ...face('condensed'), fontSize: 64, fontVariant: ['tabular-nums'] },
  inviteCode: { ...face('condensed'), fontSize: 56, fontVariant: ['tabular-nums'] },
  brand: { ...face('condensed'), fontSize: 24, letterSpacing: 3, lineHeight: 28 },
  display: { ...face('bold'), fontSize: 32, letterSpacing: -0.3, lineHeight: 38 },
  title: { ...face('semibold'), fontSize: 22, lineHeight: 28 },
  row: { ...face('semibold'), fontSize: 18, lineHeight: 24 },
  body: { ...face('regular'), fontSize: 17, lineHeight: 25 },
  bodyStrong: { ...face('semibold'), fontSize: 17, lineHeight: 25 },
  support: { ...face('regular'), fontSize: 15, lineHeight: 21 },
  supportStrong: { ...face('semibold'), fontSize: 15, lineHeight: 21 },
  button: { ...face('bold'), fontSize: 17, lineHeight: 22 },
  overline: {
    ...face('semibold'),
    fontSize: 13,
    letterSpacing: 1.6,
    lineHeight: 16,
    textTransform: 'uppercase',
  },
  navigation: { ...face('semibold'), fontSize: 13, lineHeight: 16 },
} satisfies Record<string, TextStyle>;
