import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppAlert } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppIcon } from '@/components/ui/AppIcon';
import { Avatar } from '@/components/ui/Avatar';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import type { PhotoSource } from './photo-change';
import type { usePhotoChange } from './usePhotoChange';

type PhotoChange = ReturnType<typeof usePhotoChange>;

const BIG = 96;
const BADGE = 30;

/**
 * The profile's big avatar as the button that opens the photo options. The
 * camera badge is the only sign that it can be pressed (no helper text); the
 * avatar itself stays decorative, and the button carries the name. While a
 * photo is sent the badge turns into the spinner and the avatar dims, so the
 * initials stay readable under it.
 */
export function ProfilePhotoButton({
  change,
  expanded,
  id,
  name,
  onPress,
  photo,
}: {
  change: PhotoChange;
  expanded: boolean;
  id: string;
  name: string;
  onPress: () => void;
  photo: string | null;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={pt.photos.openProfile}
      accessibilityRole="button"
      accessibilityState={{ busy: change.busy, expanded }}
      aria-expanded={expanded}
      onPress={onPress}
      style={({ pressed }) => [styles.big, { opacity: pressed ? 0.86 : 1 }]}
      testID="profile-photo-button"
    >
      <View style={{ opacity: change.busy ? 0.55 : 1 }}>
        <Avatar id={id} name={name} photo={photo} size={BIG} />
      </View>
      <View
        aria-hidden
        style={[styles.badge, { backgroundColor: colors.primary, borderColor: colors.background }]}
      >
        {change.busy ? (
          <ActivityIndicator color={colors.onPrimary} size="small" style={styles.badgeSpinner} />
        ) : (
          <AppIcon color={colors.onPrimary} name="camera" size={15} />
        )}
      </View>
    </Pressable>
  );
}

/**
 * "Trocar foto" / "Escolher foto" and "Remover foto". The PWA opens the file
 * chooser at once; native asks gallery or camera first. While the photo is
 * sent the buttons wait, and the outcome is said once, below them.
 */
export function PhotoActions({
  align = 'center',
  change,
  chooseLabel,
  hasPhoto,
  testID,
}: {
  /** Centred under the profile's avatar; at the start of a section elsewhere. */
  align?: 'center' | 'start';
  change: PhotoChange;
  chooseLabel: string;
  hasPhoto: boolean;
  testID: string;
}) {
  const alignItems = align === 'center' ? 'center' : 'flex-start';
  const justifyContent = align === 'center' ? 'center' : 'flex-start';
  const [asking, setAsking] = useState(false);
  const choose = (source: PhotoSource) => {
    setAsking(false);
    void change.choose(source);
  };
  const status =
    change.phase === 'sending'
      ? pt.photos.sending
      : change.phase === 'removing'
        ? pt.photos.removing
        : (change.message ?? '');
  return (
    <View style={[styles.actions, { alignItems }]} testID={testID}>
      <View style={[styles.row, { justifyContent }]}>
        {asking ? (
          <>
            <AppButton
              compact
              icon="image"
              label={pt.photos.library}
              onPress={() => choose('library')}
              testID={`${testID}-library`}
              variant="outline"
            />
            <AppButton
              compact
              icon="camera"
              label={pt.photos.camera}
              onPress={() => choose('camera')}
              testID={`${testID}-camera`}
              variant="outline"
            />
          </>
        ) : (
          <AppButton
            ariaDisabled={change.busy}
            compact
            icon="camera"
            label={chooseLabel}
            onPress={() => {
              if (change.busy) return;
              if (Platform.OS === 'web') choose('library');
              else setAsking(true);
            }}
            testID={`${testID}-choose`}
            variant="outline"
          />
        )}
        {hasPhoto && !asking ? (
          <AppButton
            ariaDisabled={change.busy}
            compact
            icon="trash-2"
            label={pt.photos.remove}
            onPress={() => {
              if (!change.busy) void change.remove();
            }}
            testID={`${testID}-remove`}
            variant="outline-destructive"
          />
        ) : null}
      </View>
      <PhotoStatus busy={change.busy} message={status} testID={`${testID}-status`} />
      {change.error ? <AppAlert message={change.error} testID={`${testID}-error`} /> : null}
    </View>
  );
}

/**
 * One live region, kept mounted so every change is announced: a spinner while
 * the photo travels, the check only once it is done (docs/15: state is icon
 * and text, never colour alone).
 */
function PhotoStatus({
  busy,
  message,
  testID,
}: {
  busy: boolean;
  message: string;
  testID: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.status}>
      {message === '' ? null : (
        <View aria-hidden style={styles.statusIcon}>
          {busy ? (
            <ActivityIndicator color={colors.textMuted} size="small" />
          ) : (
            <AppIcon color={colors.positive} name="check-circle" />
          )}
        </View>
      )}
      <Text
        accessibilityLiveRegion="polite"
        role="status"
        style={[styles.statusText, { color: busy ? colors.textMuted : colors.positive }]}
        testID={testID}
      >
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm, minWidth: 0 },
  badge: {
    alignItems: 'center',
    borderRadius: BADGE / 2,
    borderWidth: 3,
    bottom: -2,
    height: BADGE,
    justifyContent: 'center',
    position: 'absolute',
    right: -2,
    width: BADGE,
  },
  badgeSpinner: { transform: [{ scale: 0.8 }] },
  big: { borderRadius: BIG / 2, height: BIG, width: BIG },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  status: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minWidth: 0 },
  statusIcon: { alignItems: 'center', height: 20, justifyContent: 'center', width: 20 },
  statusText: { ...typography.supportStrong, flexShrink: 1, minWidth: 0 },
});
