import { describe, expect, it } from 'vitest';

import { completionInput } from './profile-completion';

describe('first access with the full profile (Ajustes do teste do César)', () => {
  it('sends the name and only the optional fields that were filled in', () => {
    expect(
      completionInput({
        name: '  Ana  ',
        nickname: 'Aninha',
        position: 'forward',
        dominant_foot: null,
        shirt_number: 10,
      }),
    ).toEqual({ name: 'Ana', nickname: 'Aninha', position: 'forward', shirt_number: 10 });
  });

  it('keeps the name alone when nothing else is chosen', () => {
    expect(
      completionInput({
        name: 'Bia',
        nickname: null,
        position: null,
        dominant_foot: null,
        shirt_number: null,
      }),
    ).toEqual({ name: 'Bia' });
  });

  it('applies the same rules as the profile edit', () => {
    expect(() => completionInput({ name: 'B' })).toThrow();
    expect(() => completionInput({ name: 'Bia', nickname: 'x'.repeat(31) })).toThrow();
    expect(() => completionInput({ name: 'Bia', shirt_number: 100 })).toThrow();
  });
});
