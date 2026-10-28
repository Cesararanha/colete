// Wall-clock dates and times in the match's own time zone (HX-005). The form
// and the screens read and write the match in its zone, never in the device's:
// 19:00 typed for a match in Maceió is 19:00 in Maceió, whatever zone the phone
// is in. Built on Intl alone, so the same rule holds on the web and on Hermes.

export type WallClock = {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const formats = new Map<string, Intl.DateTimeFormat>();

function wallFormat(timeZone: string): Intl.DateTimeFormat {
  let format = formats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
      minute: 'numeric',
      month: 'numeric',
      timeZone,
      year: 'numeric',
    });
    formats.set(timeZone, format);
  }
  return format;
}

/** The date and time a clock in `timeZone` shows at `instant`. */
export function wallClock(instant: Date | string, timeZone: string): WallClock {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of wallFormat(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
  };
}

function asUtc(clock: WallClock): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const exact = Math.floor(instant.getTime() / MINUTE_MS) * MINUTE_MS;
  return asUtc(wallClock(new Date(exact), timeZone)) - exact;
}

/**
 * The instant a clock in `timeZone` shows `clock`. A day or month past its end
 * rolls over like Date.UTC (day 32 of October is 1 November). In a gap of a
 * daylight-saving change the instant lands after it; in a repeated hour, on
 * the first one.
 */
export function zonedInstant(clock: WallClock, timeZone: string): Date {
  const wall = asUtc(clock);
  // The offsets a day before and a day after cover any single change around
  // this wall clock; each gives a candidate, kept when it shows that clock.
  const before = wall - zoneOffsetMs(new Date(wall - DAY_MS), timeZone);
  const after = wall - zoneOffsetMs(new Date(wall + DAY_MS), timeZone);
  const shows = (instant: number) => asUtc(wallClock(new Date(instant), timeZone)) === wall;
  const valid = [before, after].filter(shows);
  // Nothing shows it in a gap: the offset before the change puts it after.
  return new Date(valid.length === 0 ? before : Math.min(...valid));
}

/** Whether `a` and `b` are the same calendar day, ignoring the time. */
export function sameDay(a: WallClock, b: WallClock): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** Whether day `a` comes before day `b`, ignoring the time. */
export function dayBefore(a: WallClock, b: WallClock): boolean {
  return Date.UTC(a.year, a.month - 1, a.day) < Date.UTC(b.year, b.month - 1, b.day);
}

/**
 * Whether a clock on this device shows something else than one in `timeZone`
 * at `instant`: only then the screens say which zone the times are in.
 */
export function deviceDiffers(timeZone: string, instant: Date, deviceZone: string): boolean {
  return zoneOffsetMs(instant, timeZone) !== zoneOffsetMs(instant, deviceZone);
}

/** "Horário Padrão de Brasília (GMT-3)", or the zone's IANA name where Intl has no name for it. */
export function zoneLabel(timeZone: string, instant: Date): string {
  const name = (style: 'longGeneric' | 'shortOffset') => {
    try {
      return new Intl.DateTimeFormat('pt-BR', { timeZone, timeZoneName: style })
        .formatToParts(instant)
        .find((part) => part.type === 'timeZoneName')?.value;
    } catch {
      return undefined;
    }
  };
  const long = name('longGeneric');
  const offset = name('shortOffset');
  if (long === undefined) return timeZone;
  return offset === undefined || offset === long ? long : `${long} (${offset})`;
}
