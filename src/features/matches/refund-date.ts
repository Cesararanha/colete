import { wallClock, zonedInstant } from './match-zone';

/** Empty means now; a typed wall clock belongs to the match, like its form. */
export function refundInstant(
  value: string,
  timezone: string,
  createdAt: string,
  now = new Date(),
): string | null {
  let instant = now;
  if (value.trim() !== '') {
    const parts = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(value);
    if (!parts) return null;
    const clock = {
      day: Number(parts[1]),
      month: Number(parts[2]),
      year: Number(parts[3]),
      hour: Number(parts[4]),
      minute: Number(parts[5]),
    };
    instant = zonedInstant(clock, timezone);
    const actual = wallClock(instant, timezone);
    if (Object.entries(clock).some(([key, part]) => actual[key as keyof typeof clock] !== part))
      return null;
  }
  return instant.getTime() >= Date.parse(createdAt) && instant <= now
    ? instant.toISOString()
    : null;
}
