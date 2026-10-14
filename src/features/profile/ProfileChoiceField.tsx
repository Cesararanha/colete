import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

export function ProfileChoiceField<T extends string>({
  clearLabel,
  hint,
  label,
  onChange,
  options,
  value,
}: {
  clearLabel: string;
  hint?: string;
  label: string;
  onChange: (value: T | null) => void;
  options: readonly { label: string; value: T }[];
  value: T | null | undefined;
}) {
  const { colors } = useTheme();

  return (
    <View accessibilityLabel={label} role="group" style={styles.group}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      {hint === undefined ? null : (
        <Text style={[styles.hint, { color: colors.textMuted }]}>{hint}</Text>
      )}
      <View style={styles.options}>
        {options.map((option) => (
          <AppButton
            key={option.value}
            label={option.label}
            onPress={() => onChange(option.value)}
            pressed={value === option.value}
            variant="secondary"
          />
        ))}
        <AppButton
          label={clearLabel}
          onPress={() => onChange(null)}
          pressed={value === null}
          variant="secondary"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.xs, minWidth: 0, width: '100%' },
  hint: { ...typography.support },
  label: { ...typography.supportStrong },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, minWidth: 0, width: '100%' },
});
