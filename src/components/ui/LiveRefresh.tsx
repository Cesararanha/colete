import { StyleSheet, Text, View } from 'react-native';

import { pt } from '@/lib/i18n/pt';
import { updatedAt, type LiveQuery } from '@/lib/live-refresh';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { AppButton } from './AppButton';

/**
 * HX-003: when the screen last read, and "Atualizar" to read now. The screen
 * also reads by itself every LIVE_REFRESH_MS while in front.
 */
export function LiveRefresh({
  queries,
  refresh,
  testID,
}: {
  queries: readonly LiveQuery[];
  /** Reads more than `queries` (the match detail also reads the teams). */
  refresh?: (() => Promise<unknown>) | undefined;
  testID: string;
}) {
  const { colors } = useTheme();
  const time = updatedAt(queries);
  if (time === undefined) return null;
  const fetching = queries.some((query) => query.isFetching);
  return (
    <View style={styles.row} testID={testID}>
      <Text style={[styles.time, { color: colors.textMuted }]} testID={`${testID}-time`}>
        {fetching ? pt.common.refreshing : pt.common.updatedAt(time)}
      </Text>
      <AppButton
        accessibilityLabel={pt.common.refreshLabel}
        compact
        icon="refresh-cw"
        label={pt.common.refresh}
        onPress={() =>
          void (refresh ? refresh() : Promise.all(queries.map((query) => query.refetch())))
        }
        testID={`${testID}-button`}
        variant="tertiary"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  time: { ...typography.support },
});
