// Fatia 0021 (Rachas v1): HTTP real com JWT GoTrue, leitura só pelas RPCs da
// Edge com actor context, sessão revogada recusada também na leitura (revisão
// do #70, P1-1), commit sob service_role, mutante de autoridade e barreira.
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
const AUTH_PREFIX = 'matches-v1-';
const APP_PREFIX = 'colete_matches_';
const PASSWORD = 'colete-local-matches-harness-password';
const SIGNATURE = 'public.create_match(uuid,uuid,uuid,text,integer,integer,uuid,jsonb)';
const guard = installHarnessGuard('db:test:matches', {
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
    await db.query(`delete from private.matches where group_id in (${groups})`, [pattern]);
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
function read(status, actor, operation, body = {}) {
  return edge(status, `groups/${operation}`, body, actor.token);
}
function mutate(status, actor, operation, body, requestId = crypto.randomUUID()) {
  return edge(status, `groups/${operation}`, { ...body, request_id: requestId }, actor.token);
}
async function rest(status, actor, pathAndQuery, init = {}) {
  const response = await fetch(`${status.apiUrl}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: status.publishableKey,
      Authorization: `Bearer ${actor.token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
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
      { request_id: crypto.randomUUID(), profile: { name: `Racha ${label}` } },
      actor.token,
    ),
    `complete ${label}`,
  );
  actor.profileId = completed.outcome.profile_id;
  return actor;
}

// Um início futuro com precisão de minuto, a `days` dias do relógio local.
function window(days, minutes = 90) {
  const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 + days * 86_400_000);
  return {
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + minutes * 60_000).toISOString(),
  };
}
function config(overrides = {}) {
  return {
    ...window(3),
    timezone: 'America/Sao_Paulo',
    location_name: 'Arena da Vila',
    location_address: 'Rua das Flores, 100',
    description: '  Traga   colete\r\nescuro  ',
    latitude: -23.550519,
    longitude: -46.633309,
    field_slots: 14,
    field_price: '25.5',
    ...overrides,
  };
}

