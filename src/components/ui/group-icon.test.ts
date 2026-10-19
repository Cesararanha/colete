import { describe, expect, it } from 'vitest';

import { colors, contrastRatio } from '../../theme/colors';
import {
  DEFAULT_GROUP_APPEARANCE,
  GROUP_COLORS,
  GROUP_ICONS,
  groupAppearance,
  groupColors,
  groupIconTile,
} from './group-icon';

describe('group appearance', () => {
  it('lists the eight icons and six colours of the prévia, in order', () => {
    expect(GROUP_ICONS).toEqual([
      'ball',
      'goal',
      'field',
      'whistle',
      'shirt',
      'trophy',
      'bolt',
      'flame',
    ]);
    expect(GROUP_COLORS).toEqual(['blue', 'green', 'orange', 'pink', 'lilac', 'sand']);
  });

  it('keeps a listed choice and draws the blue ball for anything else', () => {
    expect(groupAppearance('flame', 'sand')).toEqual({ icon: 'flame', color: 'sand' });
    expect(groupAppearance(undefined, undefined)).toEqual(DEFAULT_GROUP_APPEARANCE);
    expect(groupAppearance('rocket', '#9DB6FF')).toEqual({ icon: 'ball', color: 'blue' });
    expect(groupAppearance('Bola', 'lilac')).toEqual({ icon: 'ball', color: 'lilac' });
  });

  it('paints the prévia hexes in the dark theme', () => {
    const dark = GROUP_COLORS.map((color) => groupColors(colors.dark, color).glyph);
    expect(dark).toEqual(['#9DB6FF', '#7CD3A0', '#FFA46B', '#F2A7C3', '#C9B3FF', '#E3D3B0']);
    expect(groupColors(colors.dark, 'blue').fill).toBe('#1B2647');
  });

  it('gives every colour a readable glyph on its tile, in both themes', () => {
    for (const palette of Object.values(colors)) {
      for (const color of GROUP_COLORS) {
        const { glyph, fill } = groupColors(palette, color);
        expect(contrastRatio(glyph, fill)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(glyph, palette.surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(palette.background, glyph)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('scales the tile of the prévia', () => {
    expect(groupIconTile(56)).toEqual({ glyph: 32, radius: 16 });
    expect(groupIconTile(44)).toEqual({ glyph: 25, radius: 13 });
  });
});
