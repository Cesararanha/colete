// Fatia 0031 (notas dos jogadores), pelo caminho HTTP real com JWT GoTrue e
// por chamadas diretas como a Edge faz, com commit de verdade: chamada forçada
// pela Edge recusada a jogador, ex-membro e estranho; quem vê o quê, em cada
// visibilidade, e a própria nota depois de sair; concorrência com barreira nas
// duas ordens (avaliar × avaliar, × expulsar o alvo, × apagar o grupo, e o
// replay × apagar); grupo apagado respondendo sem esperar a trava; expurgo
// pelo worker real; e duas contraprovas executáveis: sem as travas, e sem a
// decisão antes da trava.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { harnessEmail, harnessEmailPattern, installHarnessGuard } from './harness-guard.mjs';
import { localWorkerCronSecret } from './local-worker-test-config.mjs';
import { assertDistinctConnections, awaitLockWait, track } from './lock-barrier.mjs';

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supabase = path.join(root, 'node_modules', '.bin', 'supabase');
const AUTH_PREFIX = 'ratings-';
const APP_PREFIX = 'colete_ratings_';
const PASSWORD = 'colete-local-ratings-harness-password';
const RATE = 'public.set_rating(uuid,uuid,uuid,text,integer,integer,uuid,uuid,integer)';
const NO_WAIT_MS = 3000;
const guard = installHarnessGuard('db:test:ratings', {
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
  const profiles = (
    await db.query(
      `select p.id from public.profiles p join auth.users u on u.id = p.auth_user_id
        where u.email like $1 escape '\\'`,
      [pattern],
    )
  ).rows.map((row) => row.id);
  const groups = (
    await db.query(
      `select id from public.groups where owner_id = any($1::uuid[])
       union select group_id from public.group_members where profile_id = any($1::uuid[])`,
      [profiles],
    )
  ).rows.map((row) => row.id);
  await db.query('begin');
  try {
    for (const statement of [
      'delete from private.idempotency_records where actor_id = any($1::uuid[])',
      'delete from private.revoked_auth_sessions where profile_id = any($1::uuid[])',
      'delete from private.invite_rate_limits where profile_id = any($1::uuid[])',
    ]) {
      await db.query(statement, [profiles]);
    }
    await db.query('delete from private.ratings where group_id = any($1::uuid[])', [groups]);
    await db.query('delete from private.rating_history where group_id = any($1::uuid[])', [groups]);
    await db.query(
      `delete from private.match_players where profile_id = any($1::uuid[])
          or match_id in (select id from private.matches where group_id = any($2::uuid[]))`,
      [profiles, groups],
    );
    for (const statement of [
      'delete from private.matches where group_id = any($1::uuid[])',
      'delete from private.group_deletions where group_id = any($1::uuid[])',
      'delete from public.group_invites where group_id = any($1::uuid[])',
      'delete from public.group_members where group_id = any($1::uuid[])',
      'delete from public.groups where id = any($1::uuid[])',
    ]) {
      await db.query(statement, [groups]);
    }
    await db.query('delete from public.profiles where id = any($1::uuid[])', [profiles]);
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
function read(status, actor, operation, body = {}) {
  return edge(status, `groups/${operation}`, body, actor.token);
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
const withoutRequestId = (body) => ({ ...body, request_id: undefined });
function same(a, b, label) {
  assert.equal(a.status, b.status, label);
  assert.deepEqual(withoutRequestId(a.body), withoutRequestId(b.body), label);
}
async function createActor(status, label, position = null) {
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
  const actor = {
    authId: user.id,
    token: session.access_token,
    sessionId: claims.session_id,
    name: `Jogador ${label}`,
  };
  const completed = ok(
    await edge(
      status,
      'identity/complete_profile',
      { request_id: crypto.randomUUID(), profile: { name: actor.name, position } },
      actor.token,
    ),
    `complete ${label}`,
  );
  actor.profileId = completed.outcome.profile_id;
  return actor;
}
async function addMembers(db, groupId, members) {
  await db.query('begin');
  try {
    for (const [actor, role] of members) {
      await db.query(
        `insert into public.group_members(group_id,profile_id,role,status)
         values($1,$2,$3,'active')`,
        [groupId, actor.profileId, role],
      );
    }
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}
async function createGroup(status, owner, name) {
  return ok(await mutate(status, owner, 'create_group', { name }), `create ${name}`).outcome
    .group_id;
}
async function versions(db, groupId, profileId) {
  const { rows } = await db.query(
    `select old_stars, new_stars from private.rating_history
      where group_id = $1 and profile_id = $2 order by id`,
    [groupId, profileId],
  );
  return rows.map((row) => `${row.old_stars ?? '-'}>${row.new_stars}`).join(',');
}
async function currentStars(db, groupId, profileId) {
  const { rows } = await db.query(
    'select stars from private.ratings where group_id = $1 and profile_id = $2',
    [groupId, profileId],
  );
  return rows[0]?.stars ?? null;
}
async function worker(db, status, job) {
  // O slot corrente pode ter sido consumido por outro harness ou pelo cron
  // local; a linha é estado de teste e sai para esta invocação valer.
  await db.query(
    `delete from private.job_runs where job_name = $1
      and scheduled_for > clock_timestamp() - interval '2 days'`,
    [job],
  );
  const response = await fetch(`${status.functionsUrl}/worker/${job}`, {
    method: 'POST',
    headers: {
      apikey: status.publishableKey,
      Authorization: `Bearer ${localWorkerCronSecret()}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(response.status, 200, `worker ${job} returned ${response.status}`);
}

// Chamada direta como a Edge faz, numa conexão da barreira, com commit de
// verdade: HMAC de formato válido e o contexto do ator.
async function rpc(connection, sql, args) {
  await connection.query('begin');
  try {
    await connection.query('set local role service_role');
    const result = await connection.query(`select ${sql} as result`, args);
    await connection.query('commit');
    return result.rows[0].result;
  } catch (error) {
    try {
      await connection.query('rollback');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'rpc and rollback failed');
    }
    throw error;
  }
}
const hmac = (...parts) => crypto.createHash('sha256').update(parts.join(':')).digest('hex');
function rpcRate(connection, actor, groupId, target, stars, requestId = crypto.randomUUID()) {
  return rpc(
    connection,
    'public.set_rating($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::uuid,$6::uuid,$7::integer)',
    [
      actor.authId,
      actor.sessionId,
      requestId,
      hmac(requestId, groupId, target.profileId, stars),
      groupId,
      target.profileId,
      stars,
    ],
  );
}
function rpcRemove(connection, actor, groupId, target, requestId = crypto.randomUUID()) {
  return rpc(
    connection,
    'public.remove_member($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::uuid,$6::uuid,$7::text)',
    [
      actor.authId,
      actor.sessionId,
      requestId,
      hmac(requestId, groupId, target.profileId),
      groupId,
      target.profileId,
      'motivo do harness',
    ],
  );
}
function rpcDelete(connection, actor, groupId, requestId = crypto.randomUUID()) {
  return rpc(connection, 'public.delete_group($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::uuid)', [
    actor.authId,
    actor.sessionId,
    requestId,
    hmac(requestId, groupId),
    groupId,
  ]);
}

const rate = (status, actor, groupId, target, stars, requestId = crypto.randomUUID()) =>
  mutate(
    status,
    actor,
    'set_rating',
    { group_id: groupId, profile_id: target.profileId, stars },
    requestId,
  );
const board = (status, actor, groupId) =>
  read(status, actor, 'get_group_ratings', { group_id: groupId });
const mine = (status, actor, groupId) =>
  read(status, actor, 'get_my_rating', { group_id: groupId });

// ---------------------------------------------------------------------------
// HTTP: quem avalia, quem vê o quê, a própria nota depois de sair
// ---------------------------------------------------------------------------
async function proveHttp(status, db) {
  const [owner, organizer, player, former, stranger, m1, m2] = await Promise.all(
    ['owner', 'organizer', 'player', 'former', 'stranger', 'm1', 'm2'].map((label) =>
      createActor(status, label),
    ),
  );
  const groupId = await createGroup(status, owner, 'Grupo das Notas');
  await addMembers(db, groupId, [
    [organizer, 'organizer'],
    [player, 'player'],
    [former, 'organizer'],
    [m1, 'player'],
    [m2, 'player'],
  ]);
  await db.query(
    `update public.group_members set status='removed', removed_at=now()
      where group_id=$1 and profile_id=$2`,
    [groupId, former.profileId],
  );
  const ghost = crypto.randomUUID();

  // A organização avalia; repetir é sem mudança; autoavaliação vale.
  const first = ok(await rate(status, owner, groupId, m1, 4), 'owner rates');
  assert.deepEqual(first, {
    outcome: { group_id: groupId, logical_result: 'rating_set', profile_id: m1.profileId },
    current: { stars: 4 },
  });
  ok(await rate(status, organizer, groupId, m1, 2), 'organizer changes');
  const same = ok(await rate(status, organizer, groupId, m1, 2), 'same value');
  assert.equal(same.outcome.logical_result, 'rating_unchanged');
  assert.equal(await versions(db, groupId, m1.profileId), '->4,4>2');
  ok(await rate(status, organizer, groupId, organizer, 5), 'self-rating');
  ok(await rate(status, owner, groupId, player, 3), 'player rated');

  // Chamada forçada pela Edge: jogador 403; ex-membro e estranho 403 NOT_MEMBER.
  denied(await rate(status, player, groupId, m1, 5), 403, 'NOT_ORGANIZER', 'player rates');
  for (const [label, actor] of [
    ['former organizer', former],
    ['stranger', stranger],
  ]) {
    denied(await rate(status, actor, groupId, m1, 5), 403, 'NOT_MEMBER', `${label} rates`);
    denied(await board(status, actor, groupId), 403, 'NOT_MEMBER', `${label} reads`);
  }
  denied(await rate(status, owner, ghost, m1, 5), 404, 'NOT_FOUND', 'unknown group');
  denied(await rate(status, owner, groupId, m1, 6), 422, 'STARS_RANGE', 'six stars');
  denied(await rate(status, owner, groupId, m1, 0), 422, 'STARS_RANGE', 'zero stars');
  denied(
    await mutate(status, owner, 'set_rating', {
      group_id: groupId,
      profile_id: m1.profileId,
      stars: 2.5,
    }),
    422,
    'VALIDATION',
    'half a star',
  );
  denied(
    await rate(status, owner, groupId, stranger, 3),
    409,
    'NOT_ACTIVE_MEMBER',
    'stranger target',
  );
  denied(await rate(status, owner, groupId, former, 3), 409, 'NOT_ACTIVE_MEMBER', 'former target');
  assert.equal(await versions(db, groupId, m1.profileId), '->4,4>2', 'refusals change nothing');
  const { rows: leaked } = await db.query(
    `select count(*)::integer as n from private.idempotency_records
      where operation = 'set_rating' and (outcome::text ~ 'stars' or outcome::text ~ '[1-5]"?}')`,
  );
  assert.equal(leaked[0].n, 0, 'no ledger outcome carries stars');

  // Quem vê o quê.
  const orgView = ok(await board(status, organizer, groupId), 'organizer board');
  assert.equal(orgView.can_rate, true);
  const m1Row = orgView.members.find((member) => member.profile_id === m1.profileId);
  assert.equal(m1Row.stars, 2);
  assert.equal(m1Row.changed_by_name, organizer.name, 'who changed last');
  assert.equal(orgView.members.find((m) => m.profile_id === m2.profileId).stars, null);
  const privateView = ok(await board(status, player, groupId), 'player board, private');
  assert.deepEqual(
    { members: privateView.members, own: privateView.own_stars, rate: privateView.can_rate },
    { members: null, own: 3, rate: false },
    'a player with private ratings sees only their own',
  );
  denied(
    await mutate(status, organizer, 'set_ratings_visibility', {
      group_id: groupId,
      visibility: 'members',
      confirm_members_visibility: true,
    }),
    403,
    'OWNER_ONLY',
    'only the owner shows the ratings',
  );
  ok(
    await mutate(status, owner, 'set_ratings_visibility', {
      group_id: groupId,
      visibility: 'members',
      confirm_members_visibility: true,
    }),
    'owner shows the ratings to members',
  );
  const membersView = ok(await board(status, player, groupId), 'player board, members');
  assert.equal(membersView.members.find((m) => m.profile_id === m1.profileId).stars, 2);
  assert.ok(
    membersView.members.every(
      (member) => !('changed_by_name' in member) && !('changed_at' in member),
    ),
    'members see the stars, never who or when',
  );

  // A própria nota depois de sair; a do grupo, não.
  ok(await rate(status, owner, groupId, m2, 3), 'm2 rated');
  ok(
    await mutate(status, owner, 'remove_member', {
      group_id: groupId,
      profile_id: m2.profileId,
      reason: 'motivo do harness',
    }),
    'm2 removed',
  );
  assert.equal(ok(await mine(status, m2, groupId), 'own after leaving').stars, 3);
  denied(await board(status, m2, groupId), 403, 'NOT_MEMBER', 'removed member reads the board');
  assert.equal(ok(await mine(status, stranger, groupId), 'stranger own').stars, null);

  // Grupo apagado: nota nova e replay como um grupo inexistente.
  const request = crypto.randomUUID();
  ok(await rate(status, organizer, groupId, m1, 4, request), 'rating before deletion');
  ok(await mutate(status, owner, 'delete_group', { group_id: groupId }), 'delete group');
  same_(
    await rate(status, organizer, groupId, m1, 5),
    await rate(status, organizer, ghost, m1, 5),
    'new rating',
  );
  same_(
    await rate(status, organizer, groupId, m1, 4, request),
    await rate(status, organizer, ghost, m1, 4),
    'replay',
  );
  same_(await board(status, organizer, groupId), await board(status, organizer, ghost), 'board');
  same_(await mine(status, m1, groupId), await mine(status, m1, ghost), 'own rating', true);
  console.log(
    'ok - HTTP: owner and organizer rate (self included), the same value is unchanged, the history keeps from-to; player 403, former member and stranger NOT_MEMBER, unknown group 404, STARS_RANGE and half a star 422, non-member targets NOT_ACTIVE_MEMBER; the organization sees who and when, a player only their own while private and the stars without who or when with "members"; a removed member keeps reading their own; a deleted group answers like an unknown one, replay included',
  );
}
// Igual a um grupo inexistente, menos o request_id (e o group_id ecoado na leitura própria).
function same_(a, b, label, ownRead = false) {
  assert.equal(a.status, b.status, label);
  const strip = (body) => {
    const out = { ...body, request_id: undefined };
    if (ownRead && out.data) out.data = { ...out.data, group_id: undefined };
    return out;
  };
  assert.deepEqual(strip(a.body), strip(b.body), `${label}: deleted answers like unknown`);
}

// ---------------------------------------------------------------------------
// Barreira: os dois competidores parados atrás de quem segura o grupo
// ---------------------------------------------------------------------------
async function proveBarriers(status, connections, db) {
  const { observer, holder, first, second } = connections;
  const pids = await assertDistinctConnections({ observer, holder, first, second }, 'ratings');
  const [owner, organizer, target] = await Promise.all(
    ['b-owner', 'b-organizer', 'b-target'].map((label) => createActor(status, label)),
  );
  const fixture = async (label) => {
    const groupId = await createGroup(status, owner, `Corrida ${label}`);
    await addMembers(db, groupId, [
      [organizer, 'organizer'],
      [target, 'player'],
    ]);
    return groupId;
  };
  const race = async (label, groupId, order, start) => {
    await holder.query('begin');
    await holder.query('select 1 from public.groups where id=$1 for no key update', [groupId]);
    let one;
    let two;
    try {
      one = track(start[order[0]](first));
      await awaitLockWait(
        observer,
        one,
        pids.first,
        pids.holder,
        `${label} ${order[0]}`,
        APP_PREFIX,
      );
      two = track(start[order[1]](second));
      await awaitLockWait(
        observer,
        two,
        pids.second,
        [pids.holder, pids.first],
        `${label} ${order[1]}`,
        APP_PREFIX,
      );
    } finally {
      await holder.query('commit');
    }
    const [a, b] = await Promise.all([one.settled, two.settled]);
    return { [order[0]]: a, [order[1]]: b };
  };
  const finish = async (groupId) => {
    const { rows } = await db.query('select 1 from private.group_deletions where group_id=$1', [
      groupId,
    ]);
    if (rows.length === 0)
      ok(await mutate(status, owner, 'delete_group', { group_id: groupId }), 'end');
  };
  const results = [];

  // Avaliar × avaliar o mesmo alvo: o segundo parte do valor do primeiro.
  for (const order of [
    ['ownerRates', 'organizerRates'],
    ['organizerRates', 'ownerRates'],
  ]) {
    const groupId = await fixture(`rate-${order[0]}`);
    const settled = await race(`rate rate ${order[0]} first`, groupId, order, {
      ownerRates: (connection) => rpcRate(connection, owner, groupId, target, 4),
      organizerRates: (connection) => rpcRate(connection, organizer, groupId, target, 2),
    });
    for (const result of Object.values(settled)) {
      assert.equal(result.status, 'fulfilled', String(result.reason));
    }
    const expected = order[0] === 'ownerRates' ? ['->4,4>2', 2] : ['->2,2>4', 4];
    assert.equal(
      await versions(db, groupId, target.profileId),
      expected[0],
      'one chain of versions',
    );
    assert.equal(
      await currentStars(db, groupId, target.profileId),
      expected[1],
      'the last one wins',
    );
    await finish(groupId);
    results.push(`rate × rate, ${order[0]} first`);
  }

  // Avaliar × expulsar o alvo.
  for (const order of [
    ['remove', 'rate'],
    ['rate', 'remove'],
  ]) {
    const groupId = await fixture(`remove-${order[0]}`);
    const settled = await race(`rate remove ${order[0]} first`, groupId, order, {
      remove: (connection) => rpcRemove(connection, owner, groupId, target),
      rate: (connection) => rpcRate(connection, organizer, groupId, target, 3),
    });
    assert.equal(settled.remove.status, 'fulfilled', String(settled.remove.reason));
    if (order[0] === 'remove') {
      assert.equal(settled.rate.status, 'rejected', 'remove first: the rating is refused');
      assert.equal(settled.rate.reason.message, 'NOT_ACTIVE_MEMBER');
      assert.equal(await currentStars(db, groupId, target.profileId), null);
    } else {
      assert.equal(settled.rate.status, 'fulfilled', String(settled.rate.reason));
      assert.equal(await currentStars(db, groupId, target.profileId), 3, 'kept for retention');
    }
    await finish(groupId);
    results.push(`rate × remove the target, ${order[0]} first`);
  }

  // Avaliar × apagar o grupo, e o replay × apagar.
  for (const replay of [false, true]) {
    for (const order of [
      ['remove', 'rate'],
      ['rate', 'remove'],
    ]) {
      const groupId = await fixture(`delete-${replay}-${order[0]}`);
      const requestId = crypto.randomUUID();
      if (replay) await rpcRate(db, organizer, groupId, target, 3, requestId);
      const settled = await race(`rate delete ${replay} ${order[0]} first`, groupId, order, {
        remove: (connection) => rpcDelete(connection, owner, groupId),
        rate: (connection) => rpcRate(connection, organizer, groupId, target, 3, requestId),
      });
      assert.equal(settled.remove.status, 'fulfilled', String(settled.remove.reason));
      if (order[0] === 'remove') {
        assert.equal(settled.rate.status, 'rejected', 'delete first: the rating is refused');
        assert.equal(settled.rate.reason.message, 'GROUP_DELETED');
      } else {
        assert.equal(settled.rate.status, 'fulfilled', String(settled.rate.reason));
      }
      results.push(`${replay ? 'replay' : 'rate'} × delete group, ${order[0]} first`);
    }
  }
  console.log(
    `ok - ${results.length} races, each with both competitors observed waiting behind the group holder: ${results.join('; ')}`,
  );
  return { owner, organizer, target };
}

// ---------------------------------------------------------------------------
// Grupo apagado responde sem esperar a trava
// ---------------------------------------------------------------------------
async function withinHold(request) {
  const started = performance.now();
  let timer;
  const result = await Promise.race([
    request,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('waited'), NO_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (result === 'waited') return { waited: true };
  return { response: result, ms: performance.now() - started };
}
async function holdGroup(holder, groupId) {
  await holder.query('begin');
  await holder.query('select 1 from public.groups where id=$1 for update', [groupId]);
  await holder.query('select 1 from public.group_members where group_id=$1 for update', [groupId]);
  await holder.query('select 1 from private.ratings where group_id=$1 for update', [groupId]);
}
async function proveNoLockWait(status, db, holder) {
  const [owner, organizer, member, stranger] = await Promise.all(
    ['nw-owner', 'nw-organizer', 'nw-member', 'nw-stranger'].map((label) =>
      createActor(status, label),
    ),
  );
  const groupId = await createGroup(status, owner, 'Grupo da Trava');
  await addMembers(db, groupId, [
    [organizer, 'organizer'],
    [member, 'player'],
  ]);
  const request = crypto.randomUUID();
  ok(await rate(status, organizer, groupId, member, 4, request), 'rating before');
  ok(await mutate(status, owner, 'delete_group', { group_id: groupId }), 'delete');
  const ghost = crypto.randomUUID();
  const calls = [
    [
      'organizer new rating',
      () => rate(status, organizer, groupId, member, 5),
      () => rate(status, organizer, ghost, member, 5),
    ],
    [
      'organizer replay',
      () => rate(status, organizer, groupId, member, 4, request),
      () => rate(status, organizer, ghost, member, 4),
    ],
    [
      'stranger rating',
      () => rate(status, stranger, groupId, member, 5),
      () => rate(status, stranger, ghost, member, 5),
    ],
    ['member board', () => board(status, member, groupId), () => board(status, member, ghost)],
    [
      'stranger board',
      () => board(status, stranger, groupId),
      () => board(status, stranger, ghost),
    ],
  ];
  const timings = [];
  await holdGroup(holder, groupId);
  try {
    for (const [label, call, unknown] of calls) {
      const timed = await withinHold(call());
      assert.ok(!timed.waited, `${label} waited for the held lock`);
      timings.push(timed.ms);
      same_(timed.response, await unknown(), `${label} with the lock held`);
    }
    const own = await withinHold(mine(status, member, groupId));
    assert.ok(!own.waited, 'own rating waited');
    assert.equal(own.response.body.data.stars, null);
  } finally {
    await holder.query('rollback');
  }
  console.log(
    `ok - with the deleted group, its memberships and ratings held FOR UPDATE: new rating, replay, stranger rating and the member and stranger boards answer while the lock is held, like an unknown group (${timings.length} calls, slowest ${Math.round(Math.max(...timings))} ms); the own rating answers none`,
  );
}

// ---------------------------------------------------------------------------
// Expurgo pelo worker real
// ---------------------------------------------------------------------------
async function proveWorkerPurge(status, db) {
  const [owner, gone, stays] = await Promise.all(
    ['p-owner', 'p-gone', 'p-stays'].map((label) => createActor(status, label)),
  );
  const groupId = await createGroup(status, owner, 'Grupo do Expurgo');
  await addMembers(db, groupId, [
    [gone, 'player'],
    [stays, 'player'],
  ]);
  ok(await rate(status, owner, groupId, gone, 3), 'gone rated');
  ok(await rate(status, owner, groupId, gone, 4), 'gone changed');
  ok(await rate(status, owner, groupId, stays, 2), 'stays rated');
  await db.query(
    `update public.group_members set status='removed', removed_at=now() - interval '13 months'
      where group_id=$1 and profile_id=$2`,
    [groupId, gone.profileId],
  );
  await worker(db, status, 'purge_ratings');
  const { rows: runs } = await db.query(
    `select status from private.job_runs where job_name='purge_ratings' order by id desc limit 1`,
  );
  assert.equal(runs[0]?.status, 'succeeded', 'the worker ran purge_ratings');
  assert.equal(await currentStars(db, groupId, gone.profileId), null, 'the expired rating is gone');
  assert.equal(await versions(db, groupId, gone.profileId), '', 'with every version');
  assert.equal(await currentStars(db, groupId, stays.profileId), 2, 'the active one stays');
  ok(await mutate(status, owner, 'delete_group', { group_id: groupId }), 'end');
  console.log(
    'ok - purge_ratings through the real worker: a member who left 13 months ago loses the rating and its two versions; an active member keeps it',
  );
}

// ---------------------------------------------------------------------------
// Contraprovas executáveis, na função viva, restaurada byte a byte
// ---------------------------------------------------------------------------
async function liveDefinition(db, signature) {
  return (await db.query('select pg_get_functiondef($1::regprocedure) as d', [signature])).rows[0]
    .d;
}
async function withMutant(db, signature, mutate, run) {
  const original = await liveDefinition(db, signature);
  const mutated = mutate(original);
  assert.notEqual(mutated, original, `${signature}: the mutant changes nothing`);
  await db.query(mutated);
  try {
    return await run();
  } finally {
    await db.query(original);
    assert.equal(await liveDefinition(db, signature), original, `${signature} restored`);
  }
}

// Sem as travas e com uma pausa depois de ler a nota atual, duas notas
// simultâneas partem do mesmo valor antigo: o histórico fica com duas
// primeiras versões. Com as travas e a mesma pausa, a segunda espera e parte
// do valor da primeira.
async function proveLockMutant(status, connections, db, context) {
  const { first, second } = connections;
  const { owner, organizer, target } = context;
  const readRating = `    and not private.is_group_deleted(group_id)
  for update;
`;
  const pause = (definition) =>
    definition.replace(readRating, `${readRating}  perform pg_sleep(0.8);\n`);
  const unlock = (definition) =>
    pause(definition)
      .replace('  order by id\n  for no key update;', '  order by id;')
      .replace(
        '  where id = p_group_id and not private.is_group_deleted(id)\n  for no key update;',
        '  where id = p_group_id and not private.is_group_deleted(id);',
      )
      .replace(
        '  order by membership.profile_id\n  for no key update;',
        '  order by membership.profile_id;',
      )
      .replace(readRating, '    and not private.is_group_deleted(group_id);\n');
  const run = async (label) => {
    const groupId = await createGroup(status, owner, `Contraprova ${label}`);
    await addMembers(db, groupId, [
      [organizer, 'organizer'],
      [target, 'player'],
    ]);
    const one = track(rpcRate(first, owner, groupId, target, 4));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const two = track(rpcRate(second, organizer, groupId, target, 2));
    const [a, b] = await Promise.all([one.settled, two.settled]);
    assert.equal(a.status, 'fulfilled', String(a.reason));
    assert.equal(b.status, 'fulfilled', String(b.reason));
    const chain = await versions(db, groupId, target.profileId);
    ok(await mutate(status, owner, 'delete_group', { group_id: groupId }), 'end');
    return chain;
  };
  const locked = await withMutant(db, RATE, pause, () => run('locked'));
  assert.equal(locked, '->4,4>2', 'with the locks the second starts from the first');
  const broken = await withMutant(db, RATE, unlock, () => run('unlocked'));
  assert.equal(broken, '->4,->2', 'mutant: both versions start from nothing');
  console.log(
    'ok - counterproof: without the profile, group, membership and rating locks and with a pause after reading the current rating, two simultaneous ratings both start from no rating (history ->4,->2); with the locks and the same pause, the second waits and starts from the first (->4,4>2)',
  );
}

// Sem o predicado do grupo apagado na trava do grupo, a nota num grupo apagado
// espera quem segura a linha dele: o tempo diria que o grupo existiu.
async function proveNoWaitMutant(status, db, holder, context) {
  const { owner, organizer, target } = context;
  const groupId = await createGroup(status, owner, 'Contraprova sem espera');
  await addMembers(db, groupId, [
    [organizer, 'organizer'],
    [target, 'player'],
  ]);
  ok(await mutate(status, owner, 'delete_group', { group_id: groupId }), 'delete');
  const predicate =
    '  where id = p_group_id and not private.is_group_deleted(id)\n  for no key update;';
  const outcome = await withMutant(
    db,
    RATE,
    (d) => d.replace(predicate, '  where id = p_group_id\n  for no key update;'),
    async () => {
      await holdGroup(holder, groupId);
      let pending;
      try {
        pending = track(rate(status, organizer, groupId, target, 3));
        return { timed: await withinHold(pending.settled), pending };
      } finally {
        await holder.query('rollback');
      }
    },
  );
  assert.equal(outcome.timed.waited, true, 'mutant: the deleted group waits for its lock');
  const settled = await outcome.pending.settled;
  denied(settled.value, 404, 'NOT_FOUND', 'mutant: refused only after the wait');
  console.log(
    `ok - counterproof: without the deleted-group predicate on the group lock, a rating on a deleted group waits for the held row (more than ${NO_WAIT_MS} ms) before answering NOT_FOUND`,
  );
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
  // The worker proof leaves its own job and retention rows; they go with the
  // fixtures, above the baselines read before any proof (bugbash BB-035).
  let baselineRuns = Number.MAX_SAFE_INTEGER;
  let baselineRetention = Number.MAX_SAFE_INTEGER;
  guard.onCleanup(async (cleanupClient) => {
    await cleanup(cleanupClient);
    await cleanupClient.query(
      "delete from private.job_runs where id > $1 and job_name = 'purge_ratings'",
      [baselineRuns],
    );
    await cleanupClient.query(
      "delete from private.retention_runs where id > $1 and policy = 'purge_ratings'",
      [baselineRetention],
    );
  });
  guard.onCensus(async (census) => {
    const count = async (relation) =>
      (await census.query(`select count(*)::integer as n from ${relation}`)).rows[0].n;
    const residue = {
      'auth.users': await count('auth.users'),
      'private.ratings': await count('private.ratings'),
      'private.rating_history': await count('private.rating_history'),
      'private.group_deletions': await count('private.group_deletions'),
      'public.groups': await count('public.groups'),
      'public.profiles': await count('public.profiles'),
      'private.idempotency_records': await count('private.idempotency_records'),
      'private.job_runs (purge_ratings, this run)': (
        await census.query(
          "select count(*)::integer as n from private.job_runs where id > $1 and job_name = 'purge_ratings'",
          [baselineRuns],
        )
      ).rows[0].n,
      'private.retention_runs (purge_ratings, this run)': (
        await census.query(
          "select count(*)::integer as n from private.retention_runs where id > $1 and policy = 'purge_ratings'",
          [baselineRetention],
        )
      ).rows[0].n,
    };
    for (const [relation, n] of Object.entries(residue)) assert.equal(n, 0, `${relation} residue`);
    console.log(
      `ok - residue: ${Object.entries(residue)
        .map(([relation, n]) => `${relation}=${n}`)
        .join(', ')}`,
    );
  });
  let failure;
  try {
    const connected = await Promise.allSettled(all.map((connection) => connection.connect()));
    const errors = connected
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'harness connections');
    await cleanup(db);
    baselineRuns = Number(
      (await db.query('select coalesce(max(id), 0)::text as id from private.job_runs')).rows[0].id,
    );
    baselineRetention = Number(
      (await db.query('select coalesce(max(id), 0)::text as id from private.retention_runs'))
        .rows[0].id,
    );
    const initial = (await db.query('select count(*)::integer as n from auth.users')).rows[0].n;
    assert.equal(initial, 0, 'auth.users before proofs');
    console.log('ok - auth.users=0 before proofs');
    await proveHttp(status, db);
    const context = await proveBarriers(status, { observer, holder, first, second }, db);
    await proveNoLockWait(status, db, holder);
    await proveWorkerPurge(status, db);
    await proveLockMutant(status, { first, second }, db, context);
    await proveNoWaitMutant(status, db, holder, context);
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
if (await guard.run(main)) console.log('Ratings harness passed.');
