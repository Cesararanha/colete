import { StyleSheet, Text } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';

export function FormAlert({ message, testID }: { message: string; testID?: string }) {
  const { colors } = useTheme();
  return (
    <Text
      accessibilityLiveRegion="assertive"
      role="alert"
      style={[styles.alert, { color: colors.critical }]}
      testID={testID}
    >
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  alert: { fontSize: 15, fontWeight: '700', lineHeight: 22 },
});
