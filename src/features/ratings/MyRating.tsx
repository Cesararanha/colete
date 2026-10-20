import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppIcon } from '@/components/ui/AppIcon';
import { Chip } from '@/components/ui/Chip';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { unratedCount } from './rating-format';
import { useGroupRatings, useMyRating } from './rating-queries';

/**
 * "Minha nota" in the group detail (docs/11 screen 11): the own rating,
 * always visible to its holder whatever the visibility. The organization also
 * gets "Avaliar jogadores", with how many members still have no rating.
 */
export function MyRating({
  canOrganize,
  groupId,
  profileId,
}: {
  canOrganize: boolean;
  groupId: string;
  profileId: string;
}) {
  const { colors } = useTheme();
  const mine = useMyRating(profileId, groupId);
  const board = useGroupRatings(profileId, groupId, canOrganize);
  const stars = mine.data?.stars ?? null;
  const missing = unratedCount(board.data?.members);
  return (
    <View style={styles.section} testID="group-my-rating">
      <Text aria-level={2} role="heading" style={[styles.title, { color: colors.text }]}>
        {pt.ratings.mine}
      </Text>
      {mine.data ? (
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          <AppIcon color={stars === null ? colors.textMuted : colors.digit} name="star" size={20} />
          <Text style={[styles.body, { color: colors.text }]} testID="group-my-rating-value">
            {stars === null ? pt.ratings.myNone : pt.ratings.myStars(stars)}
          </Text>
        </View>
      ) : null}
      {canOrganize ? (
        <View style={styles.organize}>
          <AppButton
            icon="star"
            label={pt.ratings.open}
            onPress={() => router.push(`/grupos/${groupId}/notas`)}
            testID="group-ratings-link"
            variant="outline"
          />
          {board.data && missing > 0 ? (
            <Chip label={pt.ratings.unrated(missing)} testID="group-unrated" tone="warning" />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { ...typography.body, flex: 1, minWidth: 0 },
  card: {
    alignItems: 'center',
    borderRadius: radius.field + 2,
    flexDirection: 'row',
    gap: spacing.ms,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  organize: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.ms },
  section: { gap: 14 },
  title: { ...typography.section },
});
