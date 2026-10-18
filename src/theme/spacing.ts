// docs/29 §4: 4 · 8 · 12 · 16 · 24 · 32 · 40. Side margin 24; 24–32 between
// blocks; 10 between list rows.
export const spacing = {
  xs: 4,
  sm: 8,
  ms: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 40,
} as const;

export const listGap = 10;

// Prévia aprovada (PR G): the side margin of every authenticated screen.
export const gutter = 20;

export const radius = {
  tile: 8,
  field: 14,
  row: 18,
  scoreboard: 22,
  band: 28,
  pill: 999,
} as const;

// Touch target ≥ 48 · button 56 · field 56 · row 64–76.
export const size = {
  target: 48,
  button: 56,
  field: 56,
  row: 64,
  // Prévia aprovada: the compact control (avatar, pill, round action) is 44.
  compact: 44,
} as const;