async function proveHttp(status, db) {
  const owner = await createActor(status, 'owner');
  const organizer = await createActor(status, 'organizer');
  const player = await createActor(status, 'player');
  const pending = await createActor(status, 'pending');
  const removed = await createActor(status, 'removed');
  const outsider = await createActor(status, 'outsider');
  const revoked = await createActor(status, 'revoked');
  const groupId = ok(
    await mutate(status, owner, 'create_group', { name: 'Grupo do Racha' }),
    'create group',
  ).outcome.group_id;
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
    'other group',
  ).outcome.group_id;

  // Criação, linha gravada e desfecho somente com IDs.
  const requestId = crypto.randomUUID();
  const business = { group_id: groupId, config: config() };
  const first = ok(await mutate(status, owner, 'create_match', business, requestId), 'owner');
  assert.deepEqual(Object.keys(first).sort(), ['outcome']);
  assert.deepEqual(Object.keys(first.outcome).sort(), ['group_id', 'logical_result', 'match_id']);
  assert.equal(first.outcome.group_id, groupId);
  assert.equal(first.outcome.logical_result, 'match_created');
  const matchId = first.outcome.match_id;
  const row = (
    await db.query(
      `select group_id, to_char(starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS".000Z"') as starts_at,
         timezone, location_name, location_address, description, latitude::text, longitude::text,
         field_slots, field_price::text, created_by
       from private.matches where id=$1`,
      [matchId],
    )
  ).rows[0];
  assert.deepEqual(row, {
    group_id: groupId,
    starts_at: business.config.starts_at,
    timezone: 'America/Sao_Paulo',
    location_name: 'Arena da Vila',
    location_address: 'Rua das Flores, 100',
    description: 'Traga colete\nescuro',
    latitude: '-23.5505',
    longitude: '-46.6333',
    field_slots: 14,
    field_price: '25.50',
    created_by: owner.profileId,
  });
  const ledger = (
    await db.query(
      `select state, resource_type, resource_id, outcome from private.idempotency_records
       where actor_id=$1 and operation='create_match' and request_id=$2`,
      [owner.profileId, requestId],
    )
  ).rows[0];
  assert.equal(ledger.state, 'completed');
  assert.equal(ledger.resource_type, 'group');
  assert.equal(ledger.resource_id, groupId);
  assert.deepEqual(ledger.outcome, first.outcome);
  assert.doesNotMatch(JSON.stringify(ledger), /23\.55|46\.63|Arena|Flores|25\.5|colete/);
  console.log(
    'ok - owner creates; row is canonical, coordinates rounded to 4 places, ledger holds IDs only',
  );

  // Replay: forma equivalente devolve o mesmo desfecho; outra intenção conflita.
  const offset = (iso) =>
    new Date(new Date(iso).getTime() - 3 * 3_600_000).toISOString().slice(0, 16) + '-03:00';
  const replay = ok(
    await mutate(
      status,
      owner,
      'create_match',
      {
        group_id: groupId,
        config: {
          ...business.config,
          starts_at: offset(business.config.starts_at),
          ends_at: offset(business.config.ends_at),
          location_name: '  Arena　da Vila ',
          latitude: -23.55049,
          field_price: '25.50',
        },
      },
      requestId,
    ),
    'equivalent replay',
  );
  assert.deepEqual(replay, first);
  denied(
    await mutate(
      status,
      owner,
      'create_match',
      { group_id: groupId, config: config({ field_slots: 12 }) },
      requestId,
    ),
    409,
    'IDEMPOTENCY_CONFLICT',
    'same request_id, other intent',
  );
  const count = (
    await db.query('select count(*)::int as n from private.matches where group_id=$1', [groupId])
  ).rows[0].n;
  assert.equal(count, 1, 'replay and conflict create nothing');
  console.log('ok - equivalent replay returns the stored outcome; a different intent conflicts');

  // Autoridade: dono e organizador ativo criam; os demais não.
  const organizerRequest = crypto.randomUUID();
  const organizerFirst = ok(
    await mutate(
      status,
      organizer,
      'create_match',
      { group_id: groupId, config: config({ ...window(4), latitude: null, longitude: null }) },
      organizerRequest,
    ),
    'organizer',
  );
  for (const [actor, code] of [
    [player, 'NOT_ORGANIZER'],
    [pending, 'NOT_MEMBER'],
    [removed, 'NOT_MEMBER'],
    [outsider, 'NOT_MEMBER'],
  ]) {
    denied(
      await mutate(status, actor, 'create_match', { group_id: groupId, config: config() }),
      403,
      code,
      `authority ${code}`,
    );
  }
  denied(
    await mutate(status, owner, 'create_match', { group_id: otherGroup, config: config() }),
    403,
    'NOT_MEMBER',
    'owner of another group',
  );
  console.log(
    'ok - owner and active organizer create; player, pending, removed and stranger denied',
  );

  // Regras de domínio pela Edge e, sem Edge, pela própria RPC.
  denied(
    await mutate(status, owner, 'create_match', {
      group_id: groupId,
      config: config({ ...window(-1) }),
    }),
    422,
    'TIME_ORDER',
    'past start',
  );
  denied(
    await mutate(status, owner, 'create_match', {
      group_id: groupId,
      config: config({ field_price: '0' }),
    }),
    422,
    'PRICE_INVALID',
    'zero price',
  );
  denied(
    await mutate(status, owner, 'create_match', {
      group_id: groupId,
      config: config({ latitude: -23.5, longitude: null }),
    }),
    422,
    'VALIDATION',
    'half coordinate pair',
  );
  console.log('ok - TIME_ORDER, PRICE_INVALID and a half coordinate pair refused at the Edge');

  // Leitura somente pela Edge, com o JWT de cada pessoa.
  const listed = ok(await read(status, player, 'list_my_matches'), 'player list');
  assert.deepEqual(
    listed.map((match) => match.id),
    [matchId, organizerFirst.outcome.match_id],
  );
  assert.equal(listed[0].latitude, -23.5505);
  assert.equal(listed[0].group_name, 'Grupo do Racha');
  const single = ok(await read(status, player, 'get_match', { match_id: matchId }), 'get');
  assert.equal(single.length, 1);
  assert.equal(Object.hasOwn(single[0], 'created_by'), false, 'created_by is not projected');
  const strip = (body) => ({ ...body, request_id: undefined });
  for (const actor of [pending, removed, outsider]) {
    const existing = await read(status, actor, 'get_match', { match_id: matchId });
    const unknown = await read(status, actor, 'get_match', { match_id: crypto.randomUUID() });
    denied(existing, 404, 'NOT_FOUND', 'existing match outside membership');
    assert.deepEqual(strip(existing.body), strip(unknown.body), 'no enumeration');
    assert.deepEqual(ok(await read(status, actor, 'list_my_matches'), 'list'), []);
  }
  // Nenhuma porta direta: tabela em private e RPCs só para service_role.
  const tableRead = await rest(status, owner, `matches?select=id&id=eq.${matchId}`);
  assert.notEqual(tableRead.status, 200, 'no REST read of matches');
  const rpcRead = await rest(status, owner, 'rpc/get_match', {
    method: 'POST',
    body: JSON.stringify({
      p_actor_auth_user_id: owner.authId,
      p_actor_session_id: owner.sessionId,
      p_match_id: matchId,
    }),
  });
  assert.notEqual(rpcRead.status, 200, 'the client cannot call get_match around the Edge');
  const direct = await rest(status, owner, 'matches', {
    method: 'POST',
    body: JSON.stringify({
      group_id: groupId,
      starts_at: business.config.starts_at,
      ends_at: business.config.ends_at,
      timezone: 'UTC',
      location_name: 'Direto',
      field_slots: 10,
      field_price: 10,
      created_by: owner.profileId,
    }),
  });
  assert.notEqual(direct.status, 201, 'no client writes matches directly');
  console.log(
    `ok - reads only by the Edge: members read; pending, removed and stranger get the same NOT_FOUND for existing and unknown IDs; REST table ${tableRead.status}, REST rpc ${rpcRead.status}, insert ${direct.status}`,
  );

  // Autoridade perdida: replay preserva o desfecho; chamada nova é negada.
  await db.query(
    `update public.group_members set role='player' where group_id=$1 and profile_id=$2`,
    [groupId, organizer.profileId],
  );
  const roleReplay = ok(
    await mutate(
      status,
      organizer,
      'create_match',
      { group_id: groupId, config: config({ ...window(4), latitude: null, longitude: null }) },
      organizerRequest,
    ),
    'role lost replay',
  );
  assert.deepEqual(roleReplay, organizerFirst);
  denied(
    await mutate(status, organizer, 'create_match', { group_id: groupId, config: config() }),
    403,
    'NOT_ORGANIZER',
    'role lost new call',
  );

  const revokedRequest = crypto.randomUUID();
  const revokedBusiness = { group_id: groupId, config: config({ ...window(5) }) };
  const revokedMatch = ok(
    await mutate(status, revoked, 'create_match', revokedBusiness, revokedRequest),
    'pre-revoke',
  ).outcome.match_id;
  // Roteiro da revisão do #70 (P1-1): criar → ler → revogar → ler de novo
  // com o mesmo JWT.
  const liveRead = ok(await read(status, revoked, 'get_match', { match_id: revokedMatch }), 'r');
  assert.equal(liveRead[0].location_address, 'Rua das Flores, 100', 'a live session reads');
  assert.equal(
    liveRead[0].description,
    'Traga colete\nescuro',
    'get_match projects the description',
  );
  ok(
    await edge(
      status,
      'identity/revoke_current_session',
      { request_id: crypto.randomUUID() },
      revoked.token,
    ),
    'revoke session',
  );
  denied(
    await mutate(status, revoked, 'create_match', revokedBusiness, revokedRequest),
    401,
    'UNAUTHENTICATED',
    'revoked replay',
  );
  denied(
    await read(status, revoked, 'get_match', { match_id: revokedMatch }),
    401,
    'UNAUTHENTICATED',
    'revoked read through the Edge',
  );
  denied(await read(status, revoked, 'list_my_matches'), 401, 'UNAUTHENTICATED', 'revoked list');
  const revokedRest = await rest(
    status,
    revoked,
    `matches?select=id,location_address,latitude,longitude&id=eq.${revokedMatch}`,
  );
  // Sem porta direta: a tabela não está exposta e a RPC é só de service_role,
  // então o PostgREST recusa antes de qualquer linha, com JWT vivo ou revogado.
  assert.equal(revokedRest.status, 404, 'revoked JWT reads no row through PostgREST');
  assert.equal(revokedRest.body?.code, 'PGRST205');
  assert.equal(JSON.stringify(revokedRest.body ?? '').includes('Flores'), false);
  const revokedRpc = await rest(status, revoked, 'rpc/get_match', {
    method: 'POST',
    body: JSON.stringify({
      p_actor_auth_user_id: revoked.authId,
      p_actor_session_id: revoked.sessionId,
      p_match_id: revokedMatch,
    }),
  });
  assert.equal(revokedRpc.status, 403, 'revoked JWT cannot call the RPC directly');
  assert.equal(revokedRpc.body?.code, '42501');
  console.log(
    `ok - revoked session: Edge read and list 401 UNAUTHENTICATED; PostgREST table ${revokedRest.status} ${revokedRest.body?.code}, rpc ${revokedRpc.status} ${revokedRpc.body?.code}`,
  );
  console.log(
    'ok - lost role keeps the replay and denies new calls; revoked session denies replay',
  );

  const stateGroup = ok(
    await mutate(status, owner, 'create_group', { name: 'Grupo de Estado' }),
    'state group',
  ).outcome.group_id;
  await db.query('update public.groups set suspended_at=now() where id=$1', [stateGroup]);
  denied(
    await mutate(status, owner, 'create_match', { group_id: stateGroup, config: config() }),
    403,
    'GROUP_SUSPENDED',
    'suspended group',
  );
  await db.query('update public.groups set suspended_at=null, archived_at=now() where id=$1', [
    stateGroup,
  ]);
  denied(
    await mutate(status, owner, 'create_match', { group_id: stateGroup, config: config() }),
    410,
    'GROUP_ARCHIVED',
    'archived group',
  );
  console.log('ok - suspended and archived groups refuse create_match with contracted codes');
  return { owner, player, groupId, revoked, revokedMatch };
}

