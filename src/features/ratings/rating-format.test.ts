import { describe, expect, it } from 'vitest';

import type { MemberRating } from '@/lib/api';

import { changedOn, unratedAmong, unratedCount } from './rating-format';

const member = (id: string, stars: number | null): MemberRating => ({
  profile_id: id,
  display_name: id,
  stars,
});

describe('rating counts', () => {
  it('counts who has no rating, and nothing without a list', () => {
    expect(unratedCount([member('a', 3), member('b', null), member('c', null)])).toBe(2);
    expect(unratedCount(null)).toBe(0);
  });

  it('counts the confirmed without a rating, ignoring removed accounts and non-members', () => {
    const members = [member('a', 3), member('b', null), member('c', null)];
    expect(unratedAmong(members, ['a', 'b', null, 'z'])).toBe(1);
    expect(unratedAmong(members, ['b', 'c'])).toBe(2);
    expect(unratedAmong(null, ['b'])).toBe(0);
  });

  it('formats the day of the last change', () => {
    expect(changedOn('2026-10-18T15:00:00.000Z')).toMatch(/^\d{2}\/\d{2}$/);
  });
});
