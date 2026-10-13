import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, Text, View } from 'react-native';

import { AppAlert, AppStatus } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppTextField } from '@/components/ui/AppTextField';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import { AppError, TransportError, api, type GroupOutcome, type MutationIntent } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';
import { useTheme } from '@/theme/ThemeProvider';
import { spacing } from '@/theme/spacing';
import { typography } from '@/theme/typography';

import { groupErrorMessage } from './group-errors';

export function JoinGroupScreen({ initialToken }: { initialToken: string | null }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const [token, setToken] = useState(initialToken);
  const [preview, setPreview] = useState<{ group_name: string } | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [joiningPending, setJoiningPending] = useState(false);
  const [joiningError, setJoiningError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [result, setResult] = useState<GroupOutcome | null>(null);
  const previewStarted = useRef(false);
  const previewSequence = useRef(0);
  const joiningBusy = useRef(false);
  const intent = useRef<MutationIntent<GroupOutcome> | null>(null);
  const { control, getValues, setFocus } = useForm<{ code: string }>({
    defaultValues: { code: '' },
    mode: 'onBlur',
    reValidateMode: 'onChange',
  });
  // The invitation stays in component memory. React Query's mutation cache
  // would retain its variables, including the token, after the preview.
  const previewGroup = useCallback(async (kind: 'code' | 'token', value: string) => {
    const sequence = ++previewSequence.current;
    setPreviewPending(true);
    try {
      const data =
        kind === 'token'
          ? await api.previewGroupByInvite(value)
          : await api.previewGroupByCode(value);
      if (sequence === previewSequence.current) {
        setPreview(data);
        setPreviewError(null);
      }
    } catch (error) {
      if (sequence === previewSequence.current) {
        setPreview(null);
        setPreviewError(error);
      }
    } finally {
      if (sequence === previewSequence.current) setPreviewPending(false);
    }
  }, []);
  useEffect(() => {
    if (token !== null && !previewStarted.current) {
      previewStarted.current = true;
      void previewGroup('token', token);
    }
  }, [token, previewGroup]);

  const checkCode = () => {
    const code = getValues('code');
    if (code.replace(/[\s-]/gu, '').length !== 10) {
      setFieldError(pt.groups.join.invalid);
      setFocus('code');
      return;
    }
    setFieldError(undefined);
    setPreview(null);
    setPreviewError(null);
    setJoiningError(null);
    setResult(null);
    setToken(null);
    void previewGroup('code', code);
  };
  const join = async () => {
    if (preview === null || joiningBusy.current) return;
    joiningBusy.current = true;
    setJoiningPending(true);
    setJoiningError(null);
    try {
      intent.current ??=
        token === null ? api.joinGroupByCode(getValues('code')) : api.joinGroupByInvite(token);
      const data = await intent.current.execute();
      intent.current = null;
      setResult(data);
      setPreview(null);
      setToken(null);
      void queryClient.invalidateQueries({ queryKey: [PRIVATE_QUERY_ROOT, 'groups'] });
    } catch (error) {
      const sameIntentCanRetry =
        error instanceof TransportError ||
        (error instanceof AppError &&
          (error.retryable ||
            error.code === 'RATE_LIMITED' ||
            error.code === 'RATE_LIMIT_UNAVAILABLE'));
      if (!sameIntentCanRetry) intent.current = null;
      setJoiningError(error);
    } finally {
      joiningBusy.current = false;
      setJoiningPending(false);
    }
  };

  return (
    <AuthenticatedShell {...pt.groups.join}>
      <AppCard testID="join-group-card">
        <Controller
          control={control}
          name="code"
          render={({ field }) => (
            <AppTextField
              label={pt.groups.join.code}
              hint={pt.groups.join.codeHint}
              error={fieldError}
              value={field.value}
              onBlur={() => {
                field.onBlur();
                if (field.value !== '' && field.value.replace(/[\s-]/gu, '').length !== 10)
                  setFieldError(pt.groups.join.invalid);
              }}
              onChangeText={(value) => {
                previewSequence.current += 1;
                setPreviewPending(false);
                field.onChange(value);
                if (fieldError !== undefined) {
                  setFieldError(
                    value.replace(/[\s-]/gu, '').length === 10 ? undefined : pt.groups.join.invalid,
                  );
                }
                setPreview(null);
                setPreviewError(null);
                setJoiningError(null);
                setResult(null);
                intent.current = null;
                setToken(null);
              }}
              ref={field.ref}
              testID="group-code"
              autoCapitalize="characters"
            />
          )}
        />
        <AppButton label={pt.groups.join.preview} onPress={checkCode} testID="preview-code" />
        {previewPending ? <AppSkeleton lines={2} /> : null}
        {previewError ? (
          <>
            <AppAlert message={groupErrorMessage(previewError)} testID="preview-error" />
            {token !== null && previewError instanceof TransportError ? (
              <AppButton
                label={pt.common.retry}
                onPress={() => void previewGroup('token', token)}
              />
            ) : null}
          </>
        ) : null}
        {preview ? (
          <View style={styles.confirm} testID="join-confirmation">
            <Text aria-level={2} role="heading" style={[styles.title, { color: colors.text }]}>
              {pt.groups.join.confirm(preview.group_name)}
            </Text>
            {joiningError ? (
              <AppAlert message={groupErrorMessage(joiningError)} testID="join-error" />
            ) : null}
            {joiningPending ? <AppSkeleton lines={2} /> : null}
            <AppButton
              label={pt.groups.join.enter}
              onPress={() => void join()}
              testID="join-submit"
            />
          </View>
        ) : null}
        {result?.current?.status === 'pending' ? (
          <AppStatus
            message={`${pt.groups.join.pending}. ${pt.groups.join.pendingBody}`}
            testID="join-pending"
          />
        ) : null}
        {result?.current?.status === 'active' ? (
          <AppStatus message={pt.groups.join.active} testID="join-active" />
        ) : null}
        {result?.current?.status === 'active' && result.current.group_id ? (
          <AppButton
            label={pt.groups.list.open}
            onPress={() => router.replace(`/grupos/${result.current?.group_id}`)}
          />
        ) : null}
      </AppCard>
    </AuthenticatedShell>
  );
}

const styles = StyleSheet.create({
  confirm: { gap: spacing.md },
  title: { ...typography.title },
});
