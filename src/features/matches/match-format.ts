// Display of a match in the match's own time zone, never the viewer's: a
// match in São Paulo starts at 19:30 for everyone who reads it.

import type { MatchSummary } from '../../lib/api';

function part(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('pt-BR', { ...options, timeZone }).format(new Date(iso));
}

/** "19:30" */
export function matchTime(iso: string, timeZone: string): string {
  return part(iso, timeZone, { hour: '2-digit', hourCycle: 'h23', minute: '2-digit' });
}

/** "qui., 16/10" */
export function matchDay(iso: string, timeZone: string): string {
  return part(iso, timeZone, { day: '2-digit', month: '2-digit', weekday: 'short' });
}

/** "quinta-feira, 16 de outubro de 2026" */
export function matchLongDay(iso: string, timeZone: string): string {
  return part(iso, timeZone, { dateStyle: 'full' });
}

function short(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  const text = part(iso, timeZone, options).replace(/\.$/u, '');
  return text.charAt(0).toLocaleUpperCase('pt-BR') + text.slice(1);
}

/** "20:00–22:00" */
export function matchTimeRange(startsAt: string, endsAt: string, timeZone: string): string {
  return `${matchTime(startsAt, timeZone)}–${matchTime(endsAt, timeZone)}`;
}

/** "Sáb, 18 out · 20:00–22:00": the line at the top of the detail. */
export function matchWhenLine(startsAt: string, endsAt: string, timeZone: string): string {
  const weekday = short(startsAt, timeZone, { weekday: 'short' });
  const day = part(startsAt, timeZone, { day: 'numeric' });
  const month = part(startsAt, timeZone, { month: 'short' }).replace(/\.$/u, '');
  return `${weekday}, ${day} ${month} · ${matchTimeRange(startsAt, endsAt, timeZone)}`;
}

/** The ticket block of a card: { day: "18", month: "OUT", weekday: "SÁB" }. */
export function matchTicket(iso: string, timeZone: string) {
  const upper = (options: Intl.DateTimeFormatOptions) =>
    part(iso, timeZone, options).replace(/\.$/u, '').toLocaleUpperCase('pt-BR');
  return {
    day: part(iso, timeZone, { day: '2-digit' }),
    month: upper({ month: 'short' }),
    weekday: upper({ weekday: 'short' }),
  };
}

/** "sábado, 18 de outubro", for accessible names. */
export function matchSpokenDay(iso: string, timeZone: string): string {
  return part(iso, timeZone, { day: 'numeric', month: 'long', weekday: 'long' });
}

/** "R$ 25,50" */
export function matchPrice(value: number): string {
  return new Intl.NumberFormat('pt-BR', { currency: 'BRL', style: 'currency' }).format(value);
}

/** "-23,5505, -46,6333" */
export function coordinatesText(latitude: number, longitude: number): string {
  const format = new Intl.NumberFormat('pt-BR', {
    maximumFractionDigits: 4,
    minimumFractionDigits: 4,
  });
  return `${format.format(latitude)}, ${format.format(longitude)}`;
}

/**
 * An https Google Maps search: by the confirmed coordinates when the match has
 * them, otherwise by the place and address the organizer typed. Human decision
 * of 15/10/2026 (review of #70, P1-2): the coordinates may reach Google Maps
 * only through this search, only when the person presses "Abrir no Google
 * Maps", and the URL carries nothing else from the app: no match, group or
 * person ID. It is never rendered as an href, logged or put in an app URL.
 */
export function mapUrl(
  match: Pick<MatchSummary, 'latitude' | 'longitude' | 'location_address' | 'location_name'>,
): string {
  const query =
    match.latitude !== null && match.longitude !== null
      ? `${match.latitude},${match.longitude}`
      : [match.location_name, match.location_address].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
