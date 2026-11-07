// Fatia 0029 (apagar grupo): permissões e chamada forçada pela Edge com JWT
// GoTrue real; depois do encerramento, replay e chamada nova recusados e as
// leituras iguais às de um grupo que não existe, também sem esperar trava
// (P1 da revisão do #80); apagar × entrar, apagar ×
// criar racha e apagar × confirmar presença na mesma trava do grupo, nas duas
// ordens e com commit de verdade; contraprova executável sem a trava.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { harnessEmail, harnessEmailPattern, installHarnessGuard } from './harness-guard.mjs';
import { assertDistinctConnections, awaitLockWait, track } from './lock-barrier.mjs';

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supabase = path.join(root, 'node_modules', '.bin', 'supabase');
const AUTH_PREFIX = 'group-deletion-';
const APP_PREFIX = 'colete_group_deletion_';
const PASSWORD = 'colete-local-group-deletion-harness-password';
const DELETE = 'public.delete_group(uuid,uuid,uuid,text,integer,integer,uuid)';
const guard = installHarnessGuard('db:test:group-deletion', {
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
// Two refusals that must be indistinguishable: same status and same error, the
// request_id being each call's own correlation.
function same(a, b, label) {
  assert.equal(a.status, b.status, `${label}: status`);
  assert.deepEqual(a.body.error, b.body.error, `${label}: error`);
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
      { request_id: crypto.randomUUID(), profile: { name: `Pessoa ${label}` } },
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
    for (const [actor, role, state] of members) {
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
}
function matchConfig(days) {
  const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 + days * 86_400_000);
  return {
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 90 * 60_000).toISOString(),
    timezone: 'America/Sao_Paulo',
    location_name: 'Arena do Encerramento',
    location_address: null,
    description: null,
    latitude: null,
    longitude: null,
    field_slots: 6,
    field_price: '10.00',
  };
}
async function createGroup(status, owner, name) {
  const data = ok(await mutate(status, owner, 'create_group', { name }), `create ${name}`);
  return { groupId: data.outcome.group_id, inviteId: data.outcome.invite_id };
}
async function createMatch(status, actor, groupId, days = 4) {
  return ok(
    await mutate(status, actor, 'create_match', { group_id: groupId, config: matchConfig(days) }),
    'create match',
  ).outcome.match_id;
}
async function liveMatches(db, groupId) {
  const { rows } = await db.query(
    `select count(*)::integer as n from private.matches
      where group_id = $1 and canceled_at is null and ends_at > now()`,
    [groupId],
  );
  return rows[0].n;
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
const hmac = (requestId) => crypto.createHash('sha256').update(requestId).digest('hex');
function rpcDelete(connection, actor, groupId, requestId = crypto.randomUUID()) {
  return rpc(connection, `public.delete_group($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::uuid)`, [
    actor.authId,
    actor.sessionId,
    requestId,
    hmac(requestId),
    groupId,
  ]);
}
function rpcJoinByCode(connection, actor, codeDigest, requestId = crypto.randomUUID()) {
  return rpc(connection, `public.join_by_code($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::text)`, [
    actor.authId,
    actor.sessionId,
    requestId,
    hmac(requestId),
    codeDigest,
  ]);
}
function rpcCreateMatch(connection, actor, groupId, config, requestId = crypto.randomUUID()) {
  return rpc(
    connection,
    `public.create_match($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::uuid,$6::jsonb)`,
    [actor.authId, actor.sessionId, requestId, hmac(requestId), groupId, JSON.stringify(config)],
  );
}
function rpcJoinMatch(connection, actor, matchId, requestId = crypto.randomUUID()) {
  return rpc(connection, `public.join_match($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::uuid)`, [
    actor.authId,
    actor.sessionId,
    requestId,
    hmac(requestId),
    matchId,
  ]);
}
// O config como a Edge o canoniza para create_match.
function canonicalConfig(days) {
  return { ...matchConfig(days), latitude: null, longitude: null };
}

// ---------------------------------------------------------------------------
// HTTP: permissões, chamada forçada, replay e leituras depois do encerramento
// ---------------------------------------------------------------------------
async function proveHttp(status, db) {
  const [owner, organizer, player, former, stranger] = await Promise.all(
    ['owner', 'organizer', 'player', 'former', 'stranger'].map((label) =>
      createActor(status, label),
    ),
  );
  const { groupId, inviteId } = await createGroup(status, owner, 'Grupo do Harness');
  await addMembers(db, groupId, [
    [organizer, 'organizer', 'active'],
    [player, 'player', 'active'],
    [former, 'organizer', 'removed'],
  ]);
  const matchId = await createMatch(status, owner, groupId);
  const code = ok(
    await read(status, owner, 'get_invite_share_link', { invite_id: inviteId }),
    'share',
  ).code;

  // A chamada forçada de quem não é dono, direto na Edge.
  for (const [actor, httpStatus, errorCode, label] of [
    [organizer, 403, 'OWNER_ONLY', 'organizer'],
    [player, 403, 'OWNER_ONLY', 'player'],
    [former, 403, 'NOT_MEMBER', 'former organizer'],
    [stranger, 403, 'NOT_MEMBER', 'stranger'],
  ]) {
    denied(
      await mutate(status, actor, 'delete_group', { group_id: groupId }),
      httpStatus,
      errorCode,
      `forced delete by ${label}`,
    );
  }
  denied(
    await mutate(status, owner, 'delete_group', { group_id: crypto.randomUUID() }),
    404,
    'NOT_FOUND',
    'unknown group',
  );
  denied(
    await edge(
      status,
      'groups/delete_group',
      { request_id: crypto.randomUUID(), group_id: groupId },
      'x',
    ),
    401,
    'UNAUTHENTICATED',
    'no session',
  );
  denied(
    await mutate(status, owner, 'delete_group', { group_id: groupId, name: 'Grupo do Harness' }),
    422,
    'VALIDATION',
    'the typed name never travels',
  );
  const before = await db.query(
    `select (select count(*)::integer from private.group_deletions where group_id = $1) as closed,
            (select archived_at from public.groups where id = $1) as archived`,
    [groupId],
  );
  assert.deepEqual(before.rows[0], { closed: 0, archived: null }, 'refusals change nothing');
  console.log(
    'ok - only the active owner deletes: organizer and player OWNER_ONLY, former member and stranger NOT_MEMBER, by a forced Edge call',
  );

  // Um pedido do jogador, repetido depois do encerramento.
  const joinRequest = crypto.randomUUID();
  ok(
    await mutate(status, player, 'join_match', { match_id: matchId }, joinRequest),
    'player joins',
  );

  const deleteRequest = crypto.randomUUID();
  const deleted = ok(
    await mutate(status, owner, 'delete_group', { group_id: groupId }, deleteRequest),
    'owner deletes',
  );
  assert.deepEqual(deleted, { outcome: { group_id: groupId, logical_result: 'group_deleted' } });
  assert.deepEqual(
    ok(await mutate(status, owner, 'delete_group', { group_id: groupId }, deleteRequest), 'replay'),
    deleted,
    'the deletion replays its outcome',
  );
  const state = await db.query(
    `select (select count(*)::integer from private.group_deletions where group_id = $1) as closed,
            (select archived_at is not null from public.groups where id = $1) as archived,
            (select canceled_at is not null from private.matches where id = $2) as canceled,
            (select revoked_at is not null from public.group_invites where id = $3) as revoked`,
    [groupId, matchId, inviteId],
  );
  assert.deepEqual(state.rows[0], { closed: 1, archived: true, canceled: true, revoked: true });
  console.log(
    'ok - the owner deletes: closed, archived, the match canceled and the invite revoked, committed; the same request_id replays the outcome',
  );

  // Depois: o grupo responde como um que nunca existiu.
  const unknownGroup = crypto.randomUUID();
  const unknownMatch = crypto.randomUUID();
  same(
    await mutate(status, player, 'join_match', { match_id: matchId }, joinRequest),
    await mutate(status, player, 'join_match', { match_id: unknownMatch }),
    'a replay from before the deletion',
  );
  denied(
    await mutate(status, player, 'join_match', { match_id: matchId }, joinRequest),
    404,
    'NOT_FOUND',
    'replay',
  );
  for (const [operation, body, unknownBody] of [
    [
      'rename_group',
      { group_id: groupId, name: 'Outro nome' },
      { group_id: unknownGroup, name: 'Outro nome' },
    ],
    [
      'set_group_appearance',
      { group_id: groupId, icon: 'ball', color: 'blue' },
      { group_id: unknownGroup, icon: 'ball', color: 'blue' },
    ],
    [
      'create_match',
      { group_id: groupId, config: matchConfig(5) },
      { group_id: unknownGroup, config: matchConfig(5) },
    ],
    ['delete_group', { group_id: groupId }, { group_id: unknownGroup }],
    ['cancel_match', { match_id: matchId }, { match_id: unknownMatch }],
    ['leave_match', { match_id: matchId }, { match_id: unknownMatch }],
  ]) {
    const actual = await mutate(status, owner, operation, body);
    denied(actual, 404, 'NOT_FOUND', `owner ${operation}`);
    same(actual, await mutate(status, owner, operation, unknownBody), `owner ${operation}`);
  }
  for (const [operation, body, unknownBody, httpStatus, errorCode] of [
    ['get_group_members', { group_id: groupId }, { group_id: unknownGroup }, 403, 'NOT_MEMBER'],
    ['get_match', { match_id: matchId }, { match_id: unknownMatch }, 404, 'NOT_FOUND'],
    ['get_match_roster', { match_id: matchId }, { match_id: unknownMatch }, 404, 'NOT_FOUND'],
  ]) {
    const actual = await read(status, owner, operation, body);
    denied(actual, httpStatus, errorCode, `owner reads ${operation}`);
    same(actual, await read(status, owner, operation, unknownBody), `owner reads ${operation}`);
  }
  assert.deepEqual(ok(await read(status, player, 'list_my_matches'), 'agenda'), []);
  assert.deepEqual(ok(await read(status, player, 'get_matches_occupancy'), 'occupancy'), []);
  const preview = await read(status, stranger, 'preview_group_by_code', { code });
  denied(preview, 400, 'CODE_INVALID', 'preview of the revoked code');
  console.log(
    'ok - after the deletion: replay and new calls answer the unknown-group NOT_FOUND byte for byte; the reads too; the invite preview is the generic CODE_INVALID',
  );
}

// ---------------------------------------------------------------------------
// Sem espera de trava: o grupo apagado responde como o inexistente, também no
// tempo (P1 da revisão do #80)
// ---------------------------------------------------------------------------
// Uma conexão segura FOR UPDATE a linha do grupo apagado, as memberships, os
// convites e os rachas dele. Cada operação, chamada pelo membro antigo e por
// um estranho, com o ID do grupo apagado e com um ID inexistente, precisa
// responder com a trava ainda presa, com o mesmo status e o mesmo erro. Uma
// chamada que esperasse a trava não terminaria antes do prazo.
const NO_WAIT_MS = 3000;
async function withinHold(label, request) {
  const started = performance.now();
  let timer;
  const result = await Promise.race([
    request,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('waited'), NO_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (result === 'waited') return { waited: label };
  return { ...result, ms: performance.now() - started };
}
async function proveNoLockWait(status, db, holder) {
  const [owner, former, stranger, target] = await Promise.all(
    ['nw-owner', 'nw-former', 'nw-stranger', 'nw-target'].map((label) =>
      createActor(status, label),
    ),
  );
  const { groupId, inviteId } = await createGroup(status, owner, 'Grupo da Trava');
  await addMembers(db, groupId, [
    [former, 'organizer', 'active'],
    [target, 'player', 'active'],
  ]);
  const matchId = await createMatch(status, owner, groupId, 9);
  ok(await mutate(status, owner, 'delete_group', { group_id: groupId }), 'delete');
  // Uma leitura e uma escrita de cada família, mais as do racha.
  const unknownGroup = crypto.randomUUID();
  const unknownInvite = crypto.randomUUID();
  const unknownMatch = crypto.randomUUID();
  const calls = [
    ['get_group_members', 'read', (g) => ({ group_id: g })],
    ['get_invite_share_link', 'read', (_g, i) => ({ invite_id: i })],
    ['get_match', 'read', (_g, _i, m) => ({ match_id: m })],
    ['get_match_roster', 'read', (_g, _i, m) => ({ match_id: m })],
    [
      'approve_member',
      'write',
      (g) => ({ group_id: g, profile_id: target.profileId, approve: true }),
    ],
    ['remove_member', 'write', (g) => ({ group_id: g, profile_id: target.profileId, reason: 'x' })],
    [
      'set_role',
      'write',
      (g) => ({ group_id: g, profile_id: target.profileId, role: 'organizer' }),
    ],
    ['set_monthly', 'write', (g) => ({ group_id: g, profile_id: target.profileId, enabled: true })],
    [
      'set_ratings_visibility',
      'write',
      (g) => ({ group_id: g, visibility: 'private', confirm_members_visibility: false }),
    ],
    ['transfer_ownership', 'write', (g) => ({ group_id: g, new_owner_id: target.profileId })],
    ['leave_group', 'write', (g) => ({ group_id: g })],
    ['rename_group', 'write', (g) => ({ group_id: g, name: 'Outro nome' })],
    ['set_group_appearance', 'write', (g) => ({ group_id: g, icon: 'ball', color: 'blue' })],
    ['revoke_group_invite', 'write', (_g, i) => ({ invite_id: i })],
    ['regenerate_group_invite', 'write', (_g, i) => ({ invite_id: i })],
    ['issue_group_invite', 'write', (g) => ({ group_id: g })],
    ['create_match', 'write', (g) => ({ group_id: g, config: matchConfig(10) })],
    ['update_match', 'write', (_g, _i, m) => ({ match_id: m, config: matchConfig(11) })],
    ['cancel_match', 'write', (_g, _i, m) => ({ match_id: m })],
    ['join_match', 'write', (_g, _i, m) => ({ match_id: m })],
    ['leave_match', 'write', (_g, _i, m) => ({ match_id: m })],
    [
      'set_match_payment',
      'write',
      (_g, _i, m) => ({ match_id: m, profile_id: target.profileId, paid: true }),
    ],
    ['delete_group', 'write', (g) => ({ group_id: g })],
  ];
  const call = (actor, operation, kind, body) =>
    kind === 'read' ? read(status, actor, operation, body) : mutate(status, actor, operation, body);
  // A trava é tomada e solta a cada operação, e a chamada que esperou termina
  // antes da próxima: cada operação é julgada sozinha, sem fila herdada.
  const hold = async () => {
    await holder.query('begin');
    await holder.query('select 1 from public.groups where id=$1 for update', [groupId]);
    await holder.query('select 1 from public.group_members where group_id=$1 for update', [
      groupId,
    ]);
    await holder.query('select 1 from public.group_invites where group_id=$1 for update', [
      groupId,
    ]);
    await holder.query('select 1 from private.matches where group_id=$1 for update', [groupId]);
  };
  const timings = [];
  const waited = [];
  for (const [who, actor] of [
    ['former member', former],
    ['stranger', stranger],
  ]) {
    for (const [operation, kind, body] of calls) {
      const label = `${who} ${operation}`;
      const requests = [];
      let unknown;
      let deleted;
      await hold();
      try {
        requests.push(
          call(actor, operation, kind, body(unknownGroup, unknownInvite, unknownMatch)),
        );
        unknown = await withinHold(`${label} unknown`, requests[0]);
        requests.push(call(actor, operation, kind, body(groupId, inviteId, matchId)));
        deleted = await withinHold(`${label} deleted`, requests[1]);
      } finally {
        await holder.query('rollback');
      }
      await Promise.allSettled(requests);
      if (unknown.waited || deleted.waited) {
        waited.push(unknown.waited ?? deleted.waited);
        continue;
      }
      assert.equal(deleted.status, unknown.status, `${label}: status`);
      assert.deepEqual(deleted.body.error, unknown.body.error, `${label}: error`);
      assert.equal(Object.hasOwn(deleted.body, 'data'), false, `${label}: no data`);
      timings.push(deleted.ms);
    }
  }
  assert.deepEqual(waited, [], `waited for the lock of the deleted group: ${waited.join(', ')}`);
  const unchanged = await db.query(
    `select (select count(*)::integer from private.matches
              where group_id = $1 and canceled_at is null) as live,
            (select name from public.groups where id = $1) as name,
            (select count(*)::integer from public.group_invites
              where group_id = $1 and revoked_at is null) as invites`,
    [groupId],
  );
  assert.deepEqual(unchanged.rows[0], { live: 0, name: 'Grupo da Trava', invites: 0 });
  console.log(
    `ok - with the deleted group, its memberships, invites and matches held FOR UPDATE: ${timings.length} calls (${calls.length} operations × former member and stranger) answer like an unknown ID while the lock is held, slowest ${Math.round(Math.max(...timings))} ms`,
  );

  // Um estranho lendo os membros de um grupo vivo também não espera a trava:
  // responde NOT_MEMBER como para um grupo inexistente.
  const live = await createGroup(status, owner, 'Grupo Vivo da Trava');
  await holder.query('begin');
  try {
    await holder.query('select 1 from public.groups where id=$1 for update', [live.groupId]);
    const unknown = await withinHold(
      'stranger members unknown',
      read(status, stranger, 'get_group_members', { group_id: unknownGroup }),
    );
    const alive = await withinHold(
      'stranger members live',
      read(status, stranger, 'get_group_members', { group_id: live.groupId }),
    );
    assert.equal(unknown.waited ?? alive.waited, undefined, 'a stranger waited for a live group');
    assert.equal(alive.status, unknown.status);
    assert.deepEqual(alive.body.error, unknown.body.error);
  } finally {
    await holder.query('rollback');
  }
  console.log(
    'ok - a stranger reading the members of a live group held FOR UPDATE answers NOT_MEMBER like an unknown group, without waiting',
  );
}

// Os replays e o resgate. Cada operação de grupo e de racha é concluída antes
// do encerramento pelo próprio titular (dono, membro, membro antigo) e
// repetida depois com o mesmo corpo e request_id, com o grupo apagado, as
// memberships, os convites e os rachas presos: a recusa precisa sair com a
// trava presa, sem desfecho. O replay do próprio encerramento devolve o
// desfecho, também sem esperar. O resgate e a prévia de um convite do grupo
// apagado, pelo membro antigo e por um estranho, respondem com a trava presa,
// como um código inexistente (o resgate com INVITE_REVOKED, M2-D42); e o
// pedido encerrado sai da lista de pendentes sem esperar.
async function holdDeleted(holder, groupId) {
  await holder.query('begin');
  await holder.query('select 1 from public.groups where id=$1 for update', [groupId]);
  await holder.query('select 1 from public.group_members where group_id=$1 for update', [groupId]);
  await holder.query('select 1 from public.group_invites where group_id=$1 for update', [groupId]);
  await holder.query('select 1 from private.matches where group_id=$1 for update', [groupId]);
}
function tokenOf(shareUrl) {
  return new URLSearchParams(new URL(shareUrl).hash.slice(1)).get('token');
}
async function proveNoLockWaitReplays(status, db, holder) {
  const [owner, m1, m2, m3, m4, m5, stranger] = await Promise.all(
    ['rp-owner', 'rp-m1', 'rp-m2', 'rp-m3', 'rp-m4', 'rp-m5', 'rp-stranger'].map((label) =>
      createActor(status, label),
    ),
  );
  const recorded = [];
  // Executa e guarda o pedido para repetir depois, com o mesmo corpo.
  const record = async (actor, operation, body, label = operation) => {
    const requestId = crypto.randomUUID();
    const data = ok(await mutate(status, actor, operation, body, requestId), `record ${label}`);
    recorded.push({ actor, operation, body, requestId, label });
    return data;
  };
  const created = await record(owner, 'create_group', { name: 'Grupo dos Replays' });
  const groupId = created.outcome.group_id;
  const firstInvite = created.outcome.invite_id;
  const first = ok(
    await read(status, owner, 'get_invite_share_link', { invite_id: firstInvite }),
    'share',
  );
  await record(m1, 'join_by_code', { code: first.code });
  await record(m2, 'join_by_invite', { token: tokenOf(first.share_url) });
  await record(owner, 'approve_member', {
    group_id: groupId,
    profile_id: m1.profileId,
    approve: true,
  });
  ok(
    await mutate(status, owner, 'approve_member', {
      group_id: groupId,
      profile_id: m2.profileId,
      approve: true,
    }),
    'approve m2',
  );
  await addMembers(db, groupId, [
    [m3, 'player', 'active'],
    [m4, 'player', 'active'],
  ]);
  await db.query('update public.groups set monthly_enabled = true where id = $1', [groupId]);
  await record(owner, 'set_role', {
    group_id: groupId,
    profile_id: m1.profileId,
    role: 'organizer',
  });
  await record(owner, 'set_monthly', {
    group_id: groupId,
    profile_id: m2.profileId,
    enabled: true,
  });
  await record(owner, 'set_ratings_visibility', {
    group_id: groupId,
    visibility: 'private',
    confirm_members_visibility: false,
  });
  await record(owner, 'rename_group', { group_id: groupId, name: 'Grupo dos Replays' });
  await record(owner, 'set_group_appearance', { group_id: groupId, icon: 'goal', color: 'green' });
  await record(owner, 'remove_member', {
    group_id: groupId,
    profile_id: m3.profileId,
    reason: 'x',
  });
  await record(m4, 'leave_group', { group_id: groupId }, 'leave_group (former member)');
  await record(owner, 'transfer_ownership', { group_id: groupId, new_owner_id: m1.profileId });
  await record(
    m1,
    'transfer_ownership',
    { group_id: groupId, new_owner_id: owner.profileId },
    'transfer_ownership back',
  );
  await record(owner, 'revoke_group_invite', { invite_id: firstInvite });
  const issued = await record(owner, 'issue_group_invite', { group_id: groupId });
  await record(owner, 'regenerate_group_invite', { invite_id: issued.outcome.invite_id });
  const second = ok(
    await read(status, owner, 'get_invite_share_link', { invite_id: issued.outcome.invite_id }),
    'share after regenerate',
  );
  // Um pedido que fica pendente e o encerramento fecha.
  ok(await mutate(status, m5, 'join_by_code', { code: second.code }), 'm5 requests');
  const matchId = (
    await record(owner, 'create_match', { group_id: groupId, config: matchConfig(12) })
  ).outcome.match_id;
  await record(owner, 'update_match', { match_id: matchId, config: matchConfig(13) });
  await record(m1, 'join_match', { match_id: matchId });
  ok(await mutate(status, m2, 'join_match', { match_id: matchId }), 'm2 joins');
  await record(m2, 'leave_match', { match_id: matchId });
  await record(owner, 'set_match_payment', {
    match_id: matchId,
    profile_id: m1.profileId,
    paid: true,
  });
  const other = (
    await record(
      owner,
      'create_match',
      { group_id: groupId, config: matchConfig(14) },
      'create_match (second)',
    )
  ).outcome.match_id;
  await record(owner, 'cancel_match', { match_id: other });
  // 0034: retain the paid replay intent, explicitly clear its current mark
  // before the deletion success that this test replays under held locks.
  ok(
    await mutate(status, owner, 'set_match_payment', {
      match_id: matchId,
      profile_id: m1.profileId,
      paid: false,
    }),
    'clear payment before deletion',
  );
  const deleted = await record(owner, 'delete_group', { group_id: groupId });

  const judged = [];
  const waited = [];
  const judge = async (label, run, check) => {
    let result;
    let request;
    await holdDeleted(holder, groupId);
    try {
      request = run();
      result = await withinHold(label, request);
    } finally {
      await holder.query('rollback');
    }
    await Promise.allSettled([request]);
    if (result.waited) {
      waited.push(result.waited);
      return;
    }
    check(result);
    judged.push(result.ms);
  };
  for (const item of recorded) {
    await judge(
      `replay ${item.label}`,
      () => mutate(status, item.actor, item.operation, item.body, item.requestId),
      (result) => {
        if (item.operation === 'delete_group') {
          assert.equal(result.status, 200, 'replay of the deletion');
          assert.deepEqual(result.body.data, deleted);
          return;
        }
        denied(result, 404, 'NOT_FOUND', `replay ${item.label}`);
      },
    );
  }
  const unknownCode = second.code.replace(/[A-Z0-9]/u, (c) => (c === 'A' ? 'B' : 'A'));
  const unknownToken = `${tokenOf(second.share_url).slice(0, -2)}AA`;
  for (const [who, actor] of [
    ['former member', m3],
    ['stranger', stranger],
  ]) {
    for (const [operation, body, unknown, code] of [
      ['join_by_code', { code: second.code }, { code: unknownCode }, 'INVITE_REVOKED'],
      [
        'join_by_invite',
        { token: tokenOf(second.share_url) },
        { token: unknownToken },
        'INVITE_REVOKED',
      ],
    ]) {
      await judge(
        `${who} ${operation} unknown`,
        () => mutate(status, actor, operation, unknown),
        () => {},
      );
      await judge(
        `${who} ${operation}`,
        () => mutate(status, actor, operation, body),
        (result) => denied(result, 409, code, `${who} ${operation}`),
      );
    }
    for (const [operation, body, unknown] of [
      ['preview_group_by_code', { code: second.code }, { code: unknownCode }],
      ['preview_group_by_invite', { token: tokenOf(second.share_url) }, { token: unknownToken }],
    ]) {
      await judge(
        `${who} ${operation} unknown`,
        () => read(status, actor, operation, unknown),
        () => {},
      );
      await judge(
        `${who} ${operation}`,
        () => read(status, actor, operation, body),
        (result) => denied(result, 400, 'CODE_INVALID', `${who} ${operation}`),
      );
    }
  }
  await judge(
    'closed request list',
    () => read(status, m5, 'get_my_pending_group_requests'),
    (result) => {
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.data, []);
    },
  );
  assert.deepEqual(waited, [], `waited for the lock of the deleted group: ${waited.join(', ')}`);
  console.log(
    `ok - with the deleted group, its memberships, invites and matches held FOR UPDATE: ${recorded.length} replays recorded before the deletion (every group and match operation) answer while the lock is held, NOT_FOUND without outcome and the deletion its own outcome; redemption and preview of its code and link by a former member and a stranger, and the closed request list, too: ${judged.length} calls, slowest ${Math.round(Math.max(...judged))} ms`,
  );
}

// A exclusão commita enquanto a chamada espera (revisão de 4d58e22). Para
// cada operação que decide algo antes da trava, um grupo novo e vivo: a
// conexão A executa delete_group e segura sem commit; a chamada, por quem tem
// acesso ao grupo, ou o replay de um pedido concluído antes, é observada
// esperando uma trava de A; A commita; a resposta precisa ser a recusa de um
// grupo inexistente (o resgate novo, o INVITE_REVOKED da M2-D42), nunca o
// desfecho guardado.
async function awaitBlockedBy(observer, blockerPid, pending, label) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (pending.state.done) {
      throw new Error(
        `${label}: finished before waiting for the uncommitted deletion: ${JSON.stringify(
          pending.state.result?.value?.body ?? String(pending.state.result?.reason),
        )}`,
      );
    }
    const { rows } = await observer.query(
      `select count(*)::integer as n from pg_stat_activity
        where wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))`,
      [blockerPid],
    );
    if (rows[0].n > 0) return;
    if (Date.now() > deadline) throw new Error(`${label}: no wait on the deletion was observed`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function proveDeletionDuringWait(status, db, { observer, first }) {
  const names = ['dw-owner', 'dw-m1', 'dw-m2', 'dw-tp', 'dw-ta', 'dw-stranger', 'dw-j1', 'dw-j2'];
  const [owner, m1, m2, tp, ta, stranger, j1, j2] = await Promise.all(
    names.map((label) => createActor(status, label)),
  );
  const actors = { owner, m1, m2, stranger };
  const firstPid = Number((await first.query('select pg_backend_pid() as pid')).rows[0].pid);
  let serial = 0;
  const fixture = async () => {
    serial += 1;
    const createRequest = crypto.randomUUID();
    const created = ok(
      await mutate(status, owner, 'create_group', { name: `Corrida ${serial}` }, createRequest),
      'create group',
    );
    const groupId = created.outcome.group_id;
    const inviteId = created.outcome.invite_id;
    await addMembers(db, groupId, [
      [m1, 'organizer', 'active'],
      [m2, 'player', 'active'],
      [tp, 'player', 'pending'],
      [ta, 'player', 'active'],
    ]);
    await db.query('update public.groups set monthly_enabled = true where id = $1', [groupId]);
    const matchId = await createMatch(status, owner, groupId, 15);
    const share = ok(
      await read(status, owner, 'get_invite_share_link', { invite_id: inviteId }),
      'share',
    );
    return { groupId, inviteId, matchId, createRequest, share, deleter: owner };
  };
  const results = [];
  const failures = [];
  const race = async (label, f, run, check) => {
    await first.query('begin');
    let pending;
    try {
      await first.query('set local role service_role');
      const requestId = crypto.randomUUID();
      const deleted = await first.query(
        'select public.delete_group($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::uuid) as result',
        [f.deleter.authId, f.deleter.sessionId, requestId, hmac(requestId), f.groupId],
      );
      assert.equal(deleted.rows[0].result.outcome.logical_result, 'group_deleted', label);
      pending = track(run());
      await awaitBlockedBy(observer, firstPid, pending, label);
    } catch (error) {
      await first.query('rollback');
      if (pending) await pending.settled;
      throw error;
    }
    await first.query('commit');
    const settled = await pending.settled;
    try {
      assert.equal(settled.status, 'fulfilled', `${label}: ${String(settled.reason)}`);
      await check(settled.value);
      results.push(label);
    } catch (error) {
      failures.push(`${label}: ${settled.value?.status} ${JSON.stringify(settled.value?.body)}`);
    }
  };
  const unknownGroup = crypto.randomUUID();
  const unknownInvite = crypto.randomUUID();
  const unknownMatch = crypto.randomUUID();
  const call = (who, operation, kind, body, requestId) =>
    kind === 'read'
      ? read(status, actors[who], operation, body)
      : mutate(status, actors[who], operation, body, requestId);
  // Chamadas novas, por quem tem acesso ao grupo ainda vivo.
  const newCalls = [
    [
      'get_group_members',
      'read',
      'm1',
      (f) => ({ group_id: f.groupId }),
      { group_id: unknownGroup },
    ],
    [
      'get_invite_share_link',
      'read',
      'm1',
      (f) => ({ invite_id: f.inviteId }),
      { invite_id: unknownInvite },
    ],
    [
      'approve_member',
      'write',
      'm1',
      (f) => ({ group_id: f.groupId, profile_id: tp.profileId, approve: true }),
      { group_id: unknownGroup, profile_id: tp.profileId, approve: true },
    ],
    [
      'remove_member',
      'write',
      'm1',
      (f) => ({ group_id: f.groupId, profile_id: ta.profileId, reason: 'x' }),
      { group_id: unknownGroup, profile_id: ta.profileId, reason: 'x' },
    ],
    [
      'set_role',
      'write',
      'owner',
      (f) => ({ group_id: f.groupId, profile_id: ta.profileId, role: 'organizer' }),
      { group_id: unknownGroup, profile_id: ta.profileId, role: 'organizer' },
    ],
    [
      'set_monthly',
      'write',
      'm1',
      (f) => ({ group_id: f.groupId, profile_id: ta.profileId, enabled: true }),
      { group_id: unknownGroup, profile_id: ta.profileId, enabled: true },
    ],
    [
      'set_ratings_visibility',
      'write',
      'owner',
      (f) => ({ group_id: f.groupId, visibility: 'private', confirm_members_visibility: false }),
      { group_id: unknownGroup, visibility: 'private', confirm_members_visibility: false },
    ],
    [
      'transfer_ownership',
      'write',
      'owner',
      (f) => ({ group_id: f.groupId, new_owner_id: m1.profileId }),
      { group_id: unknownGroup, new_owner_id: m1.profileId },
    ],
    ['leave_group', 'write', 'm2', (f) => ({ group_id: f.groupId }), { group_id: unknownGroup }],
    [
      'rename_group',
      'write',
      'm1',
      (f) => ({ group_id: f.groupId, name: 'Outro nome' }),
      { group_id: unknownGroup, name: 'Outro nome' },
    ],
    [
      'set_group_appearance',
      'write',
      'owner',
      (f) => ({ group_id: f.groupId, icon: 'ball', color: 'blue' }),
      { group_id: unknownGroup, icon: 'ball', color: 'blue' },
    ],
    [
      'revoke_group_invite',
      'write',
      'm1',
      (f) => ({ invite_id: f.inviteId }),
      { invite_id: unknownInvite },
    ],
    [
      'regenerate_group_invite',
      'write',
      'm1',
      (f) => ({ invite_id: f.inviteId }),
      { invite_id: unknownInvite },
    ],
    [
      'issue_group_invite',
      'write',
      'm1',
      (f) => ({ group_id: f.groupId }),
      { group_id: unknownGroup },
    ],
    [
      'create_match',
      'write',
      'm1',
      (f) => ({ group_id: f.groupId, config: matchConfig(16) }),
      { group_id: unknownGroup, config: matchConfig(16) },
    ],
    [
      'update_match',
      'write',
      'm1',
      (f) => ({ match_id: f.matchId, config: matchConfig(17) }),
      { match_id: unknownMatch, config: matchConfig(17) },
    ],
    ['cancel_match', 'write', 'm1', (f) => ({ match_id: f.matchId }), { match_id: unknownMatch }],
    ['join_match', 'write', 'm2', (f) => ({ match_id: f.matchId }), { match_id: unknownMatch }],
    ['leave_match', 'write', 'm2', (f) => ({ match_id: f.matchId }), { match_id: unknownMatch }],
    [
      'set_match_payment',
      'write',
      'm1',
      (f) => ({ match_id: f.matchId, profile_id: m2.profileId, paid: true }),
      { match_id: unknownMatch, profile_id: m2.profileId, paid: true },
    ],
    [
      'delete_group',
      'write',
      'owner',
      (f) => ({ group_id: f.groupId }),
      { group_id: unknownGroup },
    ],
  ];
  for (const [operation, kind, who, body, unknownBody] of newCalls) {
    const f = await fixture();
    await race(
      `new ${operation}`,
      f,
      () => call(who, operation, kind, body(f)),
      async (result) => {
        const unknown = await call(who, operation, kind, unknownBody);
        assert.equal(
          result.status,
          unknown.status,
          `new ${operation}: status ${JSON.stringify(result.body)}`,
        );
        assert.deepEqual(result.body.error, unknown.body.error, `new ${operation}: error`);
        assert.equal(Object.hasOwn(result.body, 'data'), false, `new ${operation}: no data`);
      },
    );
  }
  // Resgate novo por um estranho: o convite fica revogado pela exclusão (M2-D42).
  for (const [operation, body] of [
    ['join_by_code', (f) => ({ code: f.share.code })],
    ['join_by_invite', (f) => ({ token: tokenOf(f.share.share_url) })],
  ]) {
    const f = await fixture();
    await race(
      `new ${operation}`,
      f,
      () => call('stranger', operation, 'write', body(f)),
      (result) => denied(result, 409, 'INVITE_REVOKED', `new ${operation}`),
    );
  }
  // Replays de pedidos concluídos com o grupo vivo, pelo próprio titular.
  const replays = [
    [
      'create_group',
      owner,
      async (f) => ({ body: { name: `Corrida ${serial}` }, requestId: f.createRequest }),
    ],
    ['join_by_code', j1, async (f) => ({ body: { code: f.share.code } })],
    ['join_by_invite', j2, async (f) => ({ body: { token: tokenOf(f.share.share_url) } })],
    [
      'approve_member',
      owner,
      async (f) => ({ body: { group_id: f.groupId, profile_id: tp.profileId, approve: true } }),
    ],
    [
      'remove_member',
      owner,
      async (f) => ({ body: { group_id: f.groupId, profile_id: ta.profileId, reason: 'x' } }),
    ],
    [
      'set_role',
      owner,
      async (f) => ({ body: { group_id: f.groupId, profile_id: ta.profileId, role: 'organizer' } }),
    ],
    [
      'set_monthly',
      m1,
      async (f) => ({ body: { group_id: f.groupId, profile_id: ta.profileId, enabled: true } }),
    ],
    [
      'set_ratings_visibility',
      owner,
      async (f) => ({
        body: { group_id: f.groupId, visibility: 'private', confirm_members_visibility: false },
      }),
    ],
    [
      'transfer_ownership',
      owner,
      async (f) => {
        f.after = () => {
          f.deleter = m1;
        };
        return { body: { group_id: f.groupId, new_owner_id: m1.profileId } };
      },
    ],
    ['leave_group', m2, async (f) => ({ body: { group_id: f.groupId } })],
    [
      'rename_group',
      m1,
      async (f) => ({ body: { group_id: f.groupId, name: `Corrida ${serial}` } }),
    ],
    [
      'set_group_appearance',
      owner,
      async (f) => ({ body: { group_id: f.groupId, icon: 'goal', color: 'green' } }),
    ],
    ['revoke_group_invite', m1, async (f) => ({ body: { invite_id: f.inviteId } })],
    ['regenerate_group_invite', m1, async (f) => ({ body: { invite_id: f.inviteId } })],
    [
      'issue_group_invite',
      m1,
      async (f) => {
        ok(
          await mutate(status, m1, 'revoke_group_invite', { invite_id: f.inviteId }),
          'revoke first',
        );
        return { body: { group_id: f.groupId } };
      },
    ],
    ['create_match', m1, async (f) => ({ body: { group_id: f.groupId, config: matchConfig(18) } })],
    ['update_match', m1, async (f) => ({ body: { match_id: f.matchId, config: matchConfig(19) } })],
    ['cancel_match', m1, async (f) => ({ body: { match_id: f.matchId } })],
    ['join_match', m2, async (f) => ({ body: { match_id: f.matchId } })],
    [
      'leave_match',
      m2,
      async (f) => {
        ok(await mutate(status, m2, 'join_match', { match_id: f.matchId }), 'join first');
        return { body: { match_id: f.matchId } };
      },
    ],
    [
      'set_match_payment',
      m1,
      async (f) => {
        ok(await mutate(status, m2, 'join_match', { match_id: f.matchId }), 'join first');
        return { body: { match_id: f.matchId, profile_id: m2.profileId, paid: true } };
      },
    ],
  ];
  for (const [operation, actor, prepare] of replays) {
    const f = await fixture();
    const { body, requestId = crypto.randomUUID() } = await prepare(f);
    if (operation !== 'create_group')
      ok(await mutate(status, actor, operation, body, requestId), `record ${operation}`);
    f.after?.();
    if (operation === 'set_match_payment')
      ok(
        await mutate(status, owner, 'set_match_payment', {
          match_id: f.matchId,
          profile_id: m2.profileId,
          paid: false,
        }),
        'clear mark for deletion without changing replay intent',
      );
    await race(
      `replay ${operation}`,
      f,
      () => mutate(status, actor, operation, body, requestId),
      (result) => denied(result, 404, 'NOT_FOUND', `replay ${operation}`),
    );
  }
  assert.deepEqual(failures, [], `answered after the deletion committed: ${failures.join(' | ')}`);
  console.log(
    `ok - deletion committing while the call waits for it: ${results.length} races (${newCalls.length + 2} new calls by members with access and ${replays.length} replays recorded while the group was live), each observed waiting on the uncommitted deletion, all answer like an unknown group after the commit, never the stored outcome`,
  );
}

// ---------------------------------------------------------------------------
// Concorrência: apagar × entrar, criar racha e confirmar, nas duas ordens
// ---------------------------------------------------------------------------
// Os dois parados atrás de quem segura o grupo. Quem pega a trava primeiro
// decide; o outro vê o resultado, sem 40P01 e sem efeito parcial.
async function race(status, connections, db, order, label, setup) {
  const { observer, holder, first, second } = connections;
  const pids = await assertDistinctConnections({ observer, holder, first, second }, label);
  const fixture = await setup();
  const start = { delete: fixture.remove, other: fixture.compete };
  await holder.query('begin');
  await holder.query('select 1 from public.groups where id=$1 for no key update', [
    fixture.groupId,
  ]);
  let one;
  let two;
  try {
    one = track(start[order[0]](first));
    await awaitLockWait(observer, one, pids.first, pids.holder, `${label} ${order[0]}`, APP_PREFIX);
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
  const byName = { [order[0]]: a, [order[1]]: b };
  for (const result of [a, b]) {
    assert.notEqual(result.reason?.code, '40P01', `${label}: no deadlock`);
  }
  assert.equal(
    byName.delete.status,
    'fulfilled',
    `${label}: delete ${String(byName.delete.reason)}`,
  );
  assert.equal(byName.delete.value.outcome.logical_result, 'group_deleted');
  return { ...byName, fixture };
}
async function proveBarriers(status, connections, db) {
  const owner = await createActor(status, 'race-owner');
  const organizer = await createActor(status, 'race-organizer');

  // Entrar pelo código.
  const joinSetup = (label) => async () => {
    const { groupId, inviteId } = await createGroup(status, owner, `Entrar ${label}`);
    const joiner = await createActor(status, `joiner-${label}`);
    const { rows } = await db.query('select code_digest from public.group_invites where id=$1', [
      inviteId,
    ]);
    return {
      groupId,
      joiner,
      remove: (connection) => rpcDelete(connection, owner, groupId),
      compete: (connection) => rpcJoinByCode(connection, joiner, rows[0].code_digest),
    };
  };
  const membership = async (groupId, actor) =>
    (
      await db.query(
        'select status from public.group_members where group_id=$1 and profile_id=$2',
        [groupId, actor.profileId],
      )
    ).rows[0]?.status ?? null;
  const joinFirst = await race(
    status,
    connections,
    db,
    ['other', 'delete'],
    'join first',
    joinSetup('a'),
  );
  assert.equal(joinFirst.other.value?.outcome.logical_result, 'membership_requested');
  assert.equal(await membership(joinFirst.fixture.groupId, joinFirst.fixture.joiner), 'removed');
  const deleteFirstJoin = await race(
    status,
    connections,
    db,
    ['delete', 'other'],
    'delete first join',
    joinSetup('b'),
  );
  assert.equal(deleteFirstJoin.other.status, 'rejected');
  assert.equal(deleteFirstJoin.other.reason.message, 'INVITE_REVOKED');
  assert.equal(
    await membership(deleteFirstJoin.fixture.groupId, deleteFirstJoin.fixture.joiner),
    null,
  );
  console.log(
    'ok - delete × join, both orders: join first is closed as removed with the deletion; delete first leaves the code revoked and no membership',
  );

  // Criar racha, pelo organizador.
  const createSetup = (label) => async () => {
    const { groupId } = await createGroup(status, owner, `Criar ${label}`);
    await addMembers(db, groupId, [[organizer, 'organizer', 'active']]);
    return {
      groupId,
      remove: (connection) => rpcDelete(connection, owner, groupId),
      compete: (connection) => rpcCreateMatch(connection, organizer, groupId, canonicalConfig(6)),
    };
  };
  const createFirst = await race(
    status,
    connections,
    db,
    ['other', 'delete'],
    'create first',
    createSetup('a'),
  );
  assert.equal(createFirst.other.value?.outcome.logical_result, 'match_created');
  assert.equal(
    await liveMatches(db, createFirst.fixture.groupId),
    0,
    'the new match is canceled with the group',
  );
  const deleteFirstCreate = await race(
    status,
    connections,
    db,
    ['delete', 'other'],
    'delete first create',
    createSetup('b'),
  );
  assert.equal(deleteFirstCreate.other.status, 'rejected');
  assert.equal(deleteFirstCreate.other.reason.message, 'GROUP_DELETED');
  assert.equal(
    (
      await db.query('select count(*)::integer as n from private.matches where group_id=$1', [
        deleteFirstCreate.fixture.groupId,
      ])
    ).rows[0].n,
    0,
  );
  console.log(
    'ok - delete × create match, both orders: create first is canceled with the group; delete first refuses the creation',
  );

  // Confirmar presença.
  const presenceSetup = (label) => async () => {
    const { groupId } = await createGroup(status, owner, `Confirmar ${label}`);
    const player = await createActor(status, `player-${label}`);
    await addMembers(db, groupId, [[player, 'player', 'active']]);
    const matchId = await createMatch(status, owner, groupId, 7);
    return {
      groupId,
      matchId,
      player,
      remove: (connection) => rpcDelete(connection, owner, groupId),
      compete: (connection) => rpcJoinMatch(connection, player, matchId),
    };
  };
  const presence = async (fixture) =>
    (
      await db.query(
        `select m.canceled_at is not null as canceled,
                (select status from private.match_players p where p.match_id = m.id and p.profile_id = $2) as status
           from private.matches m where m.id = $1`,
        [fixture.matchId, fixture.player.profileId],
      )
    ).rows[0];
  const joinMatchFirst = await race(
    status,
    connections,
    db,
    ['other', 'delete'],
    'presence first',
    presenceSetup('a'),
  );
  assert.equal(joinMatchFirst.other.value?.outcome.logical_result, 'match_joined');
  assert.deepEqual(await presence(joinMatchFirst.fixture), { canceled: true, status: 'starter' });
  const deleteFirstPresence = await race(
    status,
    connections,
    db,
    ['delete', 'other'],
    'delete first presence',
    presenceSetup('b'),
  );
  assert.equal(deleteFirstPresence.other.status, 'rejected');
  assert.equal(deleteFirstPresence.other.reason.message, 'GROUP_DELETED');
  assert.deepEqual(await presence(deleteFirstPresence.fixture), { canceled: true, status: null });
  console.log(
    'ok - delete × join match, both orders: the confirmation stays as history in the canceled match; delete first refuses it',
  );
}

// Contraprova executável: sem a trava do grupo e com uma pausa entre cancelar
// os rachas e gravar o encerramento, um "Criar racha" no meio deixa um racha
// vivo num grupo apagado. Com a trava e a mesma pausa, a criação espera e é
// recusada.
async function proveLockMutant(status, connections, db) {
  const { first, second } = connections;
  const original = (await db.query('select pg_get_functiondef($1::regprocedure) as d', [DELETE]))
    .rows[0].d;
  const groupLock =
    '  perform 1 from public.groups where id = p_group_id and not private.is_group_deleted(id)\n    for no key update;\n';
  const cancel = `  update private.matches
  set canceled_at = now(), canceled_by = v_actor_id
  where group_id = p_group_id and canceled_at is null and ends_at > now();
`;
  assert.ok(original.includes(groupLock) && original.includes(cancel));
  const paused = original.replace(cancel, `${cancel}  perform pg_sleep(0.8);\n`);
  const unlocked = paused.replace(groupLock, '');
  const owner = await createActor(status, 'mutant-owner');
  const organizer = await createActor(status, 'mutant-organizer');
  const run = async (label) => {
    const { groupId } = await createGroup(status, owner, `Mutante ${label}`);
    await addMembers(db, groupId, [[organizer, 'organizer', 'active']]);
    const removal = track(rpcDelete(first, owner, groupId));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const creation = track(rpcCreateMatch(second, organizer, groupId, canonicalConfig(8)));
    const [removed, created] = await Promise.all([removal.settled, creation.settled]);
    return { removed, created, live: await liveMatches(db, groupId) };
  };
  try {
    await db.query(unlocked);
    const broken = await run('sem trava');
    assert.equal(broken.removed.status, 'fulfilled', 'mutant deletion goes through');
    assert.equal(broken.created.value?.outcome.logical_result, 'match_created');
    assert.equal(broken.live, 1, 'mutant: a live match in a deleted group');
    await db.query(paused);
    const guarded = await run('com trava');
    assert.equal(guarded.removed.status, 'fulfilled');
    assert.equal(guarded.created.status, 'rejected');
    assert.equal(guarded.created.reason.message, 'GROUP_DELETED');
    assert.equal(guarded.live, 0);
  } finally {
    await db.query(original);
  }
  const live = (await db.query('select pg_get_functiondef($1::regprocedure) as d', [DELETE]))
    .rows[0].d;
  assert.equal(live, original, 'delete_group restored byte for byte');
  console.log(
    'ok - mutant without the group lock: a match created during the deletion stays live in the deleted group; with the lock and the same pause: refused, none live',
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
  guard.onCleanup(cleanup);
  guard.onCensus(async (census) => {
    const count = async (relation) =>
      (await census.query(`select count(*)::integer as n from ${relation}`)).rows[0].n;
    const residue = {
      'auth.users': await count('auth.users'),
      'private.group_deletions': await count('private.group_deletions'),
      'private.matches': await count('private.matches'),
      'public.groups': await count('public.groups'),
      'public.profiles': await count('public.profiles'),
      'private.idempotency_records': await count('private.idempotency_records'),
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
    const initial = (await db.query('select count(*)::integer as n from auth.users')).rows[0].n;
    assert.equal(initial, 0, 'auth.users before proofs');
    console.log('ok - auth.users=0 before proofs');
    await proveHttp(status, db);
    await proveNoLockWait(status, db, holder);
    await proveNoLockWaitReplays(status, db, holder);
    await proveDeletionDuringWait(status, db, { observer, first });
    await proveBarriers(status, { observer, holder, first, second }, db);
    await proveLockMutant(status, { first, second }, db);
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
if (await guard.run(main)) console.log('Group deletion harness passed.');
