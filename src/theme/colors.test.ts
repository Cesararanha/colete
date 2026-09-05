import { describe, expect, it } from 'vitest';

import { colors, contrastRatio } from './colors';

describe('theme contrast', () => {
  for (const [mode, palette] of Object.entries(colors)) {
    it(`${mode} keeps body text at WCAG AA contrast`, () => {
      expect(contrastRatio(palette.text, palette.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.text, palette.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.text, palette.surfaceStrong)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.textMuted, palette.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.textMuted, palette.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.textMuted, palette.surfaceStrong)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.positive, palette.surfaceStrong)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.critical, palette.surface)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${mode} keeps primary controls at WCAG AA contrast`, () => {
      expect(contrastRatio(palette.onPrimary, palette.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.primary, palette.surface)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${mode} keeps focus and component boundaries distinguishable`, () => {
      expect(contrastRatio(palette.focus, palette.background)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(palette.focus, palette.surface)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(palette.border, palette.surface)).toBeGreaterThanOrEqual(3);
    });
  }
});
