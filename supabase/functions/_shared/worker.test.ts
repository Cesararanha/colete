import { describe, expect, it } from 'vitest';

import { computeIdempotencyHmac } from './hmac.ts';
import {
  processExternalEffects,
  runScheduledJob,
  timingSafeEqualText,
  WorkerEffectError,
} from './worker.ts';
import type {
  BegunJob,
  ExternalEffect,
  ExternalEffectKind,
  JobSummary,
  WorkerRpc,
} from './worker.ts';

const effect: ExternalEffect = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  kind: 'delete_auth_user',
  resource_type: 'deletion_request',
  resource_id: 'bbbbbbbb-0000-4000-8000-000000000002',
  dedupe_key: 'delete_auth_user:bbbbbbbb-0000-4000-8000-000000000002',
  attempts: 1,
  lease_token: 'cccccccc-0000-4000-8000-000000000003',
  lease_until: '2026-09-07T12:03:00.000000Z',
};

function fakeRpc(overrides: Partial<WorkerRpc> = {}): WorkerRpc {
  return {
    beginJob: async () => ({
      acquired: true,
      run_id: 1,
      job_name: 'process_external_effects',
      scheduled_for: '2026-09-07T12:00:00.000000Z',
      soft_deadline_seconds: 120,
      max_effects: 10,
    }),
    executeDatabaseJob: async () => ({
      scanned: 0,
      changed: 0,
      skipped: 0,
      failed: 0,
      stale: 0,
      duration_ms: 0,
    }),
    acquireEffect: async () => null,
    completeEffect: async () => {},
    finishJob: async () => {},
    ...overrides,
  };
}

describe('worker runtime boundary', () => {
  it('compares the dedicated cron secret without accepting length or byte differences', () => {
    expect(timingSafeEqualText('cron-secret', 'cron-secret')).toBe(true);
    expect(timingSafeEqualText('cron-secret', 'cron-secreu')).toBe(false);
    expect(timingSafeEqualText('cron-secret', 'cron-secret-longer')).toBe(false);
  });

  it('reproduces the common HMAC golden vector in the job runtime', async () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    const digest = await computeIdempotencyHmac(() => key, 1, 'join_match', {
      list_kind: 'field',
      match_id: '01890f7e-e948-7c53-b13a-4a36e4b7d21e',
    });
    expect(digest).toBe('5974c4e8c2434e4d150f2f2199180b3228c869f80e72dabc0f25218132595ee4');
  });

  it('turns a repeated slot into a no-op without executing or finishing it', async () => {
    let touched = false;
    const begin: BegunJob = {
      acquired: false,
      job_name: 'health_check_jobs',
      scheduled_for: '2026-09-07T12:00:00.000000Z',
    };
    const result = await runScheduledJob(
      {
        rpc: fakeRpc({
          beginJob: async () => begin,
          executeDatabaseJob: async () => {
            touched = true;
            throw new Error('must not execute');
          },
          finishJob: async () => {
            touched = true;
          },
        }),
        handlers: {},
      },
      'health_check_jobs',
    );
    expect(result).toBe('noop');
    expect(touched).toBe(false);
  });

  it('closes every successful database job with its exact counter summary', async () => {
    const expected: JobSummary = {
      scanned: 4,
      changed: 3,
      skipped: 1,
      failed: 0,
      stale: 0,
      duration_ms: 7,
    };
    const finishes: unknown[] = [];
    const result = await runScheduledJob(
      {
        rpc: fakeRpc({
          beginJob: async () => ({
            acquired: true,
            run_id: 91,
            job_name: 'purge_expired_revoked_sessions',
            scheduled_for: '2026-09-07T12:17:00.000000Z',
          }),
          executeDatabaseJob: async () => expected,
          finishJob: async (...args) => {
            finishes.push(args);
          },
        }),
        handlers: {},
      },
      'purge_expired_revoked_sessions',
    );
    expect(result).toBe('succeeded');
    expect(finishes).toEqual([[91, 'succeeded', expected, null]]);
  });

  it('never passes a provider message beyond the handler boundary', async () => {
    const providerMessage =
      'https://provider.invalid/private/path?token=provider-token user@example.invalid';
    const completions: unknown[] = [];
    let acquired = false;
    const rpc = fakeRpc({
      acquireEffect: async (kinds: readonly ExternalEffectKind[]) => {
        expect(kinds).toEqual(['delete_auth_user']);
        if (acquired) return null;
        acquired = true;
        return effect;
      },
      completeEffect: async (...args) => {
        completions.push(args);
      },
    });

    const summary = await processExternalEffects(
      rpc,
      {
        delete_auth_user: async () => {
          throw new Error(providerMessage);
        },
      },
      10,
      120,
      () => 0,
    );

    expect(completions).toEqual([
      [effect.id, effect.lease_token, 'retryable_failure', 'EXTERNAL_PROVIDER_FAILURE'],
    ]);
    expect(JSON.stringify({ completions, summary })).not.toContain(providerMessage);
    expect(summary.failed).toBe(1);
  });

  it('keeps only an explicit normalised code from a typed permanent failure', async () => {
    const completions: unknown[] = [];
    let acquired = false;
    const summary = await processExternalEffects(
      fakeRpc({
        acquireEffect: async () => {
          if (acquired) return null;
          acquired = true;
          return effect;
        },
        completeEffect: async (...args) => {
          completions.push(args);
        },
      }),
      {
        delete_auth_user: async () => {
          throw new WorkerEffectError('AUTH_REFUSED', true);
        },
      },
      10,
      120,
      () => 0,
    );
    expect(completions).toEqual([
      [effect.id, effect.lease_token, 'permanent_failure', 'AUTH_REFUSED'],
    ]);
    expect(summary.failed).toBe(1);
  });
});
