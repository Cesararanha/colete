// Pure orchestration for the scheduled worker of docs/22 section 3. Network,
// clock and handlers are injected so retry, sanitisation and lifecycle can be
// proved without a provider or a remote project.

import { computeIdempotencyHmac } from './hmac.ts';

export const WORKER_JOBS = [
  'process_external_effects',
  'health_check_jobs',
  'purge_expired_revoked_sessions',
  'purge_expired_idempotency_outcomes',
  'purge_completed_deletion_requests',
  'expire_data_exports',
] as const;

export type WorkerJob = (typeof WORKER_JOBS)[number];

export const EXTERNAL_EFFECT_KINDS = [
  'delete_auth_user',
  'delete_storage_object',
  'build_data_export',
  'delete_data_export',
  'purge_proof_object',
] as const;

export type ExternalEffectKind = (typeof EXTERNAL_EFFECT_KINDS)[number];

export interface JobSummary {
  scanned: number;
  changed: number;
  skipped: number;
  failed: number;
  stale: number;
  duration_ms: number;
  cursor?: string;
}

export interface BegunJob {
  acquired: boolean;
  run_id?: number;
  job_name: WorkerJob;
  scheduled_for: string;
  soft_deadline_seconds?: number;
  max_effects?: number;
}

export interface ExternalEffect {
  id: string;
  kind: ExternalEffectKind;
  resource_type: string;
  resource_id: string;
  dedupe_key: string;
  attempts: number;
  lease_token: string;
  lease_until: string;
}

export interface WorkerRpc {
  beginJob(job: WorkerJob): Promise<BegunJob>;
  executeDatabaseJob(runId: number): Promise<JobSummary>;
  acquireEffect(supportedKinds: readonly ExternalEffectKind[]): Promise<ExternalEffect | null>;
  completeEffect(
    effectId: string,
    leaseToken: string,
    result: 'succeeded' | 'retryable_failure' | 'permanent_failure',
    errorCode: string | null,
  ): Promise<void>;
  finishJob(
    runId: number,
    status: 'succeeded' | 'failed',
    summary: JobSummary,
    errorCode: string | null,
  ): Promise<void>;
}

export type EffectHandler = (effect: ExternalEffect) => Promise<void>;
export type EffectHandlers = Partial<Record<ExternalEffectKind, EffectHandler>>;

export class WorkerEffectError extends Error {
  readonly code: string;
  readonly permanent: boolean;

  constructor(code: string, permanent = false) {
    super(code);
    this.name = 'WorkerEffectError';
    this.code = /^[A-Z][A-Z0-9_]{0,62}$/.test(code) ? code : 'EXTERNAL_PROVIDER_FAILURE';
    this.permanent = permanent;
  }
}

// Provider status classes do not describe whether an operation can succeed on
// a later attempt. Credential rotation and throttling are transient even though
// they are 4xx. Only a request that is intrinsically malformed is terminal.
const PERMANENT_PROVIDER_STATUSES = new Set([400, 405, 406, 413, 415, 422]);

export function providerHttpError(code: string, status: number): WorkerEffectError {
  return new WorkerEffectError(code, PERMANENT_PROVIDER_STATUSES.has(status));
}

const zeroSummary = (): JobSummary => ({
  scanned: 0,
  changed: 0,
  skipped: 0,
  failed: 0,
  stale: 0,
  duration_ms: 0,
});

export function isWorkerJob(value: string): value is WorkerJob {
  return (WORKER_JOBS as readonly string[]).includes(value);
}

