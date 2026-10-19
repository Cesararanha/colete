import { describe, expect, it } from 'vitest';

import { deleteConfirmed } from './group-delete';

describe('deleteConfirmed', () => {
  it('unlocks only on the group name', () => {
    expect(deleteConfirmed('Pelada de Quinta', 'Pelada de Quinta')).toBe(true);
    expect(deleteConfirmed('Pelada de Quint', 'Pelada de Quinta')).toBe(false);
    expect(deleteConfirmed('', 'Pelada de Quinta')).toBe(false);
    expect(deleteConfirmed('Outro grupo', 'Pelada de Quinta')).toBe(false);
  });

  it('forgives case, outer and doubled spaces, and the composition of accents', () => {
    expect(deleteConfirmed('  pelada  de quinta ', 'Pelada de Quinta')).toBe(true);
    expect(deleteConfirmed('CAFÉ DA TURMA', 'Café da Turma')).toBe(true);
    expect(deleteConfirmed('Café da Turma', 'Café da Turma')).toBe(true);
    expect(deleteConfirmed('Cafe da Turma', 'Café da Turma')).toBe(false);
  });

  it('never unlocks on an empty name', () => {
    expect(deleteConfirmed('', '')).toBe(false);
    expect(deleteConfirmed('  ', ' ')).toBe(false);
  });
});
