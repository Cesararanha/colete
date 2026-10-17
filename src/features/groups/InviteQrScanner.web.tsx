import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AppButton } from '@/components/ui/AppButton';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';
import { focusGroupControl } from './GroupConfirmation';
import { startInviteCamera } from './invite-camera.web';
import type { InviteScannerProps } from './invite-scanner-types';

export function InviteQrScanner({ onRead, onError, onCancel }: InviteScannerProps) {
  const { colors } = useTheme();
  const video = useRef<HTMLVideoElement>(null);
  const camera = useRef<ReturnType<typeof startInviteCamera> | null>(null);
  const [ready, setReady] = useState(false);
  const cancel = useCallback(() => {
    camera.current?.stop();
    onCancel();
  }, [onCancel]);
  useFocusEffect(
    useCallback(
      () => () => {
        camera.current?.stop();
      },
      [],
    ),
  );
  useLayoutEffect(() => {
    focusGroupControl('cancel-invite-camera');
  }, []);
  useEffect(() => {
    if (!video.current) return;
    camera.current = startInviteCamera(video.current, {
      onRead,
      onError,
      onInactive: onCancel,
      onReady: () => setReady(true),
    });
    return () => {
      camera.current?.stop();
      camera.current = null;
    };
  }, [onRead, onError, onCancel]);
  return (
    <View style={styles.frame} testID="invite-camera">
      <Text style={[typography.support, { color: colors.text }]}>{pt.groups.join.cameraHint}</Text>
      {!ready ? (
        <Text role="status" style={[typography.support, { color: colors.textMuted }]}>
          {pt.groups.join.cameraLoading}
        </Text>
      ) : null}
      <video
        ref={video}
        aria-label={pt.groups.join.cameraTitle}
        autoPlay
        playsInline
        muted
        style={{
          width: '100%',
          maxHeight: 320,
          aspectRatio: '4 / 3',
          objectFit: 'cover',
          background: '#000000',
        }}
      />
      <AppButton
        label={pt.groups.join.cancelCamera}
        onPress={cancel}
        variant="secondary"
        testID="cancel-invite-camera"
      />
      <AppButton label={pt.groups.join.typeCode} onPress={cancel} variant="tertiary" />
    </View>
  );
}
const styles = StyleSheet.create({ frame: { gap: spacing.ms, minWidth: 0 } });
