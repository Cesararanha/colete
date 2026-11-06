// 0034: real commits under service_role, lock barriers, migration data and residual census.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import pg from 'pg';
import { assertDistinctConnections, awaitLockWait, track } from './lock-barrier.mjs';

const output = execFileSync('./node_modules/.bin/supabase', ['status', '-o', 'env'], {
  encoding: 'utf8',
  env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const localValue = (name) => output.match(new RegExp(`^${name}="([^"]+)"$`, 'm'))?.[1];
const apiUrl = localValue('API_URL');
const functionsUrl = localValue('FUNCTIONS_URL');
const secret = localValue('SECRET_KEY');
const publishable = localValue('PUBLISHABLE_KEY');
const url = output.match(/^DB_URL="([^"]+)"$/m)?.[1];
assert.ok(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'local database only');
const clients = Object.fromEntries(
  ['observer', 'holder', 'first', 'second'].map((key) => [
    key,
    new pg.Client({ connectionString: url, application_name: `colete_refunds_${key}` }),
  ]),
);
await Promise.all(Object.values(clients).map((client) => client.connect()));
const { observer: db, holder, first, second } = clients;
const pids = await assertDistinctConnections(clients, 'refund barriers');
const auth = '34000000-0000-4000-8000-000000000001';
const organizer = '34000000-0000-4000-8000-000000000002';
const group = '34200000-0000-4000-8000-000000000001';
const match = '34300000-0000-4000-8000-000000000001';
const target = '34100000-0000-4000-8000-000000000003';
const session = '34900000-0000-4000-8000-000000000000';
const request = () => crypto.randomUUID();
const databaseNow = async () =>
  (await db.query('select clock_timestamp() as instant')).rows[0].instant.toISOString();
async function rpc(client, op, tail, actor = auth, req = request()) {
  const types = ['mark_refunded', 'correct_refund'].includes(op)
    ? '$7::uuid,$8::uuid,$9::timestamptz'
    : op === 'set_match_payment'
      ? '$7::uuid,$8::uuid,$9::boolean'
      : ['correct_refund', 'record_canceled_match_payment'].includes(op)
        ? '$7::uuid,$8::uuid'
        : '$7::uuid';
  return (
    await client.query(
      `select public.${op}($1::uuid,$2::uuid,$3::uuid,$4::text,$5::integer,$6::integer,${types}) as r`,
      [actor, session, req, 'a'.repeat(64), 1, 1, ...tail],
    )
  ).rows[0].r;
}
let originalLock;
let realAuthId;
let realProfileId;
try {
  const sql = fs.readFileSync('supabase/tests/database/0034_match_refunds.test.sql', 'utf8');
  const fixture = sql.slice(
    sql.indexOf('insert into auth.users'),
    sql.indexOf('create function pg_temp.cfg'),
  );
  await db.query('begin');
  await db.query(fixture);
  await db.query('commit');
  await first.query('set role service_role');
  await second.query('set role service_role');
  const cancel = await rpc(first, 'cancel_match', [match]);
  assert.deepEqual(Object.keys(cancel.outcome).sort(), ['group_id', 'logical_result', 'match_id']);
  const refund = (
    await db.query(
      'select r.id from private.match_refunds r join private.match_players p on p.id=r.match_player_id where p.match_id=$1',
      [match],
    )
  ).rows[0].id;
  await holder.query('begin');
  await holder.query('select 1 from public.groups where id=$1 for no key update', [group]);
  const marking = track(rpc(first, 'mark_refunded', [match, refund, await databaseNow()]));
  await awaitLockWait(
    db,
    marking,
    pids.first,
    pids.holder,
    'mark waits for group',
    'colete_refunds_',
  );
  await holder.query('commit');
  assert.equal((await marking.settled).status, 'fulfilled');
  console.log('ok - mark_refunded commits under service_role after the group barrier');
  await first.query('begin');
  const correctedAt = await databaseNow();
  await rpc(first, 'correct_refund', [match, refund, correctedAt]);
  const correction = track(rpc(second, 'correct_refund', [match, refund, correctedAt], organizer));
  await awaitLockWait(
    db,
    correction,
    pids.second,
    pids.first,
    'two corrections serialize',
    'colete_refunds_',
  );
  await first.query('commit');
  const corrected = await correction.settled;
  assert.equal(corrected.status, 'fulfilled');
  assert.equal(corrected.value.outcome.logical_result, 'refund_correction_unchanged');
  await db.query(
    "update private.match_refunds set status='refund_due',refunded_at=null where id=$1",
    [refund],
  );
  await first.query('begin');
  await rpc(first, 'mark_refunded', [match, refund, await databaseNow()]);
  const mark2 = track(
    rpc(second, 'mark_refunded', [match, refund, await databaseNow()], organizer),
  );
  await awaitLockWait(db, mark2, pids.second, pids.first, 'two marks serialize', 'colete_refunds_');
  await first.query('commit');
  const marked = await mark2.settled;
  assert.equal(marked.status, 'fulfilled');
  assert.equal(marked.value.outcome.logical_result, 'refund_unchanged');
  console.log('ok - two marks and two corrections serialize, each with real commits');
  // A valid resource FK but malformed conclusion: only the deferred trigger refuses COMMIT.
  for (const completed of [false, true]) {
    await db.query('begin');
    await db.query(
      `insert into private.idempotency_records(actor_key,actor_id,operation,request_id,request_hash,hash_key_version) values($1,$2,'mark_refunded',$3,repeat('a',64),1)`,
      [
        `profile:34100000-0000-4000-8000-000000000001`,
        '34100000-0000-4000-8000-000000000001',
        request(),
      ],
    );
    if (completed)
      await db.query(
        `update private.idempotency_records set state='completed',completed_at=now(),resource_type='group',resource_id=$1::uuid,outcome_code='refund_recorded',outcome=jsonb_build_object('group_id',$1::uuid::text,'match_id',$2::uuid::text,'refund_id',$3::uuid::text,'logical_result','refund_recorded','extra','forbidden') where operation='mark_refunded' and state='executing_uncommitted'`,
        [group, match, refund],
      );
    await db.query('set local role service_role');
    await assert.rejects(db.query('commit'), (error) => ['23514', '22023'].includes(error.code));
    await db.query('rollback');
  }
  console.log(
    'ok - deferred trigger refuses both malformed and unfinished COMMIT under service_role',
  );
  // P20/§14 backfill is read from the migration itself; fixture reopens the old CHECK only inside rollback.
  await db.query('begin');
  await db.query(
    'alter table private.match_players drop constraint match_players_paid_starter_check',
  );
  await db.query(
    'delete from private.match_refunds where match_player_id in (select id from private.match_players where match_id in (select id from private.matches where group_id=$1))',
    [group],
  );
  await db.query(
    `update private.matches set starts_at=now()-interval '2 days',ends_at=now()-interval '1 day' where id=$1`,
    [match],
  );
  await db.query(
    `update private.match_players set status='removed',paid=true,payment_marked_by='34100000-0000-4000-8000-000000000001',payment_marked_at=clock_timestamp() where match_id=$1`,
    [match],
  );
  await db.query(`insert into private.match_players(match_id,profile_id,status,queue_seq)
    values('34300000-0000-4000-8000-000000000002','34100000-0000-4000-8000-000000000001','removed',nextval('private.match_queue_seq')),
    ('34300000-0000-4000-8000-000000000003','34100000-0000-4000-8000-000000000001','removed',nextval('private.match_queue_seq'))`);
  await db.query(
    `update private.match_players set status='removed',paid=true,payment_marked_at=clock_timestamp(),payment_marked_by='34100000-0000-4000-8000-000000000001' where match_id in(select id from private.matches where group_id=$1)`,
    [group],
  );
  const migration = fs.readFileSync('supabase/migrations/0034_match_refunds.sql', 'utf8');
  const backfill = migration.slice(
    migration.indexOf('insert into private.match_refunds(match_player_id'),
    migration.indexOf('-- Chamador'),
  );
  await db.query(backfill);
  assert.equal(
    (
      await db.query(
        'select count(*)::int n from private.match_players where match_id=$1 and paid',
        [match],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await db.query(
        `select count(*)::int n from private.match_refunds r join private.match_players p on p.id=r.match_player_id where p.match_id=$1 and origin='canceled'`,
        [match],
      )
    ).rows[0].n,
    4,
  );
  assert.equal(
    (
      await db.query(
        `select count(*)::int n from private.match_refunds r join private.match_players p on p.id=r.match_player_id join private.matches m on m.id=p.match_id where m.group_id=$1 and origin='left_group'`,
        [group],
      )
    ).rows[0].n,
    5,
  );
  assert.equal(
    (
      await db.query(
        `select count(*)::int n from private.match_players p join private.matches m on m.id=p.match_id where m.group_id=$1 and (paid or payment_marked_at is not null or payment_marked_by is not null)`,
        [group],
      )
    ).rows[0].n,
    0,
  );
  await db.query('rollback');
  console.log(
    'ok - actual migration backfills removed paid registrations, including ended canceled matches',
  );
  // Group deletion holds the shared group barrier, then refuses the competing payment.
  await db.query(
    "update private.match_refunds set status='refunded',refunded_at=clock_timestamp(),marked_at=clock_timestamp(),marked_by=$1 where match_player_id in (select id from private.match_players where match_id=$2)",
    ['34100000-0000-4000-8000-000000000001', match],
  );
  const live = '34300000-0000-4000-8000-000000000004';
  originalLock = (
    await db.query(
      "select pg_get_functiondef('private.lock_match_context(uuid,uuid,uuid,uuid)'::regprocedure) def",
    )
  ).rows[0].def;
  async function deletionBarrier(mutant) {
    await holder.query('begin');
    await rpc(holder, 'delete_group', [group]);
    await second.query('begin');
    const payment = track(rpc(second, 'set_match_payment', [live, target, true], organizer));
    let detected = false;
    try {
      await awaitLockWait(
        db,
        payment,
        pids.second,
        pids.holder,
        'delete versus payment',
        'colete_refunds_',
      );
    } catch (error) {
      if (!mutant) throw error;
      detected = true;
    } finally {
      await holder.query('rollback');
    }
    const result = await payment.settled;
    await second.query('rollback');
    assert.equal(result.status, 'fulfilled');
    if (mutant) assert.ok(detected, 'lock mutant must turn the barrier red');
  }
  await deletionBarrier(false);
  await db.query(
    originalLock.replaceAll('FOR NO KEY UPDATE', '').replaceAll('for no key update', ''),
  );
  await deletionBarrier(true);
  await db.query(originalLock);
  originalLock = undefined;
  console.log('ok - delete_group/payment barrier, and counterproof with context locks removed');
  // Real GoTrue session and Edge transport, without a browser or a fabricated JWT.
  const password = 'Synthetic-refunds-local-2026';
  const email = `refunds-http-${Date.now()}@colete.test`;
  const created = await fetch(`${apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  assert.equal(created.status, 200);
  realAuthId = (await created.json()).id;
  const signed = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: publishable, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(signed.status, 200);
  const token = (await signed.json()).access_token;
  const call = async (operation, body, id = request()) => {
    const response = await fetch(
      `${functionsUrl}/${operation === 'complete_profile' ? 'identity' : 'groups'}/${operation}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ request_id: id, ...body }),
      },
    );
    const envelope = await response.json();
    assert.equal(response.status, 200, `${operation}: ${envelope.error?.code}`);
    return envelope.data;
  };
  realProfileId = (
    await call('complete_profile', { profile: { name: 'Synthetic refund organizer' } })
  ).outcome.profile_id;
  await db.query(
    "insert into public.group_members(group_id,profile_id,role,status) values($1,$2,'organizer','active')",
    [group, realProfileId],
  );
  const lateBody = { match_id: match, profile_id: '34100000-0000-4000-8000-000000000007' };
  const lateRequest = request();
  const late = await call('record_canceled_match_payment', lateBody, lateRequest);
  assert.deepEqual(await call('record_canceled_match_payment', lateBody, lateRequest), late);
  const refundBody = { match_id: match, refund_id: late.outcome.refund_id };
  const markBody = { ...refundBody, refunded_at: await databaseNow() };
  const markRequest = request();
  const markedHttp = await call('mark_refunded', markBody, markRequest);
  assert.deepEqual(await call('mark_refunded', markBody, markRequest), markedHttp);
  const correctBody = { ...refundBody, corrected_at: await databaseNow() };
  const correctionRequest = request();
  const correctedHttp = await call('correct_refund', correctBody, correctionRequest);
  assert.deepEqual(await call('correct_refund', correctBody, correctionRequest), correctedHttp);
  assert.equal(
    (
      await db.query('select status from private.match_refunds where id=$1', [
        late.outcome.refund_id,
      ])
    ).rows[0].status,
    'refunded',
  );
  const read = async (operation) =>
    fetch(`${functionsUrl}/groups/${operation}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ match_id: match }),
    });
  const projection = await read('get_match_refunds');
  assert.equal(projection.status, 200);
  assert.ok(
    (await projection.json()).data.some(
      (item) => item.id === late.outcome.refund_id && item.status === 'refunded',
    ),
  );
  await db.query(
    "update public.group_members set role='player' where group_id=$1 and profile_id=$2",
    [group, realProfileId],
  );
  const forbiddenRead = await read('get_match_refunds');
  assert.equal(forbiddenRead.status, 403);
  assert.equal((await forbiddenRead.json()).error.code, 'NOT_ORGANIZER');
  const forbiddenMark = await fetch(`${functionsUrl}/groups/mark_refunded`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ request_id: request(), ...markBody }),
  });
  assert.equal(forbiddenMark.status, 403);
  assert.equal((await forbiddenMark.json()).error.code, 'NOT_ORGANIZER');
  console.log(
    'ok - three new mutations, replays and organization projection through Edge with a real GoTrue session; player refused',
  );
} finally {
  await Promise.allSettled(Object.values(clients).map((client) => client.query('rollback')));
  await db.query('reset role');
  if (originalLock) await db.query(originalLock);
  await db.query('begin');
  if (realProfileId)
    await db.query('delete from private.idempotency_records where actor_id=$1', [realProfileId]);
  await db.query(
    "delete from private.idempotency_records where actor_id in(select id from public.profiles where id::text like '34100000-%')",
  );
  await db.query(
    'delete from private.match_players where match_id in(select id from private.matches where group_id=$1)',
    [group],
  );
  await db.query('delete from private.matches where group_id=$1', [group]);
  await db.query('delete from private.group_deletions where group_id=$1', [group]);
  await db.query('delete from public.group_members where group_id=$1', [group]);
  await db.query('delete from public.groups where id=$1', [group]);
  if (realProfileId) await db.query('delete from public.profiles where id=$1', [realProfileId]);
  await db.query("delete from public.profiles where id::text like '34100000-%'");
  await db.query("delete from auth.users where id::text like '34000000-%'");
  await db.query('commit');
  if (realAuthId) {
    const removed = await fetch(`${apiUrl}/auth/v1/admin/users/${realAuthId}`, {
      method: 'DELETE',
      headers: { apikey: secret, Authorization: `Bearer ${secret}` },
    });
    assert.ok([200, 204, 404].includes(removed.status));
  }
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from private.match_refunds r join private.match_players p on p.id=r.match_player_id where p.match_id::text like '34300000-%'",
      )
    ).rows[0].n,
    0,
  );
  await Promise.allSettled(Object.values(clients).map((client) => client.end()));
}
console.log('ok - no refund fixture residue');
