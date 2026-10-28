import { describe, expect, it } from 'vitest';

import { updatedAt } from './live-refresh';

const query = (dataUpdatedAt: number) => ({
  dataUpdatedAt,
  isFetching: false,
  refetch: () => Promise.resolve(),
});

describe('the last reading of a screen (HX-003)', () => {
  it('is the oldest read of the screen, on the device clock', () => {
    const early = new Date(2030, 9, 14, 14, 31, 50).getTime();
    const late = new Date(2030, 9, 14, 14, 32, 10).getTime();
    expect(updatedAt([query(late), query(early)])).toBe('14:31');
  });

  it('ignores a query that has not read yet, and says nothing before any read', () => {
    const read = new Date(2030, 9, 14, 9, 5).getTime();
    expect(updatedAt([query(0), query(read)])).toBe('09:05');
    expect(updatedAt([query(0)])).toBeUndefined();
    expect(updatedAt([])).toBeUndefined();
  });

  it('writes midnight as 00, not 24', () => {
    expect(updatedAt([query(new Date(2030, 9, 15, 0, 7).getTime())])).toBe('00:07');
  });
});
