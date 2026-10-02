import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
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

import { absoluteInviteTime, groupErrorMessage } from './group-errors';

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

  return (
    <View style={styles.material}>
      {copyMessage ? <AppStatus message={copyMessage} /> : null}
      <Text style={[styles.label, { color: colors.text }]}>{pt.groups.invites.code}</Text>
      <Text selectable style={[styles.code, { color: colors.text }]} testID="invite-code">
        {share.code}
      </Text>
      <AppButton label={pt.groups.invites.copyCode} onPress={() => void copy(share.code)} />
      <Text style={[styles.label, { color: colors.text }]}>{pt.groups.invites.link}</Text>
      <Text selectable style={[styles.body, { color: colors.text }]} testID="invite-link">
        {share.share_url}
      </Text>
      <AppButton
        label={pt.groups.invites.copyLink}
        onPress={() => void copy(share.share_url)}
        variant="secondary"
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
    <AuthenticatedShell {...pt.groups.invites}>
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
              <Text style={[styles.body, { color: colors.text }]}>
                {pt.groups.invites.expires(absoluteInviteTime(active.expires_at))}
              </Text>
              <Text style={[styles.body, { color: colors.text }]}>
                {pt.groups.invites.remaining(active.max_uses - active.used_count)}
              </Text>
              <InviteShareMaterial
                key={`${active.id}:${shareVersion}`}
                inviteId={active.id}
                onTerminal={onTerminal}
              />
              <Text style={[styles.body, { color: colors.textMuted }]}>
                {pt.groups.invites.regenerateInfo}
              </Text>
              <AppButton
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
  body: { fontSize: 16, lineHeight: 24 },
  code: { fontSize: 22, fontWeight: '800', letterSpacing: 2, lineHeight: 30 },
  label: { fontSize: 16, fontWeight: '700', lineHeight: 24 },
  material: { gap: spacing.sm, minWidth: 0 },
});
