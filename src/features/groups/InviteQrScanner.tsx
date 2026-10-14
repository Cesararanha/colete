import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { AppButton } from '@/components/ui/AppButton';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';
import type { InviteScannerProps } from './invite-scanner-types';

export function InviteQrScanner({ onRead, onError, onCancel }: InviteScannerProps) {
  const { colors } = useTheme();
  const [, requestPermission] = useCameraPermissions();
  const [granted, setGranted] = useState(false);
  const closed = useRef(false);
  const finish = useCallback(() => {
    closed.current = true;
    setGranted(false);
  }, []);
  const cancel = useCallback(() => {
    finish();
    onCancel();
  }, [finish, onCancel]);
  useFocusEffect(
    useCallback(() => {
      closed.current = false;
      return finish;
    }, [finish]),
  );
  useEffect(() => {
    let current = true;
    void requestPermission()
      .then((permission) => {
        if (!current || closed.current) return;
        if (permission.granted) setGranted(true);
        else {
          finish();
          onError('denied');
        }
      })
      .catch(() => {
        if (current && !closed.current) {
          finish();
          onError('unavailable');
        }
      });
    const subscription = AppState.addEventListener('change', (state) => {
      // iOS permission alerts are inactive, not background.
      if (state === 'background') cancel();
    });
    return () => {
      current = false;
      closed.current = true;
      subscription.remove();
    };
  }, [requestPermission, finish, onError, cancel]);
  return (
    <View style={styles.frame} testID="invite-camera">
      <Text style={[typography.support, { color: colors.text }]}>{pt.groups.join.cameraHint}</Text>
      {granted ? (
        <CameraView
          style={styles.camera}
          facing="back"
          autofocus="on"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (!closed.current) {
              finish();
              onRead(data);
            }
          }}
          onMountError={() => {
            if (!closed.current) {
              finish();
              onError('unavailable');
            }
          }}
        />
      ) : (
        <Text
          accessibilityLiveRegion="polite"
          style={[typography.support, { color: colors.textMuted }]}
        >
          {pt.groups.join.cameraLoading}
        </Text>
      )}
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
const styles = StyleSheet.create({
  frame: { gap: spacing.ms },
  camera: { width: '100%', height: 280 },
});