/** Compares every byte up to the longer input without an early mismatch exit. */
export function timingSafeEqualText(expected: string, received: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(expected);
  const right = encoder.encode(received);
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function assertJobRuntimeGoldenVector(): Promise<void> {
  const publicTestKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  const digest = await computeIdempotencyHmac(() => publicTestKey, 1, 'join_match', {
    list_kind: 'field',
    match_id: '01890f7e-e948-7c53-b13a-4a36e4b7d21e',
  });
  if (digest !== '5974c4e8c2434e4d150f2f2199180b3228c869f80e72dabc0f25218132595ee4') {
    throw new Error('WORKER_CANONICALIZATION_MISMATCH');
  }
}

function normalisedFailure(error: unknown): {
  result: 'retryable_failure' | 'permanent_failure';
  code: string;
} {
  if (error instanceof WorkerEffectError) {
    return {
      result: error.permanent ? 'permanent_failure' : 'retryable_failure',
      code: error.code,
    };
  }
  // Provider messages can contain paths, tokens, e-mails or response bodies.
  // Unknown failures collapse here and the original value is never returned,
  // persisted or passed to the logger.
  return { result: 'retryable_failure', code: 'EXTERNAL_PROVIDER_FAILURE' };
}

export async function processExternalEffects(
  rpc: WorkerRpc,
  handlers: EffectHandlers,
  maxEffects: number,
  softDeadlineSeconds: number,
  now: () => number,
): Promise<JobSummary> {
  const summary = zeroSummary();
  const startedAt = now();
  const supportedKinds = Object.keys(handlers) as ExternalEffectKind[];

  for (let count = 0; count < maxEffects; count += 1) {
    if (now() - startedAt >= softDeadlineSeconds * 1000) break;
    const effect = await rpc.acquireEffect(supportedKinds);
    if (effect === null) break;
    summary.scanned += 1;

    const handler = handlers[effect.kind];
    if (handler === undefined) {
      await rpc.completeEffect(
        effect.id,
        effect.lease_token,
        'permanent_failure',
        'HANDLER_NOT_PUBLISHED',
      );
      summary.failed += 1;
      continue;
    }

    try {
      await handler(effect);
      await rpc.completeEffect(effect.id, effect.lease_token, 'succeeded', null);
      summary.changed += 1;
    } catch (error) {
      const failure = normalisedFailure(error);
      try {
        await rpc.completeEffect(effect.id, effect.lease_token, failure.result, failure.code);
        summary.failed += 1;
      } catch {
        // A completion refused by fencing means another attempt owns the row.
        // The original error and the stale token are deliberately not logged.
        summary.stale += 1;
      }
    }
  }

  summary.duration_ms = Math.max(0, Math.floor(now() - startedAt));
  return summary;
}

export interface WorkerDependencies {
  rpc: WorkerRpc;
  handlers: EffectHandlers;
  now?: () => number;
  healthAlert?: (code: 'JOB_HEALTH_ALERT') => void;
}

export async function runScheduledJob(
  dependencies: WorkerDependencies,
  job: WorkerJob,
): Promise<'noop' | 'succeeded' | 'failed'> {
  // This executes inside the deployed Deno isolate, not only in the Node test
  // process, and closes the third-runtime golden-vector proof before work starts.
  await assertJobRuntimeGoldenVector();
  const now = dependencies.now ?? Date.now;
  const begun = await dependencies.rpc.beginJob(job);
  if (!begun.acquired || begun.run_id === undefined) return 'noop';

  let summary = zeroSummary();
  try {
    if (job === 'process_external_effects') {
      summary = await processExternalEffects(
        dependencies.rpc,
        dependencies.handlers,
        begun.max_effects ?? 0,
        begun.soft_deadline_seconds ?? 0,
        now,
      );
    } else {
      summary = await dependencies.rpc.executeDatabaseJob(begun.run_id);
      if (job === 'health_check_jobs' && (summary.failed > 0 || summary.stale > 0)) {
        dependencies.healthAlert?.('JOB_HEALTH_ALERT');
      }
    }
    await dependencies.rpc.finishJob(begun.run_id, 'succeeded', summary, null);
    return 'succeeded';
  } catch {
    const failed = { ...summary, failed: summary.failed + 1 };
    try {
      await dependencies.rpc.finishJob(begun.run_id, 'failed', failed, 'WORKER_JOB_FAILED');
    } catch {
      // The run may already have been marked abandoned by the next slot. The
      // refusal is the intended guard; no provider message is safe to surface.
    }
    return 'failed';
  }
}
