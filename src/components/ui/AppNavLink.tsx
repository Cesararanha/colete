import { Link, type Href } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';

type AppNavLinkProps = {
  active?: boolean;
  href: Href;
  label: string;
};

export function AppNavLink({ active = false, href, label }: AppNavLinkProps) {
  const { colors } = useTheme();

  return (
    <Link href={href} asChild>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="link"
        accessibilityState={{ selected: active }}
        style={({ pressed }) => [
          styles.link,
          {
            backgroundColor: active ? colors.surfaceStrong : 'transparent',
            borderColor: active ? colors.border : 'transparent',
            opacity: pressed ? 0.72 : 1,
          },
        ]}
      >
        <Text style={[styles.text, { color: colors.text }]}>{label}</Text>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  link: {
    alignItems: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 96,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  text: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
  },
});
