import { describe, expect, it } from 'vitest';

import { coordinatesText, mapUrl, matchPrice, matchTime } from './match-format';
import { matchConfigFromForm, roundCoordinate, type MatchFormValues } from './match-form';

const ZONE = 'America/Sao_Paulo';
// The form reads the device's wall clock, so the expected instants are built
// from that same local clock: the check holds in any zone the suite runs in.
const NOW = new Date(2030, 9, 14, 12, 0);

const values: MatchFormValues = {
  date: '15/10/2030',
  startTime: '19:30',
  endTime: '21:00',
  locationName: '  Arena da Vila ',
  locationAddress: '',
  slots: '14',
  price: '25,5',
};

describe('match form to create_match config', () => {
  it('builds the canonical config with rounded, confirmed coordinates', () => {
    const result = matchConfigFromForm(
      values,
      { latitude: -23.550519, longitude: -46.633309 },
      NOW,
      ZONE,
    );
    expect('config' in result).toBe(true);
    if (!('config' in result)) return;
    expect(result.config).toMatchObject({
      timezone: ZONE,
      location_name: 'Arena da Vila',
      location_address: null,
      latitude: -23.5505,
      longitude: -46.6333,
      field_slots: 14,
      field_price: '25.50',
    });
    expect(result.config.starts_at).toBe(new Date(2030, 9, 15, 19, 30).toISOString());
    expect(result.config.ends_at).toBe(new Date(2030, 9, 15, 21, 0).toISOString());
  });

  it('sends no coordinate unless one was confirmed', () => {
    const result = matchConfigFromForm(values, null, NOW, ZONE);
    expect('config' in result && result.config.latitude === null).toBe(true);
    expect('config' in result && result.config.longitude === null).toBe(true);
  });

  it('reads an end at or before the start as the next day', () => {
    const result = matchConfigFromForm(
      { ...values, startTime: '23:00', endTime: '00:30' },
      null,
      NOW,
      ZONE,
    );
    if (!('config' in result)) throw new Error('expected a config');
    const duration = Date.parse(result.config.ends_at) - Date.parse(result.config.starts_at);
    expect(duration).toBe(90 * 60_000);
  });

  it('names each invalid field before any request', () => {
    const result = matchConfigFromForm(
      {
        date: '31/02/2030',
        startTime: '25:00',
        endTime: '9h',
        locationName: 'A',
        locationAddress: 'B',
        slots: '0',
        price: '0,00',
      },
      null,
      NOW,
      ZONE,
    );
    expect('errors' in result && Object.keys(result.errors).sort()).toEqual([
      'date',
      'endTime',
      'locationAddress',
      'locationName',
      'price',
      'slots',
      'startTime',
    ]);
  });

  it('refuses a start in the past and a match longer than 12 hours', () => {
    const past = matchConfigFromForm(
      { ...values, date: '14/10/2030', startTime: '08:00' },
      null,
      NOW,
      ZONE,
    );
    expect('errors' in past && past.errors.startTime).toBeTruthy();
    const long = matchConfigFromForm(
      { ...values, startTime: '08:00', endTime: '20:30' },
      null,
      NOW,
      ZONE,
    );
    expect('errors' in long && long.errors.endTime).toBeTruthy();
  });

  it('rounds coordinates to 4 places and never yields -0', () => {
    expect(roundCoordinate(-23.55052)).toBe(-23.5505);
    expect(roundCoordinate(-0.00001)).toBe(0);
  });
});

describe('match display in the match time zone', () => {
  it('formats time, price and coordinates in Portuguese', () => {
    expect(matchTime('2030-10-15T22:30:00.000Z', ZONE)).toBe('19:30');
    expect(matchPrice(25.5).replace(/\s/gu, ' ')).toBe('R$ 25,50');
    expect(coordinatesText(-23.5505, -46.6333)).toBe('-23,5505, -46,6333');
  });

  it('opens the map by coordinates, or by place and address without them', () => {
    expect(
      mapUrl({
        latitude: -23.5505,
        longitude: -46.6333,
        location_name: 'A',
        location_address: null,
      }),
    ).toBe('https://www.google.com/maps/search/?api=1&query=-23.5505%2C-46.6333');
    expect(
      mapUrl({
        latitude: null,
        longitude: null,
        location_name: 'Arena',
        location_address: 'Rua Um, 10',
      }),
    ).toBe('https://www.google.com/maps/search/?api=1&query=Arena%2C%20Rua%20Um%2C%2010');
  });
});
