import { forwardRef, useId } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';

type AppCheckboxProps = {
  checked: boolean;
  describedBy?: string | undefined;
  error?: string | undefined;
  label: string;
  onChange: (checked: boolean) => void;
  testID?: string;
};

export const AppCheckbox = forwardRef<View, AppCheckboxProps>(function AppCheckbox(
  { checked, describedBy, error, label, onChange, testID },
  ref,
) {
  const { colors } = useTheme();
  const invalid = error !== undefined;
  const errorId = `app-checkbox-${useId().replace(/[^A-Za-z0-9_-]/gu, '')}-error`;
  const descriptionIds = [describedBy, invalid ? errorId : undefined].filter(
    (value): value is string => value !== undefined,
  );
  // react-native-web only maps Space to a press for button-like roles; a
  // checkbox must toggle on Space as well, as the native control does.
  const webKeyboard = {
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        onChange(!checked);
      }
    },
  } as object;

  return (
    <View style={styles.group}>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        aria-checked={checked}
        aria-describedby={descriptionIds.length === 0 ? undefined : descriptionIds.join(' ')}
        aria-invalid={invalid}
        onPress={() => onChange(!checked)}
        ref={ref}
        role="checkbox"
        {...webKeyboard}
        style={({ pressed }) => [styles.row, { opacity: pressed ? 0.78 : 1 }]}
        testID={testID}
      >
        <View
          aria-hidden
          style={[
            styles.box,
            {
              backgroundColor: checked ? colors.primary : colors.surface,
              borderColor: invalid ? colors.critical : checked ? colors.primary : colors.border,
            },
          ]}
        >
          {checked ? (
            <Text style={[styles.mark, { color: colors.onPrimary }]} aria-hidden>
              ✓
            </Text>
          ) : null}
        </View>
        <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      </Pressable>
      {invalid ? (
        <Text
          accessibilityLiveRegion="assertive"
          nativeID={errorId}
          role="alert"
          style={[styles.error, { color: colors.critical }]}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    borderRadius: radius.sm,
    borderWidth: 2,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  error: { fontSize: 14, fontWeight: '700', lineHeight: 20 },
  group: { gap: spacing.xs, minWidth: 0, width: '100%' },
  label: { flex: 1, fontSize: 16, lineHeight: 24, minWidth: 0 },
  mark: { fontSize: 18, fontWeight: '900', lineHeight: 22 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 48,
    minWidth: 0,
    paddingVertical: spacing.sm,
    width: '100%',
  },
});
