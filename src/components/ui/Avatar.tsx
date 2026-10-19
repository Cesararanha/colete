import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

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
 * gap of an overlapping stack in the colour of the card below. With `photo`
 * (a signed URL, 0030) the photo takes the place of the initials; a photo
 * that does not load falls back to them.
 */
export function Avatar({
  id,
  name,
  photo,
  ring,
  size = 40,
}: {
  id: string | null | undefined;
  name: string;
  photo?: string | null | undefined;
  ring?: string;
  size?: AvatarSize;
}) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState<string | null>(null);
  const showPhoto = typeof photo === 'string' && photo !== '' && failed !== photo;
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
      {showPhoto ? (
        <Image
          accessibilityIgnoresInvertColors
          onError={() => setFailed(photo)}
          source={{ uri: photo }}
          style={{ height: size, width: size }}
          testID="avatar-photo"
        />
      ) : (
        <Text style={[size === 96 ? styles.large : styles.initials, fonts[size], { color: text }]}>
          {memberInitials(name)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: 'center', flexShrink: 0, justifyContent: 'center', overflow: 'hidden' },
  initials: { ...face('bold') },
  large: { ...face('condensed') },
});
