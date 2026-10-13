import { useEffect } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { ReactNode } from 'react';

import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

export function focusGroupControl(testId: string) {
  if (typeof document !== 'undefined')
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus();
}

export function GroupConfirmation({
  title,
  children,
  testID,
}: {
  title: string;
  children: ReactNode;
  testID: string;
}) {
  const { colors } = useTheme();
  useEffect(() => {
    focusGroupControl(`${testID}-heading`);
    if (typeof document !== 'undefined')
      document
        .querySelector<HTMLElement>(`[data-testid="${testID}"]`)
        ?.scrollIntoView({ block: 'start' });
  }, [testID]);
  return (
    <View style={styles.container} testID={testID}>
      {Platform.OS === 'web' ? (
        <h3
          tabIndex={-1}
          data-testid={`${testID}-heading`}
          style={{
            fontFamily: typography.title.fontFamily,
            fontWeight: 600,
            color: colors.text,
            fontSize: typography.title.fontSize,
            lineHeight: `${typography.title.lineHeight}px`,
            margin: 0,
          }}
        >
          {title}
        </h3>
      ) : (
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
          {title}
        </Text>
      )}
      {children}
    </View>
  );
}
const styles = StyleSheet.create({
  container: { gap: spacing.md },
  title: { ...typography.title },
});
