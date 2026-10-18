import type { ReactNode } from 'react';

import { useTheme } from '@/theme/ThemeProvider';

import { groupColors, groupIconTile, type GroupAppearance, type GroupIconKey } from './group-icon';

// The prévia's eight outlines (icone-do-grupo.html), drawn inline: no icon
// font is added to the bundle for them.
const GLYPHS: Record<GroupIconKey, ReactNode> = {
  ball: (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <polygon points="12,8 15.8,10.8 14.4,15.2 9.6,15.2 8.2,10.8" />
      <path d="M12 8V2.5M15.8 10.8l5.2-1.7M14.4 15.2l3.2 4.4M9.6 15.2l-3.2 4.4M8.2 10.8 3 9.1" />
    </>
  ),
  goal: (
    <>
      <path d="M2 20V5h20v15" />
      <path d="M2 10h20M2 15h20M7 5v15M12 5v15M17 5v15" opacity=".6" strokeWidth="1" />
    </>
  ),
  field: (
    <>
      <rect height="14" rx="1.5" width="20" x="2" y="5" />
      <path d="M12 5v14" />
      <circle cx="12" cy="12" r="2.8" />
      <path d="M2 9h3v6H2M22 9h-3v6h3" />
    </>
  ),
  whistle: (
    <>
      <circle cx="9" cy="14" r="5.5" />
      <path d="M12.5 9.7 21 7.5v4.3l-6.2 1.4" />
      <circle cx="9" cy="14" r="1.4" />
    </>
  ),
  shirt: (
    <path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z" />
  ),
  trophy: (
    <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z" />
  ),
  bolt: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
  flame: (
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  ),
};

/** One of the eight outlines, alone: the picker draws its own buttons around it. */
export function GroupGlyph({
  color,
  icon,
  size,
}: {
  color: string;
  icon: GroupIconKey;
  size: number;
}) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      height={size}
      stroke={color}
      strokeLinecap={icon === 'ball' ? undefined : 'round'}
      strokeLinejoin="round"
      strokeWidth={size >= 24 ? 1.8 : 2}
      viewBox="0 0 24 24"
      width={size}
    >
      {GLYPHS[icon]}
    </svg>
  );
}

/**
 * The group's icon in the colour the owner chose (PR H). Same contract as
 * GroupIcon.tsx: always decorative, because the group's name is written
 * beside it.
 */
export function GroupIcon({
  appearance,
  size,
  tile = false,
}: {
  appearance: GroupAppearance;
  size: number;
  tile?: boolean;
}) {
  const { colors } = useTheme();
  const { glyph, fill } = groupColors(colors, appearance.color);
  const shape = groupIconTile(size);
  return (
    <div
      aria-hidden="true"
      data-group-color={appearance.color}
      data-group-icon={appearance.icon}
      style={{
        alignItems: 'center',
        backgroundColor: tile ? fill : 'transparent',
        borderRadius: tile ? shape.radius : 0,
        display: 'flex',
        flexShrink: 0,
        height: size,
        justifyContent: 'center',
        width: size,
      }}
    >
      <GroupGlyph color={glyph} icon={appearance.icon} size={tile ? shape.glyph : size} />
    </div>
  );
}
