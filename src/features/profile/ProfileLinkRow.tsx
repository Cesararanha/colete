import { Link, type Href } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { AppIcon, type IconName } from '@/components/ui/AppIcon';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/**
 * A settings row that opens another screen (prévia aprovada): icon, the
 * title as the link's name, and the chevron that says "goes somewhere"
 * without being the only cue.
 */
export function ProfileLinkRow({
  href,
  icon,
  testID,
  title,
}: {
  href: Href;
  icon: IconName;
  testID?: string;
  title: string;
}) {
  const { colors } = useTheme();
  return (
    <Link asChild href={href}>
      <Pressable
        accessibilityLabel={title}
        accessibilityRole="link"
        style={styles.row}
        testID={testID}
      >
        <AppIcon color={colors.textMuted} name={icon} size={20} />
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        <AppIcon color={colors.textMuted} name="chevron-right" size={18} />
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  // The card's radius, so the focus ring follows the card's shape.
  row: {
    alignItems: 'center',
    borderRadius: radius.row,
    flexDirection: 'row',
    gap: spacing.ms,
    minHeight: 56,
    minWidth: 0,
    paddingHorizontal: 14,
    paddingVertical: spacing.sm,
    width: '100%',
  },
  title: { ...typography.bodyStrong, flex: 1, fontSize: 16, lineHeight: 22, minWidth: 0 },
});
