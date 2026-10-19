import { describe, expect, it, vi } from 'vitest';

import { createPhotoLoader } from './photo-urls';

const A = '30a00001-0000-4000-8000-000000000000';
const B = '30a00002-0000-4000-8000-000000000000';
const G = '30b00001-0000-4000-8000-000000000000';

describe('createPhotoLoader', () => {
  it('answers every avatar of a tick with one read and draws no photo for the rest', async () => {
    let flush: () => void = () => undefined;
    const read = vi.fn(async () => ({
      expires_in: 300,
      self: null,
      profiles: { [A]: '/storage/v1/object/sign/avatars/a.jpg?token=t' },
      groups: {},
    }));
    const load = createPhotoLoader(
      read,
      (relative) => `https://api.example${relative}`,
      () => undefined,
      (f) => {
        flush = f;
      },
    );
    const results = Promise.all([
      load('profile', A),
      load('profile', B),
      load('group', G),
      load('profile', A),
    ]);
    flush();
    expect(await results).toEqual([
      'https://api.example/storage/v1/object/sign/avatars/a.jpg?token=t',
      null,
      null,
      'https://api.example/storage/v1/object/sign/avatars/a.jpg?token=t',
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith([A, B], [G], false);
  });

  it('a failed read fails each waiter, so the screen keeps the fallback', async () => {
    let flush: () => void = () => undefined;
    const load = createPhotoLoader(
      async () => {
        throw new Error('offline');
      },
      (relative) => relative,
      () => undefined,
      (f) => {
        flush = f;
      },
    );
    const result = load('group', G);
    flush();
    await expect(result).rejects.toThrow('offline');
  });

  it('asks for the own photo by the self flag and never sends the own ID', async () => {
    let flush: () => void = () => undefined;
    const read = vi.fn(async () => ({
      expires_in: 300,
      self: '/storage/v1/object/sign/avatars/own.jpg?token=t',
      profiles: { [B]: '/storage/v1/object/sign/avatars/b.jpg?token=t' },
      groups: {},
    }));
    const load = createPhotoLoader(
      read,
      (relative) => relative,
      () => A,
      (f) => {
        flush = f;
      },
    );
    const results = Promise.all([load('profile', A), load('profile', B)]);
    flush();
    expect(await results).toEqual([
      '/storage/v1/object/sign/avatars/own.jpg?token=t',
      '/storage/v1/object/sign/avatars/b.jpg?token=t',
    ]);
    expect(read).toHaveBeenCalledWith([B], [], true);
    expect(JSON.stringify(read.mock.calls)).not.toContain(A);
  });

  it('the own avatar alone still makes one read, with no ID at all', async () => {
    let flush: () => void = () => undefined;
    const read = vi.fn(async () => ({ expires_in: 300, self: null, profiles: {}, groups: {} }));
    const load = createPhotoLoader(
      read,
      (relative) => relative,
      () => A,
      (f) => {
        flush = f;
      },
    );
    const result = load('profile', A);
    flush();
    expect(await result).toBeNull();
    expect(read).toHaveBeenCalledWith([], [], true);
  });
});
