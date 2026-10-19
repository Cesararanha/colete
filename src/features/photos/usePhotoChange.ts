import { useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { api, type MutationIntent, type PhotoOutcome } from '@/lib/api';
import { pt } from '@/lib/i18n/pt';
import { PRIVATE_QUERY_ROOT } from '@/lib/private-queries';

import { changePhoto, type PhotoSource, type PickedPhoto } from './photo-change';
import { photoErrorMessage } from './photo-errors';
import { photoQueryKey, type PhotoKind } from './photo-urls';
import { preparePhoto } from './prepare-photo';

export type PhotoTarget =
  { kind: 'profile'; profileId: string } | { kind: 'group'; groupId: string };

type Phase = 'idle' | 'sending' | 'removing';

async function requestPermission(source: PhotoSource): Promise<boolean> {
  const response =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  return response.granted;
}

async function pick(source: PhotoSource): Promise<PickedPhoto | null> {
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    // Native crops to a square before the shrink; the web picker is a plain
    // file input with no editor.
    allowsEditing: Platform.OS !== 'web',
    aspect: [1, 1],
    quality: 1,
    exif: false,
    base64: false,
  };
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? undefined : result.assets[0];
  if (asset === undefined) return null;
  return { uri: asset.uri, width: asset.width, height: asset.height };
}

/**
 * Changes or removes one photo: the person's own, or (owner only) a group's.
 * The screen shows `phase` while it runs and `message`/`error` after; nothing
 * on screen changes until the server has the new photo, so a failure keeps
 * the current one.
 */
export function usePhotoChange(target: PhotoTarget) {
  const client = useQueryClient();
  const alive = useRef(true);
  const busy = useRef(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const kind: PhotoKind = target.kind;
  const subjectId = target.kind === 'profile' ? target.profileId : target.groupId;
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: photoQueryKey(kind, subjectId) });
    if (target.kind === 'group') {
      // The group's own screens read it again with the new photo.
      await client.invalidateQueries({ queryKey: [PRIVATE_QUERY_ROOT, 'group-administration'] });
    }
  };

  const run = async (work: () => Promise<string | null>) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setMessage(null);
    try {
      const failure = await work();
      if (!alive.current) return;
      if (failure !== null) setError(failure);
    } finally {
      busy.current = false;
      if (alive.current) setPhase('idle');
    }
  };

  const choose = (source: PhotoSource) =>
    run(async () => {
      const result = await changePhoto(
        {
          ...(Platform.OS === 'web' ? {} : { requestPermission }),
          pick,
          prepare: preparePhoto,
          begin: () =>
            target.kind === 'profile'
              ? api.beginPhotoUpload('profile')
              : api.beginPhotoUpload('group', target.groupId),
          upload: (upload, body) => api.uploadPhoto(upload, body),
          commit: (uploadId) =>
            target.kind === 'profile'
              ? api.setProfilePhoto(uploadId)
              : api.setGroupPhoto(target.groupId, uploadId),
          onSending: () => {
            if (alive.current) setPhase('sending');
          },
        },
        source,
      );
      if (result.status === 'failed') return result.message;
      if (result.status === 'changed') {
        await refresh();
        if (alive.current) setMessage(pt.photos.saved);
      }
      return null;
    });

  const remove = () =>
    run(async () => {
      setPhase('removing');
      const intent: MutationIntent<PhotoOutcome> =
        target.kind === 'profile' ? api.removeProfilePhoto() : api.removeGroupPhoto(target.groupId);
      try {
        await intent.execute();
      } catch (caught) {
        return photoErrorMessage(caught);
      }
      await refresh();
      if (alive.current) setMessage(pt.photos.removed);
      return null;
    });

  return {
    phase,
    busy: phase !== 'idle',
    error,
    message,
    choose,
    remove,
    clear: () => {
      setError(null);
      setMessage(null);
    },
  };
}
