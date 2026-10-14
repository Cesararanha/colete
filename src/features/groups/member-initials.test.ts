import { describe, expect, it } from 'vitest';

import { memberInitials } from './member-initials';

describe('memberInitials', () => {
  it('takes the first letter of the first and last words', () => {
    expect(memberInitials('Ana Beatriz Souza')).toBe('AS');
    expect(memberInitials('  pessoa   members-active ')).toBe('PM');
  });

  it('keeps one initial for a single word and none for a blank name', () => {
    expect(memberInitials('Capitã')).toBe('C');
    expect(memberInitials('   ')).toBe('');
  });

  it('never splits an accented or astral first character', () => {
    expect(memberInitials('Élida Ômega')).toBe('ÉÔ');
    expect(memberInitials('𝒜na Lima')).toBe('𝒜L');
  });
});
