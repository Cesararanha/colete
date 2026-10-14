import { Link, type Href } from 'expo-router';
import { useId } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppIcon, type IconName } from '@/components/ui/AppIcon';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/**
 * A settings row that opens another screen: the title is the link's name, the
 * hint is its description, and the chevron says "goes somewhere" without
 * being the only cue.
 */
export function ProfileLinkRow({
  hint,
  href,
  icon,
  testID,
  title,
}: {
  hint: string;
  href: Href;
  icon: IconName;
  testID?: string;
  title: string;
}) {
  const { colors } = useTheme();
  const hintId = `profile-link-${useId().replace(/[^A-Za-z0-9_-]/gu, '')}-hint`;

  return (
    <Link asChild href={href}>
      <Pressable
        accessibilityLabel={title}
        accessibilityRole="link"
        aria-describedby={hintId}
        style={styles.row}
        testID={testID}
      >
        <View style={[styles.iconTile, { backgroundColor: colors.background }]}>
          <AppIcon color={colors.text} name={icon} size={20} />
        </View>
        <View style={styles.texts}>
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
          <Text nativeID={hintId} style={[styles.hint, { color: colors.textMuted }]}>
            {hint}
          </Text>
        </View>
        <AppIcon color={colors.textMuted} name="chevron-right" size={22} />
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  hint: { ...typography.support },
  iconTile: {
    alignItems: 'center',
    borderRadius: radius.field,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  row: {
    alignItems: 'center',
    borderRadius: radius.field,
    flexDirection: 'row',
    gap: spacing.ms,
    minHeight: size.row,
    minWidth: 0,
    paddingVertical: spacing.sm,
    width: '100%',
  },
  texts: { flex: 1, gap: 2, minWidth: 0 },
  title: { ...typography.row },
});
