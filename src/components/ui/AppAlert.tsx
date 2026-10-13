import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { AppIcon } from './AppIcon';

// docs/15: state is icon + text, never colour alone. The icon stays outside the
// live region so the announced text is exactly the message.
export function AppAlert({ message, testID }: { message: string; testID?: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.row}>
      <View style={styles.icon}>
        <AppIcon color={colors.critical} name="alert-circle" />
      </View>
      <Text
        accessibilityLiveRegion="assertive"
        role="alert"
        style={[styles.message, { color: colors.critical }]}
        testID={testID}
      >
        {message}
      </Text>
    </View>
  );
}

export function AppStatus({ message, testID }: { message: string; testID?: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.row}>
      <View style={styles.icon}>
        <AppIcon color={colors.positive} name="check-circle" />
      </View>
      <Text
        accessibilityLiveRegion="polite"
        role="status"
        style={[styles.message, { color: colors.positive }]}
        testID={testID}
      >
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  icon: { paddingTop: 1 },
  message: { ...typography.supportStrong, flex: 1, minWidth: 0 },
  row: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.sm, minWidth: 0 },
});
