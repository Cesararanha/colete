import { z } from '../../lib/zod';

// docs/22 section 6: once Auth is gone, the shell keeps only the protocol and
// stops claiming a status it can no longer verify. The protocol is a request
// identifier and an instant; it carries no Auth ID, no e-mail and no name, and
// it is the only privacy fact the client is allowed to keep locally.
export const DELETION_PROTOCOL_STORAGE_KEY = 'colete.deletion-protocol.v1';

const storedDeletionProtocolSchema = z.object({ id: z.uuid(), requested_at: z.string() }).strict();

export type StoredDeletionProtocol = z.output<typeof storedDeletionProtocolSchema>;

type KeyValueStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

function browserStorage(): KeyValueStorage | undefined {
  try {
    return typeof globalThis.localStorage === 'undefined' ? undefined : globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readFrom(storage: () => KeyValueStorage | undefined): StoredDeletionProtocol | null {
  try {
    const raw = storage()?.getItem(DELETION_PROTOCOL_STORAGE_KEY);
    if (raw === null || raw === undefined) return null;
    const parsed = storedDeletionProtocolSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * A tiny external store so that screens can subscribe with
 * `useSyncExternalStore` instead of mirroring the value in component state.
 */
export function createDeletionProtocolStore(storage: () => KeyValueStorage | undefined) {
  let snapshot: StoredDeletionProtocol | null | undefined;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const read = (): StoredDeletionProtocol | null => {
    snapshot ??= readFrom(storage);
    return snapshot;
  };

  // Methods are closures, not `this`-bound: React reads `getSnapshot` and
  // `subscribe` as detached functions.
  return {
    read,
    getSnapshot: read,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    store(protocol: StoredDeletionProtocol): void {
      const current = read();
      if (current?.id === protocol.id && current.requested_at === protocol.requested_at) return;
      try {
        storage()?.setItem(DELETION_PROTOCOL_STORAGE_KEY, JSON.stringify(protocol));
      } catch {
        // A blocked storage only loses the offline copy of the protocol.
      }
      snapshot = protocol;
      notify();
    },
    clear(): void {
      try {
        storage()?.removeItem(DELETION_PROTOCOL_STORAGE_KEY);
      } catch {
        // Nothing to clear when storage is unavailable.
      }
      if (snapshot === null) return;
      snapshot = null;
      notify();
    },
  };
}

export const deletionProtocolStore = createDeletionProtocolStore(browserStorage);
