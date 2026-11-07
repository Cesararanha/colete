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
  level = 3,
  testID,
}: {
  title: string;
  children: ReactNode;
  /** 2 where no section heading precedes it (Perfil, the presence of a match). */
  level?: 2 | 3;
  testID: string;
}) {
  const { colors } = useTheme();
  const Heading = level === 2 ? 'h2' : 'h3';
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
        <Heading
          tabIndex={-1}
          data-testid={`${testID}-heading`}
          data-group-confirmation={testID}
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
        </Heading>
      ) : (
        <Text
          accessibilityRole="header"
          aria-level={level}
          style={[styles.title, { color: colors.text }]}
        >
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
