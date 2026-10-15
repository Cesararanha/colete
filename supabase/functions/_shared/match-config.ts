// The config of create_match (docs/13 section 3.1), cut to Rachas v1 by the
// human decisions of 12/10, 14/10 and 15/10/2026 (docs/25 section 8.1). The
// RPC validates the same contract again; this copy only keeps a malformed
// request from spending an idempotency key.
//
// Every key is required and the optional ones travel as an explicit null, so
// absence and null never become two spellings of one config. Canonical JSON v1
// carries integers only (docs/13 section 0.1), so the price and the rounded
// coordinates are canonical decimal strings with a fixed number of places.

import { GatewayError, defaultMessage, validation } from './errors.ts';

export const MATCH_CONFIG_KEYS = [
  'ends_at',
  'field_price',
  'field_slots',
  'latitude',
  'location_address',
  'location_name',
  'longitude',
  'starts_at',
  'timezone',
] as const;

export interface MatchConfig {
  readonly starts_at: string;
  readonly ends_at: string;
  readonly timezone: string;
  readonly location_name: string;
  readonly location_address: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly field_slots: number;
  readonly field_price: string;
}

const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;
const PRICE = /^(\d{1,4})(?:\.(\d{1,2}))?$/;
const MAX_DURATION_MS = 12 * 60 * 60 * 1000;
const MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1000;

/** Same rule as the group name (docs/13 section 5.0.6), with its own bounds. */
export function normaliseMatchText(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string') throw validation(field, 'must be a string');
  const raw = value.normalize('NFC');
  if (/[\p{Cc}؜​‎‏‪-‮⁠-⁤⁦-⁩﻿]/u.test(raw)) {
    throw validation(field, 'contains a forbidden control character');
  }
  const text = raw.replace(/[\p{Zs}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  if ([...text].length < min || [...text].length > max) {
    throw validation(field, `must be between ${min} and ${max} code points`);
  }
  return text;
}

/** An absolute instant at minute precision, canonicalised to UTC. */
function instant(value: unknown, field: string): Date {
  if (typeof value !== 'string') throw validation(field, 'must be an ISO 8601 instant');
  const parts = INSTANT.exec(value);
  if (parts === null) throw validation(field, 'must be an ISO 8601 instant with offset');
  const [, year, month, day, hour, minute, second = '00', millis = '0'] = parts;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > daysInMonth ||
    Number(hour) > 23 ||
    Number(minute) > 59
  ) {
    throw validation(field, 'is not a calendar instant');
  }
  if (Number(second) !== 0 || Number(millis) !== 0) {
    throw validation(field, 'must have minute precision');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw validation(field, 'is not a calendar instant');
  return parsed;
}

/** Rounded to 4 decimals (~11 m), the only precision the database stores. */
export function roundCoordinate(value: number): number {
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function coordinate(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw validation(field, 'must be a number, or null with its pair');
  }
  const rounded = roundCoordinate(value);
  if (rounded < -limit || rounded > limit) throw validation(field, `must be within ±${limit}`);
  return rounded.toFixed(4);
}

export function normaliseMatchConfig(value: unknown, now = new Date()): MatchConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validation('config', 'must be an object');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(MATCH_CONFIG_KEYS as readonly string[]).includes(key)) {
      throw validation(`config.${key}`, 'unknown key');
    }
  }
  for (const key of MATCH_CONFIG_KEYS) {
    if (!Object.hasOwn(record, key)) throw validation(`config.${key}`, 'is required');
  }

  const startsAt = instant(record['starts_at'], 'config.starts_at');
  const endsAt = instant(record['ends_at'], 'config.ends_at');

  const timezone = record['timezone'];
  if (typeof timezone !== 'string' || timezone.length < 1 || timezone.length > 64) {
    throw validation('config.timezone', 'must be an IANA time zone');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw validation('config.timezone', 'must be an IANA time zone');
  }

  const locationName = normaliseMatchText(record['location_name'], 'config.location_name', 2, 80);
  const locationAddress =
    record['location_address'] === null
      ? null
      : normaliseMatchText(record['location_address'], 'config.location_address', 2, 160);

  const rawLatitude = record['latitude'];
  const rawLongitude = record['longitude'];
  if ((rawLatitude === null) !== (rawLongitude === null)) {
    throw validation('config.latitude', 'latitude and longitude travel together');
  }
  const latitude = rawLatitude === null ? null : coordinate(rawLatitude, 'config.latitude', 90);
  const longitude =
    rawLongitude === null ? null : coordinate(rawLongitude, 'config.longitude', 180);

  const slots = record['field_slots'];
  if (typeof slots !== 'number' || !Number.isInteger(slots) || slots < 1 || slots > 99) {
    throw validation('config.field_slots', 'must be an integer between 1 and 99');
  }

  const rawPrice = record['field_price'];
  const price = typeof rawPrice === 'string' ? PRICE.exec(rawPrice) : null;
  if (price === null) {
    throw validation('config.field_price', 'must be a decimal string up to 9999.99');
  }
  const fieldPrice = `${Number(price[1])}.${(price[2] ?? '').padEnd(2, '0')}`;
  if (Number(fieldPrice) <= 0) {
    throw new GatewayError('PRICE_INVALID', defaultMessage('PRICE_INVALID'));
  }

  const start = startsAt.getTime();
  const end = endsAt.getTime();
  if (
    start <= now.getTime() ||
    end <= start ||
    end - start > MAX_DURATION_MS ||
    start > now.getTime() + MAX_LEAD_MS
  ) {
    throw new GatewayError('TIME_ORDER', defaultMessage('TIME_ORDER'));
  }

  return {
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    timezone,
    location_name: locationName,
    location_address: locationAddress,
    latitude,
    longitude,
    field_slots: slots,
    field_price: fieldPrice,
  };
}
