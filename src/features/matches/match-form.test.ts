import { describe, expect, it } from 'vitest';

import { coordinatesText, mapUrl, matchPrice, matchTime } from './match-format';
import { pt } from '../../lib/i18n/pt';

import {
  formValuesFromMatch,
  matchConfigFromForm,
  roundCoordinate,
  type MatchFormValues,
} from './match-form';

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
  description: '',
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
        description: '   ',
        slots: '0',
        price: '0,00',
      },
      null,
      NOW,
      ZONE,
    );
    expect('errors' in result && Object.keys(result.errors).sort()).toEqual([
      'date',
      'description',
      'endTime',
      'locationAddress',
      'locationName',
      'price',
      'slots',
      'startTime',
    ]);
  });

  it('refuses a start in the past and a match longer than 6 hours', () => {
    const past = matchConfigFromForm(
      { ...values, date: '14/10/2030', startTime: '08:00' },
      null,
      NOW,
      ZONE,
    );
    expect('errors' in past && past.errors.startTime).toBe('O horário de início já passou');
    const long = matchConfigFromForm(
      { ...values, startTime: '08:00', endTime: '20:30' },
      null,
      NOW,
      ZONE,
    );
    expect('errors' in long && long.errors.endTime).toBe('O racha pode durar no máximo 6 horas.');
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

describe('match form in the edit (0028)', () => {
  const stored = {
    starts_at: new Date(2030, 9, 14, 11, 30).toISOString(),
    ends_at: new Date(2030, 9, 14, 13, 0).toISOString(),
    location_name: 'Quadra',
    location_address: 'Rua Um, 10',
    description: 'Traga colete',
    field_slots: 12,
    field_price: 22.5,
    latitude: -9.6658,
    longitude: -35.7353,
  };

  it('fills the form with the stored match, as the person would type it', () => {
    const { values: filled, place } = formValuesFromMatch(stored);
    expect(filled).toEqual({
      date: '14/10/2030',
      startTime: '11:30',
      endTime: '13:00',
      locationName: 'Quadra',
      locationAddress: 'Rua Um, 10',
      description: 'Traga colete',
      slots: '12',
      price: 'R$ 22,50',
    });
    expect(place).toEqual({ latitude: -9.6658, longitude: -35.7353 });
    expect(formValuesFromMatch({ ...stored, latitude: null, longitude: null }).place).toBeNull();
  });

  it('keeps a match in progress editable while its times stay, and judges new times', () => {
    const { values: filled, place } = formValuesFromMatch(stored);
    const kept = { startsAt: stored.starts_at, endsAt: stored.ends_at };
    // NOW (12:00) is between the stored start and end.
    const result = matchConfigFromForm({ ...filled, price: 'R$ 30,00' }, place, NOW, ZONE, {
      kept,
    });
    expect('config' in result && result.config.field_price).toBe('30.00');
    expect(matchConfigFromForm(filled, place, NOW, ZONE)).toEqual({
      errors: { startTime: pt.matches.create.errors.startPassed },
    });
    expect(
      matchConfigFromForm({ ...filled, startTime: '11:45' }, place, NOW, ZONE, { kept }),
    ).toEqual({ errors: { startTime: pt.matches.create.errors.startPassed } });
    expect(
      matchConfigFromForm({ ...filled, date: '13/10/2030' }, place, NOW, ZONE, { kept }),
    ).toEqual({ errors: { date: pt.matches.create.errors.pastDate } });
  });

  it('refuses slots below the confirmed with "Já há N confirmados"', () => {
    expect(
      matchConfigFromForm({ ...values, slots: '3' }, null, NOW, ZONE, { confirmed: 4 }),
    ).toEqual({ errors: { slots: 'Já há 4 confirmados' } });
    expect(
      matchConfigFromForm({ ...values, slots: '0' }, null, NOW, ZONE, { confirmed: 1 }),
    ).toEqual({ errors: { slots: pt.matches.create.errors.slots } });
    expect(pt.matches.create.errors.slotsBelow(1)).toBe('Já há 1 confirmado');
    expect(
      'config' in matchConfigFromForm({ ...values, slots: '4' }, null, NOW, ZONE, { confirmed: 4 }),
    ).toBe(true);
  });
});
