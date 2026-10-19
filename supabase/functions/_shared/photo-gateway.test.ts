import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import {
  PHOTO_READ_LIMIT,
  dispatchPhoto,
  tokenExpiry,
  type PhotoDependencies,
  type PhotoStorage,
} from './photo-gateway.ts';

const REQUEST_ID = '01890f7e-e948-7c53-b13a-4a36e4b7d21e';
const ACTOR = {
  authUserId: '5f0d9f1e-6a2e-4d2b-8c3a-1a2b3c4d5e6f',
  sessionId: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
};
const PROFILE = '30a00001-0000-4000-8000-000000000000';
const OTHER = '30a00002-0000-4000-8000-000000000000';
const GROUP = '30b00001-0000-4000-8000-000000000000';
const UPLOAD = '30c00001-0000-4000-8000-000000000000';
const AVATAR_PATH = `${PROFILE}/${UPLOAD}.jpg`;
const NOW = 1_800_000_000;

function token(exp: number): string {
  const payload = btoa(JSON.stringify({ url: `avatars/${AVATAR_PATH}`, exp }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

function storage(overrides: Partial<PhotoStorage> = {}): PhotoStorage {
  return {
    signUpload: vi.fn(async (bucket, path) => ({
      url: `/object/upload/sign/${bucket}/${path}?token=${token(NOW + 60)}`,
      token: token(NOW + 60),
    })),
    read: vi.fn(async () => null),
    remove: vi.fn(async () => undefined),
    signRead: vi.fn(async (_bucket, paths) =>
      paths.map((path) => ({ path, signedURL: `/object/sign/x/${path}?token=t` })),
    ),
    ...overrides,
  };
}

function deps(
  callRpc: PhotoDependencies['callRpc'],
  photoStorage: PhotoStorage = storage(),
): PhotoDependencies {
  return {
    actor: ACTOR,
    resolveKey: () => new Uint8Array(32),
    callRpc,
    storage: photoStorage,
    now: () => NOW,
  };
}

async function jpeg(width: number, gps = false): Promise<Uint8Array> {
  let image = sharp({
    create: { width, height: width, channels: 3, background: { r: 10, g: 90, b: 40 } },
  });
  if (gps) {
    image = image.withExif({ IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '23/1 33/1 0/1' } });
  }
  return new Uint8Array(await image.jpeg().toBuffer());
}

describe('get_photo_urls', () => {
  it('asks the database who may be seen and signs only those, for five minutes', async () => {
    const callRpc = vi.fn(async () => ({
      data: [
        {
          kind: 'profile',
          subject_id: PROFILE,
          bucket: 'avatars',
          object_path: AVATAR_PATH,
        },
        {
          kind: 'group',
          subject_id: GROUP,
          bucket: 'group-photos',
          object_path: `${GROUP}/${UPLOAD}.jpg`,
        },
      ],
    }));
    const photoStorage = storage();
    const result = await dispatchPhoto(deps(callRpc, photoStorage), 'get_photo_urls', {
      profile_ids: [OTHER, PROFILE, PROFILE],
      group_ids: [GROUP],
    });
    expect(result.status).toBe(200);
    expect(callRpc).toHaveBeenCalledWith('get_visible_photos', {
      p_actor_auth_user_id: ACTOR.authUserId,
      p_actor_session_id: ACTOR.sessionId,
      p_profile_ids: [PROFILE, OTHER],
      p_group_ids: [GROUP],
      p_self: false,
    });
    expect(photoStorage.signRead).toHaveBeenCalledWith('avatars', [AVATAR_PATH], 300);
    expect(result.body['data']).toEqual({
      expires_in: 300,
      self: null,
      profiles: { [PROFILE]: `/storage/v1/object/sign/x/${AVATAR_PATH}?token=t` },
      groups: { [GROUP]: `/storage/v1/object/sign/x/${GROUP}/${UPLOAD}.jpg?token=t` },
    });
  });

  it('refuses a body that names a path, too many IDs or a malformed ID', async () => {
    const callRpc = vi.fn();
    for (const body of [
      { profile_ids: [PROFILE], path: AVATAR_PATH },
      { profile_ids: Array.from({ length: PHOTO_READ_LIMIT + 1 }, () => PROFILE) },
      { group_ids: ['not-a-uuid'] },
      { profile_ids: 'all' },
    ]) {
      const result = await dispatchPhoto(deps(callRpc), 'get_photo_urls', body);
      expect(result.status).toBe(422);
    }
    expect(callRpc).not.toHaveBeenCalled();
  });

  it('never signs a subject the client did not ask for', async () => {
    const callRpc = vi.fn(async () => ({
      data: [{ kind: 'profile', subject_id: OTHER, bucket: 'avatars', object_path: AVATAR_PATH }],
    }));
    const photoStorage = storage();
    const result = await dispatchPhoto(deps(callRpc, photoStorage), 'get_photo_urls', {
      profile_ids: [PROFILE],
    });
    expect(result.status).toBe(500);
    expect(photoStorage.signRead).not.toHaveBeenCalled();
  });
});

describe('get_photo_urls for the own photo', () => {
  it('answers the self flag under self, never keyed by the own ID', async () => {
    const callRpc = vi.fn(async () => ({
      data: [{ kind: 'self', subject_id: PROFILE, bucket: 'avatars', object_path: AVATAR_PATH }],
    }));
    const result = await dispatchPhoto(deps(callRpc), 'get_photo_urls', { self: true });
    expect(result.status).toBe(200);
    expect(callRpc.mock.calls[0]?.[1]).toMatchObject({ p_self: true, p_profile_ids: [] });
    expect(result.body['data']).toEqual({
      expires_in: 300,
      self: `/storage/v1/object/sign/x/${AVATAR_PATH}?token=t`,
      profiles: {},
      groups: {},
    });
  });

  it('refuses a self row nobody asked for, and a self flag that is not a boolean', async () => {
    const callRpc = vi.fn(async () => ({
      data: [{ kind: 'self', subject_id: PROFILE, bucket: 'avatars', object_path: AVATAR_PATH }],
    }));
    expect((await dispatchPhoto(deps(callRpc), 'get_photo_urls', {})).status).toBe(500);
    expect((await dispatchPhoto(deps(vi.fn()), 'get_photo_urls', { self: 'yes' })).status).toBe(
      422,
    );
  });
});

describe('begin_photo_upload', () => {
  const opened = {
    outcome: { upload_id: UPLOAD, logical_result: 'photo_upload_started' },
    current: {
      upload_id: UPLOAD,
      bucket: 'avatars',
      path: AVATAR_PATH,
      commit_before: new Date((NOW + 900) * 1000).toISOString(),
      reclaim_after: new Date((NOW + 7500) * 1000).toISOString(),
    },
  };

  it('signs an upload URL for the path the database decided, and returns no path', async () => {
    const callRpc = vi.fn(async () => ({ data: opened }));
    const photoStorage = storage();
    const result = await dispatchPhoto(deps(callRpc, photoStorage), 'begin_photo_upload', {
      request_id: REQUEST_ID,
      target: 'profile',
    });
    expect(result.status).toBe(200);
    const params = callRpc.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(params['p_target']).toBe('profile');
    expect(params['p_group_id']).toBeNull();
    expect(params['p_input_hmac']).toMatch(/^[0-9a-f]{64}$/);
    expect(photoStorage.signUpload).toHaveBeenCalledWith('avatars', AVATAR_PATH);
    const data = result.body['data'] as Record<string, unknown>;
    expect(data['outcome']).toEqual(opened.outcome);
    expect(data['upload']).toMatchObject({
      upload_id: UPLOAD,
      content_type: 'image/jpeg',
      max_bytes: 1_048_576,
      max_side: 512,
      expires_at: new Date((NOW + 60) * 1000).toISOString(),
    });
    expect(JSON.stringify(data)).not.toContain('reclaim_after');
    expect(JSON.stringify(data)).not.toContain('"path"');
  });

  it('fails closed when Storage hands out a URL that outlives the reclaim', async () => {
    const callRpc = vi.fn(async () => ({ data: opened }));
    const longLived = storage({
      signUpload: vi.fn(async (bucket, path) => ({
        url: `/object/upload/sign/${bucket}/${path}?token=x`,
        token: token(NOW + 7500),
      })),
    });
    const result = await dispatchPhoto(deps(callRpc, longLived), 'begin_photo_upload', {
      request_id: REQUEST_ID,
      target: 'profile',
    });
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain('upload/sign');
  });

  it('requires the group for a group photo and refuses it for a profile photo', async () => {
    const callRpc = vi.fn();
    for (const body of [
      { request_id: REQUEST_ID, target: 'group' },
      { request_id: REQUEST_ID, target: 'profile', group_id: GROUP },
      { request_id: REQUEST_ID, target: 'profile', group_id: null },
      { request_id: REQUEST_ID, target: 'avatar' },
      { request_id: REQUEST_ID, target: 'profile', profile_id: PROFILE },
    ]) {
      expect((await dispatchPhoto(deps(callRpc), 'begin_photo_upload', body)).status).toBe(422);
    }
    expect(callRpc).not.toHaveBeenCalled();
  });

  it('a replay whose session is gone returns the outcome with no URL', async () => {
    const callRpc = vi.fn(async () => ({ data: { outcome: opened.outcome } }));
    const photoStorage = storage();
    const result = await dispatchPhoto(deps(callRpc, photoStorage), 'begin_photo_upload', {
      request_id: REQUEST_ID,
      target: 'profile',
    });
    expect(result.body['data']).toEqual({ outcome: opened.outcome, upload: null });
    expect(photoStorage.signUpload).not.toHaveBeenCalled();
  });
});

describe('set_profile_photo', () => {
  const target = { kind: 'profile_avatar', group_id: null, bucket: 'avatars', path: AVATAR_PATH };
  const swapped = {
    outcome: { profile_id: PROFILE, logical_result: 'profile_photo_set' },
    current: { has_photo: true },
  };

  function rpcFor(sessionTarget: unknown) {
    return vi.fn(async (name: string) =>
      name === 'get_photo_upload_target' ? { data: sessionTarget } : { data: swapped },
    );
  }

  it('reads the stored object, holds it to the rule and only then swaps', async () => {
    const callRpc = rpcFor(target);
    const bytes = await jpeg(512);
    const photoStorage = storage({ read: vi.fn(async () => bytes) });
    const result = await dispatchPhoto(deps(callRpc, photoStorage), 'set_profile_photo', {
      request_id: REQUEST_ID,
      upload_id: UPLOAD,
    });
    expect(result.status).toBe(200);
    expect(photoStorage.read).toHaveBeenCalledWith('avatars', AVATAR_PATH, 1_048_576);
    expect(callRpc.mock.calls.map((call) => call[0])).toEqual([
      'get_photo_upload_target',
      'set_profile_photo',
    ]);
    expect(photoStorage.remove).not.toHaveBeenCalled();
  });

  it('deletes a photo with GPS in its Exif and never swaps it in', async () => {
    const callRpc = rpcFor(target);
    const bytes = await jpeg(300, true);
    const photoStorage = storage({ read: vi.fn(async () => bytes) });
    const result = await dispatchPhoto(deps(callRpc, photoStorage), 'set_profile_photo', {
      request_id: REQUEST_ID,
      upload_id: UPLOAD,
    });
    expect(result.status).toBe(422);
    expect(result.body['error']).toMatchObject({
      code: 'VALIDATION',
      fields: { photo: 'must not carry camera or location metadata' },
    });
    expect(photoStorage.remove).toHaveBeenCalledWith('avatars', AVATAR_PATH);
    expect(callRpc.mock.calls.map((call) => call[0])).toEqual(['get_photo_upload_target']);
  });

  it('refuses a session whose object never arrived', async () => {
    const callRpc = rpcFor(target);
    const result = await dispatchPhoto(deps(callRpc), 'set_profile_photo', {
      request_id: REQUEST_ID,
      upload_id: UPLOAD,
    });
    expect(result.status).toBe(422);
    expect(callRpc.mock.calls.map((call) => call[0])).toEqual(['get_photo_upload_target']);
  });

  it('without an open session, the database answers: NOT_FOUND or the recorded replay', async () => {
    const callRpc = vi.fn(async (name: string) =>
      name === 'get_photo_upload_target'
        ? { data: null }
        : { error: { message: 'NOT_FOUND', code: 'P0002' } },
    );
    const photoStorage = storage();
    const result = await dispatchPhoto(deps(callRpc, photoStorage), 'set_profile_photo', {
      request_id: REQUEST_ID,
      upload_id: UPLOAD,
    });
    expect(result.status).toBe(404);
    expect(photoStorage.read).not.toHaveBeenCalled();
  });
});

describe('remove and group photo', () => {
  it('a deleted group answers like one that never existed', async () => {
    const callRpc = vi.fn(async () => ({ error: { message: 'GROUP_DELETED', code: 'P0002' } }));
    const result = await dispatchPhoto(deps(callRpc), 'remove_group_photo', {
      request_id: REQUEST_ID,
      group_id: GROUP,
    });
    expect(result.status).toBe(404);
    expect(result.body['error']).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('remove_profile_photo takes no business field', async () => {
    const callRpc = vi.fn(async () => ({
      data: { outcome: { profile_id: PROFILE, logical_result: 'profile_photo_removed' } },
    }));
    expect(
      (await dispatchPhoto(deps(callRpc), 'remove_profile_photo', { request_id: REQUEST_ID }))
        .status,
    ).toBe(200);
    expect(
      (
        await dispatchPhoto(deps(callRpc), 'remove_profile_photo', {
          request_id: REQUEST_ID,
          upload_id: UPLOAD,
        })
      ).status,
    ).toBe(422);
  });
});

describe('tokenExpiry', () => {
  it('reads exp and ignores anything malformed', () => {
    expect(tokenExpiry(token(NOW))).toBe(NOW);
    expect(tokenExpiry('not-a-token')).toBeUndefined();
    expect(tokenExpiry('a.!!!.c')).toBeUndefined();
  });
});
