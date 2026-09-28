import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import {
  countMarkedAuthUsers,
  harnessEmail,
  installHarnessGuard,
  sweepMarkedAuthUsers,
} from './harness-guard.mjs';
import { outcomeOf, sameActorPair, track } from './lock-barrier.mjs';

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
// Marca dos usuários Auth deste harness (scripts/harness-guard.mjs).
const AUTH_EMAIL_PREFIX = 'idempotency-harness-';

// Toda falha, inclusive a rejeição sem tratador, reprova com a causa, para o
// trabalho novo, espera o que está em voo e só então limpa
// (scripts/harness-guard.mjs). Toda conexão leva o prefixo colete_idempotency_.
const guard = installHarnessGuard('db:test:idempotency', {
  applicationPrefix: 'colete_idempotency_',
  authEmailPrefix: AUTH_EMAIL_PREFIX,
});

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
    application_name: 'colete_idempotency_worker',
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

function expectFulfilled(results) {
  for (const result of results) {
    assert.equal(
      result.status,
      'fulfilled',
      `a competitor was rejected: ${result.reason?.code} ${result.reason?.message}`,
    );
  }
  return results.map((result) => result.value);
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
  // The handler is attached before any await: a competitor may reject as soon
  // as the winner commits, before this function resumes from that commit.
  const settledCompetitors = Promise.allSettled(competitors);

  await delay(250);
  await complete(winner, requestId, winnerHmac);
  await winner.query('commit');

  const results = await settledCompetitors;
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

  const settledCompetitors = Promise.allSettled(competitors);

  await delay(250);
  await firstWinner.query('rollback');
  const results = expectFulfilled(await settledCompetitors);

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

  const settledCompetitors = Promise.allSettled(competitors);

  await delay(250);
  await failedWinner.end();
  const results = expectFulfilled(await settledCompetitors);

  assert.equal(results.filter((result) => result.acquired).length, 1);
  assert.equal(results.filter((result) => !result.acquired).length, workerCount - 2);
  assert.equal(await effectCount(workers[1], scenario), 1);
  assert.equal((await storedRecord(workers[1], requestId)).state, 'completed');

  const replacement = newClient(connectionString);
  await replacement.connect();
  workers[0] = replacement;
}

// M2-D14: update_profile do mesmo ator, com request_id diferentes. O ator
// nasce por SQL: a prova é da RPC interna, e o Auth só precisa existir para a
// FK de profiles. O catálogo de políticas vazio não deixa versão pendente.
const SAME_ACTOR_STORM = 20;
const sameActor = {
  profile: '13e00000-0000-4000-8000-000000000001',
  auth: '13e10000-0000-4000-8000-000000000001',
  session: '13e20000-0000-4000-8000-000000000001',
};
const requestFor = (pair, side) =>
  `13e3${side}000-0000-4000-8000-${pair.toString(16).padStart(12, '0')}`;

