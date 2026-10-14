import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppIcon } from '@/components/ui/AppIcon';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { Scoreboard } from '@/components/ui/Scoreboard';
import { SectionHeading } from '@/components/ui/SectionHeading';
import {
  AppError,
  TransportError,
  api,
  type GroupInvite,
  type GroupOutcome,
  type InviteShare,
  type MutationIntent,
  type OwnProfile,
} from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT, withCurrentAccessToken } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { absoluteInviteTime, groupErrorMessage } from './group-errors';
import { InviteQrCode } from './InviteQrCode';

// Revocation and use counts are server projections. The sensitive share read
// decides expiry using the server clock; this screen never compares Date.now().
function candidateInvite(invite: GroupInvite): boolean {
  return invite.revoked_at === null && invite.used_count < invite.max_uses;
}

function InviteShareMaterial({
  inviteId,
  onTerminal,
}: {
  inviteId: string;
  onTerminal: (inviteId: string) => void;
}) {
  const { colors } = useTheme();
  const [share, setShare] = useState<InviteShare | null>(null);
  const [shareError, setShareError] = useState<unknown>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [readVersion, setReadVersion] = useState(0);

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    void api
      .getInviteShareLink(inviteId, controller.signal)
      .then((data) => {
        if (current) {
          setShare(data);
          setShareError(null);
        }
      })
      .catch((error: unknown) => {
        if (!current) return;
        if (
          error instanceof AppError &&
          ['INVITE_REVOKED', 'INVITE_EXPIRED', 'INVITE_USED'].includes(error.code)
        ) {
          onTerminal(inviteId);
          return;
        }
        setShare(null);
        setShareError(error);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [inviteId, onTerminal, readVersion]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage(pt.groups.invites.copied);
    } catch {
      setCopyMessage(pt.groups.invites.copyFailed);
    }
  };

  if (shareError) {
    return (
      <>
        <AppAlert message={groupErrorMessage(shareError)} />
        <AppButton
          label={pt.common.retry}
          onPress={() => {
            setShareError(null);
            setReadVersion((version) => version + 1);
          }}
          variant="secondary"
        />
      </>
    );
  }
  if (share === null) return <AppSkeleton lines={2} />;

  // docs/29 §6: the board is decorative; the selectable code right below it is
  // what readers, copy-by-hand (copyFailed) and tests rely on.
  const codeGroups = share.code.split('-').map((chars) => ({ chars }));
  return (
    <View style={styles.material}>
      {copyMessage ? <AppStatus message={copyMessage} /> : null}
      <Text style={[styles.overline, { color: colors.textMuted }]}>{pt.groups.invites.code}</Text>
      <Scoreboard decorative groups={codeGroups} layout="stacked" size="lg" />
      <Text selectable style={[styles.code, { color: colors.text }]} testID="invite-code">
        {share.code}
      </Text>
      <AppButton
        icon="copy"
        label={pt.groups.invites.copyCode}
        onPress={() => void copy(share.code)}
      />
      <InviteQrCode value={share.share_url} />
      <Text style={[styles.body, { color: colors.textMuted }]}>{pt.groups.invites.qrHint}</Text>
      <Text style={[styles.label, { color: colors.text }]}>{pt.groups.invites.link}</Text>
      <Text selectable style={[styles.link, { color: colors.textMuted }]} testID="invite-link">
        {share.share_url}
      </Text>
      <AppButton
        icon="link"
        label={pt.groups.invites.copyLink}
        onPress={() => void copy(share.share_url)}
        variant="tertiary"
      />
    </View>
  );
}

