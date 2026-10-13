import Feather from '@expo/vector-icons/Feather';
import type { ComponentProps } from 'react';
import { View } from 'react-native';

export type IconName = ComponentProps<typeof Feather>['name'];

/**
 * Feather outline icon, always decorative: whatever it means is said by the
 * text beside it (docs/15). The glyph is a private-use character, so the icon
 * never sits inside an element whose text a reader or a test announces.
 */
export function AppIcon({
  color,
  name,
  size = 20,
}: {
  color: string;
  name: IconName;
  size?: number;
}) {
  return (
    <View
      accessibilityElementsHidden
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={{ alignItems: 'center', height: size, justifyContent: 'center', width: size }}
    >
      <Feather color={color} name={name} size={size} />
    </View>
  );
}
