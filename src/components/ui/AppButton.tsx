import { Link, type Href } from 'expo-router';
import type { ReactNode } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

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
  /**
   * A destination: the same button, but a real link on the web (href, new
   * tab, copy address). `onPress` still runs; the link navigates.
   */
  href?: Href;
  /** With `href`, the destination replaces the current entry. */
  replace?: boolean;
  /** Decorative Feather icon; the label carries the meaning. */
  icon?: IconName;
  /** `trailing` (e.g. a chevron) puts the icon at the end and starts the label. */
  iconPosition?: 'leading' | 'trailing';
  label: string;
  onPress: () => void;
  pressed?: boolean;
  /** One line, cut with an ellipsis (the way back); the accessible label stays whole. */
  singleLine?: boolean;
  /** Prévia aprovada: a 44 px pill (Criar racha, Editar) instead of the 56 px block. */
  compact?: boolean;
  testID?: string;
  /**
   * `outline` and `outline-destructive` (prévia aprovada) are the transparent
   * button with a 1 px fieldBorder / critical outline: Convidar, Abrir no
   * mapa, Desistir, Sair da conta.
   */
  variant?:
    'primary' | 'secondary' | 'tertiary' | 'destructive' | 'outline' | 'outline-destructive';
};

export function AppButton({
  accessibilityLabel,
  ariaDisabled = false,
  children,
  compact = false,
  describedBy,
  href,
  icon,
  iconPosition = 'leading',
  label,
  onPress,
  pressed,
  replace = false,
  singleLine = false,
  testID,
  variant = 'primary',
}: AppButtonProps) {
  const { colors } = useTheme();
  const layer = useSurfaceLayer();
  const reducedMotion = useReducedMotion();
  const selected = pressed === true;
  const textOnly = variant === 'tertiary' || variant === 'destructive';
  const outline = variant === 'outline' || variant === 'outline-destructive';
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
        : variant === 'destructive' || variant === 'outline-destructive'
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
          backgroundColor: textOnly || outline ? 'transparent' : colors.surface,
          border: outline ? `1px solid ${colors.fieldBorder}` : 'none',
          borderRadius: compact ? radius.pill : outline ? radius.field : radius.row,
          color: colors.textMuted,
          cursor: 'default',
          display: 'inline-flex',
          fontFamily: typography.button.fontFamily,
          gap: spacing.ms,
          fontSize: typography.button.fontSize,
          fontWeight: 700,
          justifyContent: 'center',
          lineHeight: `${typography.button.lineHeight}px`,
          minHeight: compact ? size.compact : textOnly || outline ? size.target : size.button,
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

  // Web hover (rev77, BB-028): a perceptible dimming, distinct from the
  // selected state, which changes the fill and adds a check.
  const surface = (isPressed: boolean, isHovered = false): StyleProp<ViewStyle> => [
    styles.base,
    textOnly ? styles.textOnly : styles.filled,
    outline
      ? [
          styles.outline,
          {
            borderColor: variant === 'outline-destructive' ? colors.critical : colors.fieldBorder,
          },
        ]
      : null,
    compact ? styles.compact : null,
    {
      backgroundColor: background,
      opacity: isPressed && textOnly ? 0.72 : isHovered && !isPressed ? 0.84 : 1,
      transform: [{ scale: isPressed && !reducedMotion ? 0.98 : 1 }],
    } satisfies ViewStyle,
    Platform.OS === 'web'
      ? ({
          transitionDuration: isPressed ? '100ms' : '160ms',
          transitionProperty: 'transform, opacity',
        } as ViewStyle)
      : null,
  ];

  const button = (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole={href === undefined ? 'button' : 'link'}
      accessibilityState={{
        disabled: ariaDisabled,
        ...(pressed === undefined ? {} : { selected: pressed }),
      }}
      aria-disabled={ariaDisabled}
      aria-describedby={describedBy}
      aria-pressed={pressed}
      onPress={onPress}
      // Link asChild takes only one flat, static style: the link is drawn unpressed.
      style={
        href === undefined
          ? ({ pressed: isPressed, hovered }: { pressed: boolean; hovered?: boolean }) =>
              surface(isPressed, hovered === true)
          : StyleSheet.flatten(surface(false))
      }
      testID={testID}
    >
      {children}
      {leadingIcon ? (
        <View style={styles.icon}>
          <AppIcon color={textColor} name={leadingIcon} size={20} />
        </View>
      ) : null}
      <Text
        numberOfLines={singleLine ? 1 : undefined}
        style={[
          styles.label,
          compact ? styles.compactLabel : undefined,
          trailingIcon ? styles.labelStart : undefined,
          { color: textColor },
        ]}
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
  return href === undefined ? (
    button
  ) : (
    <Link asChild href={href} replace={replace}>
      {button}
    </Link>
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
  compact: {
    borderRadius: radius.pill,
    gap: spacing.xs + 2,
    minHeight: size.compact,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  compactLabel: { fontSize: 15, lineHeight: 20 },
  filled: { minHeight: size.button, paddingVertical: spacing.sm },
  outline: {
    backgroundColor: 'transparent',
    borderRadius: radius.field,
    borderWidth: 1,
    minHeight: size.target,
  },
  icon: { flexShrink: 0 },
  // minWidth 0: a long label (a member's name) wraps instead of leaving the button.
  label: {
    ...typography.button,
    flexShrink: 1,
    minWidth: 0,
    textAlign: 'center',
  },
  labelStart: { flex: 1, textAlign: 'left' },
  textOnly: { minHeight: size.target, paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
});
