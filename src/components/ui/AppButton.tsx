import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';

type AppButtonProps = {
  accessibilityLabel?: string;
  ariaDisabled?: boolean;
  children?: ReactNode;
  /**
   * docs/15: a button stays enabled and focusable; what it still needs is said
   * by adjacent text associated here, and the press explains itself.
   */
  describedBy?: string | undefined;
  label: string;
  onPress: () => void;
  pressed?: boolean;
  testID?: string;
  variant?: 'primary' | 'secondary' | 'destructive';
};

export function AppButton({
  accessibilityLabel,
  ariaDisabled = false,
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

  // Pressable overwrites aria-disabled from its native `disabled` prop on web.
  // A real button with aria-disabled remains in keyboard order and keeps the
  // associated reason, while the owner action is guarded at its call site.
  if (Platform.OS === 'web' && ariaDisabled) {
    return (
      <button
        aria-label={accessibilityLabel ?? label}
        aria-disabled="true"
        aria-describedby={describedBy}
        data-testid={testID}
        type="button"
        style={{
          alignItems: 'center',
          backgroundColor: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: radius.pill,
          color: textColor,
          cursor: 'default',
          display: 'inline-flex',
          fontSize: 16,
          fontWeight: 700,
          justifyContent: 'center',
          lineHeight: '22px',
          minHeight: 48,
          minWidth: 48,
          padding: `${spacing.sm}px ${spacing.lg}px`,
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{
        disabled: ariaDisabled,
        ...(pressed === undefined ? {} : { selected: pressed }),
      }}
      aria-disabled={ariaDisabled}
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
