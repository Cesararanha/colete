import { describe, expect, it } from 'vitest';

import { pixChangedAt } from './pix-changed';

const NOW = Date.parse('2026-11-08T15:00:00.000Z');

describe('pixChangedAt', () => {
  it('says the time of a replacement within the last day, in the match zone', () => {
    expect(
      pixChangedAt(
        { replaced: true, set_at: '2026-11-08T13:05:00.000Z' },
        'America/Sao_Paulo',
        NOW,
      ),
    ).toBe('10:05');
  });
  it('is silent for a first Pix, an old replacement or a bad instant', () => {
    expect(pixChangedAt({ replaced: false, set_at: '2026-11-08T13:05:00.000Z' }, 'UTC', NOW)).toBe(
      null,
    );
    expect(pixChangedAt({ replaced: true, set_at: '2026-11-07T14:59:00.000Z' }, 'UTC', NOW)).toBe(
      null,
    );
    expect(pixChangedAt({ replaced: true, set_at: 'not a date' }, 'UTC', NOW)).toBe(null);
  });
});
