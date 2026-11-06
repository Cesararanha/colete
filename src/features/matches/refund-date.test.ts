import { describe, expect, it } from 'vitest';
import { refundInstant } from './refund-date';

describe('refund date in the match zone', () => {
  const created = '2026-11-01T12:00:00.000Z';
  const now = new Date('2026-11-06T12:00:00.123Z');
  it.each([-60_000, 60_000])(
    'delegates an empty date to the server with device offset %s',
    (offset) => {
      expect(
        refundInstant('', 'America/Maceio', now.toISOString(), new Date(now.getTime() + offset)),
      ).toBeUndefined();
      expect(refundInstant('  ', 'America/Maceio', created, now)).toBeUndefined();
    },
  );
  it('uses the match zone irrespective of the device', () => {
    expect(refundInstant('05/11/2026 19:00', 'America/Manaus', created, now)).toBe(
      '2026-11-05T23:00:00.000Z',
    );
    expect(refundInstant('05/11/2026 19:00', 'America/Sao_Paulo', created, now)).toBe(
      '2026-11-05T22:00:00.000Z',
    );
  });
  it.each([
    '31/11/2026 19:00',
    '06/11/2026 30:00',
    '01/11/2026 08:00',
    '07/11/2026 08:00',
    'invalid',
  ])('rejects impossible and out-of-range clocks: %s', (value) => {
    expect(refundInstant(value, 'America/Maceio', created, now)).toBeNull();
  });
});
