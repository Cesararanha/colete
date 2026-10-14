import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { useReducedMotion } from '@/theme/motion';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { AppIcon, type IconName } from './AppIcon';
import { useSurfaceLayer } from './SurfaceContext';

type AppButtonProps = {
  accessibilityLabel?: string;
  ariaDisabled?: boolean;
  children?: ReactNode;
  /**
   * docs/15: a button stays enabled and focusable; what it still needs is said
   * by adjacent text associated here, and the press explains itself.
   */
  describedBy?: string | undefined;
  /** Decorative Feather icon; the label carries the meaning. */
  icon?: IconName;
  /** `trailing` (e.g. a chevron) puts the icon at the end and starts the label. */
  iconPosition?: 'leading' | 'trailing';
  label: string;
  onPress: () => void;
  pressed?: boolean;
  testID?: string;
  variant?: 'primary' | 'secondary' | 'tertiary' | 'destructive';
};

export function AppButton({
  accessibilityLabel,
  ariaDisabled = false,
  children,
  describedBy,
  icon,
  iconPosition = 'leading',
  label,
  onPress,
  pressed,
  testID,
  variant = 'primary',
}: AppButtonProps) {
  const { colors } = useTheme();
  const layer = useSurfaceLayer();
  const reducedMotion = useReducedMotion();
  const selected = pressed === true;
  const textOnly = variant === 'tertiary' || variant === 'destructive';
  // docs/29 §6: a selected option is never told by colour alone — it gains a check.
  const background = selected
    ? colors.indicator
    : variant === 'primary'
      ? colors.primary
      : variant === 'secondary'
        ? layer === 'raised'
          ? colors.background
          : colors.surfaceRaised
        : 'transparent';
  const textColor = selected
    ? colors.onPrimary
    : ariaDisabled
      ? colors.textMuted
      : variant === 'primary'
        ? colors.onPrimary
        : variant === 'destructive'
          ? colors.critical
          : variant === 'tertiary'
            ? colors.link
            : colors.text;
  const leadingIcon: IconName | undefined = selected
    ? 'check'
    : iconPosition === 'leading'
      ? icon
      : undefined;
  const trailingIcon = !selected && iconPosition === 'trailing' ? icon : undefined;

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
          backgroundColor: textOnly ? 'transparent' : colors.surface,
          border: 'none',
          borderRadius: radius.row,
          color: colors.textMuted,
          cursor: 'default',
          display: 'inline-flex',
          fontFamily: typography.button.fontFamily,
          gap: spacing.ms,
          fontSize: typography.button.fontSize,
          fontWeight: 700,
          justifyContent: 'center',
          lineHeight: `${typography.button.lineHeight}px`,
          minHeight: textOnly ? size.target : size.button,
          minWidth: size.target,
          padding: `${spacing.sm}px ${textOnly ? spacing.md : spacing.lg}px`,
        }}
      >
        {/* The disabled look keeps its icon, so the action reads the same. */}
        {icon && iconPosition === 'leading' ? (
          <AppIcon color={colors.textMuted} name={icon} size={20} />
        ) : null}
        {label}
        {icon && iconPosition === 'trailing' ? (
          <AppIcon color={colors.textMuted} name={icon} size={20} />
        ) : null}
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
        textOnly ? styles.textOnly : styles.filled,
        {
          backgroundColor: background,
          opacity: isPressed && textOnly ? 0.72 : 1,
          transform: [{ scale: isPressed && !reducedMotion ? 0.98 : 1 }],
        } satisfies ViewStyle,
        Platform.OS === 'web'
          ? ({
              transitionDuration: isPressed ? '100ms' : '160ms',
              transitionProperty: 'transform, opacity',
            } as ViewStyle)
          : null,
      ]}
      testID={testID}
    >
      {children}
      {leadingIcon ? (
        <View style={styles.icon}>
          <AppIcon color={textColor} name={leadingIcon} size={20} />
        </View>
      ) : null}
      <Text
        style={[styles.label, trailingIcon ? styles.labelStart : undefined, { color: textColor }]}
      >
        {label}
      </Text>
      {trailingIcon ? (
        <View style={styles.icon}>
          <AppIcon color={textColor} name={trailingIcon} size={20} />
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    borderRadius: radius.row,
    flexDirection: 'row',
    flexShrink: 1,
    gap: spacing.ms,
    justifyContent: 'center',
    maxWidth: '100%',
    minWidth: size.target,
    paddingHorizontal: spacing.lg,
  },
  filled: { minHeight: size.button, paddingVertical: spacing.sm },
  icon: { flexShrink: 0 },
  label: {
    ...typography.button,
    flexShrink: 1,
    textAlign: 'center',
  },
  labelStart: { flex: 1, textAlign: 'left' },
  textOnly: { minHeight: size.target, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
});
