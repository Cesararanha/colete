// Fatias 0023/0024 (busca de endereço): o portão real do PostgreSQL
// (geocode_reserve, horários a 2 s) com o despacho produtivo da Edge
// (supabase/functions/_shared/geocode.ts) e um upstream simulado. Mede os
// instantes reais de chamada ao upstream: duas saídas nunca ficam a menos de
// 1 s, mesmo com atraso entre o portão e a chamada, com a ida e volta da RPC
// em 300–800 ms (PR F) e com várias instâncias. O Nominatim nunca é chamado.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DEFAULT_USER_AGENT, dispatchGeocode } from '../supabase/functions/_shared/geocode.ts';
import { harnessEmail, harnessEmailPattern, installHarnessGuard } from './harness-guard.mjs';
import { awaitLockWait, backendPid, track } from './lock-barrier.mjs';

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supabase = path.join(root, 'node_modules', '.bin', 'supabase');
const AUTH_PREFIX = 'geocode-gate-';
const APP_PREFIX = 'colete_geocode_';
const GATE = 'public.geocode_reserve(uuid,uuid,boolean)';
const MIN_GAP_MS = 1_000;
const guard = installHarnessGuard('db:test:geocode', {
  applicationPrefix: APP_PREFIX,
  authEmailPrefix: AUTH_PREFIX,
});

