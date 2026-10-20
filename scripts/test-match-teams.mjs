// Fatia 0031 (sorteio de times), pelo caminho HTTP real com JWT GoTrue e por
// chamadas diretas como a Edge faz, com commit de verdade: chamada forçada
// pela Edge recusada a jogador, ex-membro e estranho (este igual a um ID
// inexistente); o organizador sorteia e o jogador lê os mesmos times;
// concorrência na trava do racha com barreira, nas duas ordens (sortear ×
// desistir, × confirmar, × cancelar, × apagar o grupo, e o replay × cancelar
// e × apagar); racha cancelado e grupo apagado respondendo sem esperar a
// trava; e duas contraprovas executáveis: sem as travas, e sem a revalidação
// depois delas.
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
const AUTH_PREFIX = 'match-teams-';
const APP_PREFIX = 'colete_match_teams_';
const PASSWORD = 'colete-local-match-teams-harness-password';
const DRAW = 'public.draw_teams(uuid,uuid,uuid,text,integer,integer,uuid,integer,boolean)';
const LOCKS = 'private.lock_match_context(uuid,uuid,uuid,uuid)';
const DRAW_TEAMS = 'private.draw_match_teams(uuid,uuid,integer,uuid)';
const NO_WAIT_MS = 3000;
const guard = installHarnessGuard('db:test:teams', {
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
      `delete from private.match_draws where match_id in
         (select id from private.matches where group_id = any($1::uuid[]))`,
      [groups],
    );
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
function matchConfig(days, slots) {
  const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 + days * 86_400_000);
  return {
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 90 * 60_000).toISOString(),
    timezone: 'America/Sao_Paulo',
    location_name: 'Arena do Sorteio',
    location_address: null,
    description: null,
    latitude: null,
    longitude: null,
    field_slots: slots,
    field_price: '10.00',
  };
}
async function createGroup(status, owner, name) {
  return ok(await mutate(status, owner, 'create_group', { name }), `create ${name}`).outcome
    .group_id;
}
async function createMatch(status, actor, groupId, slots = 12, days = 4) {
  return ok(
    await mutate(status, actor, 'create_match', {
      group_id: groupId,
      config: matchConfig(days, slots),
    }),
    'create match',
  ).outcome.match_id;
}
async function joinAll(status, actors, matchId) {
  for (const actor of actors) {
    ok(await mutate(status, actor, 'join_match', { match_id: matchId }), `join ${actor.name}`);
  }
}
// The owner rates each [actor, stars] through the Edge, as the app does (0031).
async function rateAll(status, owner, groupId, entries) {
  for (const [actor, stars] of entries) {
    ok(
      await mutate(status, owner, 'set_rating', {
        group_id: groupId,
        profile_id: actor.profileId,
        stars,
      }),
      `rate ${actor.name}`,
    );
  }
}
// Oráculo independente da serpentina da D63-A (docs/04 §§2 e 6): ordem por
// nota desc e UUID asc, capacidades balanced_sizes, índices 0..K-1 e depois
// K-1..0 repetindo os extremos e pulando time cheio. Devolve id -> time (1..K).
function snake(players, teamCount) {
  const order = [...players].sort((a, b) =>
    b.stars !== a.stars ? b.stars - a.stars : a.profileId < b.profileId ? -1 : 1,
  );
  const n = order.length;
  const capacity = Array.from({ length: teamCount }, (_, t) =>
    t < n % teamCount ? Math.floor(n / teamCount) + 1 : Math.floor(n / teamCount),
  );
  const sequence = [];
  for (let pass = 0; sequence.length < n * teamCount; pass += 1) {
    for (let t = 0; t < teamCount; t += 1) sequence.push(pass % 2 === 0 ? t : teamCount - 1 - t);
  }
  const fill = Array(teamCount).fill(0);
  const result = new Map();
  let cursor = 0;
  for (const player of order) {
    while (fill[sequence[cursor]] >= capacity[sequence[cursor]]) cursor += 1;
    const team = sequence[cursor];
    cursor += 1;
    fill[team] += 1;
    result.set(player.profileId, team + 1);
  }
  return result;
}
async function drawn(db, matchId) {
  const { rows } = await db.query(
    `select member.profile_id, member.team_number from private.match_draw_members member
       join private.match_draws draw on draw.id = member.draw_id where draw.match_id = $1`,
    [matchId],
  );
  return new Map(rows.map((row) => [row.profile_id, row.team_number]));
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
function rpcDraw(
  connection,
  actor,
  matchId,
  teamCount,
  requestId = crypto.randomUUID(),
  confirm = true,
) {
  return rpc(
    connection,
    'public.draw_teams($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::uuid,$6::integer,$7::boolean)',
    [
      actor.authId,
      actor.sessionId,
      requestId,
      hmac(requestId, matchId, teamCount, confirm),
      matchId,
      teamCount,
      confirm,
    ],
  );
}
function rpcMatch(name) {
  return (connection, actor, matchId, requestId = crypto.randomUUID()) =>
    rpc(connection, `public.${name}($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::uuid)`, [
      actor.authId,
      actor.sessionId,
      requestId,
      hmac(requestId, matchId),
      matchId,
    ]);
}
const rpcJoin = rpcMatch('join_match');
const rpcLeave = rpcMatch('leave_match');
const rpcCancel = rpcMatch('cancel_match');
function rpcDelete(connection, actor, groupId, requestId = crypto.randomUUID()) {
  return rpc(connection, 'public.delete_group($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::uuid)', [
    actor.authId,
    actor.sessionId,
    requestId,
    hmac(requestId, groupId),
    groupId,
  ]);
}

// ---------------------------------------------------------------------------
// HTTP: o organizador sorteia, o jogador lê; os demais, a recusa padrão
// ---------------------------------------------------------------------------
async function proveHttp(status, db) {
  const owner = await createActor(status, 'owner');
  const organizer = await createActor(status, 'organizer');
  const keepers = await Promise.all(
    ['gk1', 'gk2'].map((label) => createActor(status, label, 'goalkeeper')),
  );
  const field = await Promise.all(
    [
      ['d1', 'defender'],
      ['d2', 'defender'],
      ['m1', 'midfielder'],
      ['m2', 'midfielder'],
      ['f1', 'forward'],
      ['n1', null],
    ].map(([label, position]) => createActor(status, label, position)),
  );
  const player = await createActor(status, 'player');
  const former = await createActor(status, 'former');
  const stranger = await createActor(status, 'stranger');
  const groupId = await createGroup(status, owner, 'Grupo do Sorteio');
  await addMembers(db, groupId, [
    [organizer, 'organizer'],
    [player, 'player'],
    [former, 'organizer'],
    ...[...keepers, ...field].map((actor) => [actor, 'player']),
  ]);
  const matchId = await createMatch(status, owner, groupId, 8);
  // Cinco confirmados primeiro: não fazem 3 times (6) nem 4 (8).
  await joinAll(status, [...keepers, ...field.slice(0, 3)], matchId);
  await db.query(
    `update public.group_members set status='removed', removed_at=now()
      where group_id=$1 and profile_id=$2`,
    [groupId, former.profileId],
  );

  // Sem sorteio: o jogador não vê times; o organizador pode sortear.
  const before = ok(await read(status, player, 'get_match_teams', { match_id: matchId }), 'empty');
  assert.deepEqual(
    { can_draw: before.can_draw, teams: before.teams, stale: before.stale },
    { can_draw: false, teams: [], stale: false },
  );

  // Chamada forçada pela Edge: jogador 403, ex-membro e estranho 404 iguais a um ID inexistente.
  const ghost = crypto.randomUUID();
  const draw = (actor, id, teamCount = 2, confirm = true) =>
    mutate(status, actor, 'draw_teams', {
      match_id: id,
      team_count: teamCount,
      confirm_unequal_sizes: confirm,
    });
  denied(await draw(player, matchId), 403, 'NOT_ORGANIZER', 'player draws');
  denied(await draw(keepers[0], matchId), 403, 'NOT_ORGANIZER', 'confirmed player draws');
  for (const [label, actor] of [
    ['former organizer', former],
    ['stranger', stranger],
  ]) {
    const existing = await draw(actor, matchId);
    denied(existing, 404, 'NOT_FOUND', `${label} draws`);
    same(existing, await draw(actor, ghost), `${label}: existing and unknown draw alike`);
    const reading = await read(status, actor, 'get_match_teams', { match_id: matchId });
    denied(reading, 404, 'NOT_FOUND', `${label} reads`);
    same(
      reading,
      await read(status, actor, 'get_match_teams', { match_id: ghost }),
      `${label}: existing and unknown read alike`,
    );
  }
  for (const body of [
    { match_id: matchId, team_count: 5, confirm_unequal_sizes: true },
    { match_id: matchId, team_count: 1, confirm_unequal_sizes: true },
    { match_id: matchId, confirm_unequal_sizes: true },
    { match_id: matchId, team_count: 2 },
    { match_id: matchId, team_count: 2, confirm_unequal_sizes: true, players: [] },
  ]) {
    denied(await mutate(status, organizer, 'draw_teams', body), 422, 'VALIDATION', 'shape');
  }
  denied(await draw(organizer, matchId, 3), 409, 'TEAM_SIZE_INVALID', 'five confirmed, 3 teams');
  denied(await draw(organizer, matchId, 4), 409, 'TEAM_SIZE_INVALID', 'five confirmed, 4 teams');
  // Sem nota, o sorteio não roda (docs/01 §5.6), e sem valor padrão.
  denied(await draw(organizer, matchId, 2), 409, 'RATINGS_MISSING', 'unrated confirmed');
  // Notas: os dois "goleiros" do perfil são os melhores e o pior; a posição
  // não conta (D8, D9), então caem no mesmo time pela serpentina.
  const stars = new Map([
    [keepers[0], 5],
    [field[0], 4],
    [field[1], 4],
    [field[2], 3],
    [field[3], 3],
    [field[4], 2],
    [field[5], 2],
    [keepers[1], 1],
  ]);
  await rateAll(status, owner, groupId, [...stars]);
  denied(
    await draw(organizer, matchId, 2, false),
    422,
    'UNEQUAL_TEAMS_CONFIRMATION_REQUIRED',
    'five in two teams without the confirmation',
  );
  const { rows: ledger } = await db.query(
    "select count(*)::integer as n from private.idempotency_records where operation='draw_teams'",
  );
  assert.equal(ledger[0].n, 0, 'no refusal leaves a ledger row');
  await joinAll(status, field.slice(3), matchId);

  // O organizador sorteia; dono, organizador e jogador leem os mesmos times.
  const requestId = crypto.randomUUID();
  const outcome = ok(
    await mutate(
      status,
      organizer,
      'draw_teams',
      { match_id: matchId, team_count: 2, confirm_unequal_sizes: true },
      requestId,
    ),
    'organizer draws',
  );
  assert.deepEqual(outcome, {
    outcome: { group_id: groupId, logical_result: 'teams_drawn', match_id: matchId },
  });
  const views = await Promise.all(
    [owner, organizer, player, keepers[0]].map(async (actor) =>
      ok(await read(status, actor, 'get_match_teams', { match_id: matchId }), 'read'),
    ),
  );
  const names = (view) =>
    view.teams.map((team) => team.players.map((entry) => entry.name).join(',')).join('|');
  for (const view of views) assert.equal(names(view), names(views[0]), 'same teams for all');
  assert.deepEqual(
    views.map((view) => view.can_draw),
    [true, true, false, false],
  );
  const sizes = views[0].teams.map((team) => team.players.length);
  assert.deepEqual(sizes, [4, 4], 'eight confirmed in 2 teams of 4');
  const expected = snake(
    [...stars].map(([actor, value]) => ({ profileId: actor.profileId, stars: value })),
    2,
  );
  assert.deepEqual(
    Object.fromEntries(await drawn(db, matchId)),
    Object.fromEntries(expected),
    'the teams are the D63-A snake by rating',
  );
  assert.equal(
    expected.get(keepers[0].profileId),
    expected.get(keepers[1].profileId),
    'both profile "goalkeepers" share a team: position never enters the draw',
  );
  const { rows: versionRows } = await db.query(
    `select count(*)::integer as n from private.match_draw_members member
       join private.match_draws draw on draw.id = member.draw_id
       join private.ratings rating on rating.profile_id = member.profile_id
        and rating.group_id = $2 and rating.current_history_id = member.rating_history_id
      where draw.match_id = $1 and draw.algorithm_version = 'snake-v1'`,
    [matchId, groupId],
  );
  assert.equal(versionRows[0].n, 8, 'each member keeps the rating version used, snake-v1');
  const beforeReplay = await drawn(db, matchId);
  const replay = ok(
    await mutate(
      status,
      organizer,
      'draw_teams',
      { match_id: matchId, team_count: 2, confirm_unequal_sizes: true },
      requestId,
    ),
    'replay',
  );
  assert.deepEqual(replay, outcome, 'the replay is the same outcome');
  assert.deepEqual(await drawn(db, matchId), beforeReplay, 'and draws nothing again');

  // Sortear de novo substitui: só o último vale.
  ok(await draw(owner, matchId, 4), 'owner draws 4 teams');
  const four = ok(await read(status, player, 'get_match_teams', { match_id: matchId }), '4');
  assert.equal(four.team_count, 4);
  assert.deepEqual(
    four.teams.map((team) => team.players.length),
    [2, 2, 2, 2],
  );
  const { rows: draws } = await db.query(
    'select count(*)::integer as n from private.match_draws where match_id=$1',
    [matchId],
  );
  assert.equal(draws[0].n, 1, 'one draw kept');

  // Desatualizado: quem desiste some; quem confirma fica sem time.
  const late = await createActor(status, 'late', 'forward');
  await addMembers(db, groupId, [[late, 'player']]);
  await rateAll(status, owner, groupId, [[late, 3]]);
  ok(await mutate(status, field[0], 'leave_match', { match_id: matchId }), 'leave');
  ok(await mutate(status, late, 'join_match', { match_id: matchId }), 'late join');
  const stale = ok(await read(status, player, 'get_match_teams', { match_id: matchId }), 'stale');
  assert.equal(stale.stale, true);
  assert.deepEqual(
    stale.unassigned.map((entry) => entry.name),
    [late.name],
  );
  assert.ok(!names(stale).includes(field[0].name), 'the leaver left the teams');

  // Cancelado: sem times, sortear recusa (a chamada nova e o replay).
  ok(await mutate(status, owner, 'cancel_match', { match_id: matchId }), 'cancel');
  const canceled = ok(await read(status, player, 'get_match_teams', { match_id: matchId }), 'c');
  assert.deepEqual([canceled.teams, canceled.can_draw], [[], false]);
  denied(await draw(organizer, matchId), 409, 'MATCH_CANCELED', 'draw on canceled');
  denied(
    await mutate(
      status,
      organizer,
      'draw_teams',
      { match_id: matchId, team_count: 2, confirm_unequal_sizes: true },
      requestId,
    ),
    409,
    'MATCH_CANCELED',
    'replay on canceled',
  );
  same(await draw(stranger, matchId), await draw(stranger, ghost), 'stranger on canceled');

  // Grupo apagado: as duas rotas respondem como a um racha inexistente.
  const secondMatch = await createMatch(status, owner, groupId, 8, 5);
  await joinAll(status, [...keepers, ...field.slice(1)], secondMatch);
  const deletedRequest = crypto.randomUUID();
  ok(
    await mutate(
      status,
      organizer,
      'draw_teams',
      { match_id: secondMatch, team_count: 2, confirm_unequal_sizes: true },
      deletedRequest,
    ),
    'draw before deletion',
  );
  ok(await mutate(status, owner, 'delete_group', { group_id: groupId }), 'delete group');
  for (const actor of [owner, organizer, player]) {
    same(await draw(actor, secondMatch), await draw(actor, ghost), 'draw on deleted group');
    const reading = await read(status, actor, 'get_match_teams', { match_id: secondMatch });
    denied(reading, 404, 'NOT_FOUND', 'read deleted');
    same(
      reading,
      await read(status, actor, 'get_match_teams', { match_id: ghost }),
      'read deleted group',
    );
  }
  same(
    await mutate(
      status,
      organizer,
      'draw_teams',
      { match_id: secondMatch, team_count: 2, confirm_unequal_sizes: true },
      deletedRequest,
    ),
    await draw(organizer, ghost),
    'replay on deleted group',
  );
  console.log(
    'ok - HTTP: unrated confirmed 409 RATINGS_MISSING, five in two teams without confirmation 422; the organizer draws the D63-A snake by rating (checked against an independent oracle, profile goalkeepers together, rating versions kept) and owner, organizer and player read the same teams; player 403, former member and stranger 404 like an unknown ID (draw and read); shape 422; 3 and 4 teams of 5 refused; replay; drawing again keeps one draw; stale after leave and join; canceled and deleted group refuse, replay included',
  );
}

// ---------------------------------------------------------------------------
// Barreira: os dois competidores parados atrás de quem segura o grupo
// ---------------------------------------------------------------------------
async function proveBarriers(status, connections, db) {
  const { observer, holder, first, second } = connections;
  const pids = await assertDistinctConnections({ observer, holder, first, second }, 'teams');
  const owner = await createActor(status, 'b-owner');
  const organizer = await createActor(status, 'b-organizer');
  const squad = await Promise.all(
    ['b1', 'b2', 'b3', 'b4', 'b5'].map((label, index) =>
      createActor(status, label, index < 2 ? 'goalkeeper' : 'defender'),
    ),
  );
  const [x, y, z, w, extra] = squad;
  // Os grupos são apagados ao fim de cada corrida: ninguém passa de 5 ativos.
  const fixture = async (label, joined = [x, y, z, w]) => {
    const groupId = await createGroup(status, owner, `Corrida ${label}`);
    await addMembers(db, groupId, [
      [organizer, 'organizer'],
      ...squad.map((actor) => [actor, 'player']),
    ]);
    await rateAll(
      status,
      owner,
      groupId,
      squad.map((actor, index) => [actor, 5 - index]),
    );
    const matchId = await createMatch(status, owner, groupId, 6);
    await joinAll(status, joined, matchId);
    return { groupId, matchId };
  };
  const race = async (label, order, start) => {
    await holder.query('begin');
    await holder.query('select 1 from public.groups where id=$1 for no key update', [
      start.groupId,
    ]);
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
  const teamsOf = async (matchId) =>
    ok(await read(status, organizer, 'get_match_teams', { match_id: matchId }), 'teams');
  const results = [];

  // Sortear × desistir.
  for (const order of [
    ['leave', 'draw'],
    ['draw', 'leave'],
  ]) {
    // Cinco confirmados: depois da desistência ainda há dois por time.
    const f = await fixture(`leave-${order[0]}`, squad);
    const settled = await race(`draw leave ${order[0]} first`, order, {
      groupId: f.groupId,
      leave: (connection) => rpcLeave(connection, x, f.matchId),
      draw: (connection) => rpcDraw(connection, organizer, f.matchId, 2),
    });
    assert.equal(settled.leave.status, 'fulfilled', String(settled.leave.reason));
    assert.equal(settled.draw.status, 'fulfilled', String(settled.draw.reason));
    const members = await drawn(db, f.matchId);
    const teams = await teamsOf(f.matchId);
    if (order[0] === 'leave') {
      assert.equal(members.has(x.profileId), false, 'leave first: the draw never saw x');
      assert.equal(members.size, 4);
      assert.equal(teams.stale, false, 'leave first: the teams are current');
    } else {
      assert.equal(members.has(x.profileId), true, 'draw first: x was confirmed then');
      assert.equal(teams.stale, true, 'draw first: the leave makes them stale');
      assert.ok(
        teams.teams.every((team) => team.players.every((entry) => entry.name !== x.name)),
        'and x leaves the teams',
      );
    }
    await finish(f.groupId);
    results.push(`draw × leave, ${order[0]} first`);
  }

  // Sortear × confirmar.
  for (const order of [
    ['join', 'draw'],
    ['draw', 'join'],
  ]) {
    const f = await fixture(`join-${order[0]}`);
    const settled = await race(`draw join ${order[0]} first`, order, {
      groupId: f.groupId,
      join: (connection) => rpcJoin(connection, extra, f.matchId),
      draw: (connection) => rpcDraw(connection, organizer, f.matchId, 2),
    });
    assert.equal(settled.join.status, 'fulfilled', String(settled.join.reason));
    assert.equal(settled.draw.status, 'fulfilled', String(settled.draw.reason));
    const members = await drawn(db, f.matchId);
    const teams = await teamsOf(f.matchId);
    if (order[0] === 'join') {
      assert.equal(members.size, 5, 'join first: five drawn');
      assert.equal(teams.stale, false);
    } else {
      assert.equal(members.has(extra.profileId), false, 'draw first: four drawn');
      assert.equal(teams.stale, true);
      assert.deepEqual(
        teams.unassigned.map((entry) => entry.name),
        [extra.name],
      );
    }
    await finish(f.groupId);
    results.push(`draw × join, ${order[0]} first`);
  }

  // Sortear × avaliar: as notas são lidas sob a trava do grupo, que set_rating
  // também segura. Avaliar primeiro: o sorteio usa a nota nova. Sortear
  // primeiro: a nota muda depois e a organização vê os times desatualizados.
  for (const order of [
    ['rate', 'draw'],
    ['draw', 'rate'],
  ]) {
    const f = await fixture(`rate-${order[0]}`);
    const settled = await race(`draw rate ${order[0]} first`, order, {
      groupId: f.groupId,
      rate: (connection) =>
        rpc(
          connection,
          'public.set_rating($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::uuid,$6::uuid,$7::integer)',
          (() => {
            const requestId = crypto.randomUUID();
            return [
              owner.authId,
              owner.sessionId,
              requestId,
              hmac(requestId, f.groupId, x.profileId, 1),
              f.groupId,
              x.profileId,
              1,
            ];
          })(),
        ),
      draw: (connection) => rpcDraw(connection, organizer, f.matchId, 2),
    });
    assert.equal(settled.rate.status, 'fulfilled', String(settled.rate.reason));
    assert.equal(settled.draw.status, 'fulfilled', String(settled.draw.reason));
    const { rows } = await db.query(
      `select member.rating_history_id = rating.current_history_id as current
         from private.match_draw_members member
         join private.match_draws draw on draw.id = member.draw_id
         join private.ratings rating on rating.group_id = $2 and rating.profile_id = member.profile_id
        where draw.match_id = $1 and member.profile_id = $3`,
      [f.matchId, f.groupId, x.profileId],
    );
    const teams = await teamsOf(f.matchId);
    if (order[0] === 'rate') {
      assert.equal(rows[0].current, true, 'rate first: the draw used the new rating');
      assert.equal(teams.stale, false);
    } else {
      assert.equal(rows[0].current, false, 'draw first: the rating changed afterwards');
      assert.equal(teams.stale, true, 'and the organization sees the teams stale');
    }
    await finish(f.groupId);
    results.push(`draw × rate, ${order[0]} first`);
  }

  // Sortear × cancelar, e o replay de um sorteio anterior × cancelar.
  for (const replay of [false, true]) {
    for (const order of [
      ['cancel', 'draw'],
      ['draw', 'cancel'],
    ]) {
      const f = await fixture(`cancel-${replay}-${order[0]}`);
      const requestId = crypto.randomUUID();
      if (replay) await rpcDraw(db, organizer, f.matchId, 2, requestId);
      const settled = await race(`draw cancel ${replay} ${order[0]} first`, order, {
        groupId: f.groupId,
        cancel: (connection) => rpcCancel(connection, owner, f.matchId),
        draw: (connection) => rpcDraw(connection, organizer, f.matchId, 2, requestId),
      });
      assert.equal(settled.cancel.status, 'fulfilled', String(settled.cancel.reason));
      if (order[0] === 'cancel') {
        assert.equal(settled.draw.status, 'rejected', 'cancel first: the draw is refused');
        assert.equal(settled.draw.reason.message, 'MATCH_CANCELED');
      } else {
        assert.equal(settled.draw.status, 'fulfilled', String(settled.draw.reason));
        assert.equal(settled.draw.value.outcome.logical_result, 'teams_drawn');
      }
      assert.deepEqual((await teamsOf(f.matchId)).teams, [], 'a canceled match shows no teams');
      await finish(f.groupId);
      results.push(`${replay ? 'replay' : 'draw'} × cancel, ${order[0]} first`);
    }
  }

  // Sortear × apagar o grupo, e o replay × apagar.
  for (const replay of [false, true]) {
    for (const order of [
      ['remove', 'draw'],
      ['draw', 'remove'],
    ]) {
      const f = await fixture(`delete-${replay}-${order[0]}`);
      const requestId = crypto.randomUUID();
      if (replay) await rpcDraw(db, organizer, f.matchId, 2, requestId);
      const settled = await race(`draw delete ${replay} ${order[0]} first`, order, {
        groupId: f.groupId,
        remove: (connection) => rpcDelete(connection, owner, f.groupId),
        draw: (connection) => rpcDraw(connection, organizer, f.matchId, 2, requestId),
      });
      assert.equal(settled.remove.status, 'fulfilled', String(settled.remove.reason));
      if (order[0] === 'remove') {
        assert.equal(settled.draw.status, 'rejected', 'delete first: the draw is refused');
        assert.equal(settled.draw.reason.message, 'GROUP_DELETED');
      } else {
        assert.equal(settled.draw.status, 'fulfilled', String(settled.draw.reason));
      }
      denied(
        await read(status, organizer, 'get_match_teams', { match_id: f.matchId }),
        404,
        'NOT_FOUND',
        'the teams of a deleted group are not read',
      );
      results.push(`${replay ? 'replay' : 'draw'} × delete group, ${order[0]} first`);
    }
  }
  console.log(
    `ok - ${results.length} races on the match lock, each with both competitors observed waiting behind the group holder: ${results.join('; ')}`,
  );
  return { owner, organizer, squad };
}

// ---------------------------------------------------------------------------
// Racha cancelado e grupo apagado respondem sem esperar a trava
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
async function proveNoLockWait(status, db, holder) {
  const owner = await createActor(status, 'nw-owner');
  const organizer = await createActor(status, 'nw-organizer');
  const stranger = await createActor(status, 'nw-stranger');
  const squad = await Promise.all(['nw1', 'nw2', 'nw3', 'nw4'].map((l) => createActor(status, l)));
  const timings = [];
  for (const kind of ['canceled', 'deleted']) {
    const groupId = await createGroup(status, owner, `Trava ${kind}`);
    await addMembers(db, groupId, [
      [organizer, 'organizer'],
      ...squad.map((actor) => [actor, 'player']),
    ]);
    await rateAll(
      status,
      owner,
      groupId,
      squad.map((actor, index) => [actor, index + 2]),
    );
    const matchId = await createMatch(status, owner, groupId, 6);
    await joinAll(status, squad, matchId);
    const requestId = crypto.randomUUID();
    ok(
      await mutate(
        status,
        organizer,
        'draw_teams',
        { match_id: matchId, team_count: 2, confirm_unequal_sizes: true },
        requestId,
      ),
      'draw',
    );
    if (kind === 'canceled') {
      ok(await mutate(status, owner, 'cancel_match', { match_id: matchId }), 'cancel');
    } else {
      ok(await mutate(status, owner, 'delete_group', { group_id: groupId }), 'delete');
    }
    const ghost = crypto.randomUUID();
    const calls = [
      [
        'organizer new draw',
        () =>
          mutate(status, organizer, 'draw_teams', {
            match_id: matchId,
            team_count: 2,
            confirm_unequal_sizes: true,
          }),
      ],
      [
        'organizer replay',
        () =>
          mutate(
            status,
            organizer,
            'draw_teams',
            { match_id: matchId, team_count: 2, confirm_unequal_sizes: true },
            requestId,
          ),
      ],
      [
        'stranger draw',
        () =>
          mutate(status, stranger, 'draw_teams', {
            match_id: matchId,
            team_count: 2,
            confirm_unequal_sizes: true,
          }),
      ],
      ['member read', () => read(status, squad[0], 'get_match_teams', { match_id: matchId })],
      ['stranger read', () => read(status, stranger, 'get_match_teams', { match_id: matchId })],
    ];
    await holder.query('begin');
    try {
      await holder.query('select 1 from public.groups where id=$1 for update', [groupId]);
      await holder.query('select 1 from public.group_members where group_id=$1 for update', [
        groupId,
      ]);
      await holder.query('select 1 from private.matches where group_id=$1 for update', [groupId]);
      await holder.query(
        `select 1 from private.match_draws where match_id in
           (select id from private.matches where group_id=$1) for update`,
        [groupId],
      );
      for (const [label, call] of calls) {
        const timed = await withinHold(call());
        assert.ok(!timed.waited, `${kind} ${label} waited for the held lock`);
        timings.push(timed.ms);
        const { response } = timed;
        if (kind === 'deleted' || label.startsWith('stranger')) {
          denied(response, 404, 'NOT_FOUND', `${kind} ${label}`);
        } else if (label === 'member read') {
          assert.deepEqual(ok(response, label).teams, [], 'canceled: no teams');
        } else {
          denied(response, 409, 'MATCH_CANCELED', `${kind} ${label}`);
        }
      }
      // O estranho responde igual a um ID inexistente, com a trava presa.
      same(
        await mutate(status, stranger, 'draw_teams', {
          match_id: matchId,
          team_count: 2,
          confirm_unequal_sizes: true,
        }),
        await mutate(status, stranger, 'draw_teams', {
          match_id: ghost,
          team_count: 2,
          confirm_unequal_sizes: true,
        }),
        `${kind}: stranger like unknown`,
      );
    } finally {
      await holder.query('rollback');
    }
  }
  console.log(
    `ok - with the canceled match and the deleted group (group, memberships, matches and draws) held FOR UPDATE: new draw, replay, stranger draw, member and stranger reads answer while the lock is held (${timings.length} calls, slowest ${Math.round(Math.max(...timings))} ms); the stranger answers like an unknown ID`,
  );
}

// ---------------------------------------------------------------------------
// Contraprovas executáveis, nas funções vivas, restauradas byte a byte
// ---------------------------------------------------------------------------
async function liveDefinition(db, signature) {
  return (await db.query('select pg_get_functiondef($1::regprocedure) as d', [signature])).rows[0]
    .d;
}
async function withMutants(db, mutants, run) {
  const originals = [];
  for (const [signature, mutate] of mutants) {
    const original = await liveDefinition(db, signature);
    const mutated = mutate(original);
    assert.notEqual(mutated, original, `${signature}: the mutant changes nothing`);
    originals.push([signature, original]);
    await db.query(mutated);
  }
  try {
    return await run();
  } finally {
    for (const [signature, original] of originals.reverse()) {
      await db.query(original);
      assert.equal(await liveDefinition(db, signature), original, `${signature} restored`);
    }
  }
}

// Sem as travas de grupo e racha, com uma pausa depois de ler os confirmados:
// um "Desistir" no meio termina antes do sorteio, e o sorteio grava quem já
// tinha saído. Com as travas e a mesma pausa, a desistência espera o sorteio.
// Sem a decisão antes da trava, o sorteio num racha cancelado passa pela trava
// do racha e espera quem segura o grupo: o tempo diria que o racha existe.
async function proveNoWaitMutant(status, db, holder, context) {
  const { owner, organizer, squad } = context;
  const groupId = await createGroup(status, owner, 'Contraprova sem espera');
  await addMembers(db, groupId, [
    [organizer, 'organizer'],
    ...squad.map((actor) => [actor, 'player']),
  ]);
  const matchId = await createMatch(status, owner, groupId, 6);
  await joinAll(status, squad.slice(0, 4), matchId);
  ok(await mutate(status, owner, 'cancel_match', { match_id: matchId }), 'cancel');
  const precheck = 'if v_group_id is null or v_canceled_at is not null';
  const outcome = await withMutants(
    db,
    [[DRAW, (d) => d.replace(precheck, 'if v_group_id is null')]],
    async () => {
      await holder.query('begin');
      let pending;
      try {
        await holder.query('select 1 from public.groups where id=$1 for update', [groupId]);
        pending = track(
          mutate(status, organizer, 'draw_teams', {
            match_id: matchId,
            team_count: 2,
            confirm_unequal_sizes: true,
          }),
        );
        const timed = await withinHold(pending.settled);
        return { timed, pending };
      } finally {
        await holder.query('rollback');
      }
    },
  );
  assert.equal(outcome.timed.waited, true, 'mutant: the canceled match waits for the lock');
  const settled = await outcome.pending.settled;
  denied(settled.value, 409, 'MATCH_CANCELED', 'mutant: refused only after the wait');
  ok(await mutate(status, owner, 'delete_group', { group_id: groupId }), 'end');
  console.log(
    `ok - counterproof: deciding the canceled match only after the match lock makes the draw wait for the held group (more than ${NO_WAIT_MS} ms), then answer MATCH_CANCELED`,
  );
}

async function proveLockMutant(status, connections, db, context) {
  const { first, second } = connections;
  const { owner, organizer, squad } = context;
  const [x, y, z, w] = squad;
  const groupLock = 'perform 1 from public.groups where id = v_group_id for no key update;';
  const matchLock = 'perform 1 from private.matches where id = p_match_id for no key update;';
  const paused = (definition) =>
    definition.replace('  end loop;\nend;', '  end loop;\n  perform pg_sleep(0.8);\nend;');
  const run = async (label) => {
    const groupId = await createGroup(status, owner, `Contraprova ${label}`);
    await addMembers(db, groupId, [
      [organizer, 'organizer'],
      ...squad.map((actor) => [actor, 'player']),
    ]);
    await rateAll(
      status,
      owner,
      groupId,
      squad.map((actor, index) => [actor, 5 - index]),
    );
    const matchId = await createMatch(status, owner, groupId, 5);
    await joinAll(status, [x, y, z, w], matchId);
    const order = [];
    const drawing = track(rpcDraw(first, organizer, matchId, 2).finally(() => order.push('draw')));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const leaving = track(rpcLeave(second, x, matchId).finally(() => order.push('leave')));
    const [d, l] = await Promise.all([drawing.settled, leaving.settled]);
    assert.equal(d.status, 'fulfilled', String(d.reason));
    assert.equal(l.status, 'fulfilled', String(l.reason));
    const members = await drawn(db, matchId);
    ok(await mutate(status, owner, 'delete_group', { group_id: groupId }), 'end');
    return { order, drewLeaver: members.has(x.profileId) };
  };
  const locked = await withMutants(db, [[DRAW_TEAMS, paused]], () => run('locked'));
  assert.deepEqual(locked.order, ['draw', 'leave'], 'with the locks the leave waits the draw');
  const broken = await withMutants(
    db,
    [
      [DRAW_TEAMS, paused],
      [LOCKS, (d) => d.replace(groupLock, '').replace(matchLock, '')],
    ],
    () => run('unlocked'),
  );
  assert.deepEqual(broken.order, ['leave', 'draw'], 'mutant: the leave commits mid-draw');
  assert.equal(broken.drewLeaver, true, 'mutant: the draw holds someone who already left');
  console.log(
    'ok - counterproof: without the group and match locks and with a pause after reading the confirmed, a leave commits mid-draw and the draw keeps the player who left; with the locks and the same pause, the leave waits for the draw',
  );
}

// Sem a releitura depois da trava, um cancelamento que commita enquanto o
// sorteio espera deixa sortear num racha cancelado. Com ela, MATCH_CANCELED.
async function proveRevalidationMutant(status, connections, db, context) {
  const { observer, holder, first, second } = connections;
  const { owner, organizer, squad } = context;
  const pids = await assertDistinctConnections({ observer, holder, first, second }, 'revalidate');
  const recheck = `  if v_match.canceled_at is not null then
    raise exception using errcode = 'P0001', message = 'MATCH_CANCELED';
  end if;
`;
  const run = async (label) => {
    const groupId = await createGroup(status, owner, `Releitura ${label}`);
    await addMembers(db, groupId, [
      [organizer, 'organizer'],
      ...squad.map((actor) => [actor, 'player']),
    ]);
    await rateAll(
      status,
      owner,
      groupId,
      squad.map((actor, index) => [actor, 5 - index]),
    );
    const matchId = await createMatch(status, owner, groupId, 5);
    await joinAll(status, squad.slice(0, 4), matchId);
    await holder.query('begin');
    await holder.query('select 1 from public.groups where id=$1 for no key update', [groupId]);
    let canceling;
    let drawing;
    try {
      canceling = track(rpcCancel(first, owner, matchId));
      await awaitLockWait(
        observer,
        canceling,
        pids.first,
        pids.holder,
        `${label} cancel`,
        APP_PREFIX,
      );
      drawing = track(rpcDraw(second, organizer, matchId, 2));
      await awaitLockWait(
        observer,
        drawing,
        pids.second,
        [pids.holder, pids.first],
        `${label} draw`,
        APP_PREFIX,
      );
    } finally {
      await holder.query('commit');
    }
    const [c, d] = await Promise.all([canceling.settled, drawing.settled]);
    assert.equal(c.status, 'fulfilled', String(c.reason));
    const { rows } = await db.query(
      'select count(*)::integer as n from private.match_draws where match_id=$1',
      [matchId],
    );
    ok(await mutate(status, owner, 'delete_group', { group_id: groupId }), 'end');
    return { draw: d, draws: rows[0].n };
  };
  const live = await run('live');
  assert.equal(live.draw.status, 'rejected');
  assert.equal(live.draw.reason.message, 'MATCH_CANCELED');
  assert.equal(live.draws, 0);
  const broken = await withMutants(db, [[DRAW, (d) => d.replace(recheck, '')]], () =>
    run('mutant'),
  );
  assert.equal(broken.draw.status, 'fulfilled', 'mutant: the waiting draw goes through');
  assert.equal(broken.draws, 1, 'mutant: a canceled match holds a draw');
  console.log(
    'ok - counterproof: without the re-read after the lock, a cancellation that commits while the draw waits lets it draw on a canceled match; with it, MATCH_CANCELED and no draw',
  );
}

// Uma versão com o goleiro no sorteio (o perfil "goleiro" primeiro, como na
// regra anterior ao D8) reprova: dois goleiros com notas 5 e 2 vão para times
// diferentes, e não para os que a serpentina por nota manda.
async function proveGoalkeeperMutant(status, db) {
  const owner = await createActor(status, 'gk-owner');
  const [keeperA, fieldA, fieldB, keeperB] = await Promise.all(
    [
      ['gk-a', 'goalkeeper'],
      ['f-a', 'forward'],
      ['f-b', 'defender'],
      ['gk-b', 'goalkeeper'],
    ].map(([label, position]) => createActor(status, label, position)),
  );
  const ratings = [
    [keeperA, 5],
    [fieldA, 4],
    [fieldB, 3],
    [keeperB, 2],
  ];
  const expected = Object.fromEntries(
    snake(
      ratings.map(([actor, stars]) => ({ profileId: actor.profileId, stars })),
      2,
    ),
  );
  const run = async (label) => {
    const groupId = await createGroup(status, owner, `Goleiro ${label}`);
    await addMembers(
      db,
      groupId,
      ratings.map(([actor]) => [actor, 'player']),
    );
    await rateAll(status, owner, groupId, ratings);
    const matchId = await createMatch(status, owner, groupId, 4);
    await joinAll(status, [keeperA, fieldA, fieldB, keeperB], matchId);
    ok(
      await mutate(status, owner, 'draw_teams', {
        match_id: matchId,
        team_count: 2,
        confirm_unequal_sizes: false,
      }),
      'draw',
    );
    const placed = Object.fromEntries(await drawn(db, matchId));
    ok(await mutate(status, owner, 'delete_group', { group_id: groupId }), 'end');
    return placed;
  };
  const live = await run('live');
  assert.deepEqual(live, expected, 'the snake by rating');
  assert.equal(live[keeperA.profileId], live[keeperB.profileId], 'both goalkeepers together');
  const byPosition = await withMutants(
    db,
    [
      [
        DRAW_TEAMS,
        (d) =>
          d.replace(
            '    order by rating.stars desc, player.profile_id',
            `    order by (select case p.position when 'goalkeeper' then 0 else 1 end
                from public.profiles p where p.id = player.profile_id),
      rating.stars desc, player.profile_id`,
          ),
      ],
    ],
    () => run('mutant'),
  );
  assert.notDeepEqual(byPosition, expected, 'mutant: the goalkeepers leave the snake');
  assert.notEqual(
    byPosition[keeperA.profileId],
    byPosition[keeperB.profileId],
    'mutant: one goalkeeper per team, as the rule before D8',
  );
  console.log(
    'ok - counterproof: a version that puts the profile goalkeepers first splits them (one per team) and departs from the snake by rating; the live draw keeps them together, as the ratings say (D8, D9)',
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
      'private.match_draws': await count('private.match_draws'),
      'private.match_draw_members': await count('private.match_draw_members'),
      'private.ratings': await count('private.ratings'),
      'private.rating_history': await count('private.rating_history'),
      'private.match_players': await count('private.match_players'),
      'private.matches': await count('private.matches'),
      'private.group_deletions': await count('private.group_deletions'),
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
    const context = await proveBarriers(status, { observer, holder, first, second }, db);
    await proveNoLockWait(status, db, holder);
    await proveLockMutant(status, { first, second }, db, context);
    await proveRevalidationMutant(status, { observer, holder, first, second }, db, context);
    await proveNoWaitMutant(status, db, holder, context);
    await proveGoalkeeperMutant(status, db);
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
if (await guard.run(main)) console.log('Match teams harness passed.');
