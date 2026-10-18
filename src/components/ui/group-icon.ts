import type { ThemeColors } from '../../theme/colors';

/** The tile of the group icon in the prévia: 56 with a 32 glyph and radius 16. */
export const GROUP_ICON_TILE = { glyph: 32, radius: 16 } as const;

/** The same proportions at any tile size: 44 gives a 25 glyph and radius 13. */
export function groupIconTile(size: number) {
  return {
    glyph: Math.round((size * GROUP_ICON_TILE.glyph) / 56),
    radius: Math.round((size * GROUP_ICON_TILE.radius) / 56),
  };
}

/**
 * The owner's choice (PR H, docs/13 section 5.0.7): the keys the database
 * stores, in the order of the prévia. The labels live in pt.groups.appearance.
 */
export const GROUP_ICONS = [
  'ball',
  'goal',
  'field',
  'whistle',
  'shirt',
  'trophy',
  'bolt',
  'flame',
] as const;
export const GROUP_COLORS = ['blue', 'green', 'orange', 'pink', 'lilac', 'sand'] as const;

export type GroupIconKey = (typeof GROUP_ICONS)[number];
export type GroupColorKey = (typeof GROUP_COLORS)[number];
export type GroupAppearance = { icon: GroupIconKey; color: GroupColorKey };

/** Every group starts as the blue ball, in the database and here. */
export const DEFAULT_GROUP_APPEARANCE: GroupAppearance = { icon: 'ball', color: 'blue' };

/**
 * Glyph and tile of each colour, as theme tokens. Blue, green, orange and pink
 * are the info, positive, warning and accent tones of the design system with
 * their soft fills; lilac and sand have their own (docs/29).
 */
export const GROUP_COLOR_TOKENS = {
  blue: { glyph: 'info', fill: 'infoSoft' },
  green: { glyph: 'positive', fill: 'positiveSoft' },
  orange: { glyph: 'warning', fill: 'warningSoft' },
  pink: { glyph: 'accent', fill: 'accentSoft' },
  lilac: { glyph: 'lilac', fill: 'lilacSoft' },
  sand: { glyph: 'sand', fill: 'sandSoft' },
} as const satisfies Record<GroupColorKey, { glyph: keyof ThemeColors; fill: keyof ThemeColors }>;

/**
 * Reads a projection's icon and colour. A key outside the lists (an old
 * cached read, a server ahead of this build) draws the default, never
 * nothing: the name beside the icon always says which group it is.
 */
export function groupAppearance(icon: unknown, color: unknown): GroupAppearance {
  return {
    icon: (GROUP_ICONS as readonly unknown[]).includes(icon)
      ? (icon as GroupIconKey)
      : DEFAULT_GROUP_APPEARANCE.icon,
    color: (GROUP_COLORS as readonly unknown[]).includes(color)
      ? (color as GroupColorKey)
      : DEFAULT_GROUP_APPEARANCE.color,
  };
}

export function groupColors(colors: ThemeColors, color: GroupColorKey) {
  const tokens = GROUP_COLOR_TOKENS[color];
  return { glyph: colors[tokens.glyph], fill: colors[tokens.fill] };
}
