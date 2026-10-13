import type { PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';

import { raisedShadow } from '@/theme/elevation';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';

import { SurfaceContext } from './SurfaceContext';

type AppCardProps = PropsWithChildren<{
  testID?: string;
}>;

// docs/29 §6: no outline; the raised layer (plus a light-theme shadow) separates it.
export function AppCard({ children, testID }: AppCardProps) {
  const { colors, mode } = useTheme();

  return (
    <View
      style={[styles.card, { backgroundColor: colors.surfaceRaised }, raisedShadow(mode)]}
      testID={testID}
    >
      <SurfaceContext.Provider value="raised">{children}</SurfaceContext.Provider>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.row,
    gap: spacing.md,
    minWidth: 0,
    padding: spacing.lg,
    width: '100%',
  },
});
