import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppIcon } from '@/components/ui/AppIcon';
import { backTo } from '@/lib/navigation';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

/**
 * "Voltar ao perfil" from a screen the profile opened. A real link (href for
 * the keyboard and the address bar), whose press runs the one back of the app,
 * backTo: back to the profile already in the tab, or to a new one in place of
 * this screen when it was opened directly.
 */
export function ProfileBackLink({ label }: { label: string }) {
  const { colors } = useTheme();

  return (
    <View style={styles.container}>
      <Link
        accessibilityLabel={label}
        accessibilityRole="link"
        href="/perfil"
        onPress={(event) => {
          event.preventDefault();
          backTo('/perfil');
        }}
        style={styles.link}
        testID="profile-back-link"
      >
        <View style={styles.row}>
          <AppIcon color={colors.link} name="arrow-left" size={20} />
          <Text style={[styles.text, { color: colors.link }]}>{label}</Text>
        </View>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'flex-start', marginBottom: -spacing.sm, marginTop: -spacing.sm },
  link: {
    borderRadius: radius.field,
    justifyContent: 'center',
    minHeight: size.target,
    minWidth: size.target,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.ms,
  },
  row: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  text: { ...typography.button },
});
