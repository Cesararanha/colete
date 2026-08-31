import { describe, expect, it } from 'vitest';

import { getLayoutMode, WIDE_LAYOUT_BREAKPOINT } from './layout';

describe('responsive layout boundary', () => {
  it('uses the narrow layout below the documented breakpoint', () => {
    expect(getLayoutMode(WIDE_LAYOUT_BREAKPOINT - 1)).toBe('narrow');
  });

  it('uses the wide layout at and above the documented breakpoint', () => {
    expect(getLayoutMode(WIDE_LAYOUT_BREAKPOINT)).toBe('wide');
    expect(getLayoutMode(1440)).toBe('wide');
  });
});
