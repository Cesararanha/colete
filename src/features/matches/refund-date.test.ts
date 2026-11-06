import { describe, expect, it } from 'vitest';
import { refundInstant } from './refund-date';

describe('refund date in the match zone', () => {
  const created = '2026-11-01T12:00:00.000Z';
  it('delegates an empty date to the server', () => {
    expect(refundInstant('', 'America/Maceio', created)).toBeUndefined();
    expect(refundInstant('  ', 'America/Maceio', created)).toBeUndefined();
  });
  it('uses the match zone irrespective of the device', () => {
    expect(refundInstant('05/11/2026 19:00', 'America/Manaus', created)).toBe(
      '2026-11-05T23:00:00.000Z',
    );
    expect(refundInstant('05/11/2026 19:00', 'America/Sao_Paulo', created)).toBe(
      '2026-11-05T22:00:00.000Z',
    );
  });
  it('leaves a date after now to the server, whose clock decides', () => {
    expect(refundInstant('07/11/2099 08:00', 'America/Maceio', created)).toBe(
      '2099-11-07T11:00:00.000Z',
    );
  });
  it.each(['31/11/2026 19:00', '06/11/2026 30:00', '01/11/2026 08:00', 'invalid'])(
    'rejects impossible clocks and dates before the obligation: %s',
    (value) => {
      expect(refundInstant(value, 'America/Maceio', created)).toBeNull();
    },
  );
});
