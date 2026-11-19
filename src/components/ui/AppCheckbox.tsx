import { forwardRef, useId } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewInstance } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { AppIcon } from './AppIcon';

type AppCheckboxProps = {
  checked: boolean;
  describedBy?: string | undefined;
  error?: string | undefined;
  label: string;
  onChange: (checked: boolean) => void;
  testID?: string;
};

export const AppCheckbox = forwardRef<ViewInstance, AppCheckboxProps>(function AppCheckbox(
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
              backgroundColor: checked ? colors.primary : colors.surfaceRaised,
              borderColor: invalid
                ? colors.critical
                : checked
                  ? colors.primary
                  : colors.fieldBorder,
            },
          ]}
        >
          {checked ? <AppIcon color={colors.onPrimary} name="check" size={16} /> : null}
        </View>
        <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      </Pressable>
      {invalid ? (
        <View style={styles.errorRow}>
          <View style={styles.errorIcon}>
            <AppIcon color={colors.critical} name="alert-circle" size={16} />
          </View>
          <Text
            accessibilityLiveRegion="assertive"
            nativeID={errorId}
            role="alert"
            style={[styles.error, { color: colors.critical }]}
          >
            {error}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 2,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  error: { ...typography.supportStrong, flex: 1, minWidth: 0 },
  errorIcon: { paddingTop: 2 },
  errorRow: { flexDirection: 'row', gap: spacing.xs + 2 },
  group: { gap: spacing.xs, minWidth: 0, width: '100%' },
  label: { ...typography.body, flex: 1, minWidth: 0 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.ms,
    minHeight: size.target,
    minWidth: 0,
    paddingVertical: spacing.sm,
    width: '100%',
  },
});
