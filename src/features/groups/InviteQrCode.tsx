import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { pt } from '@/lib/i18n/pt';
import { inviteQrMatrix, qrDarkRuns } from './invite-qr';

export function InviteQrCode({ value }: { value: string }) {
  const matrix = useMemo(() => inviteQrMatrix(value), [value]);
  const [width, setWidth] = useState(0);
  const moduleSize = Math.floor(Math.min(width, 320) / (matrix.length + 8));
  const size = (matrix.length + 8) * moduleSize;
  return (
    <View style={styles.container} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {moduleSize > 0 ? (
        <View
          accessibilityRole="image"
          accessibilityLabel={pt.groups.invites.qr}
          testID="invite-qr-code"
          style={[styles.paper, { width: size, height: size }]}
        >
          <View aria-hidden importantForAccessibility="no-hide-descendants">
            {matrix.flatMap((row, y) =>
              qrDarkRuns(row).map((run) => (
                <View
                  key={`${y}:${run.start}`}
                  style={[
                    styles.run,
                    {
                      left: (run.start + 4) * moduleSize,
                      top: (y + 4) * moduleSize,
                      width: run.length * moduleSize,
                      height: moduleSize,
                    },
                  ]}
                />
              )),
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { alignItems: 'center', width: '100%' },
  paper: { backgroundColor: '#ffffff' },
  run: { position: 'absolute', backgroundColor: '#000000' },
});
