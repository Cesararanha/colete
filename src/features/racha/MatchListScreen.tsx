import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { pt } from '@/lib/i18n/pt';
import { getLayoutMode } from '@/theme/layout';
import { spacing } from '@/theme/spacing';

import { demoMatches, type DemoMatch } from './demo-data';
import { EmptyMatches } from './EmptyMatches';
import { MatchCard } from './MatchCard';

const openMatch = (match: DemoMatch) => {
  if (match.situation === 'teams_published') {
    router.push({ pathname: '/rachas/[id]/times', params: { id: match.id } });
    return;
  }
  router.push({ pathname: '/rachas/[id]', params: { id: match.id } });
};

export function MatchListScreen() {
  const { demo } = useLocalSearchParams<{ demo?: string | string[] }>();
  const { width } = useWindowDimensions();
  const wide = getLayoutMode(width) === 'wide';
  const reducedMotion = useReducedMotion();
  const demoMode = Array.isArray(demo) ? demo[0] : demo;
  const matches =
    demoMode === 'vazio'
      ? []
      : [...demoMatches].sort((left, right) => left.startsAt.localeCompare(right.startsAt));

  return (
    <AuthenticatedShell
      description={pt.racha.list.description}
      eyebrow={pt.racha.list.eyebrow}
      title={pt.racha.list.title}
    >
      {matches.length === 0 ? (
        <EmptyMatches />
      ) : (
        <View
          accessibilityLabel={pt.racha.list.timelineLabel}
          style={[styles.timeline, wide ? styles.timelineWide : styles.timelineNarrow]}
        >
          {matches.map((match, index) => (
            <Animated.View
              key={match.id}
              {...(!reducedMotion ? { entering: FadeInDown.delay(index * 80).duration(360) } : {})}
            >
              <MatchCard match={match} onAction={() => openMatch(match)} />
            </Animated.View>
          ))}
        </View>
      )}
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  timeline: {
    alignSelf: 'stretch',
  },
  timelineNarrow: {
    gap: spacing.md,
  },
  timelineWide: {
    gap: spacing.lg,
  },
});
