import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { pt } from '@/lib/i18n/pt';
import { readProblem, refreshFailed, updatedAt, type LiveQuery } from '@/lib/live-refresh';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { AppButton } from './AppButton';
import { AsyncNotice } from './AsyncNotice';

/**
 * HX-003: when the screen last read, and "Atualizar" to read now. The screen
 * also reads by itself every 30 s while in front (useLiveInterval) and, coming
 * back to the front, reads at once whatever went stale meanwhile. A read that
 * fails over data already shown is said here, not in the large notice
 * (rev89 P3-2).
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
  const readNow = () => refresh?.() ?? Promise.all(queries.map((query) => query.refetch()));
  // The focus callback stays stable, so it runs only when the screen comes to
  // the front (not each time a read goes stale); it reads the latest render here.
  const stale = queries.some((query) => query.dataUpdatedAt > 0 && query.isStale);
  const latest = useRef({ readNow, stale });
  useEffect(() => {
    latest.current = { readNow, stale };
  });
  useFocusEffect(
    useCallback(() => {
      if (latest.current.stale) void latest.current.readNow();
    }, []),
  );

  const time = updatedAt(queries);
  if (time === undefined) return null;
  const fetching = queries.some((query) => query.isFetching);
  // A failed read stays in error while the next ones are tried, so the failure
  // holds through "Atualizando…" until a read succeeds.
  const failing = refreshFailed(queries);
  const failed = !fetching && failing;
  return (
    <View style={styles.row} testID={testID}>
      {/* Always mounted, with the same text for the whole failure: it is said once,
          when the failure begins, and not again at each 30 s try (conf89 N2). */}
      <Text role="status" style={styles.visuallyHidden} testID={`${testID}-announcement`}>
        {failing ? pt.common.refreshFailedAnnouncement : ''}
      </Text>
      {failed ? (
        <Text style={[styles.time, { color: colors.critical }]} testID={`${testID}-time`}>
          {pt.common.refreshFailed(time)}
        </Text>
      ) : (
        <Text style={[styles.time, { color: colors.textMuted }]} testID={`${testID}-time`}>
          {fetching ? pt.common.refreshing : pt.common.updatedAt(time)}
        </Text>
      )}
      <AppButton
        accessibilityLabel={pt.common.refreshLabel}
        compact
        icon="refresh-cw"
        label={pt.common.refresh}
        onPress={() => void readNow()}
        testID={`${testID}-button`}
        variant="tertiary"
      />
    </View>
  );
}

/**
 * The large notice of a failed read (rev89 P3-1 and P3-2): the session one
 * whenever the server refused the session, so the person knows to sign in
 * again; the network one only when the screen has nothing to show yet.
 */
export function ReadNotice({
  query,
}: {
  query: Pick<LiveQuery, 'data' | 'error' | 'isError' | 'refetch'>;
}) {
  const problem = readProblem(query);
  if (problem === undefined) return null;
  const session = problem === 'session';
  return (
    <AsyncNotice
      action={() => void query.refetch()}
      actionLabel={pt.common.retry}
      kind="network"
      message={session ? pt.common.sessionBody : pt.common.networkBody}
      title={session ? pt.common.sessionTitle : pt.common.networkTitle}
    />
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
  time: { ...typography.support, flexShrink: 1 },
  visuallyHidden: {
    height: 1,
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    top: 0,
    width: 1,
  },
});
