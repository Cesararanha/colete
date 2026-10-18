import { StyleSheet, Text, View } from 'react-native';

import { memberInitials } from '@/features/groups/member-initials';
import { useTheme } from '@/theme/ThemeProvider';
import { face } from '@/theme/typography';

import { AVATAR_TONES, avatarTone } from './avatar-tone';

const fonts = {
  36: { fontSize: 13, lineHeight: 16 },
  40: { fontSize: 14, lineHeight: 18 },
  44: { fontSize: 15, lineHeight: 18 },
  96: { fontSize: 40, lineHeight: 44 },
} as const;

type AvatarSize = keyof typeof fonts;

/**
 * Initials on the person's tone (avatar-tone.ts). Always decorative: the name
 * is written beside it, or the control that holds it carries the name. A
 * removed account (no id) gets the neutral raised layer. `ring` draws the
 * gap of an overlapping stack in the colour of the card below.
 */
export function Avatar({
  id,
  name,
  ring,
  size = 40,
}: {
  id: string | null | undefined;
  name: string;
  ring?: string;
  size?: AvatarSize;
}) {
  const { colors } = useTheme();
  // A missing id (removed account, or a projection without it) gets the neutral layer.
  const tone = typeof id === 'string' && id !== '' ? AVATAR_TONES[avatarTone(id)] : null;
  const fill = tone ? colors[tone.fill] : colors.surfaceRaised;
  const text = tone ? colors[tone.text] : colors.textMuted;
  return (
    <View
      accessibilityElementsHidden
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.avatar,
        { backgroundColor: fill, borderRadius: size / 2, height: size, width: size },
        ring ? { borderColor: ring, borderWidth: 2 } : null,
      ]}
    >
      <Text style={[size === 96 ? styles.large : styles.initials, fonts[size], { color: text }]}>
        {memberInitials(name)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', flexShrink: 0, justifyContent: 'center', overflow: 'hidden' },
  initials: { ...face('bold') },
  large: { ...face('condensed') },
});
