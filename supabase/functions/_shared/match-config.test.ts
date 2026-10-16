import { describe, expect, it } from 'vitest';

import { canonicalise } from './jcs.ts';
import { GatewayError } from './errors.ts';
import { normaliseMatchConfig, roundCoordinate } from './match-config.ts';
import { normaliseRequest } from './operations.ts';

const REQUEST_ID = '01890f7e-e948-7c53-b13a-4a36e4b7d21e';
const GROUP = '15b00001-0000-4000-8000-000000000000';
const NOW = new Date('2030-01-01T12:00:00.000Z');

const base = {
  description: null,
  starts_at: '2030-01-02T22:00:00.000Z',
  ends_at: '2030-01-02T23:30:00.000Z',
  timezone: 'America/Sao_Paulo',
  location_name: 'Arena Vila',
  location_address: null,
  latitude: null,
  longitude: null,
  field_slots: 14,
  field_price: '25.00',
};

function refusal(run: () => unknown): GatewayError {
  try {
    run();
  } catch (thrown) {
    return thrown as GatewayError;
  }
  throw new Error('expected a refusal');
}

describe('create_match config (docs/13 section 3.1, Rachas v1 cut)', () => {
  it('canonicalises equivalent instants, text and price to one form', () => {
    const first = normaliseMatchConfig(base, NOW);
    const second = normaliseMatchConfig(
      {
        ...base,
        starts_at: '2030-01-02T19:00-03:00',
        ends_at: '2030-01-02T20:30:00.000-03:00',
        location_name: '  Arena　 Vila ',
        field_price: '25',
      },
      NOW,
    );
    expect(second).toEqual(first);
  });

  it('publishes the canonical JCS of a full create_match input', () => {
    // normaliseRequest builds exactly { group_id, config }; the clock is
    // injected here so the vector does not expire.
    const config = normaliseMatchConfig(
      {
        ...base,
        starts_at: '2030-01-02T22:00:00Z',
        ends_at: '2030-01-02T23:30:00Z',
        location_address: 'Rua Um, 10',
        description: '  Traga   colete\r\nescuro ',
        latitude: -23.550519,
        longitude: -46.633309,
        field_price: '25.5',
      },
      NOW,
    );
    expect(canonicalise({ group_id: GROUP, config: { ...config } })).toBe(
      '{"config":{"description":"Traga colete\\nescuro","ends_at":"2030-01-02T23:30:00.000Z","field_price":"25.50","field_slots":14,' +
        '"latitude":"-23.5505","location_address":"Rua Um, 10","location_name":"Arena Vila",' +
        '"longitude":"-46.6333","starts_at":"2030-01-02T22:00:00.000Z","timezone":"America/Sao_Paulo"},' +
        `"group_id":"${GROUP}"}`,
    );
  });

  it('rounds coordinates to 4 decimals and keeps them as a pair', () => {
    expect(roundCoordinate(-23.55052)).toBe(-23.5505);
    expect(roundCoordinate(-46.63336)).toBe(-46.6334);
    expect(roundCoordinate(-0.00001)).toBe(0);
    const config = normaliseMatchConfig({ ...base, latitude: 1.23456, longitude: 2 }, NOW);
    expect([config.latitude, config.longitude]).toEqual(['1.2346', '2.0000']);
    for (const pair of [
      { latitude: -23.5, longitude: null },
      { latitude: null, longitude: -46.6 },
      { latitude: 90.0001, longitude: 0 },
      { latitude: 0, longitude: -180.0001 },
      { latitude: '1', longitude: 2 },
      { latitude: Number.NaN, longitude: 2 },
    ]) {
      const error = refusal(() => normaliseMatchConfig({ ...base, ...pair }, NOW));
      expect(error.code).toBe('VALIDATION');
    }
  });

  it('never echoes a coordinate or a place in a refusal', () => {
    const marker = -23.987654;
    const error = refusal(() =>
      normaliseMatchConfig({ ...base, latitude: marker, longitude: null }, NOW),
    );
    expect(JSON.stringify({ message: error.message, fields: error.fields })).not.toContain('23.98');
  });

  it('refuses shape errors as VALIDATION before any idempotency key', () => {
    const cases: Record<string, unknown>[] = [
      { ...base, extra: 1 },
      { ...base, starts_at: '2030-01-02T22:00:30.000Z' },
      { ...base, starts_at: '2030-02-30T22:00:00.000Z' },
      { ...base, starts_at: '2030-01-02 22:00' },
      { ...base, timezone: 'Mars/Olympus' },
      { ...base, location_name: 'A' },
      { ...base, location_name: 'Are​na' },
      { ...base, location_address: '  ' },
      { ...base, field_slots: 0 },
      { ...base, field_slots: 100 },
      { ...base, field_slots: 14.5 },
      { ...base, field_price: 25 },
      { ...base, field_price: '25,00' },
      { ...base, field_price: '10000.00' },
    ];
    const { timezone: _timezone, ...missing } = base;
    cases.push(missing);
    for (const config of cases) {
      expect(refusal(() => normaliseMatchConfig(config, NOW)).code).toBe('VALIDATION');
    }
  });

  it('names the domain refusals of docs/13 section 3.1', () => {
    expect(refusal(() => normaliseMatchConfig({ ...base, field_price: '0.00' }, NOW)).code).toBe(
      'PRICE_INVALID',
    );
    for (const times of [
      { starts_at: '2030-01-01T11:00:00Z', ends_at: '2030-01-01T13:00:00Z' },
      { starts_at: '2030-01-02T22:00:00Z', ends_at: '2030-01-02T22:00:00Z' },
      { starts_at: '2030-01-02T22:00:00Z', ends_at: '2030-01-02T21:00:00Z' },
      { starts_at: '2030-01-02T08:00:00Z', ends_at: '2030-01-02T20:01:00Z' },
      { starts_at: '2031-01-02T22:00:00Z', ends_at: '2031-01-02T23:00:00Z' },
    ]) {
      expect(refusal(() => normaliseMatchConfig({ ...base, ...times }, NOW)).code).toBe(
        'TIME_ORDER',
      );
    }
  });

  it('requires config and a canonical group_id in the request', () => {
    expect(
      refusal(() => normaliseRequest('create_match', { request_id: REQUEST_ID, group_id: GROUP }))
        .code,
    ).toBe('VALIDATION');
    expect(
      refusal(() =>
        normaliseRequest('create_match', {
          request_id: REQUEST_ID,
          group_id: 'not-a-uuid',
          config: base,
        }),
      ).code,
    ).toBe('VALIDATION');
  });
});
