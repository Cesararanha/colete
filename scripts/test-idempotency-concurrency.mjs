import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Client } = pg;
const workerCount = 25;
const actorKey = 'system:concurrency_test';
const operation = 'update_profile';
const outcome = { logical_result: 'profile_updated' };
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const supabaseBinary = path.join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
);

function localDatabaseUrl() {
  if (process.env.COLETE_TEST_DATABASE_URL) {
    return process.env.COLETE_TEST_DATABASE_URL;
  }

  let status;
  try {
    status = execFileSync(supabaseBinary, ['status', '-o', 'env'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        SUPABASE_TELEMETRY_DISABLED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('The local Supabase stack is unavailable. Run npm run db:start first.');
  }

  const match = status.match(/^DB_URL="([^"]+)"$/m);
  if (!match) {
    throw new Error('Supabase status did not expose the local DB_URL.');
  }
  return match[1];
}

function newClient(connectionString) {
  return new Client({
    application_name: 'colete_idempotency_concurrency_test',
    connectionString,
    connectionTimeoutMillis: 5_000,
  });
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquire(client, requestId, inputHmac) {
  const result = await client.query(
    `select *
       from private.acquire_idempotency($1, $2, $3, $4, $5, $6)`,
    [actorKey, operation, requestId, inputHmac, 1, 1],
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function complete(client, requestId, inputHmac) {
  await client.query('select private.complete_idempotency($1, $2, $3, $4, $5, $6, $7)', [
    actorKey,
    operation,
    requestId,
    inputHmac,
    1,
    1,
    outcome,
  ]);
}

async function recordEffect(client, scenario, requestId, worker) {
  await client.query(
    `insert into idempotency_concurrency_test.effects
       (scenario, request_id, worker_number)
     values ($1, $2, $3)`,
    [scenario, requestId, worker],
  );
}

async function runMutation(
  client,
  { scenario, requestId, inputHmac, worker, holdMilliseconds = 0 },
) {
  await client.query('begin isolation level read committed');
  try {
    const result = await acquire(client, requestId, inputHmac);
    if (result.acquired) {
      await recordEffect(client, scenario, requestId, worker);
      if (holdMilliseconds > 0) {
        await client.query('select pg_sleep($1)', [holdMilliseconds / 1000]);
      }
      await complete(client, requestId, inputHmac);
    }
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

async function effectCount(client, scenario) {
  const result = await client.query(
    `select count(*)::integer as count
       from idempotency_concurrency_test.effects
      where scenario = $1`,
    [scenario],
  );
  return result.rows[0].count;
}

async function storedRecord(client, requestId) {
  const result = await client.query(
    `select state, outcome
       from private.idempotency_records
      where actor_key = $1 and operation = $2 and request_id = $3`,
    [actorKey, operation, requestId],
  );
  return result.rows[0] ?? null;
}

function expectDomainError(result, message) {
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason?.code, 'P0001');
  assert.equal(result.reason?.message, message);
}

async function testSingleWinner(workers) {
  const scenario = 'single_winner';
  const requestId = '60000000-0000-4000-8000-000000000001';
  const inputHmac = '1'.repeat(64);
  const results = await Promise.all(
    workers.map((client, worker) =>
      runMutation(client, {
        scenario,
        requestId,
        inputHmac,
        worker,
        holdMilliseconds: 250,
      }),
    ),
  );

  assert.equal(results.filter((result) => result.acquired).length, 1);
  assert.equal(results.filter((result) => !result.acquired).length, workerCount - 1);
  for (const replay of results.filter((result) => !result.acquired)) {
    assert.deepEqual(replay.outcome, outcome);
  }
  assert.equal(await effectCount(workers[0], scenario), 1);
  assert.deepEqual(await storedRecord(workers[0], requestId), {
    state: 'completed',
    outcome,
  });
}

async function testConflictAfterWait(workers) {
  const scenario = 'conflict_after_wait';
  const requestId = '60000000-0000-4000-8000-000000000002';
  const winnerHmac = '2'.repeat(64);
  const conflictingHmac = '3'.repeat(64);
  const winner = workers[0];

  await winner.query('begin isolation level read committed');
  assert.equal((await acquire(winner, requestId, winnerHmac)).acquired, true);
  await recordEffect(winner, scenario, requestId, 0);

  const competitors = workers.slice(1).map(async (client) => {
    await client.query('begin isolation level read committed');
    try {
      await acquire(client, requestId, conflictingHmac);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });

  await delay(250);
  await complete(winner, requestId, winnerHmac);
  await winner.query('commit');

  const results = await Promise.allSettled(competitors);
  for (const result of results) {
    expectDomainError(result, 'IDEMPOTENCY_CONFLICT');
  }
  assert.equal(await effectCount(workers[0], scenario), 1);
}

async function testWinnerRollback(workers) {
  const scenario = 'winner_rollback';
  const requestId = '60000000-0000-4000-8000-000000000003';
  const inputHmac = '4'.repeat(64);
  const firstWinner = workers[0];

  await firstWinner.query('begin isolation level read committed');
  assert.equal((await acquire(firstWinner, requestId, inputHmac)).acquired, true);
  await recordEffect(firstWinner, scenario, requestId, 0);

  const competitors = workers.slice(1).map((client, index) =>
    runMutation(client, {
      scenario,
      requestId,
      inputHmac,
      worker: index + 1,
    }),
  );

  await delay(250);
  await firstWinner.query('rollback');
  const results = await Promise.all(competitors);

  assert.equal(results.filter((result) => result.acquired).length, 1);
  assert.equal(results.filter((result) => !result.acquired).length, workerCount - 2);
  assert.equal(await effectCount(workers[0], scenario), 1);
  assert.equal((await storedRecord(workers[0], requestId)).state, 'completed');
}

async function testWaitTimeout(workers) {
  const scenario = 'wait_timeout';
  const requestId = '60000000-0000-4000-8000-000000000004';
  const inputHmac = '5'.repeat(64);
  const winner = workers[0];

  await winner.query('begin isolation level read committed');
  assert.equal((await acquire(winner, requestId, inputHmac)).acquired, true);
  await recordEffect(winner, scenario, requestId, 0);

  const startedAt = Date.now();
  const competitors = workers.slice(1).map(async (client) => {
    await client.query('begin isolation level read committed');
    try {
      await acquire(client, requestId, inputHmac);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  });
  const settledCompetitors = Promise.allSettled(competitors);

  await winner.query('select pg_sleep(3.5)');
  const results = await settledCompetitors;
  const elapsed = Date.now() - startedAt;
  for (const result of results) {
    expectDomainError(result, 'IDEMPOTENCY_WAIT_TIMEOUT');
  }
  assert.ok(elapsed >= 2_900, `wait timeout fired too early: ${elapsed}ms`);
  await winner.query('rollback');
  assert.equal(await effectCount(workers[0], scenario), 0);
  assert.equal(await storedRecord(workers[0], requestId), null);
}

async function testConnectionLoss(workers, connectionString) {
  const scenario = 'connection_loss';
  const requestId = '60000000-0000-4000-8000-000000000005';
  const inputHmac = '6'.repeat(64);
  const failedWinner = workers[0];

  await failedWinner.query('begin isolation level read committed');
  assert.equal((await acquire(failedWinner, requestId, inputHmac)).acquired, true);
  await recordEffect(failedWinner, scenario, requestId, 0);

  const competitors = workers.slice(1).map((client, index) =>
    runMutation(client, {
      scenario,
      requestId,
      inputHmac,
      worker: index + 1,
    }),
  );

  await delay(250);
  await failedWinner.end();
  const results = await Promise.all(competitors);

  assert.equal(results.filter((result) => result.acquired).length, 1);
  assert.equal(results.filter((result) => !result.acquired).length, workerCount - 2);
  assert.equal(await effectCount(workers[1], scenario), 1);
  assert.equal((await storedRecord(workers[1], requestId)).state, 'completed');

  const replacement = newClient(connectionString);
  await replacement.connect();
  workers[0] = replacement;
}

async function prepare(connectionString) {
  const client = newClient(connectionString);
  await client.connect();
  try {
    await client.query('delete from private.idempotency_records where actor_key = $1', [actorKey]);
    await client.query('drop schema if exists idempotency_concurrency_test cascade');
    await client.query('create schema idempotency_concurrency_test');
    await client.query(`
      create table idempotency_concurrency_test.effects (
        scenario text not null,
        request_id uuid not null,
        worker_number integer not null,
        primary key (scenario, request_id)
      )
    `);
  } finally {
    await client.end();
  }
}

async function cleanup(connectionString, workers) {
  await Promise.allSettled(workers.map((client) => client.end()));

  const client = newClient(connectionString);
  await client.connect();
  try {
    await client.query('delete from private.idempotency_records where actor_key = $1', [actorKey]);
    await client.query('drop schema if exists idempotency_concurrency_test cascade');
  } finally {
    await client.end();
  }
}

async function main() {
  const connectionString = localDatabaseUrl();
  const workers = [];
  let prepared = false;

  try {
    await prepare(connectionString);
    prepared = true;

    for (let index = 0; index < workerCount; index += 1) {
      const client = newClient(connectionString);
      await client.connect();
      workers.push(client);
    }

    const connectionFacts = await Promise.all(
      workers.map((client) =>
        client.query('select pg_backend_pid() as pid, current_setting($1) as isolation', [
          'transaction_isolation',
        ]),
      ),
    );
    assert.equal(
      new Set(connectionFacts.map(({ rows }) => rows[0].pid)).size,
      workerCount,
      'workers must be independent PostgreSQL connections',
    );
    assert.ok(
      connectionFacts.every(({ rows }) => rows[0].isolation === 'read committed'),
      'every worker must use READ COMMITTED',
    );

    await testSingleWinner(workers);
    console.log('ok - 25 callers produce one winner and one replay outcome');
    await testConflictAfterWait(workers);
    console.log('ok - conflicting input waits, then receives IDEMPOTENCY_CONFLICT');
    await testWinnerRollback(workers);
    console.log('ok - rollback releases the key and rolls back the product effect');
    await testWaitTimeout(workers);
    console.log('ok - an in-flight winner is never taken over after 3000ms');
    await testConnectionLoss(workers, connectionString);
    console.log('ok - connection loss rolls back and a retry executes exactly once');
    console.log('Idempotency concurrency harness passed with 25 independent connections.');
  } finally {
    if (prepared) {
      await cleanup(connectionString, workers);
    } else {
      await Promise.allSettled(workers.map((client) => client.end()));
    }
  }
}

await main();
