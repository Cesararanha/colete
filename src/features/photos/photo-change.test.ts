import { describe, expect, it, vi } from 'vitest';

import { AppError, TransportError, type MutationIntent } from '../../lib/api';
import { pt } from '../../lib/i18n/pt';

import { changePhoto, type PhotoChangeDependencies } from './photo-change';

const UPLOAD = {
  upload_id: '30c00001-0000-4000-8000-000000000000',
  url: '/storage/v1/object/upload/sign/avatars/a/b.jpg?token=t',
  expires_at: '2026-10-19T12:00:00.000Z',
  content_type: 'image/jpeg' as const,
  max_bytes: 1_048_576,
  max_side: 512,
};

function intent<T>(execute: () => Promise<T>): MutationIntent<T> {
  return { operation: 'begin_photo_upload', requestId: 'r', execute, retry: execute };
}

function dependencies(overrides: Partial<PhotoChangeDependencies> = {}) {
  const calls: string[] = [];
  const deps: PhotoChangeDependencies = {
    pick: vi.fn(async () => {
      calls.push('pick');
      return { uri: 'blob:photo', width: 4000, height: 3000 };
    }),
    prepare: vi.fn(async () => {
      calls.push('prepare');
      return new Blob(['jpeg']);
    }),
    begin: () =>
      intent(async () => {
        calls.push('begin');
        return {
          outcome: { upload_id: UPLOAD.upload_id, logical_result: 'photo_upload_started' as const },
          upload: UPLOAD,
        };
      }),
    upload: vi.fn(async () => {
      calls.push('upload');
    }),
    commit: (uploadId) =>
      intent(async () => {
        calls.push(`commit:${uploadId}`);
        return { outcome: { logical_result: 'profile_photo_set' } };
      }),
    ...overrides,
  };
  return { deps, calls };
}

describe('changePhoto', () => {
  it('shrinks, opens a session, sends and only then swaps', async () => {
    const { deps, calls } = dependencies();
    expect(await changePhoto(deps, 'library')).toEqual({ status: 'changed' });
    expect(calls).toEqual(['pick', 'prepare', 'begin', 'upload', `commit:${UPLOAD.upload_id}`]);
  });

  it('a denied permission says so and touches nothing', async () => {
    const { deps, calls } = dependencies({ requestPermission: async () => false });
    expect(await changePhoto(deps, 'library')).toEqual({
      status: 'failed',
      message: pt.photos.errors.permission,
    });
    expect(await changePhoto(deps, 'camera')).toEqual({
      status: 'failed',
      message: pt.photos.errors.cameraPermission,
    });
    expect(calls).toEqual([]);
  });

  it('a closed picker changes nothing', async () => {
    const { deps, calls } = dependencies({ pick: async () => null });
    expect(await changePhoto(deps, 'library')).toEqual({ status: 'canceled' });
    expect(calls).toEqual([]);
  });

  it('a failed upload keeps the current photo', async () => {
    const { deps, calls } = dependencies({
      upload: async () => {
        throw new TransportError();
      },
    });
    expect(await changePhoto(deps, 'library')).toEqual({
      status: 'failed',
      message: pt.photos.errors.network,
    });
    expect(calls).toEqual(['pick', 'prepare', 'begin']);
  });

  it('a refused photo and too many sessions have their own messages', async () => {
    const refused = dependencies({
      commit: () =>
        intent(async () => {
          throw new AppError('VALIDATION', 'x');
        }),
    });
    expect(await changePhoto(refused.deps, 'library')).toMatchObject({
      message: pt.photos.errors.invalid,
    });
    const limited = dependencies({
      begin: () =>
        intent(async () => {
          throw new AppError('RATE_LIMITED', 'x');
        }),
    });
    expect(await changePhoto(limited.deps, 'library')).toMatchObject({
      message: pt.photos.errors.rateLimited,
    });
  });

  it('an image that cannot be decoded is named as such', async () => {
    const { deps } = dependencies({
      prepare: async () => {
        throw new Error('decode');
      },
    });
    expect(await changePhoto(deps, 'library')).toEqual({
      status: 'failed',
      message: pt.photos.errors.unreadable,
    });
  });
});
