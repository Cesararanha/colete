import { forwardRef, useId, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';

type AppTextFieldProps = Omit<TextInputProps, 'style'> & {
  error?: string | undefined;
  hint?: string | undefined;
  label: string;
  passwordToggleLabel?: { hide: string; show: string } | undefined;
  testID?: string | undefined;
};

export const AppTextField = forwardRef<TextInput, AppTextFieldProps>(function AppTextField(
  { error, hint, label, passwordToggleLabel, secureTextEntry, testID, ...inputProps },
  ref,
) {
  const { colors } = useTheme();
  const [passwordVisible, setPasswordVisible] = useState(false);
  const fieldId = useId().replace(/[^A-Za-z0-9_-]/gu, '');
  const describedBy = `app-field-${fieldId}-description`;

  return (
    <View style={styles.group}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <View style={styles.inputRow}>
        <TextInput
          {...inputProps}
          ref={ref}
          accessibilityLabel={label}
          aria-describedby={error !== undefined || hint !== undefined ? describedBy : undefined}
          aria-invalid={error !== undefined}
          secureTextEntry={secureTextEntry === true && !passwordVisible}
          style={[
            styles.input,
            passwordToggleLabel === undefined ? undefined : styles.inputWithButton,
            { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text },
          ]}
          testID={testID}
        />
        {passwordToggleLabel === undefined ? null : (
          <Pressable
            accessibilityLabel={
              passwordVisible ? passwordToggleLabel.hide : passwordToggleLabel.show
            }
            accessibilityRole="button"
            onPress={() => setPasswordVisible((visible) => !visible)}
            style={[styles.passwordToggle, { borderColor: colors.border }]}
          >
            <Text style={[styles.passwordToggleText, { color: colors.text }]}>
              {passwordVisible ? passwordToggleLabel.hide : passwordToggleLabel.show}
            </Text>
          </Pressable>
        )}
      </View>
      <View style={styles.descriptionRow}>
        {error === undefined && hint === undefined ? null : (
          <Text
            accessibilityLiveRegion={error === undefined ? 'none' : 'assertive'}
            nativeID={describedBy}
            role={error === undefined ? undefined : 'alert'}
            style={[
              styles.description,
              { color: error === undefined ? colors.textMuted : colors.critical },
            ]}
          >
            {error ?? hint}
          </Text>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  description: { fontSize: 14, lineHeight: 20 },
  descriptionRow: { minHeight: 20 },
  group: { gap: spacing.xs },
  input: {
    borderRadius: radius.sm,
    borderWidth: 1,
    flex: 1,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  inputRow: { alignItems: 'stretch', flexDirection: 'row', minWidth: 0 },
  inputWithButton: { borderBottomRightRadius: 0, borderTopRightRadius: 0 },
  label: { fontSize: 15, fontWeight: '700', lineHeight: 21 },
  passwordToggle: {
    alignItems: 'center',
    borderBottomRightRadius: radius.sm,
    borderTopRightRadius: radius.sm,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    minWidth: 72,
    paddingHorizontal: spacing.sm,
  },
  passwordToggleText: { fontSize: 14, fontWeight: '700' },
});
