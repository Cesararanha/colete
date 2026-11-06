// Fatia 0022 (Racha completo): presença, espera, promoção, pagamento e
// permissões por HTTP real com JWT GoTrue; saída do grupo e exclusão de conta
// liberando a vaga; concorrência na última vaga com barreira de lock, rajada
// pela Edge e contraprova executável sem as travas. Fatia 0028: editar e
// cancelar pela Edge, com chamada forçada recusada, e editar × confirmar na
// mesma trava do racha, com contraprova sem as travas.
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
const AUTH_PREFIX = 'match-players-';
const APP_PREFIX = 'colete_match_players_';
const PASSWORD = 'colete-local-match-players-harness-password';
const JOIN = 'public.join_match(uuid,uuid,uuid,text,integer,integer,uuid)';
const LOCKS = 'private.lock_match_context(uuid,uuid,uuid,uuid)';
const UPDATE = 'public.update_match(uuid,uuid,uuid,text,integer,integer,uuid,jsonb)';
const guard = installHarnessGuard('db:test:match-players', {
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
  // Perfis com a marca, e também os desidentificados pela exclusão: o
  // auth_user_id deles some, então são achados pela membership nos grupos do
  // harness.
  const groups = (
    await db.query(
      `select g.id from public.groups g join public.profiles p on p.id = g.owner_id
         join auth.users u on u.id = p.auth_user_id where u.email like $1 escape '\\'`,
      [pattern],
    )
  ).rows.map((row) => row.id);
  const profiles = (
    await db.query(
      `select p.id from public.profiles p join auth.users u on u.id = p.auth_user_id
        where u.email like $1 escape '\\'
       union select profile_id from public.group_members where group_id = any($2::uuid[])`,
      [pattern, groups],
    )
  ).rows.map((row) => row.id);
  await db.query('begin');
  try {
    await db.query(
      `delete from private.external_effects where resource_id in (
         select id from private.deletion_requests where profile_id = any($1::uuid[]))
       or resource_id = any($1::uuid[])`,
      [profiles],
    );
    for (const statement of [
      'delete from private.idempotency_records where actor_id = any($1::uuid[])',
      'delete from private.revoked_auth_sessions where profile_id = any($1::uuid[])',
      'delete from private.deletion_requests where profile_id = any($1::uuid[])',
      'delete from public.privacy_requests where profile_id = any($1::uuid[])',
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
      {
        request_id: crypto.randomUUID(),
        profile: { name: actor.name, nickname: `apelido-${label}`, position: 'midfielder' },
      },
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
function window(days, minutes = 90) {
  const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 + days * 86_400_000);
  return {
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + minutes * 60_000).toISOString(),
  };
}
async function createMatch(status, owner, groupId, slots, price = '12.50', days = 3) {
  return ok(
    await mutate(status, owner, 'create_match', {
      group_id: groupId,
      config: {
        ...window(days),
        timezone: 'America/Sao_Paulo',
        location_name: 'Arena da Lista',
        location_address: null,
        description: null,
        latitude: null,
        longitude: null,
        field_slots: slots,
        field_price: price,
      },
    }),
    'create match',
  ).outcome.match_id;
}
async function statuses(db, matchId) {
  const { rows } = await db.query(
    `select profile_id, status, paid, payment_marked_by, payment_marked_at, queue_seq
       from private.match_players where match_id=$1 order by queue_seq`,
    [matchId],
  );
  return rows.map((row) => ({ ...row, queue_seq: BigInt(row.queue_seq) }));
}
function statusOf(rows, actor) {
  return rows.find((row) => row.profile_id === actor.profileId)?.status;
}

// ---------------------------------------------------------------------------
// HTTP: presença, espera, promoção, pagamento, permissões e idempotência
// ---------------------------------------------------------------------------
// As quatro RPCs que recebem match_id, chamadas com o mesmo corpo para o ID
// existente e para um inexistente (revisão do #71, P1-2).
const PAIR_RPCS = ['join_match', 'leave_match', 'set_match_payment', 'get_match_roster'];
function callWith(status, name, actor, matchId, target) {
  if (name === 'get_match_roster') return read(status, actor, name, { match_id: matchId });
  if (name === 'set_match_payment') {
    return mutate(status, actor, name, {
      match_id: matchId,
      profile_id: target.profileId,
      paid: true,
    });
  }
  return mutate(status, actor, name, { match_id: matchId });
}
const withoutRequestId = (body) => ({ ...body, request_id: undefined });
async function provePair(status, actor, matchId, target, httpStatus, code, label) {
  const ghost = crypto.randomUUID();
  for (const name of PAIR_RPCS) {
    const existing = await callWith(status, name, actor, matchId, target);
    const unknown = await callWith(status, name, actor, ghost, target);
    denied(existing, httpStatus, code, `${label} ${name} existing`);
    denied(unknown, httpStatus, code, `${label} ${name} unknown`);
    assert.deepEqual(
      withoutRequestId(existing.body),
      withoutRequestId(unknown.body),
      `${label} ${name}: existing and unknown answer alike`,
    );
  }
}

async function proveHttp(status, db) {
  const owner = await createActor(status, 'owner');
  const organizer = await createActor(status, 'organizer');
  const [a, b, c, d] = await Promise.all(['a', 'b', 'c', 'd'].map((x) => createActor(status, x)));
  const pending = await createActor(status, 'pending');
  const outsider = await createActor(status, 'outsider');
  const groupId = ok(
    await mutate(status, owner, 'create_group', { name: 'Grupo da Lista' }),
    'create group',
  ).outcome.group_id;
  await addMembers(db, groupId, [
    [organizer, 'organizer', 'active'],
    [a, 'player', 'active'],
    [b, 'player', 'active'],
    [c, 'player', 'active'],
    [d, 'player', 'active'],
    [pending, 'player', 'pending'],
  ]);
  const matchId = await createMatch(status, owner, groupId, 2);

  // Confirmar: dois entram, os outros dois vão para o fim da espera.
  const aRequest = crypto.randomUUID();
  const aJoin = ok(await mutate(status, a, 'join_match', { match_id: matchId }, aRequest), 'A');
  assert.deepEqual(Object.keys(aJoin.outcome).sort(), ['group_id', 'logical_result', 'match_id']);
  assert.equal(aJoin.outcome.logical_result, 'match_joined');
  assert.deepEqual(aJoin.current, {
    status: 'starter',
    waitlist_position: null,
    confirmed_count: 1,
    waitlist_count: 0,
    field_slots: 2,
  });
  assert.equal(
    ok(await mutate(status, b, 'join_match', { match_id: matchId }), 'B').outcome.logical_result,
    'match_joined',
  );
  const cJoin = ok(await mutate(status, c, 'join_match', { match_id: matchId }), 'C');
  assert.equal(cJoin.outcome.logical_result, 'match_waitlisted');
  assert.equal(cJoin.current.waitlist_position, 1);
  const dJoin = ok(await mutate(status, d, 'join_match', { match_id: matchId }), 'D');
  assert.equal(dJoin.current.waitlist_position, 2);
  assert.equal(dJoin.current.confirmed_count, 2);
  console.log('ok - two confirmed fill 2 slots; the next two enter the waitlist at 1 and 2');

  // Idempotência: chave nova com a pessoa já na lista; replay; conflito.
  const again = ok(await mutate(status, a, 'join_match', { match_id: matchId }), 'A again');
  assert.equal(again.outcome.logical_result, 'match_join_unchanged');
  const replay = ok(await mutate(status, a, 'join_match', { match_id: matchId }, aRequest), 'rep');
  assert.deepEqual(replay.outcome, aJoin.outcome);
  assert.equal(replay.current.confirmed_count, 2, 'replay recomputes the current state');
  const otherMatch = await createMatch(status, owner, groupId, 5, '10.00', 4);
  denied(
    await mutate(status, a, 'join_match', { match_id: otherMatch }, aRequest),
    409,
    'IDEMPOTENCY_CONFLICT',
    'same request_id, other match',
  );
  assert.equal((await statuses(db, otherMatch)).length, 0, 'the conflict registers nobody');
  console.log('ok - new key while listed is unchanged; replay keeps the outcome; reuse conflicts');

  // Só membro ativo confirma, e quem é de fora não distingue um racha
  // existente de um inexistente (revisão do #71, P1-2): sempre o par.
  for (const [actor, label] of [
    [pending, 'pending'],
    [outsider, 'outsider'],
  ]) {
    await provePair(status, actor, matchId, a, 404, 'NOT_FOUND', label);
  }
  denied(
    await mutate(status, a, 'join_match', { match_id: crypto.randomUUID() }),
    404,
    'NOT_FOUND',
    'unknown match',
  );
  console.log(
    'ok - pending and stranger get the same 404 NOT_FOUND for an existing and an unknown match on all four RPCs',
  );

  // Leitura: jogador vê nome, apelido e posição e só o próprio pagamento.
  const playerView = ok(await read(status, c, 'get_match_roster', { match_id: matchId }), 'C r');
  assert.deepEqual(
    playerView.confirmed.map((entry) => [entry.name, entry.nickname, entry.position, entry.paid]),
    [
      [a.name, 'apelido-a', 'midfielder', null],
      [b.name, 'apelido-b', 'midfielder', null],
    ],
  );
  assert.deepEqual(
    playerView.waitlist.map((entry) => [entry.name, entry.is_viewer]),
    [
      [c.name, true],
      [d.name, false],
    ],
  );
  assert.equal(playerView.payment_summary, null);
  assert.deepEqual(playerView.viewer, {
    status: 'waitlist',
    waitlist_position: 1,
    paid: null,
    can_manage: false,
    refunds: [],
  });
  const ownerView = ok(await read(status, owner, 'get_match_roster', { match_id: matchId }), 'o');
  assert.deepEqual(ownerView.payment_summary, {
    paid_count: 0,
    confirmed_count: 2,
    total: '0.00',
  });
  assert.deepEqual(
    ownerView.confirmed.map((entry) => entry.paid),
    [false, false],
  );
  const occupancy = ok(await read(status, d, 'get_matches_occupancy'), 'occupancy');
  assert.deepEqual(
    occupancy.find((row) => row.match_id === matchId),
    {
      match_id: matchId,
      confirmed_count: 2,
      waitlist_count: 2,
      viewer_status: 'waitlist',
      canceled: false,
    },
  );
  const direct = await fetch(`${status.apiUrl}/rest/v1/match_players?select=id`, {
    headers: { apikey: status.publishableKey, Authorization: `Bearer ${owner.token}` },
  });
  assert.notEqual(direct.status, 200, 'no REST door to the registrations');
  console.log('ok - roster: names, nicknames, positions; payment only to the organisation');

  // Pagamento: só organização, só confirmado; quem e quando ficam gravados.
  denied(
    await mutate(status, b, 'set_match_payment', {
      match_id: matchId,
      profile_id: a.profileId,
      paid: true,
    }),
    403,
    'NOT_ORGANIZER',
    'player marks',
  );
  denied(
    await mutate(status, owner, 'set_match_payment', {
      match_id: matchId,
      profile_id: c.profileId,
      paid: true,
    }),
    409,
    'NOT_STARTER',
    'waitlisted target',
  );
  const marked = ok(
    await mutate(status, owner, 'set_match_payment', {
      match_id: matchId,
      profile_id: a.profileId,
      paid: true,
    }),
    'owner marks A',
  );
  assert.equal(marked.outcome.logical_result, 'payment_marked_paid');
  assert.equal(marked.outcome.profile_id, a.profileId);
  assert.deepEqual(marked.current, { paid_count: 1, confirmed_count: 2, total: '12.50' });
  const markedRow = (await statuses(db, matchId)).find((row) => row.profile_id === a.profileId);
  assert.equal(markedRow.paid, true);
  assert.equal(markedRow.payment_marked_by, owner.profileId);
  assert.ok(markedRow.payment_marked_at instanceof Date);
  const unchanged = ok(
    await mutate(status, organizer, 'set_match_payment', {
      match_id: matchId,
      profile_id: a.profileId,
      paid: true,
    }),
    'organizer re-marks',
  );
  assert.equal(unchanged.outcome.logical_result, 'payment_unchanged');
  const keptRow = (await statuses(db, matchId)).find((row) => row.profile_id === a.profileId);
  assert.equal(keptRow.payment_marked_by, owner.profileId, 'unchanged does not rewrite who');
  assert.equal(keptRow.payment_marked_at.getTime(), markedRow.payment_marked_at.getTime());
  ok(
    await mutate(status, organizer, 'set_match_payment', {
      match_id: matchId,
      profile_id: b.profileId,
      paid: true,
    }),
    'organizer marks B',
  );
  const twoPaid = ok(await read(status, owner, 'get_match_roster', { match_id: matchId }), 'two');
  assert.deepEqual(twoPaid.payment_summary, {
    paid_count: 2,
    confirmed_count: 2,
    total: '25.00',
  });
  const own = ok(await read(status, a, 'get_match_roster', { match_id: matchId }), 'A own');
  assert.equal(own.viewer.paid, true, 'the player sees the own payment');
  assert.deepEqual(
    own.confirmed.map((entry) => entry.paid),
    [null, null],
    'and nobody else',
  );
  console.log(
    'ok - organisation marks confirmed only; who and when recorded; total = paid × price',
  );

  // Desistir: pago bloqueia; desmarcado sai e o primeiro da espera sobe.
  denied(
    await mutate(status, a, 'leave_match', { match_id: matchId }),
    409,
    'PAYMENT_ALREADY_REAL',
    'paid leaves',
  );
  const unmarked = ok(
    await mutate(status, organizer, 'set_match_payment', {
      match_id: matchId,
      profile_id: a.profileId,
      paid: false,
    }),
    'organizer unmarks A',
  );
  assert.equal(unmarked.outcome.logical_result, 'payment_marked_unpaid');
  const unmarkedRow = (await statuses(db, matchId)).find((row) => row.profile_id === a.profileId);
  assert.equal(unmarkedRow.payment_marked_by, organizer.profileId);
  const left = ok(await mutate(status, a, 'leave_match', { match_id: matchId }), 'A leaves');
  assert.equal(left.outcome.logical_result, 'match_left');
  assert.equal(left.current.status, 'out');
  let rows = await statuses(db, matchId);
  assert.equal(statusOf(rows, a), 'left');
  assert.equal(statusOf(rows, c), 'starter', 'first of the waitlist promoted');
  assert.equal(statusOf(rows, d), 'waitlist');
  const back = ok(await mutate(status, a, 'join_match', { match_id: matchId }), 'A back');
  assert.equal(back.outcome.logical_result, 'match_waitlisted');
  assert.equal(back.current.waitlist_position, 2, 'who leaves and returns goes to the end');
  rows = await statuses(db, matchId);
  assert.ok(
    rows.find((row) => row.profile_id === a.profileId).queue_seq >
      rows.find((row) => row.profile_id === d.profileId).queue_seq,
  );
  const dLeft = ok(await mutate(status, d, 'leave_match', { match_id: matchId }), 'D leaves');
  assert.equal(dLeft.outcome.logical_result, 'match_left');
  assert.equal(
    ok(await mutate(status, d, 'leave_match', { match_id: matchId }), 'D again').outcome
      .logical_result,
    'match_leave_unchanged',
  );
  const after = ok(await read(status, a, 'get_match_roster', { match_id: matchId }), 'after');
  assert.deepEqual(
    after.confirmed.map((entry) => entry.name),
    [b.name, c.name],
  );
  assert.deepEqual(after.viewer, {
    status: 'waitlist',
    waitlist_position: 1,
    paid: null,
    can_manage: false,
    refunds: [],
  });
  console.log(
    'ok - paid cannot leave; unmarked leaves and C is promoted; return goes to the end; leaving the waitlist promotes nobody',
  );

  // Livro: só IDs, nunca nome, posição na fila ou valor.
  const ledger = (
    await db.query(
      `select operation, state, resource_type, resource_id::text, outcome
         from private.idempotency_records
        where actor_id = any($1::uuid[])
          and operation in ('join_match','leave_match','set_match_payment')`,
      [[a.profileId, b.profileId, c.profileId, d.profileId, owner.profileId, organizer.profileId]],
    )
  ).rows;
  assert.ok(ledger.length >= 12);
  for (const record of ledger) {
    assert.equal(record.state, 'completed');
    assert.equal(record.resource_type, 'group');
    assert.equal(record.resource_id, groupId);
  }
  assert.doesNotMatch(
    JSON.stringify(ledger),
    /Jogador|apelido|midfielder|12\.50|waitlist_position/,
  );
  console.log(`ok - ${ledger.length} ledger records hold IDs and logical results only`);

  // Início: confirmar e desistir fecham; marcar pagamento continua.
  await db.query(`update private.matches set starts_at = now() - interval '1 minute' where id=$1`, [
    matchId,
  ]);
  denied(
    await mutate(status, d, 'join_match', { match_id: matchId }),
    409,
    'MATCH_STARTED',
    'join after start',
  );
  denied(
    await mutate(status, b, 'leave_match', { match_id: matchId }),
    409,
    'MATCH_STARTED',
    'leave after start',
  );
  ok(
    await mutate(status, owner, 'set_match_payment', {
      match_id: matchId,
      profile_id: c.profileId,
      paid: true,
    }),
    'payment after start',
  );
  assert.equal(
    ok(await read(status, b, 'get_match_roster', { match_id: matchId }), 'started').started,
    true,
  );
  console.log('ok - after starts_at: join and leave answer MATCH_STARTED; payment still marks');

  // Grupo suspenso: nova confirmação fecha; desistir continua.
  ok(await mutate(status, b, 'join_match', { match_id: otherMatch }), 'B other');
  await db.query('update public.groups set suspended_at=now() where id=$1', [groupId]);
  denied(
    await mutate(status, c, 'join_match', { match_id: otherMatch }),
    403,
    'GROUP_SUSPENDED',
    'suspended join',
  );
  assert.equal(
    ok(await mutate(status, b, 'leave_match', { match_id: otherMatch }), 'suspended leave').outcome
      .logical_result,
    'match_left',
  );
  await db.query('update public.groups set suspended_at=null where id=$1', [groupId]);
  console.log('ok - suspended group refuses a new confirmation and still lets a player leave');
  return { owner, organizer, a, b, c, d, groupId };
}

// ---------------------------------------------------------------------------
// Replay depois da perda de autoridade (revisão do #71, P1-1; M2-D20)
// ---------------------------------------------------------------------------
// O replay conserva o desfecho gravado, mas omite current quando a autoridade
// atual não autoriza a projeção; a mutação não se repete. Autenticação
// perdida devolve o erro normal, sem desfecho.
async function proveReplayAuthority(status, db, context) {
  const { owner, groupId } = context;
  const [manager, player, quitter, leaver, revoked] = await Promise.all(
    ['manager', 'player', 'quitter', 'leaver', 'revoked'].map((x) => createActor(status, x)),
  );
  await addMembers(db, groupId, [
    [manager, 'organizer', 'active'],
    [player, 'player', 'active'],
    [quitter, 'player', 'active'],
    [leaver, 'player', 'active'],
    [revoked, 'player', 'active'],
  ]);
  const matchId = await createMatch(status, owner, groupId, 1, '30.00', 10);
  const playerJoin = crypto.randomUUID();
  ok(await mutate(status, player, 'join_match', { match_id: matchId }, playerJoin), 'player');
  const quitterJoin = crypto.randomUUID();
  ok(await mutate(status, quitter, 'join_match', { match_id: matchId }, quitterJoin), 'quitter');
  const leaverLeave = crypto.randomUUID();
  ok(await mutate(status, leaver, 'join_match', { match_id: matchId }), 'leaver joins');
  ok(await mutate(status, leaver, 'leave_match', { match_id: matchId }, leaverLeave), 'leaver');
  const payRequest = crypto.randomUUID();
  const payBody = { match_id: matchId, profile_id: player.profileId, paid: true };
  const paid = ok(
    await mutate(status, manager, 'set_match_payment', payBody, payRequest),
    'manager marks',
  );
  assert.deepEqual(paid.current, { paid_count: 1, confirmed_count: 1, total: '30.00' });
  // Com autoridade, o replay recalcula current.
  assert.deepEqual(
    ok(await mutate(status, manager, 'set_match_payment', payBody, payRequest), 'replay').current,
    paid.current,
  );

  // Rebaixado a jogador: o desfecho volta, o resumo de hoje não.
  ok(
    await mutate(status, owner, 'set_role', {
      group_id: groupId,
      profile_id: manager.profileId,
      role: 'player',
    }),
    'demote',
  );
  ok(
    await mutate(status, owner, 'set_match_payment', { ...payBody, paid: false }),
    'owner unmarks',
  );
  const demoted = ok(
    await mutate(status, manager, 'set_match_payment', payBody, payRequest),
    'demoted replay',
  );
  assert.deepEqual(Object.keys(demoted), ['outcome'], 'no current after the demotion');
  assert.deepEqual(demoted.outcome, paid.outcome, 'the stored outcome is kept');
  let rows = await statuses(db, matchId);
  const playerRow = rows.find((row) => row.profile_id === player.profileId);
  assert.equal(playerRow.paid, false, 'the replay did not mark again');
  assert.equal(playerRow.payment_marked_by, owner.profileId);
  denied(
    await mutate(status, manager, 'set_match_payment', payBody),
    403,
    'NOT_ORGANIZER',
    'a new call of the demoted organizer',
  );

  // Fora do grupo: o mesmo desfecho sem current, para pagamento e presença.
  ok(await mutate(status, manager, 'leave_group', { group_id: groupId }), 'manager leaves');
  const gone = ok(
    await mutate(status, manager, 'set_match_payment', payBody, payRequest),
    'replay after leaving',
  );
  assert.deepEqual(Object.keys(gone), ['outcome']);
  ok(
    await mutate(status, owner, 'remove_member', {
      group_id: groupId,
      profile_id: quitter.profileId,
      reason: 'teste',
    }),
    'remove quitter',
  );
  const removedReplay = ok(
    await mutate(status, quitter, 'join_match', { match_id: matchId }, quitterJoin),
    'join replay after removal',
  );
  assert.deepEqual(Object.keys(removedReplay), ['outcome']);
  assert.equal(removedReplay.outcome.logical_result, 'match_waitlisted');
  rows = await statuses(db, matchId);
  assert.equal(statusOf(rows, quitter), 'removed', 'the replay did not register again');
  ok(await mutate(status, leaver, 'leave_group', { group_id: groupId }), 'leaver leaves');
  const leftReplay = ok(
    await mutate(status, leaver, 'leave_match', { match_id: matchId }, leaverLeave),
    'leave replay after leaving the group',
  );
  assert.deepEqual(Object.keys(leftReplay), ['outcome']);
  denied(
    await mutate(status, quitter, 'join_match', { match_id: matchId }),
    404,
    'NOT_FOUND',
    'a new call after removal',
  );

  // Sessão revogada: o replay devolve 401, sem desfecho; e o par existente/
  // inexistente também é 401 nas quatro RPCs.
  const revokedJoin = crypto.randomUUID();
  ok(await mutate(status, revoked, 'join_match', { match_id: matchId }, revokedJoin), 'r joins');
  ok(
    await edge(
      status,
      'identity/revoke_current_session',
      { request_id: crypto.randomUUID() },
      revoked.token,
    ),
    'revoke',
  );
  denied(
    await mutate(status, revoked, 'join_match', { match_id: matchId }, revokedJoin),
    401,
    'UNAUTHENTICATED',
    'replay after revocation',
  );
  await provePair(status, revoked, matchId, player, 401, 'UNAUTHENTICATED', 'revoked');
  console.log(
    'ok - replay keeps the outcome without current after demotion, leaving and removal; never mutates again; revoked session 401 on replay and on existing/unknown pairs',
  );
}

// ---------------------------------------------------------------------------
// Saída do grupo e exclusão de conta liberam a vaga sem expor nome
// ---------------------------------------------------------------------------
async function proveMembershipExit(status, db, context) {
  const { owner, a, c, d, groupId } = context;
  const matchId = await createMatch(status, owner, groupId, 1, '20.00', 5);
  ok(await mutate(status, a, 'join_match', { match_id: matchId }), 'A exit match');
  ok(await mutate(status, d, 'join_match', { match_id: matchId }), 'D exit match');
  ok(await mutate(status, c, 'join_match', { match_id: matchId }), 'C exit match');
  ok(
    await mutate(status, owner, 'remove_member', {
      group_id: groupId,
      profile_id: a.profileId,
      reason: 'teste',
    }),
    'remove A',
  );
  let rows = await statuses(db, matchId);
  assert.equal(statusOf(rows, a), 'removed');
  assert.equal(statusOf(rows, d), 'starter', 'removal promotes the waitlist in the same commit');
  assert.equal(statusOf(rows, c), 'waitlist');

  const deletion = await edge(
    status,
    'identity/delete_account',
    { request_id: crypto.randomUUID() },
    d.token,
  );
  assert.equal(deletion.status, 200, JSON.stringify(deletion.body));
  rows = await statuses(db, matchId);
  assert.equal(statusOf(rows, d), 'removed', 'account deletion releases the slot');
  assert.equal(statusOf(rows, c), 'starter', 'and promotes the next one');
  const roster = ok(await read(status, owner, 'get_match_roster', { match_id: matchId }), 'roster');
  assert.deepEqual(
    roster.confirmed.map((entry) => entry.name),
    [c.name],
  );
  assert.doesNotMatch(JSON.stringify(roster), new RegExp(`${d.name}|${d.profileId}`));
  // Um racha já iniciado guarda a linha da conta em exclusão: ocupa a vaga
  // e não mostra identidade.
  const startedId = await createMatch(status, owner, groupId, 3, '20.00', 6);
  await db.query(
    `insert into private.match_players(match_id, profile_id, status, queue_seq)
     values ($1, $2, 'starter', nextval('private.match_queue_seq'))`,
    [startedId, d.profileId],
  );
  await db.query(`update private.matches set starts_at = now() - interval '1 minute' where id=$1`, [
    startedId,
  ]);
  const history = ok(await read(status, owner, 'get_match_roster', { match_id: startedId }), 'h');
  assert.equal(history.confirmed_count, 1);
  assert.deepEqual(history.confirmed[0], {
    profile_id: null,
    name: null,
    nickname: null,
    position: null,
    account_removed: true,
    is_viewer: false,
    paid: false,
  });
  console.log(
    'ok - removal and account deletion release the future slot and promote; a deleted account never shows its name',
  );
}

// ---------------------------------------------------------------------------
// Concorrência na última vaga
// ---------------------------------------------------------------------------
async function rpcJoin(connection, actor, matchId, requestId = crypto.randomUUID()) {
  const hmac = crypto.createHash('sha256').update(`${requestId}:${matchId}`).digest('hex');
  await connection.query('begin');
  try {
    await connection.query('set local role service_role');
    const result = await connection.query(
      `select public.join_match($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::uuid) as result`,
      [actor.authId, actor.sessionId, requestId, hmac, matchId],
    );
    await connection.query('commit');
    return result.rows[0].result;
  } catch (error) {
    try {
      await connection.query('rollback');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'join_match and rollback failed');
    }
    throw error;
  }
}

async function freshMembers(status, db, groupId, count, label) {
  const actors = await Promise.all(
    Array.from({ length: count }, (_, index) => createActor(status, `${label}${index}`)),
  );
  await addMembers(
    db,
    groupId,
    actors.map((actor) => [actor, 'player', 'active']),
  );
  return actors;
}

// Dois "Vou jogar" na última vaga, ambos parados atrás de quem segura o grupo:
// ao liberar, um confirma e o outro vai para a espera.
async function proveLastSlotBarrier(status, connections, db, context) {
  const { observer, holder, first, second } = connections;
  const pids = await assertDistinctConnections({ observer, holder, first, second }, 'last slot');
  const matchId = await createMatch(status, context.owner, context.groupId, 1, '15.00', 7);
  const [x, y] = await freshMembers(status, db, context.groupId, 2, 'race');
  await holder.query('begin');
  await holder.query('select 1 from public.groups where id=$1 for no key update', [
    context.groupId,
  ]);
  let one;
  let two;
  try {
    one = track(rpcJoin(first, x, matchId));
    await awaitLockWait(observer, one, pids.first, pids.holder, 'join x', APP_PREFIX);
    two = track(rpcJoin(second, y, matchId));
    await awaitLockWait(
      observer,
      two,
      pids.second,
      [pids.holder, pids.first],
      'join y',
      APP_PREFIX,
    );
  } finally {
    await holder.query('commit');
  }
  const results = await Promise.all([one.settled, two.settled]);
  for (const result of results) assert.equal(result.status, 'fulfilled', String(result.reason));
  assert.deepEqual(results.map((result) => result.value.outcome.logical_result).sort(), [
    'match_joined',
    'match_waitlisted',
  ]);
  const rows = await statuses(db, matchId);
  assert.deepEqual(rows.map((row) => row.status).sort(), ['starter', 'waitlist']);
  console.log(
    'ok - two joins on the last slot, both waiting on the group lock: one starter, one waitlist',
  );
  return matchId;
}

// Rajada pela Edge: oito pessoas, três vagas, sem barreira.
async function proveBurst(status, db, context) {
  const matchId = await createMatch(status, context.owner, context.groupId, 3, '15.00', 8);
  const actors = await freshMembers(status, db, context.groupId, 8, 'burst');
  const answers = await Promise.all(
    actors.map((actor) => mutate(status, actor, 'join_match', { match_id: matchId })),
  );
  const outcomes = answers.map((answer, index) => ok(answer, `burst ${index}`));
  const joined = outcomes.filter((outcome) => outcome.outcome.logical_result === 'match_joined');
  const waiting = outcomes.filter(
    (outcome) => outcome.outcome.logical_result === 'match_waitlisted',
  );
  assert.equal(joined.length, 3);
  assert.equal(waiting.length, 5);
  const rows = await statuses(db, matchId);
  assert.equal(rows.filter((row) => row.status === 'starter').length, 3);
  assert.equal(rows.filter((row) => row.status === 'waitlist').length, 5);
  // Uma desistência e duas confirmações ao mesmo tempo: o total nunca passa.
  const leaver = actors.find(
    (actor, index) => outcomes[index].outcome.logical_result === 'match_joined',
  );
  const extra = await freshMembers(status, db, context.groupId, 2, 'late');
  await Promise.all([
    mutate(status, leaver, 'leave_match', { match_id: matchId }),
    ...extra.map((actor) => mutate(status, actor, 'join_match', { match_id: matchId })),
  ]).then((all) => all.forEach((answer, index) => ok(answer, `mixed ${index}`)));
  const final = await statuses(db, matchId);
  assert.equal(final.filter((row) => row.status === 'starter').length, 3, 'never above slots');
  assert.equal(final.filter((row) => row.status === 'waitlist').length, 6);
  const firstWaiting = rows.filter((row) => row.status === 'waitlist')[0];
  assert.equal(
    final.find((row) => row.profile_id === firstWaiting.profile_id).status,
    'starter',
    'the head of the waitlist got the freed slot, not a late joiner',
  );
  console.log(
    'ok - burst of 8 on 3 slots: 3 starters, 5 waiting; leave + 2 joins keep 3 and promote the head',
  );
}

// Contraprova executável: sem as travas de grupo e racha, e com uma pausa
// entre contar e gravar, dois "Vou jogar" na última vaga confirmam os dois.
// Com as travas e a mesma pausa, o resultado volta a ser um e um.
async function proveLockMutant(status, connections, db, context) {
  const { first, second } = connections;
  const locks = (await db.query('select pg_get_functiondef($1::regprocedure) as d', [LOCKS]))
    .rows[0].d;
  const join = (await db.query('select pg_get_functiondef($1::regprocedure) as d', [JOIN])).rows[0]
    .d;
  const groupLock = 'perform 1 from public.groups where id = v_group_id for no key update;';
  const matchLock = 'perform 1 from private.matches where id = p_match_id for no key update;';
  const count = `    v_status := case when v_starters < v_match.field_slots then 'starter' else 'waitlist' end;`;
  assert.ok(locks.includes(groupLock) && locks.includes(matchLock) && join.includes(count));
  const capacityCheck = `  if (select count(*) from private.match_players
      where match_id = p_match_id and status = 'starter') > v_match.field_slots then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;
`;
  assert.ok(join.includes(capacityCheck));
  // A pausa abre a janela entre contar e gravar; sem a defesa final, só as
  // travas separam os dois pedidos.
  const paused = join
    .replace(count, `    perform pg_sleep(0.8);\n${count}`)
    .replace(capacityCheck, '');
  const unlocked = locks.replace(groupLock, '').replace(matchLock, '');
  const race = async (label) => {
    const matchId = await createMatch(status, context.owner, context.groupId, 1, '15.00', 9);
    const [x, y] = await freshMembers(status, db, context.groupId, 2, label);
    const results = await Promise.all([rpcJoin(first, x, matchId), rpcJoin(second, y, matchId)]);
    return {
      results: results.map((result) => result.outcome.logical_result).sort(),
      starters: (await statuses(db, matchId)).filter((row) => row.status === 'starter').length,
    };
  };
  try {
    await db.query(paused);
    await db.query(unlocked);
    const broken = await race('mutant');
    assert.deepEqual(broken.results, ['match_joined', 'match_joined'], 'mutant overbooks');
    assert.equal(broken.starters, 2, 'two starters on one slot without the locks');
    await db.query(locks);
    const guarded = await race('guarded');
    assert.deepEqual(guarded.results, ['match_joined', 'match_waitlisted']);
    assert.equal(guarded.starters, 1);
  } finally {
    await db.query(locks);
    await db.query(join);
  }
  const live = (await db.query('select pg_get_functiondef($1::regprocedure) as d', [JOIN])).rows[0]
    .d;
  assert.equal(live, join, 'join_match restored byte for byte');
  console.log(
    'ok - mutant without group/match locks overbooks the last slot; with the locks and the same pause: one and one',
  );
}

// ---------------------------------------------------------------------------
// Editar e cancelar (0028): permissões, vagas, promoção, preço e bloqueio
// ---------------------------------------------------------------------------
// O config inteiro do racha como o app o envia, lido pela Edge com a
// autoridade de quem edita, mais o patch do formulário.
async function editConfig(status, actor, matchId, patch = {}) {
  const [match] = ok(await read(status, actor, 'get_match', { match_id: matchId }), 'read');
  return {
    description: match.description,
    starts_at: match.starts_at,
    ends_at: match.ends_at,
    timezone: match.timezone,
    location_name: match.location_name,
    location_address: match.location_address,
    latitude: match.latitude,
    longitude: match.longitude,
    field_slots: match.field_slots,
    field_price: Number(match.field_price).toFixed(2),
    ...patch,
  };
}
const EDIT_RPCS = ['update_match', 'cancel_match'];
async function editCall(status, name, actor, matchId, config) {
  return name === 'update_match'
    ? mutate(status, actor, name, { match_id: matchId, config })
    : mutate(status, actor, name, { match_id: matchId });
}

async function proveEditCancel(status, db, context) {
  const { owner, organizer, groupId } = context;
  const [x, y, z, former, stranger] = await Promise.all(
    ['ex', 'ey', 'ez', 'eformer', 'estranger'].map((label) => createActor(status, label)),
  );
  await addMembers(db, groupId, [
    [x, 'player', 'active'],
    [y, 'player', 'active'],
    [z, 'player', 'active'],
    [former, 'organizer', 'removed'],
  ]);
  const matchId = await createMatch(status, owner, groupId, 1, '20.00', 4);
  for (const actor of [x, y, z]) {
    ok(await mutate(status, actor, 'join_match', { match_id: matchId }), 'join for edit');
  }
  const before = await statuses(db, matchId);
  const config = await editConfig(status, owner, matchId, { field_slots: 5 });

  // Chamada forçada pela Edge: jogador recebe NOT_ORGANIZER; ex-membro e
  // estranho, o NOT_FOUND de um ID inexistente, com corpo igual.
  for (const name of EDIT_RPCS) {
    denied(
      await editCall(status, name, x, matchId, config),
      403,
      'NOT_ORGANIZER',
      `player ${name}`,
    );
    for (const [actor, label] of [
      [former, 'former organizer'],
      [stranger, 'stranger'],
    ]) {
      const existing = await editCall(status, name, actor, matchId, config);
      const unknown = await editCall(status, name, actor, crypto.randomUUID(), config);
      denied(existing, 404, 'NOT_FOUND', `${label} ${name} existing`);
      denied(unknown, 404, 'NOT_FOUND', `${label} ${name} unknown`);
      assert.deepEqual(withoutRequestId(existing.body), withoutRequestId(unknown.body), label);
    }
  }
  denied(
    await mutate(status, owner, 'update_match', {
      match_id: matchId,
      config: { ...config, group_id: groupId },
    }),
    422,
    'VALIDATION',
    'the group never travels in the edit',
  );
  assert.deepEqual(await statuses(db, matchId), before, 'no refusal changed the lists');
  const untouched = (
    await db.query('select field_slots, canceled_at from private.matches where id=$1', [matchId])
  ).rows[0];
  assert.deepEqual(untouched, { field_slots: 1, canceled_at: null });
  console.log(
    'ok - forced update/cancel through the Edge: player 403 NOT_ORGANIZER; former organizer and stranger 404 alike for existing and unknown',
  );

  // Vagas: subir promove a espera em ordem; descer abaixo dos confirmados não.
  const raised = ok(
    await mutate(status, organizer, 'update_match', {
      match_id: matchId,
      config: { ...config, field_slots: 2 },
    }),
    'raise to 2',
  );
  assert.deepEqual(Object.keys(raised), ['outcome']);
  assert.deepEqual(raised.outcome, {
    group_id: groupId,
    logical_result: 'match_updated',
    match_id: matchId,
  });
  let rows = await statuses(db, matchId);
  assert.deepEqual(
    [statusOf(rows, x), statusOf(rows, y), statusOf(rows, z)],
    ['starter', 'starter', 'waitlist'],
    'the head of the waitlist is promoted, the next one waits',
  );
  denied(
    await mutate(status, owner, 'update_match', {
      match_id: matchId,
      config: { ...config, field_slots: 1 },
    }),
    409,
    'SLOTS_BELOW_CONFIRMED',
    'slots below the confirmed',
  );

  // 0034: a paid mark locks price; a same-price edit still works.
  ok(
    await mutate(status, owner, 'set_match_payment', {
      match_id: matchId,
      profile_id: x.profileId,
      paid: true,
    }),
    'mark x',
  );
  const markedAt = (await statuses(db, matchId)).find((row) => row.profile_id === x.profileId);
  denied(
    await mutate(status, organizer, 'update_match', {
      match_id: matchId,
      config: { ...config, field_slots: 2, field_price: '30', location_name: 'Arena Nova' },
    }),
    409,
    'PRICE_LOCKED',
    'paid locks price',
  );
  ok(
    await mutate(status, organizer, 'update_match', {
      match_id: matchId,
      config: { ...config, field_slots: 2, location_name: 'Arena Nova' },
    }),
    'same price edit',
  );
  const marked = (await statuses(db, matchId)).find((row) => row.profile_id === x.profileId);
  assert.deepEqual(
    [marked.paid, marked.payment_marked_by, marked.payment_marked_at.getTime()],
    [true, owner.profileId, markedAt.payment_marked_at.getTime()],
    'the paid mark keeps value, author and time',
  );
  const roster = ok(await read(status, owner, 'get_match_roster', { match_id: matchId }), 'roster');
  assert.deepEqual(roster.payment_summary, {
    paid_count: 1,
    confirmed_count: 2,
    total: Number(config.field_price).toFixed(2),
  });
  // O membro vê a mudança na leitura dele.
  const [seen] = ok(await read(status, z, 'get_match', { match_id: matchId }), 'member reads');
  assert.deepEqual(
    [seen.location_name, Number(seen.field_price), seen.field_slots, seen.canceled],
    ['Arena Nova', Number(config.field_price), 2, false],
  );
  console.log(
    'ok - raising the slots promotes the waitlist head; below the confirmed is 409; a paid mark locks repricing; the member reads the change',
  );

  // Cancelar: definitivo; presença, espera e pagamento recusam pela Edge.
  const canceled = ok(
    await mutate(status, organizer, 'cancel_match', { match_id: matchId }),
    'cancel',
  );
  assert.equal(canceled.outcome.logical_result, 'match_canceled');
  const frozen = await statuses(db, matchId);
  denied(
    await mutate(status, z, 'leave_match', { match_id: matchId }),
    409,
    'MATCH_CANCELED',
    'leave waitlist',
  );
  denied(
    await mutate(status, y, 'leave_match', { match_id: matchId }),
    409,
    'MATCH_CANCELED',
    'leave starter',
  );
  const late = (await freshMembers(status, db, groupId, 1, 'elate'))[0];
  denied(
    await mutate(status, late, 'join_match', { match_id: matchId }),
    409,
    'MATCH_CANCELED',
    'join',
  );
  denied(
    await mutate(status, owner, 'set_match_payment', {
      match_id: matchId,
      profile_id: y.profileId,
      paid: true,
    }),
    409,
    'MATCH_CANCELED',
    'payment',
  );
  denied(
    await mutate(status, owner, 'update_match', { match_id: matchId, config }),
    409,
    'MATCH_CANCELED',
    'edit after cancel',
  );
  assert.equal(
    ok(await mutate(status, owner, 'cancel_match', { match_id: matchId }), 'cancel again').outcome
      .logical_result,
    'match_cancel_unchanged',
  );
  assert.deepEqual(await statuses(db, matchId), frozen, 'nothing moved after the cancellation');
  const listed = ok(await read(status, z, 'list_my_matches'), 'agenda').find(
    (match) => match.id === matchId,
  );
  assert.equal(listed?.canceled, true, 'the Agenda keeps the canceled match, marked');
  const occupancy = ok(await read(status, z, 'get_matches_occupancy'), 'occupancy').find(
    (row) => row.match_id === matchId,
  );
  assert.equal(occupancy?.canceled, true);
  assert.equal(
    ok(await read(status, z, 'get_match_roster', { match_id: matchId }), 'roster').canceled,
    true,
  );
  console.log(
    'ok - cancel is final: leave, join, payment and edit answer 409 MATCH_CANCELED; cancel again is unchanged; detail, Agenda and occupancy say canceled',
  );
}

// update_match direto, como a Edge chama, com o config canônico lido do banco.
async function canonicalConfig(db, matchId, patch) {
  const { rows } = await db.query(
    `select jsonb_build_object(
       'starts_at', to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"'),
       'ends_at', to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"'),
       'timezone', timezone, 'location_name', location_name,
       'location_address', location_address, 'description', description,
       'latitude', latitude::text, 'longitude', longitude::text,
       'field_slots', field_slots, 'field_price', field_price::text) as config
       from private.matches where id=$1`,
    [matchId],
  );
  return { ...rows[0].config, ...patch };
}
async function rpcUpdate(connection, actor, matchId, config, requestId = crypto.randomUUID()) {
  const hmac = crypto
    .createHash('sha256')
    .update(`${requestId}:${matchId}:${JSON.stringify(config)}`)
    .digest('hex');
  await connection.query('begin');
  try {
    await connection.query('set local role service_role');
    const result = await connection.query(
      `select public.update_match($1::uuid,$2::uuid,$3::uuid,$4::text,1,1,$5::uuid,$6::jsonb) as result`,
      [actor.authId, actor.sessionId, requestId, hmac, matchId, JSON.stringify(config)],
    );
    await connection.query('commit');
    return result.rows[0].result;
  } catch (error) {
    try {
      await connection.query('rollback');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'update_match and rollback failed');
    }
    throw error;
  }
}

// Editar × confirmar: os dois parados atrás de quem segura o grupo, nas duas
// ordens. Quem pega a trava do racha primeiro decide; o outro vê o resultado.
async function proveEditJoinBarrier(status, connections, db, context) {
  const { observer, holder, first, second } = connections;
  const pids = await assertDistinctConnections({ observer, holder, first, second }, 'edit join');
  const race = async (order, label) => {
    const matchId = await createMatch(status, context.owner, context.groupId, 2, '15.00', 11);
    const [x, y] = await freshMembers(status, db, context.groupId, 2, label);
    ok(await mutate(status, x, 'join_match', { match_id: matchId }), 'x joins');
    const config = await canonicalConfig(db, matchId, { field_slots: 1 });
    const start = {
      join: (connection) => rpcJoin(connection, y, matchId),
      edit: (connection) => rpcUpdate(connection, context.owner, matchId, config),
    };
    await holder.query('begin');
    await holder.query('select 1 from public.groups where id=$1 for no key update', [
      context.groupId,
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
    const byName = { [order[0]]: a, [order[1]]: b };
    const { rows } = await db.query(
      `select field_slots, (select count(*)::integer from private.match_players
          where match_id=$1 and status='starter') as starters
         from private.matches where id=$1`,
      [matchId],
    );
    assert.ok(rows[0].starters <= rows[0].field_slots, `${label}: never above the slots`);
    return { ...byName, ...rows[0] };
  };
  // Confirmar primeiro: dois confirmados; a edição para 1 vaga é recusada.
  const joinFirst = await race(['join', 'edit'], 'ejoinfirst');
  assert.equal(joinFirst.join.status, 'fulfilled', String(joinFirst.join.reason));
  assert.equal(joinFirst.join.value.outcome.logical_result, 'match_joined');
  assert.equal(joinFirst.edit.status, 'rejected');
  assert.equal(joinFirst.edit.reason.message, 'SLOTS_BELOW_CONFIRMED');
  assert.deepEqual([joinFirst.field_slots, joinFirst.starters], [2, 2]);
  // Editar primeiro: 1 vaga; quem confirma depois vai para a espera.
  const editFirst = await race(['edit', 'join'], 'eeditfirst');
  assert.equal(editFirst.edit.status, 'fulfilled', String(editFirst.edit.reason));
  assert.equal(editFirst.join.status, 'fulfilled', String(editFirst.join.reason));
  assert.equal(editFirst.join.value.outcome.logical_result, 'match_waitlisted');
  assert.deepEqual([editFirst.field_slots, editFirst.starters], [1, 1]);
  console.log(
    'ok - edit × join on the same match lock, both orders: join first refuses slots below 2 confirmed; edit first sends the join to the waitlist',
  );
}

// Contraprova executável: sem as travas de grupo e racha e sem a defesa final,
// com uma pausa entre contar os confirmados e gravar as vagas, um "Vou jogar"
// no meio deixa 2 confirmados em 1 vaga. Com as travas e a mesma pausa, não.
async function proveEditLockMutant(status, connections, db, context) {
  const { first, second } = connections;
  const locks = (await db.query('select pg_get_functiondef($1::regprocedure) as d', [LOCKS]))
    .rows[0].d;
  const update = (await db.query('select pg_get_functiondef($1::regprocedure) as d', [UPDATE]))
    .rows[0].d;
  const groupLock = 'perform 1 from public.groups where id = v_group_id for no key update;';
  const matchLock = 'perform 1 from private.matches where id = p_match_id for no key update;';
  const count = `  select count(*) into v_starters from private.match_players
  where match_id = p_match_id and status = 'starter';
`;
  const finalCheck = `  if (select count(*) from private.match_players
      where match_id = p_match_id and status = 'starter') > v_config.field_slots then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;
`;
  assert.ok(locks.includes(groupLock) && locks.includes(matchLock));
  assert.ok(update.includes(count) && update.includes(finalCheck));
  const paused = update
    .replace(count, `${count}  perform pg_sleep(0.8);\n`)
    .replace(finalCheck, '');
  const unlocked = locks.replace(groupLock, '').replace(matchLock, '');
  const race = async (label) => {
    const matchId = await createMatch(status, context.owner, context.groupId, 2, '15.00', 12);
    const [x, y] = await freshMembers(status, db, context.groupId, 2, label);
    ok(await mutate(status, x, 'join_match', { match_id: matchId }), 'x joins');
    const config = await canonicalConfig(db, matchId, { field_slots: 1 });
    const edit = track(rpcUpdate(first, context.owner, matchId, config));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const join = track(rpcJoin(second, y, matchId));
    const [edited, joined] = await Promise.all([edit.settled, join.settled]);
    const { rows } = await db.query(
      `select field_slots, (select count(*)::integer from private.match_players
          where match_id=$1 and status='starter') as starters
         from private.matches where id=$1`,
      [matchId],
    );
    return { edited, joined, ...rows[0] };
  };
  try {
    await db.query(paused);
    await db.query(unlocked);
    const broken = await race('emutant');
    assert.equal(broken.edited.status, 'fulfilled', 'mutant edit goes through');
    assert.equal(broken.joined.value?.outcome.logical_result, 'match_joined');
    assert.deepEqual(
      [broken.field_slots, broken.starters],
      [1, 2],
      'mutant: 2 confirmed in 1 slot',
    );
    await db.query(locks);
    const guarded = await race('eguarded');
    assert.equal(guarded.edited.status, 'fulfilled');
    assert.equal(guarded.joined.value?.outcome.logical_result, 'match_waitlisted');
    assert.deepEqual([guarded.field_slots, guarded.starters], [1, 1]);
  } finally {
    await db.query(locks);
    await db.query(update);
  }
  const live = (await db.query('select pg_get_functiondef($1::regprocedure) as d', [UPDATE]))
    .rows[0].d;
  assert.equal(live, update, 'update_match restored byte for byte');
  console.log(
    'ok - mutant without group/match locks and final check: an edit to 1 slot and a join leave 2 confirmed in 1; with the locks and the same pause: 1 and the join waits',
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
      'private.match_players': await count('private.match_players'),
      'private.matches': await count('private.matches'),
      'public.groups': await count('public.groups'),
      'public.profiles': await count('public.profiles'),
      'private.idempotency_records': await count('private.idempotency_records'),
      'private.deletion_requests': await count('private.deletion_requests'),
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
    const context = await proveHttp(status, db);
    await proveReplayAuthority(status, db, context);
    await proveMembershipExit(status, db, context);
    await proveLastSlotBarrier(status, { observer, holder, first, second }, db, context);
    await proveBurst(status, db, context);
    await proveLockMutant(status, { first, second }, db, context);
    await proveEditCancel(status, db, context);
    await proveEditJoinBarrier(status, { observer, holder, first, second }, db, context);
    await proveEditLockMutant(status, { first, second }, db, context);
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
if (await guard.run(main)) console.log('Match players harness passed.');
