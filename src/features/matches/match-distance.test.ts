import { describe, expect, it } from 'vitest';

import { distanceInMeters, distanceText } from './match-distance';

const SE = { latitude: -23.5505, longitude: -46.6333 };
const PAULISTA = { latitude: -23.5614, longitude: -46.6559 };

describe('distance on the device (human decision of 17/10/2026)', () => {
  it('is zero for the same point and symmetric', () => {
    expect(distanceInMeters(SE, SE)).toBe(0);
    expect(distanceInMeters(SE, PAULISTA)).toBeCloseTo(distanceInMeters(PAULISTA, SE), 6);
  });

  it('measures a known pair: Sé to Avenida Paulista is about 2.6 km', () => {
    const meters = distanceInMeters(SE, PAULISTA);
    expect(meters).toBeGreaterThan(2_500);
    expect(meters).toBeLessThan(2_700);
    expect(distanceText(meters)).toBe('a 2,6 km de você');
  });

  it('measures one degree of latitude as about 111.2 km', () => {
    const meters = distanceInMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
    expect(meters / 1000).toBeCloseTo(111.2, 1);
  });

  it.each([
    [0, 'a 10 m de você'],
    [4, 'a 10 m de você'],
    [847, 'a 850 m de você'],
    [994, 'a 990 m de você'],
    [1_000, 'a 1,0 km de você'],
    [3_249, 'a 3,2 km de você'],
    [3_250, 'a 3,3 km de você'],
    [99_940, 'a 99,9 km de você'],
    [120_400, 'a 120 km de você'],
    [1_234_000, 'a 1.234 km de você'],
  ])('%d m reads %j', (meters, text) => {
    expect(distanceText(meters)).toBe(text);
  });
});
