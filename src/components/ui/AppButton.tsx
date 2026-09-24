import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';

type AppButtonProps = {
  accessibilityLabel?: string;
  children?: ReactNode;
  /**
   * docs/15: a button stays enabled and focusable; what it still needs is said
   * by adjacent text associated here, and the press explains itself.
   */
  describedBy?: string;
  label: string;
  onPress: () => void;
  pressed?: boolean;
  testID?: string;
  variant?: 'primary' | 'secondary' | 'destructive';
};

export function AppButton({
  accessibilityLabel,
  children,
  describedBy,
  label,
  onPress,
  pressed,
  testID,
  variant = 'primary',
}: AppButtonProps) {
  const { colors } = useTheme();
  const primary = variant === 'primary';
  const destructive = variant === 'destructive';
  const textColor = primary ? colors.onPrimary : destructive ? colors.critical : colors.text;

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={pressed === undefined ? undefined : { selected: pressed }}
      aria-describedby={describedBy}
      aria-pressed={pressed}
      onPress={onPress}
      style={({ pressed: isPressed }) => [
        styles.base,
        {
          backgroundColor: primary ? colors.primary : colors.surface,
          borderColor: primary ? colors.primary : destructive ? colors.critical : colors.border,
          borderWidth: destructive ? 2 : 1,
          opacity: isPressed ? 0.78 : 1,
          transform: [{ scale: isPressed ? 0.99 : 1 }],
        } satisfies ViewStyle,
      ]}
      testID={testID}
    >
      {children}
      <Text style={[styles.label, { color: textColor }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    flexShrink: 1,
    justifyContent: 'center',
    maxWidth: '100%',
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  label: {
    flexShrink: 1,
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
    textAlign: 'center',
  },
});