async function rpcTx(connection, actor, groupId, business, requestId = crypto.randomUUID()) {
  const hmac = crypto.createHash('sha256').update(JSON.stringify(business)).digest('hex');
  await connection.query('begin');
  try {
    await connection.query('set local role service_role');
    const result = await connection.query(
      `select public.create_match($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::uuid,$6::jsonb) as result`,
      [actor.authId, actor.sessionId, requestId, hmac, groupId, JSON.stringify(business)],
    );
    await connection.query('commit');
    return result.rows[0].result;
  } catch (error) {
    try {
      await connection.query('rollback');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'create_match and rollback failed');
    }
    throw error;
  }
}
function canonicalConfig(overrides = {}) {
  return {
    ...window(6),
    timezone: 'America/Sao_Paulo',
    location_name: 'Arena RPC',
    location_address: null,
    description: null,
    latitude: null,
    longitude: null,
    field_slots: 10,
    field_price: '20.00',
    ...overrides,
  };
}

// A RPC é a autoridade: sem a Edge, a regra temporal e o papel continuam valendo,
// e a autoridade é decidida antes do relógio.
async function proveRpcAuthority(connection, context) {
  const past = canonicalConfig({ ...window(-1) });
  const refusedPast = rpcTx(connection, context.owner, context.groupId, past);
  await assert.rejects(refusedPast, (error) => error.message === 'TIME_ORDER');
  const refusedPlayer = rpcTx(connection, context.player, context.groupId, past);
  await assert.rejects(refusedPlayer, (error) => error.message === 'NOT_ORGANIZER');
  const fiveDecimals = canonicalConfig({ latitude: '-23.55052', longitude: '-46.6333' });
  await assert.rejects(
    rpcTx(connection, context.owner, context.groupId, fiveDecimals),
    (error) => error.message === 'VALIDATION',
  );
  console.log(
    'ok - without the Edge: past start TIME_ORDER, player NOT_ORGANIZER first, 5 decimals refused',
  );
}