function dbUrl() {
  const output = execFileSync(supabase, ['status', '-o', 'env'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  const match = output.match(/^DB_URL="([^"]+)"$/m);
  if (!match) throw new Error('local stack missing DB_URL');
  return match[1];
}
function client(url, name) {
  return new Client({
    connectionString: url,
    application_name: `${APP_PREFIX}${name}`,
    connectionTimeoutMillis: 5000,
  });
}
async function cleanup(db) {
  const pattern = harnessEmailPattern(AUTH_PREFIX);
  const profiles = `select p.id from public.profiles p join auth.users u on u.id=p.auth_user_id
    where u.email like $1 escape '\\'`;
  await db.query('begin');
  try {
    await db.query(
      `delete from public.group_members where group_id in
         (select id from public.groups where owner_id in (${profiles}))`,
      [pattern],
    );
    await db.query(`delete from public.groups where owner_id in (${profiles})`, [pattern]);
    await db.query(`delete from public.profiles where id in (${profiles})`, [pattern]);
    await db.query("update private.geocode_throttle set last_slot_at = '-infinity'");
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function createOrganizers(db, count) {
  const actors = Array.from({ length: count }, () => ({
    authId: crypto.randomUUID(),
    profileId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
  }));
  const groupId = crypto.randomUUID();
  await db.query('begin');
  try {
    for (const actor of actors) {
      await db.query('insert into auth.users (id, email) values ($1, $2)', [
        actor.authId,
        harnessEmail(AUTH_PREFIX, actor.authId),
      ]);
      await db.query(
        `insert into public.profiles (id, auth_user_id, name, account_status)
         values ($1, $2, 'Sonda do portão', 'active')`,
        [actor.profileId, actor.authId],
      );
    }
    await db.query(`insert into public.groups (id, name, owner_id) values ($1, 'Portão', $2)`, [
      groupId,
      actors[0].profileId,
    ]);
    for (const actor of actors) {
      await db.query(
        `insert into public.group_members (group_id, profile_id, role, status)
         values ($1, $2, 'organizer', 'active')`,
        [groupId, actor.profileId],
      );
    }
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
  return actors;
}

// O despacho produtivo da Edge com a RPC real; deliveryDelay atrasa só a
// entrega da resposta do portão a esta instância, como na sonda da revisão.
function dispatcher(connection, actor, outgoing, label, deliveryDelay = () => 0, epoch) {
  return {
    actor: { authUserId: actor.authId, sessionId: actor.sessionId },
    userAgent: DEFAULT_USER_AGENT,
    cache: new Map(),
    callRpc: async (name, parameters) => {
      assert.equal(name, 'geocode_reserve');
      const result = await connection.query('select public.geocode_reserve($1, $2, $3) as answer', [
        parameters.p_actor_auth_user_id,
        parameters.p_actor_session_id,
        parameters.p_spend,
      ]);
      const delay = deliveryDelay();
      if (delay > 0) await sleep(delay);
      return { data: result.rows[0].answer };
    },
    fetchUpstream: async () => {
      outgoing.push({ label, ms: performance.now() - epoch });
      return Response.json([]);
    },
  };
}
function gaps(outgoing) {
  const sorted = [...outgoing].sort((a, b) => a.ms - b.ms);
  return sorted.slice(1).map((call, index) => call.ms - sorted[index].ms);
}

// 25 reservas simultâneas, todas paradas atrás de quem segura a agenda: os
// horários concedidos ficam a 1250 ms entre si, e só os que cabem em 3 s.
async function proveReservations(db, workers, holder, observer, actors) {
  await db.query("update private.geocode_throttle set last_slot_at = '-infinity'");
  const holderPid = await backendPid(holder);
  const workerPids = [];
  for (const worker of workers) workerPids.push(await backendPid(worker));
  await holder.query('begin');
  await holder.query('select 1 from private.geocode_throttle where id for no key update');
  let calls;
  try {
    calls = workers.map((connection, index) =>
      track(
        connection.query('select public.geocode_reserve($1, $2, true) as answer', [
          actors[index].authId,
          actors[index].sessionId,
        ]),
      ),
    );
    for (const [index, call] of calls.entries()) {
      await awaitLockWait(
        observer,
        call,
        workerPids[index],
        [holderPid, ...workerPids],
        `reservation ${index}`,
        APP_PREFIX,
      );
    }
  } finally {
    await holder.query('commit');
  }
  const results = await Promise.all(calls.map((call) => call.settled));
  for (const result of results) assert.equal(result.status, 'fulfilled', String(result.reason));
  const waits = results.map((result) => result.value.rows[0].answer.wait_ms);
  for (const result of results) assert.equal(result.value.rows[0].answer.spacing_ms, 2_000);
  const granted = waits.filter((wait) => wait !== null).sort((a, b) => a - b);
  assert.equal(granted.length, 4, 'slots at 0, 2, 4 and 6 s fit the 6 s horizon');
  assert.equal(waits.length - granted.length, 21, 'the others are refused, not queued');
  const slots = (await db.query('select last_slot_at from private.geocode_throttle')).rows[0];
  assert.ok(slots.last_slot_at instanceof Date);
  for (let index = 1; index < granted.length; index += 1) {
    assert.ok(granted[index] - granted[index - 1] >= 1_990, `slot spacing ${granted}`);
  }
  console.log(
    `ok - 25 simultaneous reservations, all observed waiting: ${granted.length} slots granted (${granted.join(', ')} ms ahead), ${waits.length - granted.length} refused`,
  );
}

// A sonda da revisão do #72: a resposta do primeiro portão chega 1350 ms
// atrasada; a segunda instância começa 1100 ms depois. Mede as chamadas reais.
async function proveDelayedGate(db, workers, actors) {
  await db.query("update private.geocode_throttle set last_slot_at = '-infinity'");
  const outgoing = [];
  const epoch = performance.now();
  let first = true;
  const a = dispatchGeocode(
    dispatcher(
      workers[0],
      actors[0],
      outgoing,
      'A',
      () => {
        const delay = first ? 1_350 : 0;
        first = false;
        return delay;
      },
      epoch,
    ),
    { query: 'Arena A sintética' },
  );
  await sleep(1_100);
  const b = dispatchGeocode(
    dispatcher(workers[1], actors[1], outgoing, 'B', () => 0, epoch),
    {
      query: 'Arena B sintética',
    },
  );
  const answers = await Promise.all([a, b]);
  for (const answer of answers) assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(outgoing.length, 2, 'both searches went out');
  const [gap] = gaps(outgoing);
  assert.ok(gap >= MIN_GAP_MS, `upstream calls ${gap.toFixed(3)} ms apart`);
  console.log(
    `ok - review probe (first gate reply 1350 ms late): upstream calls ${outgoing
      .map((call) => `${call.label}@${call.ms.toFixed(1)}`)
      .join(', ')}, gap ${gap.toFixed(1)} ms >= 1000`,
  );
  return gap;
}

// PR F: no servidor real a ida e volta da RPC passa de 250 ms. Quatro
// instâncias, 500 ms entre si, com toda resposta do portão atrasada 300 a
// 800 ms: todas buscam, e as saídas continuam a pelo menos 1 s.
async function proveSlowRoundTrip(db, workers, actors) {
  await db.query("update private.geocode_throttle set last_slot_at = '-infinity'");
  const outgoing = [];
  const epoch = performance.now();
  const delays = [300, 550, 800, 420];
  const runs = [];
  for (const [index, delay] of delays.entries()) {
    runs.push(
      dispatchGeocode(
        dispatcher(workers[index], actors[index], outgoing, `S${index}`, () => delay, epoch),
        { query: `Rua lenta ${index}` },
      ),
    );
    await sleep(500);
  }
  const answers = await Promise.all(runs);
  for (const answer of answers) assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(outgoing.length, 4, 'every slow-round-trip search went out');
  const measured = gaps(outgoing);
  for (const gap of measured) assert.ok(gap >= MIN_GAP_MS, `gaps ${measured}`);
  console.log(
    `ok - gate round trip 300-800 ms on every call, 4 instances: 4 calls, smallest gap ${Math.min(...measured).toFixed(1)} ms`,
  );
}

// Seis instâncias que começam a cada 700 ms, cada uma com um atraso fixo na
// primeira resposta do portão (dentro e fora da tolerância): toda saída fica
// a pelo menos 1 s da anterior, e quem chega atrasado reserva outro horário.
async function proveManyInstances(db, workers, actors) {
  await db.query("update private.geocode_throttle set last_slot_at = '-infinity'");
  const outgoing = [];
  const epoch = performance.now();
  const delays = [0, 200, 1_350, 100, 240, 600];
  const runs = [];
  for (const [index, delay] of delays.entries()) {
    let first = true;
    const deliver = () => {
      const value = first ? delay : 0;
      first = false;
      return value;
    };
    runs.push(
      dispatchGeocode(
        dispatcher(workers[index], actors[index], outgoing, `I${index}`, deliver, epoch),
        {
          query: `Rua sintética ${index}`,
        },
      ),
    );
    await sleep(700);
  }
  const answers = await Promise.all(runs);
  const statuses = answers.map((answer) => answer.status);
  assert.ok(
    statuses.every((status) => status === 200 || status === 429),
    statuses.join(','),
  );
  assert.equal(outgoing.length, statuses.filter((status) => status === 200).length);
  assert.ok(outgoing.length >= 3, `calls: ${JSON.stringify(outgoing)} statuses: ${statuses}`);
  const measured = gaps(outgoing);
  for (const gap of measured) assert.ok(gap >= MIN_GAP_MS, `gaps ${measured}`);
  console.log(
    `ok - 6 instances 700 ms apart, first gate replies ${delays.join('/')} ms late: ${outgoing.length} calls, ${statuses.filter((status) => status === 429).length} RATE_LIMITED, smallest gap ${Math.min(...measured).toFixed(1)} ms`,
  );
}

// Contraprova: com os horários de fato a 1250 ms (a regra da 0023) mas a
// resposta ainda dizendo 2000, a Edge usa tolerância de 1000 ms e uma
// resposta do portão 900 ms atrasada deixa duas saídas a menos de 1 s. É a
// conta S − T = 1000 que segura o espaçamento.
async function proveMarginMutant(db, workers, actors) {
  const original = (await db.query('select pg_get_functiondef($1::regprocedure) as d', [GATE]))
    .rows[0].d;
  const spacing = "interval '2000 milliseconds'";
  assert.equal(original.split(spacing).length, 2);
  const run = async () => {
    await db.query("update private.geocode_throttle set last_slot_at = '-infinity'");
    const outgoing = [];
    const epoch = performance.now();
    let first = true;
    const a = dispatchGeocode(
      dispatcher(
        workers[0],
        actors[0],
        outgoing,
        'A',
        () => {
          const delay = first ? 900 : 0;
          first = false;
          return delay;
        },
        epoch,
      ),
      { query: 'Arena mutante A' },
    );
    await sleep(20);
    const b = dispatchGeocode(
      dispatcher(workers[1], actors[1], outgoing, 'B', () => 0, epoch),
      {
        query: 'Arena mutante B',
      },
    );
    await Promise.all([a, b]);
    assert.equal(outgoing.length, 2);
    return gaps(outgoing)[0];
  };
  let mutantGap;
  try {
    await db.query(original.replace(spacing, "interval '1250 milliseconds'"));
    mutantGap = await run();
    assert.ok(mutantGap < MIN_GAP_MS, `the mutant must break the spacing (${mutantGap})`);
  } finally {
    await db.query(original);
  }
  const restoredGap = await run();
  assert.ok(restoredGap >= MIN_GAP_MS, `restored gap ${restoredGap}`);
  const live = (await db.query('select pg_get_functiondef($1::regprocedure) as d', [GATE])).rows[0]
    .d;
  assert.equal(live, original, 'geocode_reserve restored byte for byte');
  console.log(
    `ok - spacing mutant (slots really 1250 ms apart, gate reply 900 ms late): gap ${mutantGap.toFixed(1)} ms < 1000; restored: ${restoredGap.toFixed(1)} ms`,
  );
}

async function main() {
  const url = dbUrl();
  const db = client(url, 'admin');
  const observer = client(url, 'observer');
  const holder = client(url, 'holder');
  const workers = Array.from({ length: 25 }, (_, index) => client(url, `worker_${index}`));
  const all = [db, observer, holder, ...workers];
  guard.useDatabase(url);
  guard.onCleanup(cleanup);
  guard.onCensus(async (census) => {
    const users = (await census.query('select count(*)::integer as n from auth.users')).rows[0].n;
    const groups = (await census.query('select count(*)::integer as n from public.groups')).rows[0]
      .n;
    const clock = (
      await census.query(
        "select count(*)::integer as n from private.geocode_throttle where last_slot_at = '-infinity'",
      )
    ).rows[0].n;
    assert.equal(users, 0, 'auth.users after cleanup');
    assert.equal(groups, 0, 'groups after cleanup');
    assert.equal(clock, 1, 'the schedule is back to its seed');
    console.log(`ok - residue: auth.users=${users}, groups=${groups}, schedule reset=${clock}`);
  });
  let failure;
  try {
    const connected = await Promise.allSettled(all.map((connection) => connection.connect()));
    const errors = connected
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'harness connections');
    for (const worker of workers) await worker.query('set role service_role');
    await cleanup(db);
    assert.equal((await db.query('select count(*)::integer as n from auth.users')).rows[0].n, 0);
    const actors = await createOrganizers(db, 25);
    await proveReservations(db, workers, holder, observer, actors);
    await proveDelayedGate(db, workers, actors);
    await proveSlowRoundTrip(db, workers, actors);
    await proveManyInstances(db, workers, actors);
    await proveMarginMutant(db, workers, actors);
  } catch (error) {
    failure = error;
  }
  const closed = await Promise.allSettled(all.map((connection) => connection.end()));
  const closeErrors = closed
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (closeErrors.length)
    throw new AggregateError(
      failure === undefined ? closeErrors : [failure, ...closeErrors],
      'harness close',
    );
  if (failure !== undefined) throw failure;
}
if (await guard.run(main)) console.log('Geocode gate harness passed.');
