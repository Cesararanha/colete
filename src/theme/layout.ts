export const WIDE_LAYOUT_BREAKPOINT = 768;

export type LayoutMode = 'narrow' | 'wide';

export const getLayoutMode = (width: number): LayoutMode =>
  width >= WIDE_LAYOUT_BREAKPOINT ? 'wide' : 'narrow';
