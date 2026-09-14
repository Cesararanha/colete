import { describe, expect, it } from 'vitest';

import { accountDeletionHandlers } from './deletion.ts';
import type { DeletionEffectTarget, DeletionProviders, DeletionRpc } from './deletion.ts';
import type { ExternalEffect, ExternalEffectKind } from './worker.ts';

function effect(kind: ExternalEffectKind): ExternalEffect {
  const resourceId = 'bbbbbbbb-0000-4000-8000-000000000002';
  const deletionRequestId = 'dddddddd-0000-4000-8000-000000000004';
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    kind,
    resource_type:
      kind === 'delete_auth_user'
        ? 'deletion_request'
        : kind === 'delete_data_export'
          ? 'data_export'
          : 'profile_avatar',
    resource_id: resourceId,
    dedupe_key:
      kind === 'delete_data_export'
        ? `${kind}:${resourceId}:${deletionRequestId}`
        : `${kind}:fixture`,
    attempts: 1,
    lease_token: 'cccccccc-0000-4000-8000-000000000003',
    lease_until: '2026-09-09T12:03:00.000Z',
  };
}

function dependencies(target: DeletionEffectTarget, events: string[]) {
  const rpc: DeletionRpc = {
    getTarget: async () => {
      events.push('db:observe');
      return target;
    },
    confirmEffect: async () => {
      events.push('db:confirm');
    },
    finalizeDeletion: async () => {
      events.push('db:finalize');
    },
  };
  const providers: DeletionProviders = {
    storage: {
      exists: async () => {
        events.push('storage:observe');
        return false;
      },
      remove: async () => {
        events.push('storage:delete');
      },
    },
    auth: {
      exists: async () => {
        events.push('auth:observe');
        return false;
      },
      remove: async () => {
        events.push('auth:delete');
      },
    },
  };
  return { rpc, providers };
}

describe('account-deletion reconciliation', () => {
  it('publishes exactly the three effect kinds implemented by this slice', () => {
    const events: string[] = [];
    const deps = dependencies({ action: 'none' }, events);
    expect(Object.keys(accountDeletionHandlers(deps.rpc, deps.providers))).toEqual([
      'delete_data_export',
      'delete_storage_object',
      'delete_auth_user',
    ]);
  });

  it('treats Storage not-found as success and confirms only after observing absence', async () => {
    const events: string[] = [];
    const deps = dependencies(
      { action: 'storage', bucket: 'avatars', path: 'profiles/avatar.webp' },
      events,
    );
    await accountDeletionHandlers(deps.rpc, deps.providers).delete_storage_object?.(
      effect('delete_storage_object'),
    );
    expect(events).toEqual(['db:observe', 'storage:observe', 'db:confirm']);
  });

  it('treats Auth not-found as success, confirms it, then finalizes', async () => {
    const events: string[] = [];
    const deps = dependencies(
      {
        action: 'auth',
        auth_user_id: 'dddddddd-0000-4000-8000-000000000004',
        deletion_request_id: 'eeeeeeee-0000-4000-8000-000000000005',
      },
      events,
    );
    await accountDeletionHandlers(deps.rpc, deps.providers).delete_auth_user?.(
      effect('delete_auth_user'),
    );
    expect(events).toEqual(['db:observe', 'auth:observe', 'db:confirm', 'db:finalize']);
  });

  it('retries cleanly after a crash before any external effect', async () => {
    const events: string[] = [];
    let crash = true;
    const deps = dependencies(
      { action: 'storage', bucket: 'avatars', path: 'profiles/avatar.webp' },
      events,
    );
    deps.providers.storage.exists = async () => {
      events.push('storage:observe');
      if (crash) throw new Error('injected crash before effect');
      return false;
    };
    const handler = accountDeletionHandlers(deps.rpc, deps.providers).delete_storage_object;
    await expect(handler?.(effect('delete_storage_object'))).rejects.toThrow(
      'injected crash before effect',
    );
    expect(events).toEqual(['db:observe', 'storage:observe']);
    crash = false;
    await handler?.(effect('delete_storage_object'));
    expect(events.slice(-3)).toEqual(['db:observe', 'storage:observe', 'db:confirm']);
  });

  it('re-observes and converges after a crash immediately after Storage deletion', async () => {
    const events: string[] = [];
    let exists = true;
    let crash = true;
    const deps = dependencies(
      { action: 'storage', bucket: 'data-exports', path: 'exports/object.zip' },
      events,
    );
    deps.providers.storage.exists = async () => {
      events.push('storage:observe');
      return exists;
    };
    deps.providers.storage.remove = async () => {
      events.push('storage:delete');
      exists = false;
      if (crash) throw new Error('injected crash');
    };
    const handler = accountDeletionHandlers(deps.rpc, deps.providers).delete_data_export;
    await expect(handler?.(effect('delete_data_export'))).rejects.toThrow('injected crash');
    crash = false;
    await handler?.(effect('delete_data_export'));
    expect(exists).toBe(false);
    expect(events.slice(-3)).toEqual(['db:observe', 'storage:observe', 'db:confirm']);
  });

  it('re-enters finalization after a crash between Auth confirmation and finalize', async () => {
    const events: string[] = [];
    let target: DeletionEffectTarget = {
      action: 'auth',
      auth_user_id: 'dddddddd-0000-4000-8000-000000000004',
      deletion_request_id: 'eeeeeeee-0000-4000-8000-000000000005',
    };
    const deps = dependencies(target, events);
    deps.rpc.getTarget = async () => {
      events.push('db:observe');
      return target;
    };
    let crash = true;
    deps.rpc.confirmEffect = async () => {
      events.push('db:confirm');
      target = {
        action: 'auth',
        auth_user_id: 'dddddddd-0000-4000-8000-000000000004',
        deletion_request_id: 'eeeeeeee-0000-4000-8000-000000000005',
      };
      if (crash) throw new Error('injected crash');
    };
    const handler = accountDeletionHandlers(deps.rpc, deps.providers).delete_auth_user;
    await expect(handler?.(effect('delete_auth_user'))).rejects.toThrow('injected crash');
    crash = false;
    await handler?.(effect('delete_auth_user'));
    expect(events.at(-1)).toBe('db:finalize');
  });

  it('converges when the database confirmation committed but its response was lost', async () => {
    const events: string[] = [];
    let target: DeletionEffectTarget = {
      action: 'storage',
      bucket: 'avatars',
      path: 'profiles/avatar.webp',
    };
    let loseResponse = true;
    const deps = dependencies(target, events);
    deps.rpc.getTarget = async () => {
      events.push('db:observe');
      return target;
    };
    deps.rpc.confirmEffect = async () => {
      events.push('db:confirm');
      target = { action: 'none' };
      if (loseResponse) throw new Error('lost response after commit');
    };
    const handler = accountDeletionHandlers(deps.rpc, deps.providers).delete_storage_object;
    await expect(handler?.(effect('delete_storage_object'))).rejects.toThrow(
      'lost response after commit',
    );
    loseResponse = false;
    await handler?.(effect('delete_storage_object'));
    expect(events.slice(-1)).toEqual(['db:observe']);
  });

  it('replays finalize without a second provider call after finalization already committed', async () => {
    const events: string[] = [];
    const deps = dependencies(
      {
        action: 'none',
        deletion_request_id: 'eeeeeeee-0000-4000-8000-000000000005',
      },
      events,
    );
    await accountDeletionHandlers(deps.rpc, deps.providers).delete_auth_user?.(
      effect('delete_auth_user'),
    );
    expect(events).toEqual(['db:observe', 'db:finalize']);
  });
});
