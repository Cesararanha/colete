// The create-match form in the person's own words (date, start, end, price
// with a comma) turned into the create_match config of the gateway. The Edge
// and the RPC validate the same contract again; this copy gives field errors
// in Portuguese before any request is made.

import type { MatchConfig } from '../../lib/api';
import { pt } from '../../lib/i18n/pt';

export type MatchFormValues = {
  date: string;
  startTime: string;
  endTime: string;
  locationName: string;
  locationAddress: string;
  slots: string;
  price: string;
};

export type ConfirmedPlace = { latitude: number; longitude: number } | null;

export type MatchFormErrors = Partial<Record<keyof MatchFormValues, string>>;

const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PRICE = /^(\d{1,4})(?:[.,](\d{1,2}))?$/;
const MAX_DURATION_MS = 12 * 60 * 60 * 1000;
const MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1000;

/** Rounded to 4 decimals (~11 m) before it is shown, confirmed or sent. */
export function roundCoordinate(value: number): number {
  const rounded = Math.round(value * 10_000) / 10_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function visibleLength(value: string): number {
  return [...value.normalize('NFC').replace(/\s+/gu, ' ').trim()].length;
}

/**
 * Wall-clock date and times in the device's time zone. An end at or before
 * the start is read as the next day, as in a match from 23:00 to 00:30.
 */
function instants(values: MatchFormValues, errors: MatchFormErrors) {
  const date = DATE.exec(values.date.trim());
  const start = TIME.exec(values.startTime.trim());
  const end = TIME.exec(values.endTime.trim());
  let day: Date | undefined;
  if (date === null) {
    errors.date = pt.matches.create.errors.date;
  } else {
    const [, dd, mm, yyyy] = date;
    day = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    if (day.getDate() !== Number(dd) || day.getMonth() !== Number(mm) - 1) {
      errors.date = pt.matches.create.errors.date;
      day = undefined;
    }
  }
  if (start === null) errors.startTime = pt.matches.create.errors.time;
  if (end === null) errors.endTime = pt.matches.create.errors.time;
  if (day === undefined || start === null || end === null) return undefined;
  const startsAt = new Date(day);
  startsAt.setHours(Number(start[1]), Number(start[2]), 0, 0);
  const endsAt = new Date(day);
  endsAt.setHours(Number(end[1]), Number(end[2]), 0, 0);
  if (endsAt.getTime() <= startsAt.getTime()) endsAt.setDate(endsAt.getDate() + 1);
  return { startsAt, endsAt };
}

export function matchConfigFromForm(
  values: MatchFormValues,
  place: ConfirmedPlace,
  now = new Date(),
  timezone = deviceTimeZone(),
): { config: MatchConfig } | { errors: MatchFormErrors } {
  const errors: MatchFormErrors = {};
  const times = instants(values, errors);
  if (times !== undefined) {
    const lead = times.startsAt.getTime() - now.getTime();
    if (lead <= 0) errors.startTime = pt.matches.create.errors.past;
    else if (lead > MAX_LEAD_MS) errors.date = pt.matches.create.errors.tooFar;
    else if (times.endsAt.getTime() - times.startsAt.getTime() > MAX_DURATION_MS) {
      errors.endTime = pt.matches.create.errors.tooLong;
    }
  }
  const nameLength = visibleLength(values.locationName);
  if (nameLength < 2 || nameLength > 80) errors.locationName = pt.matches.create.errors.place;
  const addressLength = visibleLength(values.locationAddress);
  if (addressLength === 1 || addressLength > 160) {
    errors.locationAddress = pt.matches.create.errors.address;
  }
  const slots = /^\d{1,2}$/.test(values.slots.trim()) ? Number(values.slots.trim()) : NaN;
  if (!(slots >= 1 && slots <= 99)) errors.slots = pt.matches.create.errors.slots;
  const price = PRICE.exec(values.price.trim().replace(/^R\$\s*/u, ''));
  const fieldPrice =
    price === null ? undefined : `${Number(price[1])}.${(price[2] ?? '').padEnd(2, '0')}`;
  if (fieldPrice === undefined || Number(fieldPrice) <= 0) {
    errors.price = pt.matches.create.errors.price;
  }
  if (Object.keys(errors).length > 0 || times === undefined || fieldPrice === undefined) {
    return { errors };
  }
  return {
    config: {
      starts_at: times.startsAt.toISOString(),
      ends_at: times.endsAt.toISOString(),
      timezone,
      location_name: values.locationName.trim(),
      location_address: addressLength === 0 ? null : values.locationAddress.trim(),
      latitude: place === null ? null : roundCoordinate(place.latitude),
      longitude: place === null ? null : roundCoordinate(place.longitude),
      field_slots: slots,
      field_price: fieldPrice,
    },
  };
}
