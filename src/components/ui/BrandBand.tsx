import type { PropsWithChildren } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { radius } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/**
 * The light theme's navy band (docs/29 §1.4). In the dark theme brandBand is
 * the background, so the band is invisible and only spacing remains. Focus
 * rings inside it switch to focusOnBand through the `data-band` attribute.
 */
export function BrandBand({
  children,
  rounded = false,
  style,
}: PropsWithChildren<{ rounded?: boolean; style?: StyleProp<ViewStyle> }>) {
  const { colors } = useTheme();
  return (
    <View
      {...bandMarker}
      style={[{ backgroundColor: colors.brandBand }, rounded ? styles.rounded : undefined, style]}
    >
      {children}
    </View>
  );
}

/** The COLETE wordmark (Barlow Condensed 24, +3 tracking). */
export function BrandWordmark({ heading = false }: { heading?: boolean }) {
  const { colors } = useTheme();
  return (
    <Text
      {...(heading ? { 'aria-level': 1, role: 'heading' as const } : {})}
      style={[styles.wordmark, { color: colors.onBand }]}
    >
      {pt.app.name}
    </Text>
  );
}

// react-native-web renders dataSet as data-* attributes; React Native ignores it.
const bandMarker = { dataSet: { band: 'true' } } as object;

const styles = StyleSheet.create({
  rounded: {
    borderBottomLeftRadius: radius.band,
    borderBottomRightRadius: radius.band,
  },
  wordmark: { ...typography.brand, flexShrink: 1, textTransform: 'uppercase' },
});
