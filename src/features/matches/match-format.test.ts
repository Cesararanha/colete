import { describe, expect, it } from 'vitest';

import { mapUrl } from './match-format';

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
