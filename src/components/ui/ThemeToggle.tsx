import { Pressable, StyleSheet, Text } from 'react-native';

import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { AppIcon } from './AppIcon';

/**
 * The theme switch of every shell. Same name, pressed state and testID as the
 * former secondary button; it lives in the brand band, so it uses band tokens
 * (no amber in the light theme, docs/29 §1.3) and shows the target theme's icon.
 */
export function ThemeToggle({ testID }: { testID?: string }) {
  const { colors, mode, toggleMode } = useTheme();
  const label = mode === 'dark' ? pt.theme.useLight : pt.theme.useDark;

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected: mode === 'dark' }}
      aria-pressed={mode === 'dark'}
      onPress={toggleMode}
      style={({ pressed }) => [
        styles.toggle,
        { backgroundColor: colors.bandRaised, opacity: pressed ? 0.8 : 1 },
      ]}
      testID={testID}
    >
      <AppIcon color={colors.onBand} name={mode === 'dark' ? 'sun' : 'moon'} size={18} />
      <Text style={[styles.label, { color: colors.onBand }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: { ...typography.supportStrong },
  toggle: {
    alignItems: 'center',
    borderRadius: radius.pill,
    flexDirection: 'row',
    flexShrink: 1,
    gap: spacing.sm,
    minHeight: size.target,
    minWidth: size.target,
    paddingHorizontal: spacing.md,
  },
});
