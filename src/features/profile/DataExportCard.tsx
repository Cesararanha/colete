import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { AppAlert } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppTextField } from '@/components/ui/AppTextField';
import { AsyncNotice } from '@/components/ui/AsyncNotice';
import { SectionHeading } from '@/components/ui/SectionHeading';
import {
  AppError,
  api,
  DownloadInterruptedError,
  TransportError,
  type DataExportRequestResult,
  type MutationIntent,
} from '@/lib/api';
import { deliverBlobToBrowser } from '@/lib/deliver-file';
import { pt } from '@/lib/i18n/pt';
import { dataExportProjectionSchema } from '@/lib/privacy-schema';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';

import {
  formatAbsoluteInstant,
  presentDataExports,
  type DataExportView,
} from './data-export-state';
import { profileErrorMessage } from './profile-errors';

export const OWN_DATA_EXPORTS_QUERY_KEY = ['own-data-exports'] as const;

type DownloadPhase =
  | { phase: 'idle' }
  | { phase: 'reauth'; exportId: string }
  | { phase: 'delivered' }
  | { phase: 'interrupted' }
  | { phase: 'failed'; message: string };

function stateCopy(view: DataExportView): { body: string; extra?: string; title: string } {
  const states = pt.privacy.export.states;
  switch (view.kind) {
    case 'none':
      return states.none;
    case 'preparing':
      return states.preparing;
    case 'ready':
      return {
        title: states.ready.title,
        body: states.ready.validUntil(formatAbsoluteInstant(view.expiresAt)),
        extra: states.ready.oneShot,
      };
    case 'expired':
      return {
        title: states.expired.title,
        body: view.canRequest ? states.expired.body : states.expired.awaitingCleanup,
      };
    case 'consumed':
      return {
        title: states.consumed.title,
        body: states.consumed.body,
        extra: view.canRequest ? states.consumed.cleaned : states.consumed.awaitingCleanup,
      };
    case 'failed':
      return {
        title: states.failed.title,
        body: states.failed.body,
        ...(view.repeated
          ? { extra: `${states.failed.repeated} ${pt.support.contact(pt.support.channel)}` }
          : {}),
      };
  }
}

