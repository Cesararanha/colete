import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useState, type ComponentProps } from 'react';
import { Image, View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';

import { groupColors, groupIconTile, type GroupAppearance, type GroupIconKey } from './group-icon';

// Native has no inline SVG without a new dependency, so it draws the nearest
// glyph of the icon font already shipped; the web file draws the prévia's own
// outlines. The goal has no glyph of its own in the free set: the net grid
// stands in for it.
const GLYPHS: Record<GroupIconKey, ComponentProps<typeof MaterialCommunityIcons>['name']> = {
  ball: 'soccer',
  goal: 'grid',
  field: 'soccer-field',
  whistle: 'whistle-outline',
  shirt: 'tshirt-crew-outline',
  trophy: 'trophy-outline',
  bolt: 'lightning-bolt-outline',
  flame: 'fire',
};

/** One of the eight glyphs, alone: the picker draws its own buttons around it. */
export function GroupGlyph({
  color,
  icon,
  size,
}: {
  color: string;
  icon: GroupIconKey;
  size: number;
}) {
  return <MaterialCommunityIcons color={color} name={GLYPHS[icon]} size={size} />;
}

/**
 * The group's icon in the colour the owner chose (PR H). Always decorative:
 * the group's name is written beside it. With `photo` (a signed URL, 0030)
 * the group's photo fills the tile instead; one that does not load falls
 * back to the icon.
 */
export function GroupIcon({
  appearance,
  photo,
  size,
  tile = false,
}: {
  appearance: GroupAppearance;
  photo?: string | null | undefined;
  size: number;
  tile?: boolean;
}) {
  const { colors } = useTheme();
  const { glyph, fill } = groupColors(colors, appearance.color);
  const shape = groupIconTile(size);
  const [failed, setFailed] = useState<string | null>(null);
  if (typeof photo === 'string' && photo !== '' && failed !== photo) {
    return (
      <Image
        accessibilityElementsHidden
        accessibilityIgnoresInvertColors
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        onError={() => setFailed(photo)}
        source={{ uri: photo }}
        style={{ borderRadius: tile ? shape.radius : size / 4, height: size, width: size }}
        testID="group-photo"
      />
    );
  }
  return (
    <View
      accessibilityElementsHidden
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={
        tile
          ? {
              alignItems: 'center',
              backgroundColor: fill,
              borderRadius: shape.radius,
              height: size,
              justifyContent: 'center',
              width: size,
            }
          : { alignItems: 'center', height: size, justifyContent: 'center', width: size }
      }
    >
      <GroupGlyph color={glyph} icon={appearance.icon} size={tile ? shape.glyph : size} />
    </View>
  );
}
