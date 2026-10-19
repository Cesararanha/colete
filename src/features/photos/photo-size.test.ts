import { describe, expect, it } from 'vitest';

import { fitWithin } from './photo-size';

describe('fitWithin', () => {
  it('brings the longer side to 512 and keeps the proportions', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 512, height: 384 });
    expect(fitWithin(1080, 1920)).toEqual({ width: 288, height: 512 });
    expect(fitWithin(513, 513)).toEqual({ width: 512, height: 512 });
  });

  it('never enlarges a picture that already fits', () => {
    expect(fitWithin(512, 300)).toBeNull();
    expect(fitWithin(40, 40)).toBeNull();
  });

  it('keeps a very thin picture at least one pixel wide', () => {
    expect(fitWithin(10_000, 3)).toEqual({ width: 512, height: 1 });
  });

  it('treats an unknown size as nothing to resize', () => {
    expect(fitWithin(0, 0)).toBeNull();
    expect(fitWithin(Number.NaN, 10)).toBeNull();
  });
});
