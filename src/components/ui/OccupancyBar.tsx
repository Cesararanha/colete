import { StyleSheet, View } from 'react-native';

import { radius } from '@/theme/spacing';

/** Confirmed over slots as a bar; the count is always written beside it. */
export function OccupancyBar({
  color,
  height = 6,
  ratio,
  testID,
  track,
}: {
  color: string;
  height?: number;
  ratio: number;
  testID?: string;
  track: string;
}) {
  const width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%` as const;
  return (
    <View
      accessibilityElementsHidden
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.track, { backgroundColor: track, height }]}
    >
      <View style={[styles.fill, { backgroundColor: color, width }]} testID={testID} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { borderRadius: radius.pill, height: '100%' },
  track: { borderRadius: radius.pill, overflow: 'hidden', width: '100%' },
});
