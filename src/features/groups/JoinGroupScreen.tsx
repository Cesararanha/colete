import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';

import { AppAlert } from '@/components/ui/AppAlert';
import { AppButton } from '@/components/ui/AppButton';
import { AppCard } from '@/components/ui/AppCard';
import { AppSkeleton } from '@/components/ui/AppSkeleton';
import { AppTextField } from '@/components/ui/AppTextField';
import { AuthenticatedShell } from '@/components/ui/AuthenticatedShell';
import {
  AppError,
  TransportError,
  api,
  type GroupOutcome,
  type InvitePage,
  type MutationIntent,
} from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { backTo } from '@/lib/navigation';
import { forgetInvite } from '@/lib/pending-invite';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';

import { groupErrorMessage } from './group-errors';
import { InvitePageBody, InvitePageIntro } from './InvitePage';
import { InviteQrScanner } from './InviteQrScanner';
import { inviteAppOrigin, parseInviteLink } from './join-fragment';
import { joinDestination } from './join-result';

/** A refusal the same invitation can still overcome later: network, retryable, rate limit. */
function canRetryLater(error: unknown) {
  return (
    error instanceof TransportError ||
    (error instanceof AppError &&
      (error.retryable || error.code === 'RATE_LIMITED' || error.code === 'RATE_LIMIT_UNAVAILABLE'))
  );
}

export function JoinGroupScreen({ initialToken }: { initialToken: string | null }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState(initialToken);
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const cameraErrorRef = useRef<View>(null);
  useLayoutEffect(() => {
    if (cameraError) cameraErrorRef.current?.focus();
  }, [cameraError]);
  useFocusEffect(useCallback(() => () => setScanning(false), []));
  const [preview, setPreview] = useState<InvitePage | null>(null);
  const pageRef = useRef<View>(null);
  // The page replaces the form: the focus moves to the group's name.
  useLayoutEffect(() => {
    if (preview) pageRef.current?.focus();
  }, [preview]);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [joiningPending, setJoiningPending] = useState(false);
  const [joiningError, setJoiningError] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const previewStarted = useRef(false);
  const previewSequence = useRef(0);
  const joiningBusy = useRef(false);
  const intent = useRef<MutationIntent<GroupOutcome> | null>(null);
  const { control, getValues, setFocus, setValue } = useForm<{ code: string }>({
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
      // A member or a pending request has nothing left to do with the link:
      // the invitation leaves this tab's storage as soon as the page says so.
      if (data.viewer_status === 'active' || data.viewer_status === 'pending') forgetInvite();
      if (sequence === previewSequence.current) {
        setPreview(data);
        setPreviewError(null);
      }
    } catch (error) {
      // An invitation the server refuses for good is not kept for a reload.
      if (kind === 'token' && !canRetryLater(error)) forgetInvite();
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

  const cancelCamera = useCallback(() => {
    setScanning(false);
    setCameraError(null);
    requestAnimationFrame(() => setFocus('code'));
  }, [setFocus]);
  const cameraFailed = useCallback((reason: 'denied' | 'unavailable') => {
    setScanning(false);
    setCameraError(
      reason === 'denied' ? pt.groups.join.cameraDenied : pt.groups.join.cameraUnavailable,
    );
  }, []);
  const readQr = useCallback(
    (value: string) => {
      setScanning(false);
      const scannedToken = parseInviteLink(value, inviteAppOrigin());
      if (scannedToken === null) {
        setCameraError(pt.groups.join.invalidQr);
        return;
      }
      forgetInvite();
      previewSequence.current += 1;
      setValue('code', '');
      setFieldError(undefined);
      setCameraError(null);
      setPreview(null);
      setPreviewError(null);
      setJoiningError(null);
      intent.current = null;
      previewStarted.current = true;
      setToken(scannedToken);
      void previewGroup('token', scannedToken);
    },
    [previewGroup, setValue],
  );

  const checkCode = () => {
    setScanning(false);
    setCameraError(null);
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
    setToken(null);
    forgetInvite();
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
      setToken(null);
      // Used: the request is sent, so the invitation leaves this tab's storage.
      forgetInvite();
      await queryClient.invalidateQueries({ queryKey: [PRIVATE_QUERY_ROOT, 'groups'] });
      // A request sent goes to Grupos, replacing this form: the request shows
      // there as "Aguardando aprovação" and there is no way back to the form.
      const destination = joinDestination(data);
      if (destination !== null) {
        setPreview(null);
        backTo(destination);
        return;
      }
      // Approved in the meantime: the page now opens the group.
      const groupId = data.current?.status === 'active' ? data.current.group_id : undefined;
      setPreview((page) =>
        page && groupId
          ? { ...page, viewer_status: 'active', group_id: groupId, refusal: null }
          : null,
      );
    } catch (error) {
      if (!canRetryLater(error)) intent.current = null;
      setJoiningError(error);
    } finally {
      joiningBusy.current = false;
      setJoiningPending(false);
    }
  };

  // Back to the form: the invitation leaves memory with the page.
  const leavePage = () => {
    forgetInvite();
    previewSequence.current += 1;
    intent.current = null;
    setPreview(null);
    setToken(null);
    setJoiningError(null);
    requestAnimationFrame(() => setFocus('code'));
  };

  if (preview) {
    return (
      <AuthenticatedShell
        back={{
          label: pt.groups.join.title,
          href: '/join',
          onPress: leavePage,
          testID: 'invite-page-back',
        }}
        description=""
        intro={<InvitePageIntro page={preview} ref={pageRef} />}
        title={pt.groups.join.title}
      >
        <InvitePageBody
          joining={joiningPending}
          joiningError={joiningError ? groupErrorMessage(joiningError) : null}
          onJoin={() => void join()}
          onOpen={forgetInvite}
          page={preview}
        />
      </AuthenticatedShell>
    );
  }

  return (
    <AuthenticatedShell {...pt.groups.join}>
      <AppCard testID="join-group-card">
        {cameraError ? (
          <View ref={cameraErrorRef} tabIndex={-1} testID="invite-camera-error-focus">
            <AppAlert message={cameraError} testID="invite-camera-error" />
          </View>
        ) : null}
        {cameraError ? (
          <AppButton label={pt.groups.join.typeCode} onPress={cancelCamera} variant="secondary" />
        ) : null}
        {scanning ? (
          <InviteQrScanner onRead={readQr} onError={cameraFailed} onCancel={cancelCamera} />
        ) : (
          <AppButton
            label={pt.groups.join.scanQr}
            icon="camera"
            testID="read-invite-qr"
            variant="secondary"
            onPress={() => {
              if (joiningBusy.current) return;
              if (inviteAppOrigin() === null) {
                setCameraError(pt.groups.join.cameraNotConfigured);
                return;
              }
              forgetInvite();
              previewSequence.current += 1;
              setPreviewPending(false);
              setPreview(null);
              setPreviewError(null);
              setJoiningError(null);
              setToken(null);
              intent.current = null;
              setCameraError(null);
              setScanning(true);
            }}
          />
        )}
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
                setScanning(false);
                setCameraError(null);
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
                intent.current = null;
                setToken(null);
                forgetInvite();
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
      </AppCard>
    </AuthenticatedShell>
  );
}
