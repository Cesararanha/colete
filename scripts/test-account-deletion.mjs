import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { localWorkerCronSecret } from './local-worker-test-config.mjs';

const { Client } = pg;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const supabaseBinary = path.join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
);
const profileIds = Array.from(
  { length: 6 },
  (_, index) => `12600000-0000-4000-8000-00000000000${index + 1}`,
);
const authIds = [];
const authEmails = [];
const PASSWORD = 'colete-local-account-deletion-password';

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
    apiUrl: read('API_URL'),
    databaseUrl: read('DB_URL'),
    functionsUrl: read('FUNCTIONS_URL'),
    publishableKey: read('PUBLISHABLE_KEY'),
    secretKey: read('SECRET_KEY'),
    serviceRoleKey: read('SERVICE_ROLE_KEY'),
  };
}

function newClient(connectionString, name) {
  return new Client({
    application_name: name,
    connectionString,
    connectionTimeoutMillis: 5_000,
  });
}

async function deleteAccount(client, profileIndex, requestId, hmac) {
  await client.query('begin isolation level read committed');
  try {
    await client.query('set local role service_role');
    const result = await client.query(
      `select public.delete_account($1, $2, $3, $4, 1, 1) as response`,
      [
        authIds[profileIndex],
        `12800000-0000-4000-8000-00000000000${profileIndex + 1}`,
        requestId,
        hmac,
      ],
    );
    await client.query('commit');
    return result.rows[0].response;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

async function setup(admin, status) {
  const created = await Promise.all(
    profileIds.map(async (_, index) => {
      const email = `account-deletion-${Date.now()}-${index}@colete.test`;
      const response = await fetch(`${status.apiUrl}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          apikey: status.secretKey,
          Authorization: `Bearer ${status.secretKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password: PASSWORD,
          email_confirm: true,
        }),
      });
      assert.equal(response.status, 200, `admin create user ${index + 1} failed`);
      return { id: (await response.json()).id, email };
    }),
  );
  authIds.splice(0, authIds.length, ...created.map(({ id }) => id));
  authEmails.splice(0, authEmails.length, ...created.map(({ email }) => email));
  await admin.query(
    `insert into public.profiles (id, auth_user_id, name, account_status)
     select profile_id, auth_id, 'Account deletion harness ' || ordinality, 'active'
     from unnest($1::uuid[], $2::uuid[]) with ordinality
       as fixture(profile_id, auth_id, ordinality)`,
    [profileIds, authIds],
  );
}

async function signIn(status, profileIndex) {
  const response = await fetch(`${status.apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: status.publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email: authEmails[profileIndex], password: PASSWORD }),
  });
  assert.equal(response.status, 200, `password grant ${profileIndex + 1} failed`);
  return (await response.json()).access_token;
}

async function callIdentity(status, operation, body, token) {
  const response = await fetch(`${status.functionsUrl}/identity/${operation}`, {
    method: 'POST',
    headers: {
      apikey: status.publishableKey,
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function tableCounts(client, schemas) {
  const tables = await client.query(
    `select table_schema, table_name
       from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema = any($1::text[])
      order by table_schema, table_name`,
    [schemas],
  );
  const counts = new Map();
  for (const { table_schema: schema, table_name: table } of tables.rows) {
    const identifier = [schema, table].map((part) => `"${part.replaceAll('"', '""')}"`).join('.');
    const result = await client.query(`select count(*)::integer as count from ${identifier}`);
    counts.set(`${schema}.${table}`, result.rows[0].count);
  }
  return counts;
}

async function cleanup(admin) {
  await admin.query(
    `delete from private.external_effects
     where resource_id in (
       select id from private.deletion_requests where profile_id = any($1::uuid[])
     ) or resource_id = any($1::uuid[])`,
    [profileIds],
  );
  await admin.query('delete from private.idempotency_records where actor_id = any($1::uuid[])', [
    profileIds,
  ]);
  await admin.query(
    'delete from private.revoked_auth_sessions where profile_id = any($1::uuid[])',
    [profileIds],
  );
  await admin.query('delete from private.deletion_requests where profile_id = any($1::uuid[])', [
    profileIds,
  ]);
  await admin.query('delete from public.privacy_requests where profile_id = any($1::uuid[])', [
    profileIds,
  ]);
  await admin.query('delete from public.profiles where id = any($1::uuid[])', [profileIds]);
  await admin.query('delete from auth.users where id = any($1::uuid[])', [authIds]);
}

