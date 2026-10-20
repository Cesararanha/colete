import type { ThemeColors } from '../../theme/colors';

/**
 * The bib of each team (0032, human decision of 19/10/2026), as design system
 * tokens: Time A amber (the scoreboard digit), B blue, C green and D pink, the
 * info, positive and accent tones the group colours already use (docs/29).
 * The colour is also said in words on the card: it is which bib to wear.
 */
export const TEAM_COLETES = [
  { letter: 'A', color: 'amber', tone: 'digit' },
  { letter: 'B', color: 'blue', tone: 'info' },
  { letter: 'C', color: 'green', tone: 'positive' },
  { letter: 'D', color: 'pink', tone: 'accent' },
] as const satisfies readonly { letter: string; color: string; tone: keyof ThemeColors }[];

export type TeamColete = (typeof TEAM_COLETES)[number];
export const TEAM_COUNTS = [2, 3, 4] as const;

/** Team 1 is A; a number outside 1–4 (a server ahead of this build) reads as A, never nothing. */
export function teamColete(teamNumber: number): TeamColete {
  return TEAM_COLETES[teamNumber - 1] ?? TEAM_COLETES[0];
}
