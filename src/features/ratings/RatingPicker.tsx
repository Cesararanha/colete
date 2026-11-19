import { useRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type ViewInstance } from 'react-native';

import { AppIcon } from '@/components/ui/AppIcon';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { face } from '@/theme/typography';

const STARS = [1, 2, 3, 4, 5] as const;

/**
 * The 1–5 choice of one member's rating (docs/11 screen 21): a real radio
 * group with one tab stop, arrows move and choose, and the chosen value
 * carries a check and the stronger fill, never colour alone (docs/15). The
 * choice is a draft: nothing is saved until "Salvar nota", so arrowing across
 * the values never sends a rating per step.
 */
export function RatingPicker({
  label,
  onChange,
  testID,
  value,
}: {
  label: string;
  onChange: (stars: number) => void;
  testID: string;
  value: number | null;
}) {
  const { colors } = useTheme();
  const radios = useRef<(ViewInstance | null)[]>([]);
  const focusIndex = value === null ? 0 : value - 1;
  const select = (index: number) => {
    const next = ((index % STARS.length) + STARS.length) % STARS.length;
    onChange(STARS[next] ?? 1);
    radios.current[next]?.focus();
  };
  const keyboard = (index: number) =>
    Platform.OS === 'web'
      ? ({
          onKeyDown: (event: { key: string; preventDefault: () => void }) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
              event.preventDefault();
              select(index + 1);
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
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
    <View aria-label={label} role="radiogroup" style={styles.group} testID={testID}>
      {STARS.map((stars, index) => {
        const checked = value === stars;
        const tint = checked ? colors.onPrimary : colors.text;
        return (
          <Pressable
            accessibilityLabel={pt.ratings.starsLabel(stars)}
            accessibilityRole="radio"
            accessibilityState={{ checked }}
            aria-checked={checked}
            key={stars}
            onPress={() => select(index)}
            ref={(instance) => {
              radios.current[index] = instance;
            }}
            role="radio"
            style={({ pressed }) => [
              styles.pill,
              {
                backgroundColor: checked ? colors.indicator : colors.surfaceRaised,
                borderColor: checked ? colors.indicator : colors.fieldBorder,
                opacity: pressed ? 0.82 : 1,
              },
            ]}
            tabIndex={index === focusIndex ? 0 : -1}
            testID={`${testID}-${stars}`}
            {...keyboard(index)}
          >
            <AppIcon color={tint} name={checked ? 'check' : 'star'} size={16} />
            <Text style={[styles.number, { color: tint }]}>{stars}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, minWidth: 0 },
  number: { ...face('condensed'), fontSize: 20, lineHeight: 24 },
  pill: {
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.xs,
    justifyContent: 'center',
    minHeight: size.target,
    minWidth: 56,
    paddingHorizontal: spacing.ms,
  },
});
