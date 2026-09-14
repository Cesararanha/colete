// Account-deletion external effects from docs/22 section 4. Every attempt
// observes the provider before acting, then asks the database to reconcile the
// domain under the same lease token. Paths and Auth IDs never enter the generic
// effect row, job summary or a log.

import { WorkerEffectError } from './worker.ts';
import type { EffectHandlers, ExternalEffect } from './worker.ts';

export type DeletionEffectTarget =
  | { action: 'none'; deletion_request_id?: string }
  | { action: 'storage'; bucket: string; path: string }
  | { action: 'auth'; auth_user_id: string; deletion_request_id: string };

export interface DeletionRpc {
  getTarget(effectId: string, leaseToken: string): Promise<DeletionEffectTarget>;
  confirmEffect(effectId: string, leaseToken: string): Promise<void>;
  finalizeDeletion(requestId: string): Promise<void>;
}

export interface StorageDeletionProvider {
  exists(bucket: string, path: string): Promise<boolean>;
  remove(bucket: string, path: string): Promise<void>;
}

export interface AuthDeletionProvider {
  exists(authUserId: string): Promise<boolean>;
  remove(authUserId: string): Promise<void>;
}

export interface DeletionProviders {
  storage: StorageDeletionProvider;
  auth: AuthDeletionProvider;
}

async function deleteStorage(
  rpc: DeletionRpc,
  storage: StorageDeletionProvider,
  effect: ExternalEffect,
): Promise<void> {
  const target = await rpc.getTarget(effect.id, effect.lease_token);
  if (target.action === 'none') return;
  if (target.action !== 'storage') throw new WorkerEffectError('EFFECT_TARGET_INVALID', true);

  // An absent object is the reconciled success case, including a retry after a
  // crash that happened after the provider effect but before the DB commit.
  if (await storage.exists(target.bucket, target.path)) {
    await storage.remove(target.bucket, target.path);
    if (await storage.exists(target.bucket, target.path)) {
      throw new WorkerEffectError('STORAGE_DELETE_NOT_CONFIRMED');
    }
  }
  await rpc.confirmEffect(effect.id, effect.lease_token);
}

async function deleteAuth(
  rpc: DeletionRpc,
  auth: AuthDeletionProvider,
  effect: ExternalEffect,
): Promise<void> {
  const target = await rpc.getTarget(effect.id, effect.lease_token);
  if (target.action === 'none') {
    if (target.deletion_request_id !== undefined) {
      await rpc.finalizeDeletion(target.deletion_request_id);
    }
    return;
  }
  if (target.action !== 'auth') throw new WorkerEffectError('EFFECT_TARGET_INVALID', true);

  // Auth not-found is success. A retry always observes first, so a crash after
  // deleteUser converges without recreating or re-deleting an identity.
  if (await auth.exists(target.auth_user_id)) {
    await auth.remove(target.auth_user_id);
    if (await auth.exists(target.auth_user_id)) {
      throw new WorkerEffectError('AUTH_DELETE_NOT_CONFIRMED');
    }
  }
  await rpc.confirmEffect(effect.id, effect.lease_token);
  await rpc.finalizeDeletion(target.deletion_request_id);
}

export function accountDeletionHandlers(
  rpc: DeletionRpc,
  providers: DeletionProviders,
): EffectHandlers {
  return {
    delete_data_export: (effect) => deleteStorage(rpc, providers.storage, effect),
    delete_storage_object: (effect) => deleteStorage(rpc, providers.storage, effect),
    delete_auth_user: (effect) => deleteAuth(rpc, providers.auth, effect),
  };
}
