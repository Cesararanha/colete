import { describe, expect, it } from 'vitest';

import { demoMatches } from './demo-data';

describe('dados acadêmicos de rachas', () => {
  it('cobre as quatro situações pedidas em ordem cronológica', () => {
    expect(demoMatches.map((match) => match.situation)).toEqual([
      'open',
      'payment_due',
      'reserve',
      'teams_published',
    ]);
    expect(demoMatches.map((match) => match.startsAt)).toEqual(
      [...demoMatches].map((match) => match.startsAt).sort(),
    );
  });

  it('publica dois times de cinco e mantém os goleiros separados', () => {
    const published = demoMatches.find((match) => match.situation === 'teams_published');

    expect(published?.teams.map((team) => team.players.length)).toEqual([5, 5]);
    expect(published?.goalkeepers).toHaveLength(2);
  });

  it('não inclui nota nos jogadores publicados', () => {
    const published = demoMatches.find((match) => match.situation === 'teams_published');
    const playerKeys = published?.teams.flatMap((team) =>
      team.players.flatMap((player) => Object.keys(player)),
    );

    expect(playerKeys).not.toContain('rating');
    expect(playerKeys).not.toContain('note');
    expect(playerKeys).not.toContain('score');
    expect(playerKeys).not.toContain('stars');
  });
});
