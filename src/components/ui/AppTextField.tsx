import { forwardRef, useId, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputInstance,
  type TextInputProps,
  View,
} from 'react-native';

import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { AppIcon } from './AppIcon';

type AppTextFieldProps = Omit<TextInputProps, 'style'> & {
  error?: string | undefined;
  hint?: string | undefined;
  /** The nativeID of a text outside the field that also describes it, read after the hint. */
  describedByExtra?: string | undefined;
  label: string;
  passwordToggleLabel?: { hide: string; show: string } | undefined;
  testID?: string | undefined;
};

export const AppTextField = forwardRef<TextInputInstance, AppTextFieldProps>(function AppTextField(
  {
    describedByExtra,
    error,
    hint,
    label,
    passwordToggleLabel,
    secureTextEntry,
    testID,
    ...inputProps
  },
  ref,
) {
  const { colors } = useTheme();
  const [passwordVisible, setPasswordVisible] = useState(false);
  const fieldId = useId().replace(/[^A-Za-z0-9_-]/gu, '');
  const describedBy = `app-field-${fieldId}-description`;
  const invalid = error !== undefined;
  const toggleText = passwordVisible ? passwordToggleLabel?.hide : passwordToggleLabel?.show;
  const descriptions = [
    error !== undefined || hint !== undefined ? describedBy : undefined,
    describedByExtra,
  ].filter((id) => id !== undefined);

  return (
    <View style={styles.group}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <View style={styles.inputRow}>
        <TextInput
          {...inputProps}
          ref={ref}
          accessibilityLabel={label}
          aria-describedby={descriptions.length > 0 ? descriptions.join(' ') : undefined}
          aria-invalid={invalid}
          placeholderTextColor={colors.textMuted}
          secureTextEntry={secureTextEntry === true && !passwordVisible}
          style={[
            styles.input,
            passwordToggleLabel === undefined ? undefined : styles.inputWithToggle,
            {
              backgroundColor: colors.surfaceRaised,
              // docs/29 §6: error = 2 px critical border, plus the message and icon below.
              borderColor: invalid ? colors.critical : colors.fieldBorder,
              borderWidth: invalid ? 2 : 1,
              color: colors.text,
            },
          ]}
          testID={testID}
        />
        {passwordToggleLabel === undefined ? null : (
          // Icon only: the eye shows the password, the struck eye hides it again.
          // The name ("Mostrar senha" / "Ocultar senha") says the same to readers.
          <Pressable
            accessibilityLabel={toggleText}
            accessibilityRole="button"
            onPress={() => setPasswordVisible((visible) => !visible)}
            style={({ pressed }) => [styles.passwordToggle, { opacity: pressed ? 0.72 : 1 }]}
          >
            <AppIcon
              color={colors.textMuted}
              name={passwordVisible ? 'eye-off' : 'eye'}
              size={22}
            />
          </Pressable>
        )}
      </View>
      <View style={styles.descriptionRow}>
        {error === undefined && hint === undefined ? null : (
          <>
            {invalid ? (
              <View style={styles.descriptionIcon}>
                <AppIcon color={colors.critical} name="alert-circle" size={16} />
              </View>
            ) : null}
            <Text
              accessibilityLiveRegion={error === undefined ? 'none' : 'assertive'}
              nativeID={describedBy}
              role={error === undefined ? undefined : 'alert'}
              style={[
                styles.description,
                invalid ? styles.descriptionError : undefined,
                { color: error === undefined ? colors.textMuted : colors.critical },
              ]}
            >
              {error ?? hint}
            </Text>
          </>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  description: { ...typography.support, flex: 1, minWidth: 0 },
  descriptionError: { ...typography.supportStrong },
  descriptionIcon: { paddingTop: 2 },
  descriptionRow: { flexDirection: 'row', gap: spacing.xs + 2, minHeight: 21 },
  group: { gap: spacing.sm, minWidth: 0, width: '100%' },
  input: {
    ...typography.body,
    borderRadius: radius.field,
    flex: 1,
    maxWidth: '100%',
    minHeight: size.field,
    minWidth: 0,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  inputRow: { minWidth: 0, position: 'relative', width: '100%' },
  inputWithToggle: { paddingRight: size.target + spacing.sm },
  label: { ...typography.supportStrong },
  passwordToggle: {
    alignItems: 'center',
    borderRadius: radius.field - 4,
    height: size.target,
    justifyContent: 'center',
    position: 'absolute',
    right: 4,
    top: 4,
    width: size.target,
  },
});
