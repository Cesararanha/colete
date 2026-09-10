import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { localWorkerCronSecret } from './local-worker-test-config.mjs';
import { processExternalEffects } from '../supabase/functions/_shared/worker.ts';

const { Client } = pg;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const supabaseBinary = path.join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
);
const testPrefix = 'worker-harness:';

function localStatus() {
  let output;
  try {
    output = execFileSync(supabaseBinary, ['status', '-o', 'env'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('The local Supabase stack is unavailable. Run npm run db:start first.');
  }

  const read = (name) => {
    const match = output.match(new RegExp(`^${name}="([^"]+)"$`, 'm'));
    if (!match) throw new Error(`Supabase status did not expose ${name}.`);
    return match[1];
  };
  return {
    databaseUrl: read('DB_URL'),
    functionsUrl: read('FUNCTIONS_URL'),
    publishableKey: read('PUBLISHABLE_KEY'),
  };
}

function newClient(connectionString, applicationName) {
  return new Client({
    application_name: applicationName,
    connectionString,
    connectionTimeoutMillis: 5_000,
  });
}

async function asService(client, text, values = []) {
  await client.query('begin');
  try {
    await client.query('set local role service_role');
    const result = await client.query(text, values);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

async function acquire(client, kinds = ['delete_auth_user']) {
  const result = await asService(
    client,
    'select public.worker_acquire_external_effect($1::text[]) as effect',
    [kinds],
  );
  return result.rows[0].effect;
}

async function complete(client, effectId, leaseToken, result, errorCode = null) {
  const response = await asService(
    client,
    `select public.worker_complete_external_effect($1, $2, $3, $4) as effect`,
    [effectId, leaseToken, result, errorCode],
  );
  return response.rows[0].effect;
}

async function insertPending(admin, id, suffix, createdAt = null) {
  await admin.query(
    `insert into private.external_effects
       (id, kind, resource_type, resource_id, dedupe_key, created_at)
     values ($1, 'delete_auth_user', 'deletion_request', $2,
             $3, coalesce($4, clock_timestamp()))`,
    [id, id.replace(/^1/, '2'), `${testPrefix}${suffix}`, createdAt],
  );
}

function expectedBackoff(effectId, attempts) {
  const raw = Math.min(3600, 60 * 2 ** (attempts - 1));
  const half = Math.floor(raw / 2);
  const bucket = createHash('sha256')
    .update(`${effectId}${attempts}`, 'utf8')
    .digest()
    .readUInt32BE(0);
  return half + (bucket % (raw - half + 1));
}

async function expectConcurrentChange(action, message) {
  await assert.rejects(
    action,
    (error) => error?.code === 'P0001' && error?.message === 'CONCURRENT_CHANGE',
    message,
  );
}

async function testSingleLease(admin, firstWorker, secondWorker) {
  const id = '11000000-0000-4000-8000-000000000101';
  await insertPending(admin, id, 'single-lease');
  const [first, second] = await Promise.all([acquire(firstWorker), acquire(secondWorker)]);
  const acquired = [first, second].filter((value) => value !== null);
  assert.equal(acquired.length, 1, 'two workers acquired the same eligible effect');
  assert.equal(acquired[0].id, id);
  await complete(
    first !== null ? firstWorker : secondWorker,
    id,
    acquired[0].lease_token,
    'succeeded',
  );
  assert.equal(
    (await admin.query('select status from private.external_effects where id=$1', [id])).rows[0]
      .status,
    'succeeded',
  );
  console.log('ok - two independent workers produce exactly one lease owner');
}

async function testProviderFakesAndControlledClock() {
  const providerMessage =
    'storage provider said token=raw-provider-token path=exports/private-object.zip';
  const queue = [
    {
      id: '41000000-0000-4000-8000-000000000001',
      kind: 'delete_auth_user',
      resource_type: 'deletion_request',
      resource_id: '42000000-0000-4000-8000-000000000001',
      dedupe_key: 'fake-auth',
      attempts: 1,
      lease_token: '43000000-0000-4000-8000-000000000001',
      lease_until: '2026-09-07T12:03:00.000000Z',
    },
    {
      id: '41000000-0000-4000-8000-000000000002',
      kind: 'delete_storage_object',
      resource_type: 'data_export',
      resource_id: '42000000-0000-4000-8000-000000000002',
      dedupe_key: 'fake-storage',
      attempts: 1,
      lease_token: '43000000-0000-4000-8000-000000000002',
      lease_until: '2026-09-07T12:03:00.000000Z',
    },
  ];
  const completions = [];
  const auth = { deleteUser: async () => {} };
  const storage = {
    remove: async () => {
      throw new Error(providerMessage);
    },
  };
  let controlledNow = 1_000;
  const rpc = {
    beginJob: async () => {
      throw new Error('not used');
    },
    executeDatabaseJob: async () => {
      throw new Error('not used');
    },
    acquireEffect: async (kinds) => {
      const next = queue[0];
      if (next === undefined || !kinds.includes(next.kind)) return null;
      return queue.shift();
    },
    completeEffect: async (...args) => {
      completions.push(args);
    },
    finishJob: async () => {
      throw new Error('not used');
    },
  };

  const summary = await processExternalEffects(
    rpc,
    {
      delete_auth_user: async () => auth.deleteUser(),
      delete_storage_object: async () => storage.remove(),
    },
    10,
    120,
    () => {
      controlledNow += 7;
      return controlledNow;
    },
  );
  assert.deepEqual(completions, [
    [
      '41000000-0000-4000-8000-000000000001',
      '43000000-0000-4000-8000-000000000001',
      'succeeded',
      null,
    ],
    [
      '41000000-0000-4000-8000-000000000002',
      '43000000-0000-4000-8000-000000000002',
      'retryable_failure',
      'EXTERNAL_PROVIDER_FAILURE',
    ],
  ]);
  assert.equal(summary.scanned, 2);
  assert.equal(summary.changed, 1);
  assert.equal(summary.failed, 1);
  assert.ok(summary.duration_ms > 0);
  assert.doesNotMatch(
    JSON.stringify({ completions, summary }),
    /raw-provider-token|private-object/,
  );
  console.log('ok - fake Auth/Storage providers and a controlled clock leak no provider message');
}

async function testExpiryAndFencing(admin, oldWorker, newWorker) {
  const id = '11000000-0000-4000-8000-000000000102';
  await insertPending(admin, id, 'expiry-fencing');
  const first = await acquire(oldWorker);
  assert.equal(first.id, id);
  await admin.query(
    `update private.external_effects set lease_until=clock_timestamp()-interval '1 second'
      where id=$1`,
    [id],
  );

  await expectConcurrentChange(
    () => complete(oldWorker, id, first.lease_token, 'succeeded'),
    'completion after lease_until was not rejected',
  );
  assert.equal(
    (await admin.query('select status from private.external_effects where id=$1', [id])).rows[0]
      .status,
    'leased',
  );

  // Executable counterproof 1: the same fixture is mutable by the defective
  // predicate (id + status only). The production RPC must therefore be what
  // rejects it on lease time, not an accidentally terminal fixture.
  await admin.query('begin');
  const unsafeExpired = await admin.query(
    `update private.external_effects
        set status='succeeded', lease_token=null, lease_until=null, completed_at=clock_timestamp()
      where id=$1 and status='leased' returning id`,
    [id],
  );
  assert.equal(unsafeExpired.rowCount, 1);
  await admin.query('rollback');
  console.log('counterproof - id/status-only completion would accept an expired lease');

  const second = await acquire(newWorker);
  assert.equal(second.id, id, 'the expired lease did not converge to a new attempt');
  assert.notEqual(second.lease_token, first.lease_token, 'reacquisition reused the fencing token');
  assert.equal(second.attempts, 2);

  await expectConcurrentChange(
    () => complete(oldWorker, id, first.lease_token, 'succeeded'),
    'the old fencing token completed the new attempt',
  );

  // Executable counterproof 2: without the token predicate, a stale worker can
  // mutate the currently live attempt. Roll back the deliberately bad update.
  await admin.query('begin');
  const unsafeFencing = await admin.query(
    `update private.external_effects
        set status='succeeded', lease_token=null, lease_until=null, completed_at=clock_timestamp()
      where id=$1 and status='leased' returning id`,
    [id],
  );
  assert.equal(unsafeFencing.rowCount, 1);
  await admin.query('rollback');
  console.log('counterproof - id/status-only completion would let the old worker win');

  await complete(newWorker, id, second.lease_token, 'succeeded');
  console.log('ok - expiry is time-fenced, rotates the token and converges safely');
}

async function testNullsFirstOrdering(admin, worker) {
  const retryId = '11000000-0000-4000-8000-000000000103';
  const pendingId = '11000000-0000-4000-8000-000000000104';
  await admin.query(
    `insert into private.external_effects
       (id, kind, resource_type, resource_id, dedupe_key, status, attempts,
        next_attempt_at, last_error_code, created_at)
     values ($1, 'delete_auth_user', 'deletion_request', $2, $3,
             'failed_retryable', 1, clock_timestamp()-interval '1 hour',
             'TEMPORARY', clock_timestamp()-interval '2 hours')`,
    [retryId, retryId.replace(/^1/, '2'), `${testPrefix}retry-due`],
  );
  await insertPending(admin, pendingId, 'pending-new');

  // Executable counterproof 3: NULLS LAST is the previously identified defect.
  // It chooses the overdue retry and makes this exact fixture distinguish the
  // correct ordering from the wrong one.
  const faulty = await admin.query(
    `select id from private.external_effects
      where dedupe_key like $1 and status in ('pending','failed_retryable')
      order by next_attempt_at asc nulls last, created_at, id limit 1`,
    [`${testPrefix}%`],
  );
  assert.equal(faulty.rows[0].id, retryId);
  console.log('counterproof - NULLS LAST selects the overdue retry ahead of new work');

  const first = await acquire(worker);
  assert.equal(first.id, pendingId, 'new work did not precede the due retry');
  await complete(worker, first.id, first.lease_token, 'succeeded');
  const second = await acquire(worker);
  assert.equal(second.id, retryId);
  await complete(worker, second.id, second.lease_token, 'succeeded');
  console.log('ok - next_attempt_at NULLS FIRST preserves new-work priority');
}

async function testBackoffAndEighthAttempt(admin, worker) {
  for (const attempts of [1, 2, 3, 4, 5, 6, 7]) {
    const id = `11000000-0000-4000-8000-${String(200 + attempts).padStart(12, '0')}`;
    const token = `31000000-0000-4000-8000-${String(200 + attempts).padStart(12, '0')}`;
    await admin.query(
      `insert into private.external_effects
         (id, kind, resource_type, resource_id, dedupe_key, status, attempts,
          lease_token, lease_until)
       values ($1, 'delete_auth_user', 'deletion_request', $2, $3, 'leased', $4,
               $5, clock_timestamp()+interval '10 minutes')`,
      [id, id.replace(/^1/, '2'), `${testPrefix}backoff-${attempts}`, attempts, token],
    );
    const result = await complete(worker, id, token, 'retryable_failure', 'TEMPORARY');
    const actualSeconds =
      (new Date(result.next_attempt_at).getTime() - new Date(result.decided_at).getTime()) / 1000;
    assert.equal(
      actualSeconds,
      expectedBackoff(id, attempts),
      `attempt ${attempts} backoff drifted`,
    );
  }

  const eighthId = '11000000-0000-4000-8000-000000000208';
  const eighthToken = '31000000-0000-4000-8000-000000000208';
  await admin.query(
    `insert into private.external_effects
       (id, kind, resource_type, resource_id, dedupe_key, status, attempts,
        lease_token, lease_until)
     values ($1, 'delete_auth_user', 'deletion_request', $2, $3, 'leased', 8,
             $4, clock_timestamp()+interval '10 minutes')`,
    [eighthId, eighthId.replace(/^1/, '2'), `${testPrefix}backoff-8`, eighthToken],
  );
  const eighth = await complete(worker, eighthId, eighthToken, 'retryable_failure', 'TEMPORARY');
  assert.equal(eighth.status, 'dead');
  assert.equal(eighth.next_attempt_at, null);
  const capped = expectedBackoff('11000000-0000-4000-8000-000000000207', 7);
  assert.ok(capped >= 1800 && capped <= 3600, 'the capped equal-jitter range is wrong');
  console.log(
    'ok - deterministic equal jitter, 3600s cap and eighth-attempt dead letter are exact',
  );
}

async function invokeWorker(functionsUrl, publishableKey, job, secret = localWorkerCronSecret()) {
  return fetch(`${functionsUrl}/worker/${job}`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ignored: 'body body cannot choose an effect' }),
  });
}

async function testJobLifecycle(admin, service, functionsUrl, publishableKey, jobBaseline) {
  const baseline = Number(
    (await admin.query('select coalesce(max(id),0)::text as id from private.retention_runs'))
      .rows[0].id,
  );
  const beforeUnauthorized = Number(
    (await admin.query('select count(*)::text as count from private.job_runs')).rows[0].count,
  );
  const denied = await invokeWorker(functionsUrl, publishableKey, 'health_check_jobs', 'wrong');
  assert.equal(denied.status, 401);
  assert.equal(
    Number(
      (await admin.query('select count(*)::text as count from private.job_runs')).rows[0].count,
    ),
    beforeUnauthorized,
    'invalid cron authentication created a job run',
  );

  const abandoned = await admin.query(
    `insert into private.job_runs
       (run_key, job_name, triggered_by, scheduled_for, started_at, status)
     values ($1, 'health_check_jobs', 'cron', clock_timestamp()-interval '10 minutes',
             clock_timestamp()-interval '10 minutes', 'running') returning id`,
    ['cron:health_check_jobs:2000-01-01T00:00:00Z'],
  );

  for (const job of [
    'process_external_effects',
    'health_check_jobs',
    'purge_expired_revoked_sessions',
    'purge_expired_idempotency_outcomes',
  ]) {
    const response = await invokeWorker(functionsUrl, publishableKey, job);
    assert.equal(response.status, 200, `${job} endpoint failed: ${await response.text()}`);
  }
  console.log('ok - scheduled Edge invocations pass the in-isolate job-runtime golden vector');

  const abandonedState = (
    await admin.query('select status,error_code from private.job_runs where id=$1', [
      abandoned.rows[0].id,
    ])
  ).rows[0];
  assert.deepEqual(abandonedState, { status: 'failed', error_code: 'RUN_ABANDONED' });
  await expectConcurrentChange(
    () =>
      asService(
        service,
        `select public.worker_finish_job(
          $1, 'succeeded',
          '{"scanned":0,"changed":0,"skipped":0,"failed":0,"stale":0,"duration_ms":0}',
          null)`,
        [abandoned.rows[0].id],
      ),
    'an abandoned job was rewritten as success',
  );

  assert.equal(
    Number(
      (
        await admin.query(
          `select count(*)::text as count from private.job_runs
            where run_key like 'cron:%' and status='running'`,
        )
      ).rows[0].count,
    ),
    0,
    'a worker invocation left a current run open',
  );
  const completedJobs = await admin.query(
    `select job_name,status from private.job_runs
      where run_key like 'cron:%' and id>$1 and id<>$2 order by job_name`,
    [jobBaseline, abandoned.rows[0].id],
  );
  for (const job of completedJobs.rows) assert.equal(job.status, 'succeeded');

  const duplicate = await invokeWorker(functionsUrl, publishableKey, 'health_check_jobs');
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).data.status, 'noop');
  await admin.query('delete from private.retention_runs where id>$1', [baseline]);
  console.log(
    'ok - auth fails before job_runs; every run closes and abandoned never becomes success',
  );
}

