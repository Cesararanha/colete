import { StyleSheet, Text, View } from 'react-native';

import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { SectionHeading } from '@/components/ui/SectionHeading';
import type { DeletionRequestProjection } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

import { formatAbsoluteInstant } from './data-export-state';
import type { StoredDeletionProtocol } from './deletion-protocol';

type DeletionShellProps = {
  onLeave: () => void;
  onRefresh?: () => void;
  protocol: StoredDeletionProtocol;
  refreshing?: boolean;
  /** Null when Auth is already gone and the status can no longer be verified. */
  request: DeletionRequestProjection | null;
};

export function deletionShellCopy(request: DeletionRequestProjection | null): {
  body: string;
  support: boolean;
  title: string;
} {
  const copy = pt.privacy.shell;
  if (request === null)
    return { title: copy.titleUnverifiable, body: copy.unverifiable, support: true };
  if (request.status === 'completed') {
    return { title: copy.titleCompleted, body: copy.completed, support: false };
  }
  if (request.status === 'failed_retryable' || request.has_operational_failure) {
    return { title: copy.titleDelayed, body: copy.delayed, support: true };
  }
  return { title: copy.title, body: copy.inProgress, support: false };
}

/**
 * The restricted shell of docs/22 section 6. It has no domain navigation,
 * never recreates a session and shows only the five-field projection or, once
 * Auth is gone, the locally kept protocol.
 */
export function DeletionShellScreen({
  onLeave,
  onRefresh,
  protocol,
  refreshing,
  request,
}: DeletionShellProps) {
  const { colors } = useTheme();
  const copy = deletionShellCopy(request);
  const shell = pt.privacy.shell;

  return (
    <AuthenticatedShell description={shell.description} eyebrow={shell.eyebrow} title={copy.title}>
      <AppCard testID="deletion-shell-card">
        <SectionHeading eyebrow={shell.eyebrow} title={shell.protocol} />
        <Text
          accessibilityLabel={`${shell.protocol}: ${protocol.id}`}
          selectable
          style={[styles.protocol, { color: colors.text }]}
          testID="deletion-shell-protocol"
        >
          {protocol.id}
        </Text>
        <Text style={[styles.body, { color: colors.textMuted }]}>
          {shell.requestedAt(formatAbsoluteInstant(protocol.requested_at))}
        </Text>
        <View
          accessibilityLabel={shell.statusLabel}
          accessibilityLiveRegion="polite"
          role="status"
          style={[
            styles.state,
            { backgroundColor: colors.surfaceStrong, borderColor: colors.border },
          ]}
          testID="deletion-shell-status"
        >
          <Text style={[styles.stateTitle, { color: colors.text }]}>{copy.title}</Text>
          <Text style={[styles.body, { color: colors.text }]}>{copy.body}</Text>
          {request?.completed_at ? (
            <Text style={[styles.body, { color: colors.text }]}>
              {shell.completedAt(formatAbsoluteInstant(request.completed_at))}
            </Text>
          ) : null}
          {copy.support ? (
            <Text style={[styles.body, { color: colors.text }]} testID="deletion-shell-support">
              {pt.support.contact(pt.support.channel)}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.body, { color: colors.textMuted }]}>{shell.leaveHint}</Text>
        <View style={styles.actions}>
          {onRefresh === undefined ? null : (
            <AppButton
              label={refreshing === true ? pt.common.loading : shell.refresh}
              onPress={onRefresh}
              testID="deletion-shell-refresh"
              variant="secondary"
            />
          )}
          <AppButton label={shell.leave} onPress={onLeave} testID="deletion-shell-leave" />
        </View>
      </AppCard>
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  body: { fontSize: 15, lineHeight: 22 },
  protocol: { fontSize: 18, fontVariant: ['tabular-nums'], fontWeight: '700', lineHeight: 26 },
  state: { borderRadius: 18, borderWidth: 1, gap: spacing.xs, padding: spacing.md },
  stateTitle: { fontSize: 20, fontWeight: '800', lineHeight: 26 },
});
