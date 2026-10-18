import { describe, expect, it } from 'vitest';

import { colors, contrastRatio, type ThemeColors } from './colors';

type Pair = [foreground: keyof ThemeColors, background: keyof ThemeColors, minimum: number];

// docs/29 §3 (ESPEC Placar premium §3): every pair, in both themes. The ratio
// is computed here; the table's numbers are only a cross-check for humans.
// Pairs marked "—" for one theme in the table are still asserted there.
const textPairs: Pair[] = [
  ['text', 'background', 4.5],
  ['text', 'surface', 4.5],
  ['text', 'surfaceRaised', 4.5],
  ['textMuted', 'background', 4.5],
  ['textMuted', 'surface', 4.5],
  ['textMuted', 'surfaceRaised', 4.5],
  ['onPrimary', 'primary', 4.5],
  ['link', 'background', 4.5],
  ['link', 'surfaceRaised', 4.5],
  ['onBand', 'brandBand', 4.5],
  ['onBandMuted', 'brandBand', 4.5],
  ['onBand', 'bandRaised', 4.5],
  ['digit', 'scoreTileTop', 4.5],
  ['digit', 'scoreTileBottom', 4.5],
  ['warning', 'surfaceRaised', 4.5],
  ['warning', 'background', 4.5],
  ['critical', 'background', 4.5],
  ['critical', 'surfaceRaised', 4.5],
  ['positive', 'surfaceRaised', 4.5],
  ['info', 'surfaceRaised', 4.5],
  // Prévia aprovada (PR G): every chip and avatar is text on its soft fill.
  ['positive', 'positiveSoft', 4.5],
  ['warning', 'warningSoft', 4.5],
  ['info', 'infoSoft', 4.5],
  ['critical', 'criticalSoft', 4.5],
  ['primary', 'primarySoft', 4.5],
  ['accent', 'accentSoft', 4.5],
  ['text', 'avatar', 4.5],
  ['textSoft', 'surfaceRaised', 4.5],
  ['onPositive', 'positive', 4.5],
  ['onWarning', 'warning', 4.5],
  ['onPrimary', 'primary', 4.5],
  // Cards of the prévia sit on surface, not surfaceRaised.
  ['textSoft', 'surface', 4.5],
  ['positive', 'surface', 4.5],
  ['warning', 'surface', 4.5],
  ['info', 'surface', 4.5],
  ['critical', 'surface', 4.5],
  ['accent', 'surface', 4.5],
  // Group colours (PR H): the glyph on its tile, on cards and on the screen.
  ['lilac', 'lilacSoft', 4.5],
  ['sand', 'sandSoft', 4.5],
  ['lilac', 'surface', 4.5],
  ['sand', 'surface', 4.5],
  ['lilac', 'surfaceRaised', 4.5],
  ['sand', 'surfaceRaised', 4.5],
  ['accent', 'surfaceRaised', 4.5],
  // The check on the selected swatch is drawn in the background colour.
  ['background', 'info', 4.5],
  ['background', 'positive', 4.5],
  ['background', 'warning', 4.5],
  ['background', 'accent', 4.5],
  ['background', 'lilac', 4.5],
  ['background', 'sand', 4.5],
  // Labels inside the scoreboard use its own tokens, identical in both themes.
  ['digitDim', 'scoreboard', 4.5],
];

const componentPairs: Pair[] = [
  ['digitDim', 'scoreTileTop', 3],
  ['digitDim', 'scoreTileBottom', 3],
  ['digitDim', 'scoreboard', 3],
  ['fieldBorder', 'surfaceRaised', 3],
  ['fieldBorder', 'background', 3],
  ['primary', 'background', 3],
  ['indicator', 'surface', 3],
  ['indicator', 'surfaceRaised', 3],
  ['focus', 'background', 3],
  ['focusOnBand', 'brandBand', 3],
  // textMuted as a functional icon colour.
  ['textMuted', 'surfaceRaised', 3],
  // The filled part of an occupancy bar against its track (the count is also text).
  ['positive', 'track', 3],
  ['warning', 'track', 3],
  ['info', 'track', 3],
  ['critical', 'track', 3],
  // A colour swatch and the ring of the selected icon against the screen.
  ['info', 'background', 3],
  ['positive', 'background', 3],
  ['accent', 'background', 3],
  ['lilac', 'background', 3],
  ['sand', 'background', 3],
  // The outline of an outline button, on the screen and inside a card.
  ['fieldBorder', 'surface', 3],
];

describe('theme contrast', () => {
  for (const [mode, palette] of Object.entries(colors)) {
    for (const [foreground, background, minimum] of [...textPairs, ...componentPairs]) {
      it(`${mode}: ${foreground} on ${background} reaches ${minimum}:1`, () => {
        expect(contrastRatio(palette[foreground], palette[background])).toBeGreaterThanOrEqual(
          minimum,
        );
      });
    }
  }

  it('keeps the scoreboard identical in both themes', () => {
    for (const key of [
      'scoreboard',
      'scoreTileTop',
      'scoreTileBottom',
      'digit',
      'digitDim',
    ] as const) {
      expect(colors.light[key]).toBe(colors.dark[key]);
    }
  });

  it('declares the same tokens in both themes', () => {
    expect(Object.keys(colors.light).sort()).toEqual(Object.keys(colors.dark).sort());
  });
});

describe('contrast formula', () => {
  it('matches the WCAG extremes, so the table above cannot pass vacuously', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeLessThan(4.5);
  });
});
