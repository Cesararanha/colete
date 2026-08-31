import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';

type AppButtonProps = {
  accessibilityLabel?: string;
  children?: ReactNode;
  label: string;
  onPress: () => void;
  pressed?: boolean;
  testID?: string;
  variant?: 'primary' | 'secondary';
};

export function AppButton({
  accessibilityLabel,
  children,
  label,
  onPress,
  pressed,
  testID,
  variant = 'primary',
}: AppButtonProps) {
  const { colors } = useTheme();
  const primary = variant === 'primary';

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={pressed === undefined ? undefined : { selected: pressed }}
      aria-pressed={pressed}
      onPress={onPress}
      style={({ pressed: isPressed }) => [
        styles.base,
        {
          backgroundColor: primary ? colors.primary : colors.surface,
          borderColor: primary ? colors.primary : colors.border,
          opacity: isPressed ? 0.78 : 1,
          transform: [{ scale: isPressed ? 0.99 : 1 }],
        } satisfies ViewStyle,
      ]}
      testID={testID}
    >
      {children}
      <Text style={[styles.label, { color: primary ? colors.onPrimary : colors.text }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  label: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
  },
});
