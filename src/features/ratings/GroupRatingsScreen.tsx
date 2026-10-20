import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { Chip } from '@/components/ui/Chip';
import { AppError, api, type MemberRating, type OwnProfile, type RatingOutcome } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, spacing } from '@/theme/spacing';
import { face, typography } from '@/theme/typography';

import { PhotoAvatar } from '../photos/PhotoAvatar';
import { ratingErrorMessage } from './rating-errors';
import { changedOn, unratedCount } from './rating-format';
import { useGroupRatings } from './rating-queries';
import { RatingPicker } from './RatingPicker';
import { useRatingActions } from './useRatingActions';

function MemberCard({
  actions,
  groupId,
  index,
  member,
  self,
}: {
  actions: ReturnType<typeof useRatingActions>;
  groupId: string;
  index: number;
  member: MemberRating;
  self: boolean;
}) {
  const { colors } = useTheme();
  // Only a choice the person made is a draft (rev83, BB-003): an untouched
  // card follows the current rating, also after another session changed it.
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? member.stars;
  const [message, setMessage] = useState('');
  const key = `rate:${member.profile_id}:${value ?? ''}`;
  const changed = draft !== null && draft !== member.stars;
  const pending = actions.pending === key;
  const error = actions.error?.key.startsWith(`rate:${member.profile_id}:`)
    ? ratingErrorMessage(actions.error.error)
    : '';
  const testID = `rating-member-${index}`;
  const save = () => {
    if (draft === null || actions.pending !== null) return;
    const stars = draft;
    setMessage('');
    void actions
      .run<RatingOutcome>(key, () => api.setRating(groupId, member.profile_id, stars))
      .then((result) => {
        if (!result) return;
        setDraft((current) => (current === stars ? null : current));
        setMessage(
          result.outcome.logical_result === 'rating_unchanged'
            ? pt.ratings.unchanged(member.display_name)
            : pt.ratings.saved(member.display_name, stars),
        );
      });
  };
  return (
    <View
      role="listitem"
      style={[styles.card, { backgroundColor: colors.surface }]}
      testID={testID}
    >
      <View style={styles.head}>
        <PhotoAvatar id={member.profile_id} name={member.display_name} size={40} />
        <View style={styles.who}>
          <Text style={[styles.name, { color: colors.text }]}>
            {member.display_name}
            {self ? (
              <Text style={[styles.self, { color: colors.textMuted }]}> · {pt.ratings.you}</Text>
            ) : null}
          </Text>
          {member.changed_at ? (
            <Text
              style={[styles.caption, { color: colors.textMuted }]}
              testID={`${testID}-changed`}
            >
              {pt.ratings.changedBy(
                member.changed_by_removed || !member.changed_by_name
                  ? pt.ratings.removedAuthor
                  : member.changed_by_name,
                changedOn(member.changed_at),
              )}
            </Text>
          ) : null}
        </View>
        <Chip
          {...(member.stars === null ? {} : { icon: 'star' as const })}
          label={member.stars === null ? pt.ratings.none : pt.ratings.current(member.stars)}
          testID={`${testID}-stars`}
          tone={member.stars === null ? 'warning' : 'neutral'}
        />
      </View>
      <RatingPicker
        label={pt.ratings.groupLabel(member.display_name)}
        onChange={(stars) => {
          setDraft(stars);
          setMessage('');
          actions.clearError();
        }}
        testID={`${testID}-picker`}
        value={value}
      />
      {/* The live regions stay mounted, empty, so a result is announced; together they take one gap. */}
      <View>
        <AppStatus message={message} testID={`${testID}-result`} />
        <AppAlert message={error} testID={`${testID}-error`} />
      </View>
      {changed ? (
        <View style={styles.save}>
          <AppButton
            ariaDisabled={actions.pending !== null}
            compact
            label={pending ? pt.ratings.saving : pt.ratings.save}
            onPress={save}
            testID={`${testID}-save`}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Screen 21 of docs/11, the pilot's cut (0031): every active member with the
 * current rating, who changed it last and when, and the 1–5 choice. The ones
 * still without a rating come first, with the count on top, because the draw
 * will not run without them. The visibility notice says who else sees them.
 */
export function GroupRatingsScreen({ groupId, profile }: { groupId: string; profile: OwnProfile }) {
  const { colors } = useTheme();
  const ratings = useGroupRatings(profile.id, groupId);
  const actions = useRatingActions(profile.id, groupId);
  // A refusal that ends the authority (removed, or the group is gone) drops the
  // projection read while it lasted (rev83, BB-004), not only its controls.
  const lost =
    ratings.error instanceof AppError &&
    (ratings.error.code === 'NOT_MEMBER' || ratings.error.code === 'NOT_FOUND');
  const data = lost ? undefined : ratings.data;
  const members = data?.can_rate ? (data.members ?? []) : [];
  const missing = unratedCount(members);
  return (
    <AuthenticatedShell
      {...pt.ratings}
      back={{ label: pt.ratings.back, href: `/grupos/${groupId}`, testID: 'ratings-back' }}
    >
      {ratings.isPending ? <AsyncNotice kind="loading" message={pt.common.loading} /> : null}
      {ratings.isError ? (
        <AppAlert message={ratingErrorMessage(ratings.error)} testID="ratings-error" />
      ) : null}
      {data && !data.can_rate ? (
        <AppAlert message={pt.ratings.errors.notOrganizer} testID="ratings-not-organizer" />
      ) : null}
      {data?.can_rate ? (
        <>
          <View style={styles.top}>
            <Text style={[styles.notice, { color: colors.textSoft }]} testID="ratings-visibility">
              {data.visibility === 'members' ? pt.ratings.membersNotice : pt.ratings.privateNotice}
            </Text>
            {missing > 0 ? (
              <Chip
                icon="alert-triangle"
                label={pt.ratings.missing(missing)}
                testID="ratings-missing"
                tone="warning"
              />
            ) : (
              <Chip
                icon="check"
                label={pt.ratings.allRated}
                testID="ratings-missing"
                tone="positive"
              />
            )}
          </View>
          <View role="list" style={styles.list}>
            {members.map((member, index) => (
              <MemberCard
                actions={actions}
                groupId={groupId}
                index={index}
                key={member.profile_id}
                member={member}
                self={member.profile_id === profile.id}
              />
            ))}
          </View>
        </>
      ) : null}
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  caption: { ...typography.caption },
  card: {
    borderRadius: radius.field + 2,
    gap: spacing.ms,
    paddingHorizontal: spacing.ms,
    paddingVertical: spacing.ms,
  },
  head: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.ms },
  list: { gap: spacing.ms },
  name: { ...typography.bodyStrong, fontSize: 16, lineHeight: 22 },
  notice: { ...typography.support },
  save: { alignItems: 'flex-start' },
  self: { ...face('regular') },
  top: { alignItems: 'flex-start', gap: spacing.sm },
  who: { flex: 1, gap: 2, minWidth: 0 },
});
