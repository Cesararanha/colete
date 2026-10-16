import { describe, expect, it } from 'vitest';

import { mapUrl, matchSpokenDay, matchTicket, matchTimeRange, matchWhenLine } from './match-format';

const place = {
  location_name: 'Arena da Vila',
  location_address: 'Rua das Flores, 100',
};

describe('the Google Maps search (human decision of 15/10/2026)', () => {
  it('carries only api and query, with the coordinates when confirmed', () => {
    const url = new URL(mapUrl({ ...place, latitude: -23.5505, longitude: -46.6333 }));
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/search/');
    expect([...url.searchParams.keys()]).toEqual(['api', 'query']);
    expect(url.searchParams.get('query')).toBe('-23.5505,-46.6333');
    expect(url.hash).toBe('');
  });

  it('falls back to the typed place and address without coordinates', () => {
    const url = new URL(mapUrl({ ...place, latitude: null, longitude: null }));
    expect(url.searchParams.get('query')).toBe('Arena da Vila, Rua das Flores, 100');
  });
});

describe('dates on the card and the detail (human decision of 17/10/2026)', () => {
  // Saturday, 18 October 2025, 20:00 to 22:00 in São Paulo (UTC-3).
  const starts = '2025-10-18T23:00:00.000Z';
  const ends = '2025-10-19T01:00:00.000Z';
  const zone = 'America/Sao_Paulo';

  it('writes the detail line in the match time zone', () => {
    expect(matchWhenLine(starts, ends, zone)).toBe('Sáb, 18 out · 20:00–22:00');
  });

  it('builds the ticket block: big day, month and weekday', () => {
    expect(matchTicket(starts, zone)).toEqual({ day: '18', month: 'OUT', weekday: 'SÁB' });
    expect(matchTimeRange(starts, ends, zone)).toBe('20:00–22:00');
    expect(matchSpokenDay(starts, zone)).toBe('sábado, 18 de outubro');
  });
});
