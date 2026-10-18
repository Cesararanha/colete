import Ionicons from '@expo/vector-icons/Ionicons';
import { View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';

import { GROUP_ICON_TILE } from './group-icon';

/**
 * The group's icon: this PR draws the ball, in blue, for every group; the
 * owner's choice of icon and colour comes later (PR H). Always decorative:
 * the group's name is written beside it. Native draws the Ionicons ball; the
 * web file draws the prévia's own outline.
 */
export function GroupIcon({ size, tile = false }: { size: number; tile?: boolean }) {
  const { colors } = useTheme();
  const glyph = (
    <Ionicons
      color={colors.info}
      name="football-outline"
      size={tile ? GROUP_ICON_TILE.glyph : size}
    />
  );
  return (
    <View
      accessibilityElementsHidden
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={
        tile
          ? {
              alignItems: 'center',
              backgroundColor: colors.infoSoft,
              borderRadius: GROUP_ICON_TILE.radius,
              height: size,
              justifyContent: 'center',
              width: size,
            }
          : { alignItems: 'center', height: size, justifyContent: 'center', width: size }
      }
    >
      {glyph}
    </View>
  );
}
