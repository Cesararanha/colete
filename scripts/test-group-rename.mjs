// Fatia 0018: HTTP real com JWT GoTrue, commit sob service_role e barreira M2 §2.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { makeInviteMaterial } from '../supabase/functions/_shared/invite-material.ts';
import { harnessEmail, harnessEmailPattern, installHarnessGuard } from './harness-guard.mjs';
import { assertDistinctConnections, awaitLockWait, sameActorPair, track } from './lock-barrier.mjs';

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supabase = path.join(root, 'node_modules', '.bin', 'supabase');
const AUTH_PREFIX = 'group-rename-';
const APP_PREFIX = 'colete_rename_';
const PASSWORD = 'colete-local-rename-harness-password';
const syntheticKey = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index));
const guard = installHarnessGuard('db:test:rename', {
  applicationPrefix: APP_PREFIX,
  authEmailPrefix: AUTH_PREFIX,
});

function localStatus() {
  const output = execFileSync(supabase, ['status', '-o', 'env'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  const read = (name) => {
    const match = output.match(new RegExp(`^${name}="([^"]+)"$`, 'm'));
    if (!match) throw new Error(`local stack missing ${name}`);
    return match[1];
  };
  return {
    apiUrl: read('API_URL'),
    dbUrl: read('DB_URL'),
    functionsUrl: read('FUNCTIONS_URL'),
    publishableKey: read('PUBLISHABLE_KEY'),
    secretKey: read('SECRET_KEY'),
  };
}
function client(dbUrl, name) {
  return new Client({
    connectionString: dbUrl,
    application_name: `${APP_PREFIX}${name}`,
    connectionTimeoutMillis: 5000,
  });
}
async function cleanup(db) {
  const pattern = harnessEmailPattern(AUTH_PREFIX);
  const profiles = `select p.id from public.profiles p join auth.users u on u.id=p.auth_user_id
    where u.email like $1 escape '\\'`;
  const groups = `select g.id from public.groups g where g.owner_id in (${profiles})`;
  await db.query('begin');
  try {
    await db.query(`delete from private.idempotency_records where actor_id in (${profiles})`, [
      pattern,
    ]);
    await db.query(`delete from private.revoked_auth_sessions where profile_id in (${profiles})`, [
      pattern,
    ]);
    await db.query(`delete from public.group_invites where group_id in (${groups})`, [pattern]);
    await db.query(`delete from public.group_members where group_id in (${groups})`, [pattern]);
    await db.query(`delete from public.groups where id in (${groups})`, [pattern]);
    await db.query(`delete from public.profiles where id in (${profiles})`, [pattern]);
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}
async function edge(status, route, body, token) {
  const response = await fetch(`${status.functionsUrl}/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
function mutate(status, actor, operation, body, requestId = crypto.randomUUID()) {
  return edge(status, `groups/${operation}`, { ...body, request_id: requestId }, actor.token);
}
function ok(response, label) {
  assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`);
  assert.equal(typeof response.body.request_id, 'string', label);
  return response.body.data;
}
function denied(response, status, code, label) {
  assert.equal(response.status, status, `${label}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.error?.code, code, label);
  assert.equal(Object.hasOwn(response.body, 'data'), false, label);
}
async function createActor(status, label) {
  const email = harnessEmail(AUTH_PREFIX, `${crypto.randomUUID()}-${label}`);
  const created = await fetch(`${status.apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: status.secretKey,
      Authorization: `Bearer ${status.secretKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  assert.equal(created.status, 200, `create ${label}: ${created.status}`);
  const user = await created.json();
  const signed = await fetch(`${status.apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: status.publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(signed.status, 200, `sign in ${label}: ${signed.status}`);
  const session = await signed.json();
  const claims = JSON.parse(
    Buffer.from(session.access_token.split('.')[1], 'base64url').toString('utf8'),
  );
  assert.equal(claims.sub, user.id);
  const actor = { authId: user.id, token: session.access_token, sessionId: claims.session_id };
  const completed = ok(
    await edge(
      status,
      'identity/complete_profile',
      {
        request_id: crypto.randomUUID(),
        profile: { name: `Rename ${label}` },
      },
      actor.token,
    ),
    `complete ${label}`,
  );
  actor.profileId = completed.outcome.profile_id;
  return actor;
}

async function proveHttp(status, db) {
  const owner = await createActor(status, 'owner');
  const organizer = await createActor(status, 'organizer');
  const player = await createActor(status, 'player');
  const pending = await createActor(status, 'pending');
  const removed = await createActor(status, 'removed');
  const outsider = await createActor(status, 'outsider');
  const revoked = await createActor(status, 'revoked');
  const created = ok(
    await mutate(status, owner, 'create_group', { name: 'Primeiro Grupo' }),
    'create',
  );
  const groupId = created.outcome.group_id;
  await db.query('begin');
  try {
    for (const [actor, role, state] of [
      [organizer, 'organizer', 'active'],
      [player, 'player', 'active'],
      [pending, 'player', 'pending'],
      [removed, 'organizer', 'removed'],
      [revoked, 'organizer', 'active'],
    ]) {
      await db.query(
        `insert into public.group_members(group_id,profile_id,role,status,removed_at)
         values($1,$2,$3,$4,case when $4='removed' then now() else null end)`,
        [groupId, actor.profileId, role, state],
      );
    }
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
  const otherGroup = ok(
    await mutate(status, outsider, 'create_group', { name: 'Outro Grupo' }),
    'other create',
  );
  const originalRow = (
    await db.query('select to_jsonb(g) as row from public.groups g where id=$1', [groupId])
  ).rows[0].row;
  const requestId = crypto.randomUUID();
  const ownerFirst = ok(
    await mutate(
      status,
      owner,
      'rename_group',
      {
        group_id: groupId,
        name: '  Cafe\u0301　da　Turma  ',
      },
      requestId,
    ),
    'owner rename',
  );
  assert.deepEqual(ownerFirst.outcome, { group_id: groupId, logical_result: 'group_renamed' });
  assert.deepEqual(ownerFirst.current, { group_id: groupId, group_name: 'Café da Turma' });
  const afterRow = (
    await db.query('select to_jsonb(g) as row from public.groups g where id=$1', [groupId])
  ).rows[0].row;
  assert.deepEqual(
    { ...afterRow, name: originalRow.name },
    originalRow,
    'only groups.name changes',
  );
  const equivalent = ok(
    await mutate(
      status,
      owner,
      'rename_group',
      {
        group_id: groupId,
        name: 'Café da Turma',
      },
      requestId,
    ),
    'canonical replay',
  );
  assert.deepEqual(equivalent.outcome, ownerFirst.outcome);
  assert.equal(equivalent.current.group_name, 'Café da Turma');
  const organizerId = crypto.randomUUID();
  const organizerFirst = ok(
    await mutate(
      status,
      organizer,
      'rename_group',
      {
        group_id: groupId,
        name: 'Nome do Organizador',
      },
      organizerId,
    ),
    'organizer rename',
  );
  assert.equal(organizerFirst.current.group_name, 'Nome do Organizador');
  const ownerReplay = ok(
    await mutate(
      status,
      owner,
      'rename_group',
      {
        group_id: groupId,
        name: 'Café da Turma',
      },
      requestId,
    ),
    'fresh owner replay',
  );
  assert.deepEqual(ownerReplay.outcome, ownerFirst.outcome);
  assert.equal(ownerReplay.current.group_name, 'Nome do Organizador');
  for (const [actor, code] of [
    [player, 'NOT_ORGANIZER'],
    [pending, 'NOT_MEMBER'],
    [removed, 'NOT_MEMBER'],
    [outsider, 'NOT_MEMBER'],
  ]) {
    denied(
      await mutate(status, actor, 'rename_group', {
        group_id: groupId,
        name: 'Negado ao Papel',
      }),
      403,
      code,
      `authority ${code}`,
    );
  }
  denied(
    await mutate(status, owner, 'rename_group', {
      group_id: otherGroup.outcome.group_id,
      name: 'Outro Dono',
    }),
    403,
    'NOT_MEMBER',
    'other group owner',
  );
  console.log(
    'ok - HTTP owner and active organizer rename; player, pending, removed and other group denied',
  );

  await db.query(
    `update public.group_members set role='player'
    where group_id=$1 and profile_id=$2`,
    [groupId, organizer.profileId],
  );
  const roleReplay = ok(
    await mutate(
      status,
      organizer,
      'rename_group',
      {
        group_id: groupId,
        name: 'Nome do Organizador',
      },
      organizerId,
    ),
    'role lost replay',
  );
  assert.deepEqual(roleReplay, { outcome: organizerFirst.outcome });
  denied(
    await mutate(status, organizer, 'rename_group', {
      group_id: groupId,
      name: 'Nova Intenção',
    }),
    403,
    'NOT_ORGANIZER',
    'role lost new call',
  );
  await db.query(
    `update public.group_members set status='removed',removed_at=now()
    where group_id=$1 and profile_id=$2`,
    [groupId, organizer.profileId],
  );
  const membershipReplay = ok(
    await mutate(
      status,
      organizer,
      'rename_group',
      {
        group_id: groupId,
        name: 'Nome do Organizador',
      },
      organizerId,
    ),
    'membership lost replay',
  );
  assert.deepEqual(membershipReplay, { outcome: organizerFirst.outcome });
  denied(
    await mutate(status, organizer, 'rename_group', {
      group_id: groupId,
      name: 'Nova Intenção',
    }),
    403,
    'NOT_MEMBER',
    'membership lost new call',
  );
  const ledger = (
    await db.query(
      `select outcome,state from private.idempotency_records
    where actor_id=$1 and operation='rename_group' and request_id=$2`,
      [organizer.profileId, organizerId],
    )
  ).rows[0];
  assert.equal(ledger.state, 'completed');
  assert.deepEqual(ledger.outcome, organizerFirst.outcome);
  console.log(
    'ok - replay keeps stable outcome, projects fresh name only while authority is current',
  );

  const revokedId = crypto.randomUUID();
  ok(
    await mutate(
      status,
      revoked,
      'rename_group',
      {
        group_id: groupId,
        name: 'Antes da Revogação',
      },
      revokedId,
    ),
    'before revocation',
  );
  ok(
    await edge(
      status,
      'identity/revoke_current_session',
      {
        request_id: crypto.randomUUID(),
      },
      revoked.token,
    ),
    'revoke session',
  );
  denied(
    await mutate(
      status,
      revoked,
      'rename_group',
      {
        group_id: groupId,
        name: 'Antes da Revogação',
      },
      revokedId,
    ),
    401,
    'UNAUTHENTICATED',
    'revoked replay',
  );
  denied(
    await mutate(status, revoked, 'rename_group', {
      group_id: groupId,
      name: 'Nova Intenção',
    }),
    401,
    'UNAUTHENTICATED',
    'revoked new call',
  );
  console.log('ok - revoked GoTrue session denies replay and new call before any outcome');

  const stateGroup = ok(
    await mutate(status, owner, 'create_group', { name: 'Grupo de Estado' }),
    'state group',
  ).outcome.group_id;
  const stateRequest = crypto.randomUUID();
  const stateBusiness = { group_id: stateGroup, name: 'Antes do Estado' };
  const stateFirst = ok(
    await mutate(status, owner, 'rename_group', stateBusiness, stateRequest),
    'rename before state change',
  );
  await db.query('update public.groups set suspended_at=now() where id=$1', [stateGroup]);
  assert.deepEqual(
    ok(
      await mutate(status, owner, 'rename_group', stateBusiness, stateRequest),
      'suspended replay',
    ),
    { outcome: stateFirst.outcome },
    'suspended replay preserves outcome without current',
  );
  denied(
    await mutate(status, owner, 'rename_group', {
      group_id: stateGroup,
      name: 'Recusa Suspensa',
    }),
    403,
    'GROUP_SUSPENDED',
    'suspended group',
  );
  await db.query('update public.groups set suspended_at=null,archived_at=now() where id=$1', [
    stateGroup,
  ]);
  assert.deepEqual(
    ok(await mutate(status, owner, 'rename_group', stateBusiness, stateRequest), 'archived replay'),
    { outcome: stateFirst.outcome },
    'archived replay preserves outcome without current',
  );
  denied(
    await mutate(status, owner, 'rename_group', {
      group_id: stateGroup,
      name: 'Recusa Arquivada',
    }),
    410,
    'GROUP_ARCHIVED',
    'archived group',
  );
  console.log('ok - suspended and archived groups refuse new rename with contracted codes');
  return { owner, groupId };
}

function digest(operation, business) {
  return crypto
    .createHash('sha256')
    .update(`${operation}|${JSON.stringify(business)}`)
    .digest('hex');
}
async function rpcTx(connection, operation, actor, business, requestId = crypto.randomUUID()) {
  const common = [actor.authId, actor.sessionId, requestId, digest(operation, business), 1, 1];
  let sql;
  let args;
  if (operation === 'rename_group') {
    sql = `select public.rename_group($1::uuid,$2::uuid,$3::uuid,$4::text,
      $5::integer,$6::integer,$7::uuid,$8::text) as result`;
    args = [...common, ...business];
  } else {
    sql = `select public.create_group($1::uuid,$2::uuid,$3::uuid,$4::text,
      $5::integer,$6::integer,$7::text,$8::uuid,$9::smallint,
      $10::text,$11::text,$12::text) as result`;
    args = [...common, ...business];
  }
  await connection.query('begin');
  try {
    await connection.query('set local role service_role');
    const result = await connection.query(sql, args);
    await connection.query('commit');
    return result.rows[0].result;
  } catch (error) {
    try {
      await connection.query('rollback');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `${operation} and rollback failed`);
    }
    throw error;
  }
}
async function proveNameMutant(db, connection, context) {
  const invalid = 'X\u200bY';
  const create = async () => {
    const material = await makeInviteMaterial(syntheticKey);
    return rpcTx(connection, 'create_group', context.owner, [
      invalid,
      material.inviteId,
      material.tokenVersion,
      material.nonceHex,
      material.tokenDigest,
      material.codeDigest,
    ]);
  };
  const rename = () => rpcTx(connection, 'rename_group', context.owner, [context.groupId, invalid]);
  await assert.rejects(create, (error) => error.code === '22023' && error.message === 'VALIDATION');
  await assert.rejects(rename, (error) => error.code === '22023' && error.message === 'VALIDATION');
  const original = (
    await db.query(
      "select pg_get_functiondef('private.normalize_group_name(text)'::regprocedure) as definition",
    )
  ).rows[0].definition;
  assert.match(original, /1564, 8203,/);
  const mutant = original.replace('1564, 8203,', '1564, 999999,');
  assert.notEqual(mutant, original);
  await db.query(mutant);
  try {
    const created = await create();
    const renamed = await rename();
    assert.equal(created.outcome.logical_result, 'group_created');
    assert.equal(renamed.outcome.logical_result, 'group_renamed');
    assert.equal(renamed.current.group_name, invalid);
  } finally {
    await db.query(original);
  }
  await assert.rejects(create, (error) => error.code === '22023' && error.message === 'VALIDATION');
  await assert.rejects(rename, (error) => error.code === '22023' && error.message === 'VALIDATION');
  console.log('ok - one shared-name mutant makes both create_group and rename_group accept U+200B');
}
async function proveGroupBarrier(connections, context) {
  const { observer, holder, first, second } = connections;
  const pids = await assertDistinctConnections(
    { observer, holder, first, second },
    'rename group barrier',
  );
  for (const order of [1, 2]) {
    const firstConnection = order === 1 ? first : second;
    const secondConnection = order === 1 ? second : first;
    const firstPid = order === 1 ? pids.first : pids.second;
    const secondPid = order === 1 ? pids.second : pids.first;
    const firstName = `Barreira ${order} A`;
    const secondName = `Barreira ${order} B`;
    await holder.query('begin');
    await holder.query('select 1 from public.groups where id=$1 for no key update', [
      context.groupId,
    ]);
    let a;
    let b;
    try {
      a = track(
        rpcTx(firstConnection, 'rename_group', context.owner, [context.groupId, firstName]),
      );
      await awaitLockWait(observer, a, firstPid, pids.holder, `rename ${order} A`, APP_PREFIX);
      b = track(
        rpcTx(secondConnection, 'rename_group', context.owner, [context.groupId, secondName]),
      );
      await awaitLockWait(observer, b, secondPid, firstPid, `rename ${order} B`, APP_PREFIX);
    } finally {
      await holder.query('commit');
    }
    const results = await Promise.all([a.settled, b.settled]);
    for (const result of results) {
      assert.equal(
        result.status,
        'fulfilled',
        `rename ${order}: ${result.reason?.code} ${result.reason?.message}`,
      );
      assert.equal(result.value.outcome.logical_result, 'group_renamed');
    }
    const final = (
      await observer.query('select name from public.groups where id=$1', [context.groupId])
    ).rows[0].name;
    assert.equal(final, secondName, 'the last transaction to commit wins');
    console.log(
      `ok - two renames order ${order}: second resource held, waits observed, last commit wins, no 40P01`,
    );
  }
}
async function proveProfileLockMutant(db, connections, context) {
  const signature = 'public.rename_group(uuid,uuid,uuid,text,integer,integer,uuid,text)';
  const original = (
    await db.query('select pg_get_functiondef($1::regprocedure) as definition', [signature])
  ).rows[0].definition;
  const profileLock = /perform 1 from public\.profiles where id = v_actor_id for no key update;/i;
  assert.match(original, profileLock);
  const mutant = original.replace(profileLock, (match) =>
    match.replace(/for no key update;/i, 'for update;'),
  );
  for (const order of [1, 2]) {
    const orderedConnections =
      order === 1
        ? connections
        : {
            ...connections,
            first: connections.second,
            second: connections.first,
          };
    const pair = {
      label: `rename same actor order ${order}`,
      profileId: context.owner.profileId,
      runFirst: (connection) =>
        rpcTx(connection, 'rename_group', context.owner, [context.groupId, `Perfil ${order} A`]),
      runSecond: (connection) =>
        rpcTx(connection, 'rename_group', context.owner, [context.groupId, `Perfil ${order} B`]),
    };
    const correct = await sameActorPair(
      { ...orderedConnections, applicationPrefix: APP_PREFIX },
      pair,
    );
    assert.equal(correct.length, 2);
    assert.ok(correct.every((entry) => entry.status === 'fulfilled'));
    await db.query(mutant);
    try {
      let failure;
      try {
        await sameActorPair({ ...orderedConnections, applicationPrefix: APP_PREFIX }, pair);
      } catch (error) {
        failure = error;
      }
      assert.match(failure?.message ?? '', /40P01/, 'FOR UPDATE must reproduce the P1 deadlock');
    } finally {
      await db.query(original);
    }
    console.log(
      `ok - profile lock order ${order}: NO KEY UPDATE succeeds; FOR UPDATE mutator reproduces 40P01`,
    );
  }
}

async function main() {
  const status = localStatus();
  const db = client(status.dbUrl, 'admin');
  const observer = client(status.dbUrl, 'observer');
  const holder = client(status.dbUrl, 'holder');
  const first = client(status.dbUrl, 'first');
  const second = client(status.dbUrl, 'second');
  const all = [db, observer, holder, first, second];
  guard.useDatabase(status.dbUrl);
  guard.onCleanup(cleanup);
  guard.onCensus(async (census) => {
    const users = (await census.query('select count(*)::integer as n from auth.users')).rows[0].n;
    const groups = (await census.query('select count(*)::integer as n from public.groups')).rows[0]
      .n;
    const outcomes = (
      await census.query('select count(*)::integer as n from private.idempotency_records')
    ).rows[0].n;
    assert.equal(users, 0, 'auth.users after cleanup');
    assert.equal(groups, 0, 'groups after cleanup');
    assert.equal(outcomes, 0, 'idempotency after cleanup');
    console.log(`ok - residue: auth.users=${users}, groups=${groups}, idempotency=${outcomes}`);
  });
  let failure;
  try {
    const connected = await Promise.allSettled(all.map((connection) => connection.connect()));
    const errors = connected
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'harness connections');
    await cleanup(db);
    const initial = (await db.query('select count(*)::integer as n from auth.users')).rows[0].n;
    assert.equal(initial, 0, 'auth.users before proofs');
    console.log('ok - auth.users=0 before proofs');
    const context = await proveHttp(status, db);
    await proveNameMutant(db, first, context);
    await proveGroupBarrier({ observer, holder, first, second }, context);
    await proveProfileLockMutant(db, { observer, holder, first, second }, context);
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
if (await guard.run(main)) console.log('Group rename harness passed.');