async function testServiceRoleBoundary(service) {
  const privilege = await service.query(
    `select has_schema_privilege('service_role','private','usage') as usage,
            has_table_privilege('service_role','private.external_effects','update') as dml`,
  );
  assert.deepEqual(privilege.rows[0], { usage: false, dml: false });

  await service.query('begin');
  try {
    await service.query('set local role service_role');
    await assert.rejects(
      () => service.query('select * from private.external_effects'),
      (error) => error?.code === '42501',
    );
  } finally {
    await service.query('rollback');
  }
  console.log('ok - service_role has nominal RPCs but no private schema usage or direct DML');
}

async function cleanup(admin, clients, retentionBaseline, jobBaseline) {
  await Promise.allSettled(clients.map((client) => client.end()));
  await admin.query('delete from private.external_effects where dedupe_key like $1', [
    `${testPrefix}%`,
  ]);
  await admin.query('delete from private.job_runs where id>$1', [jobBaseline]);
  await admin.query('delete from private.retention_runs where id>$1', [retentionBaseline]);
}

async function main() {
  const { databaseUrl, functionsUrl, publishableKey } = localStatus();
  const admin = newClient(databaseUrl, 'colete_worker_foundation_admin');
  const firstWorker = newClient(databaseUrl, 'colete_worker_foundation_worker_1');
  const secondWorker = newClient(databaseUrl, 'colete_worker_foundation_worker_2');
  const clients = [admin, firstWorker, secondWorker];
  for (const client of clients) await client.connect();

  const pids = await Promise.all(
    clients.map((client) => client.query('select pg_backend_pid() pid')),
  );
  assert.equal(new Set(pids.map(({ rows }) => rows[0].pid)).size, clients.length);
  const retentionBaseline = Number(
    (await admin.query('select coalesce(max(id),0)::text id from private.retention_runs')).rows[0]
      .id,
  );
  const jobBaseline = Number(
    (await admin.query('select coalesce(max(id),0)::text id from private.job_runs')).rows[0].id,
  );

  try {
    await admin.query('delete from private.external_effects where dedupe_key like $1', [
      `${testPrefix}%`,
    ]);
    await admin.query('delete from private.job_runs where run_key like $1', [`${testPrefix}%`]);
    await testProviderFakesAndControlledClock();
    await testSingleLease(admin, firstWorker, secondWorker);
    await testExpiryAndFencing(admin, firstWorker, secondWorker);
    await testNullsFirstOrdering(admin, firstWorker);
    await testBackoffAndEighthAttempt(admin, firstWorker);
    await testServiceRoleBoundary(firstWorker);
    await testJobLifecycle(admin, firstWorker, functionsUrl, publishableKey, jobBaseline);
    console.log('Worker foundation harness passed with three independent PostgreSQL connections.');
  } finally {
    await cleanup(admin, [firstWorker, secondWorker], retentionBaseline, jobBaseline);
    await admin.end();
  }
}

await main();
