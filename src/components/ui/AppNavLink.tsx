import { Link, type Href } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { face, typography } from '@/theme/typography';

import { AppIcon, type IconName } from './AppIcon';

type AppNavLinkProps = {
  active?: boolean;
  href: Href;
  icon?: IconName;
  label: string;
  /** Inside the brand band (wide AppShell rail): band tokens instead of surface ones. */
  onBand?: boolean;
  /**
   * `link`: a text link. `tab`: an item of the bottom/top navigation bar.
   * `rail`: an item of the wide side navigation. Tabs and rails mark the
   * current route with a 4 px indicator plus a stronger label, not colour alone.
   */
  variant?: 'link' | 'tab' | 'rail';
};

export function AppNavLink({
  active = false,
  href,
  icon,
  label,
  onBand = false,
  variant = 'link',
}: AppNavLinkProps) {
  const { colors } = useTheme();
  // The current route of a navigation link is aria-current="page" on the web;
  // aria-selected belongs to tab/option roles, not to a link. Native readers
  // keep the selected state.
  const current =
    Platform.OS === 'web'
      ? { 'aria-current': active ? ('page' as const) : undefined }
      : { accessibilityState: { selected: active } };

  // Web hover (rev-previa, BB-028): a text link underlines, a tab or rail item
  // that is not the current one lights its label and icon.
  if (variant === 'link') {
    return (
      <Link asChild href={href}>
        <Pressable
          accessibilityLabel={label}
          accessibilityRole="link"
          {...current}
          style={styles.link}
        >
          {({ hovered }: { pressed: boolean; hovered?: boolean }) => (
            <Text
              style={[
                styles.linkText,
                { color: colors.link, textDecorationLine: hovered ? 'underline' : 'none' },
              ]}
            >
              {label}
            </Text>
          )}
        </Pressable>
      </Link>
    );
  }

  const tab = variant === 'tab';
  const tintFor = (hovered: boolean) =>
    onBand
      ? active || hovered
        ? colors.onBand
        : colors.onBandMuted
      : active
        ? colors.indicator
        : hovered
          ? colors.text
          : colors.textMuted;
  const indicator = onBand ? colors.onBand : colors.indicator;
  return (
    <Link asChild href={href}>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="link"
        {...current}
        // Link asChild merges styles as an array, so a style function would be dropped.
        style={tab ? styles.tab : styles.rail}
      >
        {({ hovered }: { pressed: boolean; hovered?: boolean }) => (
          <>
            <View
              style={[
                tab ? styles.tabIndicator : styles.railIndicator,
                { backgroundColor: active ? indicator : 'transparent' },
              ]}
            />
            {icon ? <AppIcon color={tintFor(hovered === true)} name={icon} size={22} /> : null}
            <Text
              style={[
                tab ? styles.tabText : styles.railText,
                active ? styles.activeText : undefined,
                { color: tintFor(hovered === true) },
              ]}
            >
              {label}
            </Text>
          </>
        )}
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  // Prévia aprovada: the current tab is amber and bold, under its 4 px indicator.
  activeText: { ...face('bold') },
  link: {
    alignItems: 'center',
    borderRadius: radius.field,
    justifyContent: 'center',
    minHeight: size.target,
    minWidth: size.target,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.ms,
  },
  linkText: { ...typography.button },
  rail: {
    alignItems: 'center',
    borderRadius: radius.field,
    flexDirection: 'row',
    gap: spacing.ms,
    minHeight: size.button,
    paddingHorizontal: spacing.md,
  },
  railIndicator: {
    borderRadius: radius.pill,
    bottom: spacing.ms,
    left: 0,
    position: 'absolute',
    top: spacing.ms,
    width: 4,
  },
  railText: { ...typography.bodyStrong },
  tab: {
    alignItems: 'center',
    flex: 1,
    gap: spacing.xs,
    justifyContent: 'center',
    minHeight: size.button + spacing.sm,
    // The floor is the touch target, so the bar still fits a 412 px screen at
    // 200% zoom (docs/15) without horizontal scroll.
    minWidth: size.target,
    paddingBottom: spacing.sm,
    paddingTop: spacing.ms,
  },
  tabIndicator: {
    borderRadius: radius.pill,
    height: 4,
    position: 'absolute',
    top: 0,
    width: 28,
  },
  tabText: { ...typography.navigation },
});
