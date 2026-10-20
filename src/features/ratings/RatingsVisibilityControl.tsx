import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { api, type GroupOutcome, type RatingsVisibility } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { focusGroupControl, GroupConfirmation } from '../groups/GroupConfirmation';
import { ratingErrorMessage } from './rating-errors';
import { useGroupRatings } from './rating-queries';
import { useRatingActions } from './useRatingActions';

const CHOICES: readonly RatingsVisibility[] = ['private', 'members'];

/**
 * The owner's choice of who sees the ratings (docs/11 screen 25, 0016's
 * set_ratings_visibility): private by default, or the current ratings to the
 * active members. Showing them asks first, in place, with what changes;
 * making them private again does not.
 */
export function RatingsVisibilityControl({
  groupId,
  profileId,
}: {
  groupId: string;
  profileId: string;
}) {
  const { colors } = useTheme();
  const ratings = useGroupRatings(profileId, groupId);
  const actions = useRatingActions(profileId, groupId);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('');
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!confirming && restoreFocus.current) {
      restoreFocus.current = false;
      focusGroupControl('ratings-visibility-members');
    }
  }, [confirming]);
  const current = ratings.data?.visibility;
  if (current === undefined) return null;
  const apply = (visibility: RatingsVisibility) => {
    setMessage('');
    void actions
      .run<GroupOutcome>(`visibility:${visibility}`, () =>
        api.setRatingsVisibility(groupId, visibility),
      )
      .then((result) => {
        setConfirming(false);
        if (result) setMessage(pt.ratings.visibilitySaved(visibility));
      });
  };
  return (
    <View style={styles.section} testID="ratings-visibility-control">
      <Text aria-level={2} role="heading" style={[styles.heading, { color: colors.text }]}>
        {pt.ratings.visibility}
      </Text>
      <View style={styles.choices}>
        {CHOICES.map((choice) => (
          <AppButton
            compact
            key={choice}
            label={choice === 'members' ? pt.ratings.members : pt.ratings.private}
            onPress={() => {
              if (actions.pending !== null || choice === current) return;
              actions.clearError();
              if (choice === 'members') setConfirming(true);
              else apply('private');
            }}
            pressed={current === choice}
            testID={`ratings-visibility-${choice}`}
            variant="outline"
          />
        ))}
      </View>
      <AppStatus message={message} testID="ratings-visibility-result" />
      <AppAlert
        message={actions.error ? ratingErrorMessage(actions.error.error) : ''}
        testID="ratings-visibility-error"
      />
      {confirming ? (
        <GroupConfirmation title={pt.ratings.showTitle} testID="ratings-visibility-confirmation">
          <Text style={[styles.body, { color: colors.text }]}>{pt.ratings.showBody}</Text>
          <View style={styles.choices}>
            <AppButton
              ariaDisabled={actions.pending !== null}
              label={pt.ratings.showConfirm}
              onPress={() => {
                if (actions.pending === null) apply('members');
              }}
              testID="ratings-visibility-confirm"
            />
            <AppButton
              label={pt.ratings.keep}
              onPress={() => {
                if (actions.pending !== null) return;
                restoreFocus.current = true;
                setConfirming(false);
              }}
              testID="ratings-visibility-keep"
              variant="secondary"
            />
          </View>
        </GroupConfirmation>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { ...typography.body },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  heading: { ...typography.title },
  section: { gap: spacing.sm },
});
