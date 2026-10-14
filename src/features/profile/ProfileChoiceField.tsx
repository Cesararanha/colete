import { useId, useRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppIcon } from '@/components/ui/AppIcon';
import { useSurfaceLayer } from '@/components/ui/SurfaceContext';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { face, typography } from '@/theme/typography';

type Option<T extends string> = { label: string; value: T | null };

/**
 * A single choice shown as pills (docs/15): a real radio group, one tab stop,
 * arrows move and select, and the chosen pill carries a check icon and a
 * stronger fill, never colour alone. "Not informed" is an option of its own,
 * so clearing the value is a choice and not a hidden reset.
 */
export function ProfileChoiceField<T extends string>({
  hint,
  label,
  noneLabel,
  onChange,
  options,
  testID,
  value,
}: {
  hint?: string;
  label: string;
  noneLabel: string;
  onChange: (value: T | null) => void;
  options: readonly { label: string; value: T }[];
  testID?: string;
  value: T | null | undefined;
}) {
  const { colors } = useTheme();
  const layer = useSurfaceLayer();
  const fieldId = useId().replace(/[^A-Za-z0-9_-]/gu, '');
  const labelId = `profile-choice-${fieldId}-label`;
  const hintId = `profile-choice-${fieldId}-hint`;
  const radios = useRef<(View | null)[]>([]);
  const choices: Option<T>[] = [...options, { label: noneLabel, value: null }];
  const current = value ?? null;
  const checkedIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.value === current),
  );

  const select = (index: number) => {
    const choice = choices[(index + choices.length) % choices.length];
    if (choice === undefined) return;
    onChange(choice.value);
    radios.current[choices.indexOf(choice)]?.focus();
  };
  const keyboard = (index: number) =>
    Platform.OS === 'web'
      ? ({
          onKeyDown: (event: { key: string; preventDefault: () => void }) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
              event.preventDefault();
              select(index + 1);
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
              event.preventDefault();
              select(index - 1);
            } else if (event.key === ' ' || event.key === 'Spacebar') {
              event.preventDefault();
              select(index);
            }
          },
        } as object)
      : {};

  return (
    <View
      aria-describedby={hint === undefined ? undefined : hintId}
      aria-labelledby={labelId}
      role="radiogroup"
      style={styles.group}
      testID={testID}
    >
      <Text nativeID={labelId} style={[styles.label, { color: colors.text }]}>
        {label}
      </Text>
      {hint === undefined ? null : (
        <Text nativeID={hintId} style={[styles.hint, { color: colors.textMuted }]}>
          {hint}
        </Text>
      )}
      <View style={styles.options}>
        {choices.map((choice, index) => {
          const checked = choice.value === current;
          const tint = checked ? colors.onPrimary : colors.text;
          return (
            <Pressable
              accessibilityLabel={choice.label}
              accessibilityRole="radio"
              accessibilityState={{ checked }}
              aria-checked={checked}
              key={choice.value ?? 'none'}
              onPress={() => select(index)}
              ref={(instance) => {
                radios.current[index] = instance;
              }}
              role="radio"
              style={({ pressed }) => [
                styles.pill,
                {
                  backgroundColor: checked
                    ? colors.indicator
                    : layer === 'raised'
                      ? colors.background
                      : colors.surfaceRaised,
                  borderColor: checked ? colors.indicator : colors.fieldBorder,
                  opacity: pressed ? 0.82 : 1,
                },
              ]}
              tabIndex={index === checkedIndex ? 0 : -1}
              {...keyboard(index)}
            >
              {checked ? <AppIcon color={tint} name="check" size={18} /> : null}
              <Text
                style={[
                  checked ? styles.pillTextChecked : styles.pillText,
                  { color: tint },
                  choice.value === null && !checked ? { color: colors.textMuted } : null,
                ]}
              >
                {choice.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.xs, minWidth: 0, width: '100%' },
  hint: { ...typography.support },
  label: { ...typography.supportStrong },
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    minWidth: 0,
    paddingTop: spacing.xs,
    width: '100%',
  },
  pill: {
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.xs + 2,
    justifyContent: 'center',
    minHeight: size.target,
    minWidth: size.target,
    paddingHorizontal: spacing.md,
  },
  pillText: { ...typography.supportStrong },
  pillTextChecked: { ...typography.supportStrong, ...face('bold') },
});
