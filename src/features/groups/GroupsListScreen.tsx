import { useQuery } from '@tanstack/react-query';
import { Link, router } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppIcon } from '@/components/ui/AppIcon';
import { AuthenticatedListShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { Scoreboard } from '@/components/ui/Scoreboard';
import { api, type OwnProfile } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT, withCurrentAccessToken } from '@/lib/private-queries';
import { useReducedMotion } from '@/theme/motion';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, size, spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { MAX_ACTIVE_GROUPS } from './group-limits';
import { roleIcon, roleName } from './group-roles';

type ListedGroup =
  | { kind: 'group'; id: string; name: string; role: string }
  | { kind: 'pending'; id: string; name: string };

/** A request still waiting for approval: shown, but it opens nothing. */
function PendingRow({ name }: { name: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={[styles.row, styles.pendingRow, { backgroundColor: colors.surface }]}
      testID="pending-group-card"
    >
      <View style={styles.rowText}>
        <Text aria-level={2} role="heading" style={[styles.rowName, { color: colors.text }]}>
          {name}
        </Text>
        <View style={styles.meta}>
          <AppIcon color={colors.warning} name="clock" size={16} />
          <Text style={[styles.metaText, styles.metaStrong, { color: colors.warning }]}>
            {pt.groups.list.pending}
          </Text>
        </View>
        <Text style={[styles.body, { color: colors.textMuted }]}>{pt.groups.join.pendingBody}</Text>
      </View>
    </View>
  );
}

/** One group: the whole row opens it. Name, role (icon + text) and a chevron. */
function GroupRow({ id, name, role }: { id: string; name: string; role: string }) {
  const { colors } = useTheme();
  const reducedMotion = useReducedMotion();
  return (
    <Link asChild href={`/grupos/${id}`}>
      <Pressable
        accessibilityLabel={pt.groups.list.view(name)}
        accessibilityRole="link"
        style={styles.rowTarget}
        testID="group-list-card"
      >
        {({ pressed }) => (
          <View
            style={[
              styles.row,
              {
                backgroundColor: colors.surfaceRaised,
                opacity: pressed ? 0.86 : 1,
                transform: [{ scale: pressed && !reducedMotion ? 0.99 : 1 }],
              },
              Platform.OS === 'web'
                ? ({
                    transitionDuration: pressed ? '100ms' : '160ms',
                    transitionProperty: 'transform, opacity',
                  } as ViewStyle)
                : null,
            ]}
          >
            <View style={styles.rowText}>
              <Text aria-level={2} role="heading" style={[styles.rowName, { color: colors.text }]}>
                {name}
              </Text>
              <View style={styles.meta}>
                <AppIcon color={colors.textMuted} name={roleIcon(role)} size={16} />
                <Text style={[styles.metaText, { color: colors.textMuted }]}>
                  {roleName(role, pt.groups.list.player)}
                </Text>
              </View>
            </View>
            <AppIcon color={colors.textMuted} name="chevron-right" size={24} />
          </View>
        )}
      </Pressable>
    </Link>
  );
}

export function GroupsListScreen({
  left,
  profile,
  requested,
}: {
  left?: boolean;
  profile: OwnProfile;
  requested?: boolean;
}) {
  const { colors } = useTheme();
  const listing = useQuery({
    queryKey: [PRIVATE_QUERY_ROOT, 'groups', profile.id],
    queryFn: () =>
      withCurrentAccessToken(async (token) => {
        const [groups, pending] = await Promise.all([
          api.getOwnGroups(profile.id, token),
          api.getMyPendingGroupRequests(),
        ]);
        return { groups, pending };
      }),
  });
  const actions = (
    <View style={styles.actions}>
      <AppButton
        icon="plus"
        label={pt.groups.list.create}
        onPress={() => router.push('/grupos/criar')}
      />
      <AppButton
        icon="hash"
        label={pt.groups.list.join}
        onPress={() => router.push('/join')}
        variant="tertiary"
      />
    </View>
  );
  // docs/29 §5: active groups are the size of getOwnGroups (active memberships
  // only); the limit is the D6 constant. Pending requests never count.
  const activeGroups = listing.data?.groups.length;
  const hero =
    activeGroups === undefined ? undefined : (
      <View style={styles.hero}>
        <Text aria-hidden style={[styles.overline, { color: colors.onBandMuted }]}>
          {pt.groups.list.activeOverline}
        </Text>
        <Scoreboard
          accessibilityLabel={pt.groups.list.activeCount(activeGroups, MAX_ACTIVE_GROUPS)}
          groups={[
            { chars: String(activeGroups).padStart(2, '0') },
            { chars: String(MAX_ACTIVE_GROUPS).padStart(2, '0'), reference: true },
          ]}
          testID="groups-scoreboard"
        />
      </View>
    );
  const rows: ListedGroup[] = listing.data
    ? [
        ...listing.data.groups.map((group) => ({ kind: 'group' as const, ...group })),
        ...listing.data.pending.map((pending) => ({
          kind: 'pending' as const,
          id: pending.group_id,
          name: pending.group_name,
        })),
      ]
    : [];
  const empty = listing.data !== undefined && rows.length === 0;
  return (
    <AuthenticatedListShell
      data={rows}
      footer={
        rows.length > 0 ? (
          actions
        ) : empty ? (
          <AppButton
            icon="hash"
            label={pt.groups.list.join}
            onPress={() => router.push('/join')}
            variant="tertiary"
          />
        ) : undefined
      }
      hero={hero}
      keyExtractor={(row) => `${row.kind}:${row.id}`}
      renderItem={(row) =>
        row.kind === 'group' ? (
          <GroupRow id={row.id} name={row.name} role={row.role} />
        ) : (
          <PendingRow name={row.name} />
        )
      }
      title={pt.groups.list.title}
    >
      {left ? <AppStatus message={pt.groups.detail.left} testID="group-left-status" /> : null}
      {requested ? (
        <AppStatus message={pt.groups.list.requestSent} testID="group-request-sent" />
      ) : null}
      {listing.isPending ? <AsyncNotice kind="loading" message={pt.common.loading} /> : null}
      {listing.isError ? (
        <AsyncNotice
          kind="network"
          title={pt.common.networkTitle}
          message={pt.common.networkBody}
          actionLabel={pt.common.retry}
          action={() => void listing.refetch()}
        />
      ) : null}
      {empty ? (
        <AsyncNotice
          kind="empty"
          title={pt.groups.list.emptyTitle}
          message={pt.groups.list.emptyBody}
          actionLabel={pt.groups.list.create}
          action={() => router.push('/grupos/criar')}
        />
      ) : null}
    </AuthenticatedListShell>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm },
  body: { ...typography.support },
  hero: { gap: spacing.ms },
  meta: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  metaStrong: { ...typography.supportStrong },
  metaText: { ...typography.support, flexShrink: 1 },
  overline: { ...typography.overline },
  pendingRow: { alignItems: 'flex-start' },
  row: {
    alignItems: 'center',
    borderRadius: radius.row,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: size.row + spacing.ms,
    paddingLeft: spacing.lg,
    paddingRight: spacing.md,
    paddingVertical: spacing.md,
  },
  rowName: { ...typography.row },
  rowTarget: { borderRadius: radius.row },
  rowText: { flex: 1, gap: spacing.xs, minWidth: 0 },
});
