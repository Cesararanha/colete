import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';

export function AppSkeleton({ lines = 3 }: { lines?: number }) {
  const { colors } = useTheme();
  return (
    <View accessibilityState={{ busy: true }} style={styles.container} testID="loading-skeleton">
      {Array.from({ length: lines }, (_, index) => (
        <View
          key={index}
          style={[
            styles.line,
            { backgroundColor: colors.surfaceStrong, width: index === lines - 1 ? '68%' : '100%' },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm, paddingVertical: spacing.sm },
  line: { borderRadius: radius.sm, height: 18 },
});
