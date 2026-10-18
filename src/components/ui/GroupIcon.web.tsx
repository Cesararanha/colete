import { useTheme } from '@/theme/ThemeProvider';

import { GROUP_ICON_TILE } from './group-icon';

/**
 * The web draws the prévia's ball as inline SVG: no icon font is added to the
 * bundle for one glyph. Same contract as GroupIcon.tsx: decorative, blue,
 * the ball for every group until the owner can choose (PR H).
 */
export function GroupIcon({ size, tile = false }: { size: number; tile?: boolean }) {
  const { colors } = useTheme();
  const glyph = tile ? GROUP_ICON_TILE.glyph : size;
  const svg = (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      height={glyph}
      stroke={colors.info}
      strokeLinejoin="round"
      strokeWidth={tile ? 1.8 : 2}
      viewBox="0 0 24 24"
      width={glyph}
    >
      <circle cx="12" cy="12" r="9.5" />
      <polygon points="12,8 15.8,10.8 14.4,15.2 9.6,15.2 8.2,10.8" />
      <path d="M12 8V2.5M15.8 10.8l5.2-1.7M14.4 15.2l3.2 4.4M9.6 15.2l-3.2 4.4M8.2 10.8 3 9.1" />
    </svg>
  );
  return (
    <div
      aria-hidden="true"
      style={{
        alignItems: 'center',
        backgroundColor: tile ? colors.infoSoft : 'transparent',
        borderRadius: tile ? GROUP_ICON_TILE.radius : 0,
        display: 'flex',
        flexShrink: 0,
        height: size,
        justifyContent: 'center',
        width: size,
      }}
    >
      {svg}
    </div>
  );
}