// Contraprova da P1-1: se get_match aceitasse sessão revogada, o mesmo JWT
// revogado voltaria a ler endereço e coordenadas pela Edge.
async function proveRevocationMutant(status, db, context) {
  const signature = 'public.get_match(uuid,uuid,uuid)';
  const original = (
    await db.query('select pg_get_functiondef($1::regprocedure) as definition', [signature])
  ).rows[0].definition;
  const guard = 'private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true)';
  assert.equal(original.split(guard).length, 3, 'both actor checks are present');
  const mutant = original.replaceAll(
    guard,
    'private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true, true)',
  );
  const attempt = () =>
    read(status, context.revoked, 'get_match', { match_id: context.revokedMatch });
  denied(await attempt(), 401, 'UNAUTHENTICATED', 'before the mutant');
  await db.query(mutant);
  try {
    const leaked = ok(await attempt(), 'mutant read');
    assert.equal(leaked[0].location_address, 'Rua das Flores, 100', 'the mutant leaks the place');
  } finally {
    await db.query(original);
  }
  denied(await attempt(), 401, 'UNAUTHENTICATED', 'restored');
  console.log(
    'ok - revocation mutant: get_match accepting revoked sessions leaks the address; restored answers 401',
  );
}

async function proveAuthorityMutant(db, connection, context) {
  const original = (
    await db.query('select pg_get_functiondef($1::regprocedure) as definition', [SIGNATURE])
  ).rows[0].definition;
  const check = "if v_authority not in ('owner', 'organizer') then";
  assert.ok(original.includes(check));
  const mutant = original.replace(
    check,
    "if v_authority not in ('owner', 'organizer', 'player') then",
  );
  const attempt = () => rpcTx(connection, context.player, context.groupId, canonicalConfig());
  await assert.rejects(attempt, (error) => error.message === 'NOT_ORGANIZER');
  await db.query(mutant);
  try {
    const created = await attempt();
    assert.equal(
      created.outcome.logical_result,
      'match_created',
      'the mutant lets a player create',
    );
  } finally {
    await db.query(original);
  }
  await assert.rejects(attempt, (error) => error.message === 'NOT_ORGANIZER');
  console.log('ok - authority mutant lets a player create; restored function refuses again');
}