export function DataExportCard({ email }: { email: string | null }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const stateRef = useRef<View>(null);
  const passwordRef = useRef<TextInput>(null);
  const [password, setPassword] = useState('');
  const [passwordValidated, setPasswordValidated] = useState(false);
  const [download, setDownload] = useState<DownloadPhase>({ phase: 'idle' });
  // One request_id per conscious intent. A transport retry reuses it; only a
  // later "generate a new export" after success or refusal creates another.
  const [requestIntent, setRequestIntent] =
    useState<MutationIntent<DataExportRequestResult> | null>(null);

  const exports = useQuery({
    queryKey: OWN_DATA_EXPORTS_QUERY_KEY,
    queryFn: () => api.getOwnDataExports(),
  });
  const refresh = () => void exports.refetch();
  const focusState = () => stateRef.current?.focus();

  const request = useMutation({
    mutationFn: (intent: MutationIntent<DataExportRequestResult>) => intent.execute(),
    onSuccess: (result) => {
      setRequestIntent(null);
      const parsed = dataExportProjectionSchema.array().safeParse(result.current);
      if (parsed.success) queryClient.setQueryData(OWN_DATA_EXPORTS_QUERY_KEY, parsed.data);
      refresh();
      focusState();
    },
    onError: (error) => {
      // A refused intent is finished; only transport and wait-timeouts keep it.
      if (error instanceof AppError && !error.retryable) setRequestIntent(null);
      if (error instanceof AppError && error.code === 'EXPORT_ALREADY_PENDING') refresh();
      focusState();
    },
  });
  const requestExport = () => {
    if (request.isPending) return;
    setDownload({ phase: 'idle' });
    const command = requestIntent ?? api.requestDataExport();
    setRequestIntent(command);
    request.mutate(command);
  };

  const transfer = useMutation({
    // Exactly one attempt. React Query never retries mutations here, and no
    // handler below re-issues the request: the projection decides what is next.
    mutationFn: (exportId: string) => api.downloadDataExport(exportId),
    onSuccess: (blob, exportId) => {
      deliverBlobToBrowser(blob, `colete-${exportId}.zip`);
      setDownload({ phase: 'delivered' });
      refresh();
      focusState();
    },
    onError: (error, exportId) => {
      if (error instanceof AppError && error.code === 'RECENT_REAUTH_REQUIRED') {
        setDownload({ phase: 'reauth', exportId });
        return;
      }
      setDownload(
        error instanceof DownloadInterruptedError
          ? { phase: 'interrupted' }
          : { phase: 'failed', message: profileErrorMessage(error) },
      );
      refresh();
      focusState();
    },
  });

  const reauth = useMutation({
    mutationFn: async ({ exportId, secret }: { exportId: string; secret: string }) => {
      const result = await api.signInWithPassword(email ?? '', secret);
      queryClient.setQueryData(['session'], result.session);
      return exportId;
    },
    onSuccess: (exportId) => {
      setPassword('');
      setPasswordValidated(false);
      setDownload({ phase: 'idle' });
      transfer.mutate(exportId);
    },
    onError: () => passwordRef.current?.focus(),
  });

  useEffect(() => {
    if (download.phase === 'reauth') passwordRef.current?.focus();
  }, [download.phase]);

  const view = exports.data === undefined ? null : presentDataExports(exports.data, new Date());
  const copy = view === null ? null : stateCopy(view);
  const canRetryRequest =
    request.error instanceof TransportError ||
    (request.error instanceof AppError && request.error.retryable);
  const requestError =
    request.error instanceof AppError && request.error.code === 'EXPORT_ALREADY_PENDING'
      ? null
      : request.error;
  const busy = request.isPending || transfer.isPending || reauth.isPending;
  const wantsNewExport = view !== null && view.kind !== 'none' && view.kind !== 'preparing';

  return (
    <AppCard testID="profile-export-card">
      <SectionHeading
        description={pt.privacy.export.description}
        eyebrow={pt.privacy.export.eyebrow}
        title={pt.privacy.export.title}
      />
      <Text style={[styles.body, { color: colors.textMuted }]}>{pt.privacy.export.contents}</Text>
      <Text style={[styles.body, { color: colors.textMuted }]}>{pt.privacy.export.exclusions}</Text>

      {exports.isPending ? (
        <AsyncNotice kind="loading" message={pt.common.loading} />
      ) : exports.error !== null ? (
        <AsyncNotice
          action={refresh}
          actionLabel={pt.common.retry}
          kind="network"
          message={profileErrorMessage(exports.error)}
          title={pt.common.networkTitle}
        />
      ) : view === null || copy === null ? null : (
        <>
          <View
            accessibilityLabel={pt.privacy.export.stateLabel}
            accessibilityLiveRegion="polite"
            ref={stateRef}
            role="status"
            style={[
              styles.state,
              { backgroundColor: colors.surfaceStrong, borderColor: colors.border },
            ]}
            tabIndex={-1}
            testID="export-state"
          >
            <Text
              aria-level={3}
              role="heading"
              style={[styles.stateTitle, { color: colors.text }]}
              testID="export-state-title"
            >
              {copy.title}
            </Text>
            <Text style={[styles.body, { color: colors.text }]}>{copy.body}</Text>
            {copy.extra === undefined ? null : (
              <Text style={[styles.body, { color: colors.text }]}>{copy.extra}</Text>
            )}
            {request.isSuccess && view.kind === 'preparing' ? (
              <Text style={[styles.body, { color: colors.positive }]}>
                {pt.privacy.export.requested}
              </Text>
            ) : null}
            {download.phase === 'delivered' ? (
              <Text style={[styles.body, { color: colors.positive }]}>
                {pt.privacy.export.downloadStarted}
              </Text>
            ) : null}
            {download.phase === 'interrupted' ? (
              <Text style={[styles.body, { color: colors.critical }]}>
                {pt.privacy.export.interrupted}
              </Text>
            ) : null}
            {download.phase === 'failed' ? (
              <Text style={[styles.body, { color: colors.critical }]}>{download.message}</Text>
            ) : null}
          </View>

          {requestError === null ? null : (
            <AppAlert message={profileErrorMessage(requestError)} testID="export-request-error" />
          )}
          {transfer.isPending ? <AppSkeleton lines={1} /> : null}

          {download.phase === 'reauth' ? (
            <View style={styles.reauth} testID="export-reauth">
              <Text
                aria-level={3}
                role="heading"
                style={[styles.stateTitle, { color: colors.text }]}
              >
                {pt.privacy.export.reauth.title}
              </Text>
              <Text style={[styles.body, { color: colors.textMuted }]}>
                {pt.privacy.export.reauth.body}
              </Text>
              <AppTextField
                autoCapitalize="none"
                autoComplete="current-password"
                error={
                  passwordValidated && password.length === 0
                    ? pt.privacy.export.reauth.passwordRequired
                    : reauth.error === null
                      ? undefined
                      : profileErrorMessage(reauth.error)
                }
                label={pt.privacy.export.reauth.password}
                onChangeText={(value) => {
                  reauth.reset();
                  setPassword(value);
                }}
                onBlur={() => setPasswordValidated(true)}
                passwordToggleLabel={{
                  hide: pt.auth.fields.hidePassword,
                  show: pt.auth.fields.showPassword,
                }}
                ref={passwordRef}
                secureTextEntry
                testID="export-reauth-password"
                value={password}
              />
              <View style={styles.actions}>
                <AppButton
                  label={reauth.isPending ? pt.common.sending : pt.privacy.export.reauth.action}
                  onPress={() => {
                    if (busy) return;
                    if (password.length === 0) {
                      passwordRef.current?.focus();
                      setPasswordValidated(true);
                      return;
                    }
                    reauth.mutate({ exportId: download.exportId, secret: password });
                  }}
                  testID="export-reauth-confirm"
                />
                <AppButton
                  label={pt.privacy.export.reauth.cancel}
                  onPress={() => {
                    setPassword('');
                    setPasswordValidated(false);
                    reauth.reset();
                    setDownload({ phase: 'idle' });
                  }}
                  variant="secondary"
                />
              </View>
            </View>
          ) : (
            <View style={styles.actions}>
              {view.kind === 'ready' ? (
                <AppButton
                  label={
                    transfer.isPending ? pt.privacy.export.downloading : pt.privacy.export.download
                  }
                  onPress={() => {
                    if (busy) return;
                    setDownload({ phase: 'idle' });
                    transfer.mutate(view.export.id);
                  }}
                  testID="export-download"
                />
              ) : null}
              {view.kind === 'none' ||
              (view.kind === 'expired' && view.canRequest) ||
              (view.kind === 'consumed' && view.canRequest) ||
              view.kind === 'failed' ? (
                <AppButton
                  label={
                    request.isPending
                      ? pt.common.sending
                      : wantsNewExport
                        ? pt.privacy.export.requestAgain
                        : pt.privacy.export.request
                  }
                  onPress={requestExport}
                  testID="export-request"
                  variant={view.kind === 'none' ? 'primary' : 'secondary'}
                />
              ) : null}
              {canRetryRequest && requestIntent !== null ? (
                <AppButton
                  label={pt.common.retry}
                  onPress={requestExport}
                  testID="export-request-retry"
                  variant="secondary"
                />
              ) : null}
              {view.kind === 'none' ? null : (
                <AppButton
                  label={pt.privacy.export.refresh}
                  onPress={refresh}
                  testID="export-refresh"
                  variant="secondary"
                />
              )}
            </View>
          )}
        </>
      )}
    </AppCard>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    minWidth: 0,
    width: '100%',
  },
  body: { fontSize: 15, lineHeight: 22 },
  reauth: { gap: spacing.sm },
  state: { borderRadius: 18, borderWidth: 1, gap: spacing.xs, padding: spacing.md },
  stateTitle: { fontSize: 20, fontWeight: '800', lineHeight: 26 },
});
