import { describe, expect, it } from 'vitest';

import { profilePatchSchema, profileSchema } from './profile-schema';

describe('shared profile schemas', () => {
  it('normalises the same profile values used by the form and gateway payload', () => {
    expect(
      profileSchema.parse({
        dominant_foot: 'both',
        name: '  Jose\u0301  ',
        nickname: '  Zé  ',
        position: 'midfielder',
        shirt_number: 10,
      }),
    ).toEqual({
      dominant_foot: 'both',
      name: 'José',
      nickname: 'Zé',
      position: 'midfielder',
      shirt_number: 10,
    });
  });

  it('keeps absence and explicit null distinct', () => {
    expect(profilePatchSchema.parse({ nickname: null })).toEqual({ nickname: null });
    expect(profilePatchSchema.parse({})).toEqual({});
    expect(Object.hasOwn(profilePatchSchema.parse({}), 'nickname')).toBe(false);
  });

  it('rejects blank optional text and every out-of-contract value', () => {
    expect(profilePatchSchema.safeParse({ nickname: '  ' }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ dominant_foot: 'center' }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ shirt_number: 100 }).success).toBe(false);
    expect(profilePatchSchema.safeParse({ photo_url: 'avatars/example' }).success).toBe(false);
  });
});
