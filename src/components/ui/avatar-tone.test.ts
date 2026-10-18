import { describe, expect, it } from 'vitest';

import { colors } from '../../theme/colors';

import { AVATAR_TONES, avatarTone } from './avatar-tone';

describe('avatarTone', () => {
  it('gives the same id the same tone every time', () => {
    const id = '6f1c2a5e-8d0b-4c6e-9a8f-1b2c3d4e5f60';
    expect(avatarTone(id)).toBe(avatarTone(id));
    expect(avatarTone(id)).toBe(avatarTone(`${id}`.slice(0)));
  });

  it('spreads ids over all five tones', () => {
    const seen = new Set<number>();
    for (let index = 0; index < 200; index += 1) {
      seen.add(avatarTone(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`));
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('depends on the id, not on its length alone', () => {
    const tones = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(avatarTone);
    expect(new Set(tones).size).toBeGreaterThan(1);
  });

  it('names only tokens that exist in both themes', () => {
    for (const tone of AVATAR_TONES) {
      for (const palette of Object.values(colors)) {
        expect(palette[tone.fill]).toMatch(/^#[0-9A-F]{6}$/u);
        expect(palette[tone.text]).toMatch(/^#[0-9A-F]{6}$/u);
      }
    }
  });
});
