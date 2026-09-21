import { describe, expect, it } from 'vitest';

import { DELETION_PROTOCOL_STORAGE_KEY, createDeletionProtocolStore } from './deletion-protocol';

const PROTOCOL = {
  id: '11111111-1111-4111-8111-111111111111',
  requested_at: '2026-09-20T12:00:00Z',
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  };
}

describe('deletion protocol storage', () => {
  it('keeps only the protocol id and instant', () => {
    const storage = memoryStorage();
    const store = createDeletionProtocolStore(() => storage);
    store.store(PROTOCOL);
    expect(store.read()).toEqual(PROTOCOL);
    expect(storage.map.get(DELETION_PROTOCOL_STORAGE_KEY)).toBe(JSON.stringify(PROTOCOL));
  });

  it('refuses a stored value that carries anything else', () => {
    const storage = memoryStorage();
    storage.setItem(
      DELETION_PROTOCOL_STORAGE_KEY,
      JSON.stringify({ ...PROTOCOL, auth_user_id: 'x' }),
    );
    expect(createDeletionProtocolStore(() => storage).read()).toBeNull();
  });

  it('notifies subscribers on change and keeps a stable snapshot otherwise', () => {
    const storage = memoryStorage();
    const store = createDeletionProtocolStore(() => storage);
    const seen: (string | null)[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()?.id ?? null));
    const before = store.getSnapshot();
    store.store(PROTOCOL);
    store.store(PROTOCOL);
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    store.clear();
    store.clear();
    unsubscribe();
    store.store(PROTOCOL);
    expect(before).toBeNull();
    expect(seen).toEqual([PROTOCOL.id, null]);
  });

  it('is empty after clearing and keeps an in-memory copy when storage is blocked', () => {
    const storage = memoryStorage();
    const store = createDeletionProtocolStore(() => storage);
    store.store(PROTOCOL);
    store.clear();
    expect(store.read()).toBeNull();
    const absent = createDeletionProtocolStore(() => undefined);
    absent.store(PROTOCOL);
    expect(absent.read()).toEqual(PROTOCOL);
    absent.clear();
    expect(absent.read()).toBeNull();
  });
});
