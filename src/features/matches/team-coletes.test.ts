import { describe, expect, it } from 'vitest';

import { colors, contrastRatio } from '../../theme/colors';
import { TEAM_COLETES, teamColete } from './team-coletes';

describe('team bibs', () => {
  it('names A amber, B blue, C green and D pink, in team order', () => {
    expect([1, 2, 3, 4].map((n) => `${teamColete(n).letter}:${teamColete(n).color}`)).toEqual([
      'A:amber',
      'B:blue',
      'C:green',
      'D:pink',
    ]);
  });

  it('uses the design system tones, distinct from each other', () => {
    expect(TEAM_COLETES.map((team) => team.tone)).toEqual(['digit', 'info', 'positive', 'accent']);
    expect(new Set(TEAM_COLETES.map((team) => colors.dark[team.tone])).size).toBe(4);
  });

  // The interface is dark only (docs/29 §0): the bib colour is also text there.
  it('reads as text on the card surface of the dark theme', () => {
    for (const team of TEAM_COLETES) {
      expect(contrastRatio(colors.dark[team.tone], colors.dark.surface)).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it('falls back to A outside 1–4', () => {
    expect(teamColete(0).letter).toBe('A');
    expect(teamColete(7).letter).toBe('A');
  });
});