export function GroupInvitesScreen({ groupId, profile }: { groupId: string; profile: OwnProfile }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [shareVersion, setShareVersion] = useState(0);
  const [terminalInviteId, setTerminalInviteId] = useState<string | null>(null);
  const currentIntent = useRef<{ key: string; intent: MutationIntent<GroupOutcome> } | null>(null);
  const listing = useQuery({
    queryKey: [PRIVATE_QUERY_ROOT, 'group-invites', profile.id, groupId],
    gcTime: 0,
    queryFn: () =>
      withCurrentAccessToken(async (token) => {
        const [group, invites] = await Promise.all([
          api.getGroupDetail(groupId, profile.id, token),
          api.getGroupInvites(groupId, token),
        ]);
        return { group, invites };
      }),
  });
  const candidate = listing.data?.invites.find(candidateInvite);
  const active = candidate?.id === terminalInviteId ? undefined : candidate;
  const onTerminal = useCallback((inviteId: string) => setTerminalInviteId(inviteId), []);
  const change = useMutation({
    mutationFn: async (action: 'revoke' | 'regenerate' | 'issue') => {
      const key = `${action}:${active?.id ?? groupId}`;
      if (currentIntent.current?.key !== key) {
        currentIntent.current = {
          key,
          intent:
            action === 'issue'
              ? api.issueGroupInvite(groupId)
              : action === 'revoke'
                ? api.revokeGroupInvite(active!.id)
                : api.regenerateGroupInvite(active!.id),
        };
      }
      return currentIntent.current.intent.execute();
    },
    onSuccess: async () => {
      currentIntent.current = null;
      setTerminalInviteId(null);
      setConfirmRevoke(false);
      setShareVersion((version) => version + 1);
      await queryClient.invalidateQueries({ queryKey: [PRIVATE_QUERY_ROOT, 'group-invites'] });
    },
    onError: (error) => {
      if (!(error instanceof TransportError || (error instanceof AppError && error.retryable))) {
        currentIntent.current = null;
      }
    },
  });

  return (
    <AuthenticatedShell
      {...pt.groups.invites}
      back={{
        label: pt.groups.invites.back,
        href: `/grupos/${groupId}`,
        testID: 'invites-back',
      }}
    >
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
      {listing.data?.group === null ? <AppAlert message={pt.groups.detail.missing} /> : null}
      {listing.data?.group && !['owner', 'organizer'].includes(listing.data.group.role) ? (
        <AppAlert message={pt.groups.errors.notOrganizer} />
      ) : null}
      {listing.data?.group && ['owner', 'organizer'].includes(listing.data.group.role) ? (
        <AppCard testID="group-invites-card">
          <SectionHeading eyebrow={pt.groups.invites.eyebrow} title={listing.data.group.name} />
          {change.error ? <AppAlert message={groupErrorMessage(change.error)} /> : null}
          {active ? (
            <>
              <View style={styles.facts}>
                <View style={styles.fact}>
                  <AppIcon color={colors.textMuted} name="clock" size={18} />
                  <Text style={[styles.factText, { color: colors.text }]}>
                    {pt.groups.invites.expires(absoluteInviteTime(active.expires_at))}
                  </Text>
                </View>
                <View style={styles.fact}>
                  <AppIcon color={colors.textMuted} name="users" size={18} />
                  <Text style={[styles.factText, { color: colors.text }]}>
                    {pt.groups.invites.remaining(active.max_uses - active.used_count)}
                  </Text>
                </View>
              </View>
              <InviteShareMaterial
                key={`${active.id}:${shareVersion}`}
                inviteId={active.id}
                onTerminal={onTerminal}
              />
              <Text style={[styles.body, { color: colors.textMuted }]}>
                {pt.groups.invites.regenerateInfo}
              </Text>
              <AppButton
                icon="refresh-cw"
                label={pt.groups.invites.regenerate}
                onPress={() => {
                  if (!change.isPending) change.mutate('regenerate');
                }}
                variant="secondary"
              />
              {confirmRevoke ? (
                <View style={styles.material} testID="revoke-confirmation">
                  <Text
                    aria-level={3}
                    role="heading"
                    style={[styles.label, { color: colors.text }]}
                  >
                    {pt.groups.invites.confirmRevoke}
                  </Text>
                  <AppButton
                    icon="slash"
                    label={pt.groups.invites.confirmRevokeAction}
                    onPress={() => {
                      if (!change.isPending) change.mutate('revoke');
                    }}
                    variant="destructive"
                  />
                  <AppButton
                    label={pt.groups.invites.cancelRevoke}
                    onPress={() => setConfirmRevoke(false)}
                    variant="secondary"
                  />
                </View>
              ) : (
                <AppButton
                  icon="slash"
                  label={pt.groups.invites.revoke}
                  onPress={() => setConfirmRevoke(true)}
                  variant="destructive"
                />
              )}
            </>
          ) : (
            <>
              <Text style={[styles.body, { color: colors.text }]}>
                {pt.groups.invites.terminal}
              </Text>
              <AppButton
                label={pt.groups.invites.issue}
                onPress={() => {
                  if (!change.isPending) change.mutate('issue');
                }}
              />
            </>
          )}
          {change.isPending ? <AppSkeleton lines={2} /> : null}
        </AppCard>
      ) : null}
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  body: { ...typography.support },
  code: { ...typography.row, letterSpacing: 2, textAlign: 'center' },
  fact: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  factText: { ...typography.support, flex: 1, minWidth: 0 },
  facts: { gap: spacing.sm },
  label: { ...typography.supportStrong, paddingTop: spacing.sm },
  link: { ...typography.support },
  material: { gap: spacing.ms, minWidth: 0 },
  overline: { ...typography.overline },
});
