import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { api, type MatchRoster, type MatchRosterEntry } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

import { focusGroupControl, GroupConfirmation } from '../groups/GroupConfirmation';
import { matchErrorMessage } from './match-errors';
import { entryName } from './roster-entry';
import { useMatchActions } from './useMatchActions';

export function AddMatchPlayer({
  groupId,
  matchId,
  profileId,
  roster,
  onFeedback,
}: {
  groupId: string;
  matchId: string;
  profileId: string;
  roster: MatchRoster;
  onFeedback: (error: unknown) => void;
}) {
  const { colors } = useTheme();
  const actions = useMatchActions(profileId, { groupId, onRefusal: onFeedback });
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const restore = useRef(false);
  const enabled = roster.viewer.can_manage && !roster.started && !roster.canceled;
  const members = useQuery({
    enabled: enabled && open,
    queryKey: [PRIVATE_QUERY_ROOT, 'group-members', profileId, groupId],
    queryFn: ({ signal }) => api.getGroupMembers(groupId, signal),
    staleTime: 0,
  });
  useEffect(() => {
    if (!open && restore.current && !actions.pending) {
      restore.current = false;
      focusGroupControl('match-add-player');
    }
  }, [open, actions.pending]);
  if (!enabled) return null;
  const listed = new Set([...roster.confirmed, ...roster.waitlist].map((p) => p.profile_id));
  const available =
    (members.isSuccess ? members.data : [])?.filter(
      (p) => p.status === 'active' && !listed.has(p.profile_id),
    ) ?? [];
  return (
    <View style={styles.section}>
      <AppButton
        label={pt.matchPlayers.add}
        ariaDisabled={actions.pending}
        testID="match-add-player"
        variant="outline"
        onPress={() => {
          if (actions.pending) return;
          actions.clearError();
          actions.discardIntent();
          setMessage('');
          onFeedback(null);
          setOpen(true);
        }}
      />
      <AppStatus message={message} testID="match-add-result" />
      {open ? (
        <GroupConfirmation title={pt.matchPlayers.choose} testID="match-add-picker">
          <Text style={{ color: colors.text }}>{pt.matchPlayers.queueRule}</Text>
          {members.isPending ? (
            <Text style={{ color: colors.text }}>{pt.common.loading}</Text>
          ) : null}
          {members.isError ? (
            <>
              <AppAlert message={matchErrorMessage(members.error)} testID="match-members-error" />
              <AppButton label={pt.common.retry} onPress={() => void members.refetch()} />
            </>
          ) : null}
          {members.isSuccess && available.length === 0 ? (
            <Text style={{ color: colors.text }}>{pt.matchPlayers.empty}</Text>
          ) : null}
          {available.map((member) => (
            <AppButton
              key={member.profile_id}
              ariaDisabled={actions.pending}
              label={member.display_name}
              testID={`match-add-${member.profile_id}`}
              variant="outline"
              onPress={() => {
                if (actions.pending) return;
                onFeedback(null);
                void actions
                  .run(`add:${member.profile_id}`, () => api.addPlayer(matchId, member.profile_id))
                  .then((result) => {
                    if (!result) {
                      focusGroupControl('match-refresh-button');
                      return;
                    }
                    restore.current = true;
                    setOpen(false);
                    setMessage(
                      result.outcome.logical_result === 'player_waitlisted'
                        ? pt.matchPlayers.waitlisted
                        : result.outcome.logical_result === 'player_add_unchanged'
                          ? pt.matchPlayers.unchanged
                          : pt.matchPlayers.added,
                    );
                  });
              }}
            />
          ))}
          <AppButton
            ariaDisabled={actions.pending}
            label={pt.matches.detail.cancel}
            testID="match-add-cancel"
            variant="secondary"
            onPress={() => {
              if (actions.pending) return;
              restore.current = true;
              setOpen(false);
              actions.clearError();
              actions.discardIntent();
            }}
          />
        </GroupConfirmation>
      ) : null}
    </View>
  );
}

export function RemoveMatchPlayer({
  entry,
  matchId,
  profileId,
  hasTeams,
  groupId,
  onFeedback,
}: {
  entry: MatchRosterEntry;
  matchId: string;
  profileId: string;
  hasTeams: boolean;
  groupId: string;
  onFeedback: (error: unknown) => void;
}) {
  const { colors } = useTheme();
  const actions = useMatchActions(profileId, { groupId, onRefusal: onFeedback });
  const [confirming, setConfirming] = useState(false);
  const restore = useRef(false);
  const removing = useRef(false);
  useEffect(
    () => () => {
      if (removing.current) focusGroupControl('match-refresh-button');
    },
    [],
  );
  const id = `match-remove-${entry.profile_id}`;
  useEffect(() => {
    if (!confirming && restore.current && !actions.pending) {
      restore.current = false;
      focusGroupControl(id);
    }
  }, [confirming, actions.pending, id]);
  if (entry.profile_id === null || entry.account_removed) return null;
  if (entry.is_viewer)
    return <Text style={{ color: colors.textMuted }}>{pt.matchPlayers.self}</Text>;
  return (
    <View style={styles.section}>
      {confirming ? (
        <GroupConfirmation
          title={pt.matchPlayers.confirmTitle(entryName(entry))}
          testID={`${id}-confirmation`}
        >
          <Text style={{ color: colors.text }}>
            {entry.paid !== undefined
              ? pt.matchPlayers.confirmBody
              : pt.matchPlayers.confirmWaitlist}
          </Text>
          {entry.paid ? (
            <Text style={{ color: colors.text }}>{pt.matchPlayers.paidWarning}</Text>
          ) : null}
          {hasTeams ? (
            <Text style={{ color: colors.text }}>{pt.matchPlayers.teamsWarning}</Text>
          ) : null}
          <AppButton
            ariaDisabled={actions.pending}
            label={pt.matchPlayers.confirm}
            testID={`${id}-confirm`}
            variant="destructive"
            onPress={() => {
              if (actions.pending) return;
              onFeedback(null);
              removing.current = true;
              void actions
                .run(`remove:${entry.profile_id}`, () =>
                  api.removePlayer(matchId, entry.profile_id!),
                )
                .then(() => {
                  focusGroupControl('match-refresh-button');
                });
            }}
          />
          <AppButton
            ariaDisabled={actions.pending}
            label={pt.matches.detail.cancel}
            testID={`${id}-cancel`}
            variant="secondary"
            onPress={() => {
              if (actions.pending) return;
              restore.current = true;
              setConfirming(false);
              actions.clearError();
              actions.discardIntent();
            }}
          />
        </GroupConfirmation>
      ) : (
        <AppButton
          label={pt.matchPlayers.remove}
          accessibilityLabel={pt.matchPlayers.confirmTitle(entryName(entry))}
          testID={id}
          variant="outline-destructive"
          onPress={() => {
            actions.clearError();
            actions.discardIntent();
            onFeedback(null);
            setConfirming(true);
          }}
        />
      )}
    </View>
  );
}
const styles = StyleSheet.create({ section: { gap: spacing.sm, minWidth: 0, width: '100%' } });
