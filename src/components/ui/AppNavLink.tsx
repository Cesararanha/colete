import { Link, type Href } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

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

  if (variant === 'link') {
    return (
      <Link
        accessibilityLabel={label}
        accessibilityRole="link"
        accessibilityState={{ selected: active }}
        href={href}
        style={styles.link}
      >
        <Text style={[styles.linkText, { color: colors.link }]}>{label}</Text>
      </Link>
    );
  }

  const tab = variant === 'tab';
  const tint = onBand
    ? active
      ? colors.onBand
      : colors.onBandMuted
    : active
      ? colors.text
      : colors.textMuted;
  const indicator = onBand ? colors.onBand : colors.indicator;
  return (
    <Link asChild href={href}>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="link"
        accessibilityState={{ selected: active }}
        // Link asChild merges styles as an array, so a style function would be dropped.
        style={tab ? styles.tab : styles.rail}
      >
        <View
          style={[
            tab ? styles.tabIndicator : styles.railIndicator,
            { backgroundColor: active ? indicator : 'transparent' },
          ]}
        />
        {icon ? <AppIcon color={tint} name={icon} size={22} /> : null}
        <Text style={[tab ? styles.tabText : styles.railText, { color: tint }]}>{label}</Text>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
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
    minWidth: 96,
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
