// The create-match form in the person's own words (date, start, end, price
// with a comma) turned into the create_match config of the gateway. The Edge
// and the RPC validate the same contract again; this copy gives field errors
// in Portuguese before any request is made.

import type { MatchConfig } from '../../lib/api';
import { pt } from '../../lib/i18n/pt';

import { normaliseDescription } from './match-description';

export type MatchFormValues = {
  date: string;
  startTime: string;
  endTime: string;
  locationName: string;
  locationAddress: string;
  description: string;
  slots: string;
  price: string;
};

export type ConfirmedPlace = { latitude: number; longitude: number } | null;

export type MatchFormErrors = Partial<Record<keyof MatchFormValues, string>>;

const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PRICE = /^(\d{1,4})(?:[.,](\d{1,2}))?$/;
/** The masked field: "R$ 1.234,56". */
const MASKED_PRICE = /^R\$\s?(\d{1,3}(?:\.\d{3})*),(\d{2})$/u;
/** Human decision of 17/10/2026: up to 6 h, an end before the start is the next day. */
export const MAX_DURATION_MINUTES = 6 * 60;
const MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1000;
const DAY_MINUTES = 24 * 60;

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

function minutes(value: string): number | undefined {
  const time = TIME.exec(value.trim());
  return time === null ? undefined : Number(time[1]) * 60 + Number(time[2]);
}

/**
 * The span from start to end, in minutes, on the device clock. An end before
 * the start is the next day ("22:00" to "01:00" is 180 minutes); an end equal
 * to the start is no span at all.
 */
export function spanMinutes(start: number, end: number): number {
  return end > start ? end - start : end < start ? end + DAY_MINUTES - start : 0;
}

/**
 * The end-time rule alone, for the live notice and for the error under "Fim":
 * an end before the start finishes the next day when the whole match lasts
 * up to 6 h; a longer overnight span (10:00 to 08:00) or an end equal to the
 * start is an end that is not after the start; a same-day span over 6 h is
 * too long.
 */
export function endRule(
  startTime: string,
  endTime: string,
): { nextDay: string } | { error: string } | undefined {
  const start = minutes(startTime);
  const end = minutes(endTime);
  if (start === undefined || end === undefined) return undefined;
  const span = spanMinutes(start, end);
  if (end > start) {
    return span > MAX_DURATION_MINUTES ? { error: pt.matches.create.errors.tooLong } : undefined;
  }
  if (span === 0 || span > MAX_DURATION_MINUTES) {
    return { error: pt.matches.create.errors.endBeforeStart };
  }
  return { nextDay: endTime.trim() };
}

/** "Termina às 01:00 do dia seguinte", while the form is filled in. */
export function nextDayNotice(startTime: string, endTime: string): string | undefined {
  const rule = endRule(startTime, endTime);
  return rule !== undefined && 'nextDay' in rule
    ? pt.matches.create.nextDay(rule.nextDay)
    : undefined;
}

/** "R$ 25,00" from the mask, or "25,5" typed by hand, as "25.00" / "25.50". */
export function priceFromField(value: string): string | undefined {
  const text = value.trim();
  const masked = MASKED_PRICE.exec(text);
  const typed = masked === null ? PRICE.exec(text.replace(/^R\$\s*/u, '')) : null;
  if (masked !== null) return `${Number(masked[1]!.replaceAll('.', ''))}.${masked[2]}`;
  if (typed === null) return undefined;
  return `${Number(typed[1])}.${(typed[2] ?? '').padEnd(2, '0')}`;
}

/**
 * Wall-clock date and times in the device's time zone, field by field: a
 * date before today is an error on the date; today with a start already gone
 * is an error on the start; the end follows endRule.
 */
function instants(values: MatchFormValues, errors: MatchFormErrors, now: Date) {
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
    } else if (
      day.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    ) {
      errors.date = pt.matches.create.errors.pastDate;
      day = undefined;
    }
  }
  if (start === null) errors.startTime = pt.matches.create.errors.time;
  if (end === null) errors.endTime = pt.matches.create.errors.time;
  const rule = endRule(values.startTime, values.endTime);
  if (rule !== undefined && 'error' in rule) errors.endTime = rule.error;
  if (day === undefined || start === null || end === null) return undefined;
  const startsAt = new Date(day);
  startsAt.setHours(Number(start[1]), Number(start[2]), 0, 0);
  if (startsAt.getTime() <= now.getTime()) errors.startTime = pt.matches.create.errors.startPassed;
  else if (startsAt.getTime() - now.getTime() > MAX_LEAD_MS) {
    errors.date = pt.matches.create.errors.tooFar;
  }
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
  const times = instants(values, errors, now);
  const nameLength = visibleLength(values.locationName);
  if (nameLength < 2 || nameLength > 80) errors.locationName = pt.matches.create.errors.place;
  const addressLength = visibleLength(values.locationAddress);
  if (addressLength === 1 || addressLength > 160) {
    errors.locationAddress = pt.matches.create.errors.address;
  }
  const description = normaliseDescription(values.description);
  if (!description.ok) {
    errors.description =
      description.reason === 'long'
        ? pt.matches.create.errors.descriptionLong
        : description.reason === 'blank'
          ? pt.matches.create.errors.descriptionBlank
          : pt.matches.create.errors.descriptionControl;
  }
  const slots = /^\d{1,2}$/.test(values.slots.trim()) ? Number(values.slots.trim()) : NaN;
  if (!(slots >= 1 && slots <= 99)) errors.slots = pt.matches.create.errors.slots;
  const fieldPrice = priceFromField(values.price);
  if (fieldPrice === undefined || Number(fieldPrice) <= 0) {
    errors.price = pt.matches.create.errors.price;
  }
  if (
    Object.keys(errors).length > 0 ||
    times === undefined ||
    fieldPrice === undefined ||
    !description.ok
  ) {
    return { errors };
  }
  return {
    config: {
      description: description.value,
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