async function invokeDeletionWorker(admin, functionsUrl, publishableKey) {
  // The worker-foundation harness may already have consumed this minute's
  // synthetic slot. This row is test state and is removed so this harness owns
  // an independent invocation without waiting for wall-clock rollover.
  await admin.query(
    `delete from private.job_runs
     where job_name='process_external_effects'
       and scheduled_for=date_trunc('minute', clock_timestamp())`,
  );
  const response = await fetch(`${functionsUrl}/worker/process_external_effects`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${localWorkerCronSecret()}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(response.status, 200, `the deletion worker returned ${response.status}`);
}

async function removeAvatarBucket(status) {
  const response = await fetch(`${status.apiUrl}/storage/v1/bucket/avatars`, {
    method: 'DELETE',
    headers: {
      apikey: status.serviceRoleKey,
      Authorization: `Bearer ${status.serviceRoleKey}`,
    },
  });
  assert.ok(
    response.ok || response.status === 404,
    `Storage bucket cleanup returned ${response.status}`,
  );
}

function expectDomainError(error, code) {
  return error?.code === 'P0001' && error?.message === code;
}

async function main() {
  const status = localStatus();
  const connectionString = status.databaseUrl;
  const admin = newClient(connectionString, 'colete_account_deletion_admin');
  const workers = Array.from({ length: 12 }, (_, index) =>
    newClient(connectionString, `colete_account_deletion_${index + 1}`),
  );
  await admin.connect();
  await Promise.all(workers.map((worker) => worker.connect()));
  const jobBaseline = Number(
    (await admin.query('select coalesce(max(id), 0)::text as id from private.job_runs')).rows[0].id,
  );
  let createdAvatarBucket = false;
  let tableBaseline;
  try {
    const pids = await Promise.all(
      [admin, ...workers].map(async (client) =>
        Number((await client.query('select pg_backend_pid() as pid')).rows[0].pid),
      ),
    );
    assert.equal(new Set(pids).size, pids.length, 'the harness did not open independent backends');
    console.log(`ok - ${pids.length} PostgreSQL connections use distinct backend PIDs`);

    await cleanup(admin);
    tableBaseline = await tableCounts(admin, ['public', 'private', 'auth', 'storage']);
    await setup(admin, status);

    const requestId = '12900000-0000-4000-8000-000000000001';
    const results = await Promise.all(
      workers.map((worker) => deleteAccount(worker, 0, requestId, 'a'.repeat(64))),
    );
    const protocolIds = new Set(results.map((result) => result.outcome.deletion_request_id));
    assert.equal(protocolIds.size, 1, 'concurrent replays returned more than one protocol');
    assert.equal(
      (
        await admin.query(
          'select count(*)::integer as count from private.deletion_requests where profile_id=$1',
          [profileIds[0]],
        )
      ).rows[0].count,
      1,
    );
    await assert.rejects(deleteAccount(workers[0], 0, requestId, 'b'.repeat(64)), (error) =>
      expectDomainError(error, 'IDEMPOTENCY_CONFLICT'),
    );
    console.log('ok - concurrent delete_account calls commit one saga and replay one outcome');

    const expiredRequest = '12900000-0000-4000-8000-000000000002';
    await deleteAccount(workers[0], 1, expiredRequest, 'c'.repeat(64));
    await admin.query(
      `update private.idempotency_records
       set state='payload_expired', outcome=null, payload_expired_at=outcome_expires_at,
           updated_at=outcome_expires_at
       where actor_id=$1 and operation='delete_account' and request_id=$2`,
      [profileIds[1], expiredRequest],
    );
    await assert.rejects(deleteAccount(workers[0], 1, expiredRequest, 'c'.repeat(64)), (error) =>
      expectDomainError(error, 'IDEMPOTENCY_EXPIRED'),
    );
    console.log('ok - payload_expired refuses replay without repeating account deletion');

    const crashRequest = '12900000-0000-4000-8000-000000000003';
    const crashed = newClient(connectionString, 'colete_account_deletion_crash');
    await crashed.connect();
    await crashed.query('begin isolation level read committed');
    const acquired = await crashed.query(
      `select * from private.acquire_delete_account_idempotency($1,$2,$3,1,1)`,
      [`profile:${profileIds[2]}`, crashRequest, 'd'.repeat(64)],
    );
    assert.equal(acquired.rows[0].acquired, true);
    await crashed.end();
    await deleteAccount(workers[0], 2, crashRequest, 'd'.repeat(64));
    assert.equal(
      (
        await admin.query(
          `select state from private.idempotency_records
           where actor_id=$1 and operation='delete_account' and request_id=$2`,
          [profileIds[2], crashRequest],
        )
      ).rows[0].state,
      'completed',
    );
    console.log('ok - connection loss rolls back executing state and the retry commits');

    const waitRequest = '12900000-0000-4000-8000-000000000004';
    const holder = workers[0];
    await holder.query('begin isolation level read committed');
    await holder.query(`select * from private.acquire_delete_account_idempotency($1,$2,$3,1,1)`, [
      `profile:${profileIds[3]}`,
      waitRequest,
      'e'.repeat(64),
    ]);
    const waiting = workers
      .slice(1)
      .map((worker) => deleteAccount(worker, 3, waitRequest, 'e'.repeat(64)));
    const settledWaiting = Promise.allSettled(waiting);
    await holder.query('select pg_sleep(3.5)');
    const settled = await settledWaiting;
    assert.ok(
      settled.every(
        (result) =>
          result.status === 'rejected' &&
          expectDomainError(result.reason, 'IDEMPOTENCY_WAIT_TIMEOUT'),
      ),
      'a waiter crossed the bounded idempotency timeout',
    );
    await holder.query('rollback');
    await deleteAccount(workers[1], 3, waitRequest, 'e'.repeat(64));
    console.log('ok - concurrent wait times out without residue and a later retry succeeds');

    const bucket = await admin.query(
      `insert into storage.buckets (id, name, public)
       values ('avatars', 'avatars', false)
       on conflict (id) do nothing
       returning id`,
    );
    createdAvatarBucket = bucket.rowCount === 1;
    await admin.query('update public.profiles set photo_url=$2 where id=$1', [
      profileIds[4],
      'profiles/nonexistent-avatar.webp',
    ]);
    const oldJwt = await signIn(status, 4);
    const edgeDeletion = await callIdentity(
      status,
      'delete_account',
      { request_id: '12900000-0000-4000-8000-000000000005' },
      oldJwt,
    );
    assert.equal(edgeDeletion.status, 200, JSON.stringify(edgeDeletion.body));
    assert.equal(edgeDeletion.body.data.current.status, 'requested');
    const rejectedMutation = await callIdentity(
      status,
      'update_profile',
      {
        request_id: '12900000-0000-4000-8000-000000000007',
        patch: { nickname: 'Must not commit' },
      },
      oldJwt,
    );
    assert.equal(rejectedMutation.status, 401, JSON.stringify(rejectedMutation.body));
    assert.equal(rejectedMutation.body.error.code, 'UNAUTHENTICATED');
    assert.equal(
      (await admin.query('select nickname from public.profiles where id=$1', [profileIds[4]]))
        .rows[0].nickname,
      null,
      'the rejected old-JWT mutation changed the profile',
    );
    console.log('ok - the pre-deletion JWT cannot mutate through the real identity Edge');
    await invokeDeletionWorker(admin, status.functionsUrl, status.publishableKey);
    const storageState = await admin.query(
      `select request.status as saga_status,
              exists(select 1 from auth.users where id=request.auth_user_id) as auth_exists,
              (select auth_user_id is null from public.profiles
               where id=request.profile_id) as profile_auth_redacted,
              effect.kind, effect.status as effect_status, effect.last_error_code
       from private.deletion_requests as request
       left join private.external_effects as effect
         on effect.resource_id in (request.id, request.profile_id)
       where request.profile_id=$1
       order by effect.kind`,
      [profileIds[4]],
    );
    assert.equal(
      (await admin.query('select account_status from public.profiles where id=$1', [profileIds[4]]))
        .rows[0].account_status,
      'deleted',
      `Storage 404 did not reconcile through Auth and finalization: ${JSON.stringify(storageState.rows)}`,
    );
    console.log('ok - real Storage 404 is reconciled as success before Auth deletion');

    await deleteAccount(workers[0], 5, '12900000-0000-4000-8000-000000000006', '1'.repeat(64));
    await admin.query('delete from auth.users where id=$1', [authIds[5]]);
    await invokeDeletionWorker(admin, status.functionsUrl, status.publishableKey);
    assert.equal(
      (await admin.query('select account_status from public.profiles where id=$1', [profileIds[5]]))
        .rows[0].account_status,
      'deleted',
      'Auth not-found did not reconcile through finalization',
    );
    console.log('ok - real Auth not-found is reconciled as success and finalizes once');

    await cleanup(admin);
    await admin.query('delete from private.job_runs where id > $1', [jobBaseline]);
    if (createdAvatarBucket) {
      await removeAvatarBucket(status);
      createdAvatarBucket = false;
    }
    const residue = await admin.query(`
      select table_name, rows from (
        select 'public.profiles' as table_name, count(*)::integer as rows from public.profiles
        union all select 'public.policy_acceptances', count(*)::integer from public.policy_acceptances
        union all select 'public.privacy_requests', count(*)::integer from public.privacy_requests
        union all select 'public.data_exports', count(*)::integer from public.data_exports
        union all select 'private.deletion_requests', count(*)::integer from private.deletion_requests
        union all select 'private.revoked_auth_sessions', count(*)::integer from private.revoked_auth_sessions
        union all select 'private.idempotency_records', count(*)::integer from private.idempotency_records
        union all select 'private.external_effects', count(*)::integer from private.external_effects
        union all select 'private.job_runs', count(*)::integer from private.job_runs
        union all select 'private.retention_runs', count(*)::integer from private.retention_runs
        union all select 'auth.users', count(*)::integer from auth.users
        union all select 'auth.identities', count(*)::integer from auth.identities
        union all select 'auth.sessions', count(*)::integer from auth.sessions
        union all select 'auth.refresh_tokens', count(*)::integer from auth.refresh_tokens
        union all select 'storage.objects', count(*)::integer from storage.objects
      ) as measured
      order by table_name
    `);
    assert.ok(
      residue.rows.every(({ rows }) => rows === 0),
      `owned rows remain after cleanup: ${JSON.stringify(residue.rows)}`,
    );

    const tableAfter = await tableCounts(admin, ['public', 'private', 'auth', 'storage']);
    const changedTables = [...tableAfter].filter(
      ([table, count]) => count !== tableBaseline.get(table),
    );
    assert.ok(
      changedTables.every(([table]) => table === 'auth.audit_log_entries'),
      `an undeclared table changed across the harness: ${JSON.stringify(changedTables)}`,
    );
    const auditBefore = tableBaseline.get('auth.audit_log_entries') ?? 0;
    const auditAfter = tableAfter.get('auth.audit_log_entries') ?? 0;
    const ownedCensus = Object.fromEntries(
      residue.rows.map(({ table_name, rows }) => [table_name, rows]),
    );
    console.log(`ok - measured owned-row residue by table: ${JSON.stringify(ownedCensus)}`);
    // GoTrue owns this append-only audit table and writes it by definition when
    // the harness creates, signs in and deletes real Auth users. The harness
    // reports it as accepted platform residue instead of erasing provider audit
    // evidence or falsely claiming a global zero.
    console.log(
      `ok - accepted GoTrue auth.audit_log_entries residue: total=${auditAfter}, added=${auditAfter - auditBefore}; every other table matches its baseline`,
    );
  } finally {
    await cleanup(admin).catch(() => {});
    await admin.query('delete from private.job_runs where id > $1', [jobBaseline]).catch(() => {});
    if (createdAvatarBucket) {
      await removeAvatarBucket(status).catch(() => {});
    }
    await Promise.allSettled(workers.map((worker) => worker.end()));
    await admin.end();
  }
}

await main();