async function updateProfileTx(client, requestId, patch) {
  await client.query('begin isolation level read committed');
  try {
    await client.query('set local role service_role');
    const result = await client.query(
      'select public.update_profile($1, $2, $3, $4, 1, 1, $5) as response',
      [sameActor.auth, sameActor.session, requestId, 'c'.repeat(64), patch],
    );
    await client.query('commit');
    return result.rows[0].response;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

// Remove a fixture do mesmo ator e os usuários com a marca do harness. Roda
// no início e na limpeza final do guard, depois de o trabalho em voo
// assentar; nunca toca usuário sem a marca.
async function cleanupSameActor(client) {
  await client.query('delete from private.idempotency_records where actor_id = $1', [
    sameActor.profile,
  ]);
  await client.query('delete from public.profiles where id = $1', [sameActor.profile]);
  await client.query('delete from auth.users where id = $1', [sameActor.auth]);
  await sweepMarkedAuthUsers(client, AUTH_EMAIL_PREFIX);
}

async function assertNoSameActorResidue(client) {
  const residue = await client.query(
    `select (select count(*)::integer from public.profiles where id = $1)
          + (select count(*)::integer from auth.users where id = $2)
          + (select count(*)::integer from private.idempotency_records where actor_id = $1)
            as count`,
    [sameActor.profile, sameActor.auth],
  );
  assert.equal(residue.rows[0].count, 0, 'the same-actor fixture left residue');
  assert.equal(
    await countMarkedAuthUsers(client, AUTH_EMAIL_PREFIX),
    0,
    'a marked Auth user of this harness survived the cleanup',
  );
}

// update_profile grava a idempotência, que toma FOR KEY SHARE no perfil do
// ator pela FK actor_id, e depois trava o mesmo perfil. Com FOR UPDATE, duas
// chamadas do mesmo ator esperam uma pelo FOR KEY SHARE da outra: deadlock por
// upgrade. Com FOR NO KEY UPDATE, as duas são serializadas e as duas mutações
// sobrevivem: cada patch toca um campo diferente, e o perfil final tem os dois.
async function proveSameActorUpdateProfile(connectionString) {
  const admin = newClient(connectionString);
  const applicationPrefix = 'colete_idempotency_lock_';
  const clients = Object.fromEntries(
    ['observer', 'holder', 'first', 'second'].map((role) => [
      role,
      new Client({
        application_name: `${applicationPrefix}${role}`,
        connectionString,
        connectionTimeoutMillis: 5_000,
      }),
    ]),
  );
  await Promise.all([admin, ...Object.values(clients)].map((client) => client.connect()));
  try {
    await cleanupSameActor(admin);
    await admin.query(
      `insert into auth.users (id, instance_id, aud, role, email)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
      [sameActor.auth, harnessEmail(AUTH_EMAIL_PREFIX, 'profile-lock')],
    );
    await admin.query(
      `insert into public.profiles (id, auth_user_id, name) values ($1, $2, 'Perfil concorrente')`,
      [sameActor.profile, sameActor.auth],
    );
    const profileFields = async () =>
      (
        await admin.query('select nickname, shirt_number from public.profiles where id = $1', [
          sameActor.profile,
        ])
      ).rows[0];

    const { observer, holder, first, second } = clients;
    for (const [pair, label, a, b] of [
      [1, 'same-actor update_profile order 1', first, second],
      [2, 'same-actor update_profile order 2', second, first],
    ]) {
      const results = await sameActorPair(
        { observer, holder, first: a, second: b, applicationPrefix },
        {
          label,
          profileId: sameActor.profile,
          runFirst: (connection) =>
            updateProfileTx(connection, requestFor(pair, 'a'), { nickname: `Ordem ${pair}` }),
          runSecond: (connection) =>
            updateProfileTx(connection, requestFor(pair, 'b'), { shirt_number: pair }),
        },
      );
      assert.deepEqual(results.map(outcomeOf), ['ok', 'ok'], `${label}: both must commit`);
      assert.deepEqual(await profileFields(), { nickname: `Ordem ${pair}`, shirt_number: pair });
    }
    console.log(
      'ok - same-actor update_profile pair: waits observed in both orders, no 40P01; both serialized, no lost update',
    );

    const outcomes = [];
    for (let pair = 3; pair < SAME_ACTOR_STORM + 3; pair += 1) {
      const a = track(
        updateProfileTx(first, requestFor(pair, 'a'), { nickname: `Disparo ${pair}` }),
      );
      const b = track(updateProfileTx(second, requestFor(pair, 'b'), { shirt_number: pair }));
      const results = await Promise.all([a.settled, b.settled]);
      outcomes.push({ pair, results, fields: await profileFields() });
    }
    const deadlocks = outcomes.filter(({ results }) =>
      results.some((result) => outcomeOf(result) === '40P01'),
    ).length;
    console.log(
      `same-actor update_profile storm without barrier: ${SAME_ACTOR_STORM} pairs, pairs with 40P01=${deadlocks}`,
    );
    assert.equal(
      deadlocks,
      0,
      `same-actor update_profile storm: ${deadlocks} of ${SAME_ACTOR_STORM} pairs hit 40P01`,
    );
    for (const { pair, results, fields } of outcomes) {
      assert.deepEqual(results.map(outcomeOf), ['ok', 'ok'], `storm pair ${pair}`);
      assert.deepEqual(fields, { nickname: `Disparo ${pair}`, shirt_number: pair });
    }
    console.log(
      `ok - same-actor update_profile storm: ${SAME_ACTOR_STORM} simultaneous pairs, zero 40P01, both mutations kept`,
    );
  } finally {
    // Só fecha conexões. A fixture sai na limpeza final do guard, depois de o
    // trabalho em voo assentar, e o resíduo é afirmado no censo.
    await Promise.allSettled([admin, ...Object.values(clients)].map((client) => client.end()));
  }
}

async function prepare(connectionString) {
  const client = newClient(connectionString);
  await client.connect();
  try {
    await client.query('delete from private.idempotency_records where actor_key = $1', [actorKey]);
    // Varredura inicial: o que uma execução interrompida tenha deixado.
    await cleanupSameActor(client);
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

async function cleanup(client) {
  await client.query('delete from private.idempotency_records where actor_key = $1', [actorKey]);
  await client.query('drop schema if exists idempotency_concurrency_test cascade');
  await cleanupSameActor(client);
}

async function main() {
  const connectionString = localDatabaseUrl();
  const workers = [];
  // A limpeza e o censo rodam pelo guard, numa conexão própria, depois de o
  // corpo terminar ou de o trabalho em voo assentar.
  guard.useDatabase(connectionString);
  guard.onCleanup(cleanup);
  guard.onCensus(assertNoSameActorResidue);

  try {
    await prepare(connectionString);

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
    await proveSameActorUpdateProfile(connectionString);
  } finally {
    await Promise.allSettled(workers.map((client) => client.end()));
  }
}

if (await guard.run(main)) {
  console.log('Idempotency concurrency harness passed with 25 independent connections.');
}
