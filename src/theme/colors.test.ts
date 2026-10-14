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
