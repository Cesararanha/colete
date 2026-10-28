import { afterEach, describe, expect, it, vi } from 'vitest';

import { deviceDiffers, wallClock, zonedInstant, zoneLabel, zoneOffsetMs } from './match-zone';

describe('wall clock in a match time zone (HX-005)', () => {
  it('reads and writes the same wall clock back, in any zone', () => {
    const clock = { year: 2030, month: 10, day: 15, hour: 19, minute: 0 };
    for (const zone of ['America/Maceio', 'America/Manaus', 'Asia/Tokyo', 'Europe/Lisbon']) {
      expect(wallClock(zonedInstant(clock, zone), zone)).toEqual(clock);
    }
    expect(zonedInstant(clock, 'America/Maceio').toISOString()).toBe('2030-10-15T22:00:00.000Z');
    expect(zonedInstant(clock, 'America/Manaus').toISOString()).toBe('2030-10-15T23:00:00.000Z');
  });

  it('rolls a day past the end of the month over', () => {
    const clock = { year: 2030, month: 10, day: 32, hour: 0, minute: 30 };
    expect(wallClock(zonedInstant(clock, 'America/Maceio'), 'America/Maceio')).toEqual({
      ...clock,
      month: 11,
      day: 1,
    });
  });

  it('lands after a daylight-saving gap and on the first repeated hour', () => {
    // Lisbon: 30/03/2031 jumps from 01:00 to 02:00; 26/10/2031 repeats 01:00.
    const gap = zonedInstant(
      { year: 2031, month: 3, day: 30, hour: 1, minute: 30 },
      'Europe/Lisbon',
    );
    expect(gap.toISOString()).toBe('2031-03-30T01:30:00.000Z');
    const repeated = zonedInstant(
      { year: 2031, month: 10, day: 26, hour: 1, minute: 30 },
      'Europe/Lisbon',
    );
    expect(repeated.toISOString()).toBe('2031-10-26T00:30:00.000Z');
  });

  it('says the zone only when the device shows other times', () => {
    const at = new Date('2030-10-15T22:00:00.000Z');
    expect(zoneOffsetMs(at, 'America/Manaus')).toBe(-4 * 3_600_000);
    expect(deviceDiffers('America/Maceio', at, 'America/Sao_Paulo')).toBe(false);
    expect(deviceDiffers('America/Maceio', at, 'America/Manaus')).toBe(true);
    expect(zoneLabel('America/Maceio', at)).toBe('Horário Padrão de Brasília (GMT-3)');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the offset when Intl has no long name for the zone (rev88 P3-4)', () => {
    const Original = Intl.DateTimeFormat;
    // A constructor, as zoneLabel calls it with new: only the long name fails.
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
      locales?: string | string[],
      options?: Intl.DateTimeFormatOptions,
    ) {
      if (options?.timeZoneName === 'longGeneric') throw new RangeError('no long name');
      return new Original(locales, options);
    } as unknown as typeof Intl.DateTimeFormat);
    const at = new Date('2030-10-15T22:00:00.000Z');
    expect(zoneLabel('America/Maceio', at)).toBe('America/Maceio (GMT-3)');
  });
});