// create_match trava o grupo FOR NO KEY UPDATE: espera quem segura o grupo
// (arquivar, suspender, papel) e decide a autoridade sobre o estado final.
async function proveGroupBarrier(connections, db, context) {
  const { observer, holder, first } = connections;
  const pids = await assertDistinctConnections({ observer, holder, first }, 'match barrier');
  await holder.query('begin');
  await holder.query('select 1 from public.groups where id=$1 for no key update', [
    context.groupId,
  ]);
  let pending;
  try {
    pending = track(rpcTx(first, context.owner, context.groupId, canonicalConfig()));
    await awaitLockWait(observer, pending, pids.first, pids.holder, 'create_match', APP_PREFIX);
    await holder.query('update public.groups set suspended_at=now() where id=$1', [
      context.groupId,
    ]);
  } finally {
    await holder.query('commit');
  }
  const [result] = await Promise.all([pending.settled]);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason.message, 'GROUP_SUSPENDED', 'decided on the committed state');
  await db.query('update public.groups set suspended_at=null where id=$1', [context.groupId]);
  console.log(
    'ok - create_match waits on the group lock and sees the suspension committed meanwhile',
  );
}

async function main() {
  const status = localStatus();
  const db = client(status.dbUrl, 'admin');
  const observer = client(status.dbUrl, 'observer');
  const holder = client(status.dbUrl, 'holder');
  const first = client(status.dbUrl, 'first');
  const all = [db, observer, holder, first];
  guard.useDatabase(status.dbUrl);
  guard.onCleanup(cleanup);
  guard.onCensus(async (census) => {
    const users = (await census.query('select count(*)::integer as n from auth.users')).rows[0].n;
    const matches = (await census.query('select count(*)::integer as n from private.matches'))
      .rows[0].n;
    const groups = (await census.query('select count(*)::integer as n from public.groups')).rows[0]
      .n;
    const outcomes = (
      await census.query('select count(*)::integer as n from private.idempotency_records')
    ).rows[0].n;
    assert.equal(users, 0, 'auth.users after cleanup');
    assert.equal(matches, 0, 'matches after cleanup');
    assert.equal(groups, 0, 'groups after cleanup');
    assert.equal(outcomes, 0, 'idempotency after cleanup');
    console.log(
      `ok - residue: auth.users=${users}, matches=${matches}, groups=${groups}, idempotency=${outcomes}`,
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
    const context = await proveHttp(status, db);
    await proveRevocationMutant(status, db, context);
    await proveRpcAuthority(first, context);
    await proveAuthorityMutant(db, first, context);
    await proveGroupBarrier({ observer, holder, first }, db, context);
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
if (await guard.run(main)) console.log('Matches v1 harness passed.');
