import type { MutationIntent, PhotoOutcome, PhotoUpload, PhotoUploadStart } from '../../lib/api';
import { pt } from '../../lib/i18n/pt';

import { photoErrorMessage } from './photo-errors';

export type PhotoSource = 'library' | 'camera';
export type PickedPhoto = { uri: string; width?: number; height?: number };

/** Everything a photo change touches, injected so the flow runs without a device. */
export type PhotoChangeDependencies = {
  /** Native only: the web picker is a file input and asks for nothing. */
  requestPermission?: (source: PhotoSource) => Promise<boolean>;
  pick: (source: PhotoSource) => Promise<PickedPhoto | null>;
  prepare: (photo: PickedPhoto) => Promise<BodyInit>;
  begin: () => MutationIntent<PhotoUploadStart>;
  upload: (upload: PhotoUpload, body: BodyInit) => Promise<void>;
  commit: (uploadId: string) => MutationIntent<PhotoOutcome>;
  /** Called once the server answered, before the photo is shown. */
  onSending?: () => void;
};

export type PhotoChangeResult =
  { status: 'changed' } | { status: 'canceled' } | { status: 'failed'; message: string };

/**
 * Pick, shrink and re-encode, open a session, send to its signed URL, then
 * ask the server to use it. Nothing changes until the last step succeeds, so
 * a refusal at any point keeps the current photo.
 */
export async function changePhoto(
  dependencies: PhotoChangeDependencies,
  source: PhotoSource,
): Promise<PhotoChangeResult> {
  if (dependencies.requestPermission !== undefined) {
    const granted = await dependencies.requestPermission(source).catch(() => false);
    if (!granted) {
      return {
        status: 'failed',
        message:
          source === 'camera' ? pt.photos.errors.cameraPermission : pt.photos.errors.permission,
      };
    }
  }
  let picked: PickedPhoto | null;
  try {
    picked = await dependencies.pick(source);
  } catch {
    return { status: 'failed', message: pt.photos.errors.unreadable };
  }
  if (picked === null) return { status: 'canceled' };
  dependencies.onSending?.();
  let body: BodyInit;
  try {
    body = await dependencies.prepare(picked);
  } catch {
    return { status: 'failed', message: pt.photos.errors.unreadable };
  }
  try {
    const started = await dependencies.begin().execute();
    if (started.upload === null) return { status: 'failed', message: pt.photos.errors.failed };
    await dependencies.upload(started.upload, body);
    await dependencies.commit(started.upload.upload_id).execute();
    return { status: 'changed' };
  } catch (error) {
    return { status: 'failed', message: photoErrorMessage(error) };
  }
}
