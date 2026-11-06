// Harness da fatia 2 do M2 (docs/25 §4.3). Prova com commit real, conexões
// dedicadas e o gateway HTTP produtivo o que o rollback do pgTAP esconderia:
//
// - a 0016 é a fonte textual canônica das funções que cria e redefine, e toda
//   trava de domínio delas é FOR NO KEY UPDATE (M2-D13), exceto o expurgo;
// - cada RPC, com commit real sob service_role, conclui a idempotência, e o
//   replay depois do commit devolve o mesmo outcome;
// - o par cruzado da M2-D13 de approve_member, remove_member, set_role,
//   set_monthly, transfer_ownership e exclusão × transferência, e o par do
//   mesmo ator (dois cliques) das sete RPCs, pela barreira de docs/25 §2 nas
//   duas ordens e em 20 pares simultâneos, sem 40P01;
// - quinta e sexta membership do mesmo perfil, em par e sob 25 conexões;
// - transferência × saída, exclusão × transferência e exclusão do dono ×
//   exclusão do organizador escolhido, nas duas ordens;
// - as sete rotas pela Edge groups, por HTTP real com JWT do GoTrue, com a
//   suspensão, a negação ao removido por RLS e por RPC e o job de retenção
//   pelo worker Edge;
// - M2-D18: o motivo de remove_member não aparece em tabela, log do Postgres,
//   log dos serviços da pilha, resposta nem erro.
//
// COLETE_MEMBERSHIP_PROOF=<nome> executa uma única prova; é assim que as
// contraprovas rodam contra uma implementação mutada. Nos pares,
// COLETE_MEMBERSHIP_PART=order1|order2|storm executa só uma parte, para que a
// contraprova meça cada ordem e a tempestade mesmo quando a anterior reprova.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { harnessEmail, installHarnessGuard, sweepMarkedAuthUsers } from './harness-guard.mjs';
import {
  assertDistinctConnections,
  awaitLockWait as awaitBarrierWait,
  backendPid,
  describeResult,
  track,
} from './lock-barrier.mjs';
import { localWorkerCronSecret } from './local-worker-test-config.mjs';

const { Client } = pg;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const supabaseBinary = path.join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
);
const migrationsDirectory = path.join(repositoryRoot, 'supabase', 'migrations');
const MIGRATION = '0016_group_membership_rpcs.sql';
const PASSWORD = 'colete-local-group-membership-password';
const selectedProof = process.env.COLETE_MEMBERSHIP_PROOF;
const selectedPart = process.env.COLETE_MEMBERSHIP_PART;
const runPart = (part) => selectedPart === undefined || selectedPart === part;
// Marca dos usuários Auth deste harness (scripts/harness-guard.mjs).
const AUTH_EMAIL_PREFIX = 'group-membership-';
const APPLICATION_PREFIX = 'colete_membership_';
const STORM_PAIRS = 20;
const RACERS = 25;
// Prefixos exclusivos deste harness: perfis 16a0…, grupos 16b0…, sessões
// 16c0…, pedidos 16d0… e usuários Auth criados por SQL 16e0…. A limpeza
// alcança pelo prefixo também o que uma execução interrompida deixou.
const PROFILE_PREFIX = '16a0';
const GROUP_PREFIX = '16b0';

// Toda falha, inclusive a rejeição sem tratador, reprova com a causa, para o
// trabalho novo, espera o que está em voo e só então limpa
// (scripts/harness-guard.mjs). Toda conexão leva o APPLICATION_PREFIX.
const guard = installHarnessGuard('db:test:membership', {
  applicationPrefix: APPLICATION_PREFIX,
  authEmailPrefix: AUTH_EMAIL_PREFIX,
});

// ---------------------------------------------------------------------------
// Infraestrutura local
// ---------------------------------------------------------------------------

function localStatus() {
  let output;
  try {
    output = execFileSync(supabaseBinary, ['status', '-o', 'env'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('The local Supabase stack is unavailable. Run npm run db:start first.');
  }
  const read = (name) => {
    const match = output.match(new RegExp(`^${name}="([^"]+)"$`, 'm'));
    if (!match) throw new Error(`Supabase status did not expose ${name}.`);
    return match[1];
  };
  return {
    apiUrl: read('API_URL'),
    databaseUrl: read('DB_URL'),
    functionsUrl: read('FUNCTIONS_URL'),
    publishableKey: read('PUBLISHABLE_KEY'),
    secretKey: read('SECRET_KEY'),
  };
}

function newClient(connectionString, name) {
  return new Client({
    application_name: `${APPLICATION_PREFIX}${name}`,
    connectionString,
    connectionTimeoutMillis: 5_000,
  });
}

const hex4 = (value) => value.toString(16).padStart(4, '0');
const idFor = (kind, code, index) => `16${kind}${hex4(code)}-${hex4(index)}-4000-8000-000000000000`;

let requestCounter = 0;
function newRequestId() {
  requestCounter += 1;
  return `16d00000-${hex4(Math.floor(requestCounter / 65_536))}-4000-8000-${requestCounter
    .toString(16)
    .padStart(12, '0')}`;
}

// O HMAC real é da Edge; aqui basta um digest determinístico da entrada, para
// que o replay com a mesma entrada case e uma entrada diferente conflite.
function hmacOf(operation, args) {
  return crypto
    .createHash('sha256')
    .update(`${operation}|${JSON.stringify(args)}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Fixture: criada como postgres somente no setup de cada prova
// ---------------------------------------------------------------------------

// Perfis com usuário Auth criado por SQL, com a marca do harness. Os usuários
// das provas HTTP são criados pela API admin do GoTrue, à parte.
async function createActors(admin, code, count) {
  const actors = Array.from({ length: count }, (_, index) => ({
    id: idFor('a0', code, index + 1),
    authId: idFor('e0', code, index + 1),
    sessionId: idFor('c0', code, index + 1),
  }));
  await admin.query(
    `insert into auth.users (id, email)
     select id, email from unnest($1::uuid[], $2::text[]) as fixture(id, email)`,
    [
      actors.map((actor) => actor.authId),
      actors.map((_, index) => harnessEmail(AUTH_EMAIL_PREFIX, `${hex4(code)}-${index + 1}`)),
    ],
  );
  await admin.query(
    `insert into public.profiles (id, auth_user_id, name, account_status)
     select id, auth_id, 'Membership ' || id::text, 'active'
     from unnest($1::uuid[], $2::uuid[]) as fixture(id, auth_id)`,
    [actors.map((actor) => actor.id), actors.map((actor) => actor.authId)],
  );
  return actors;
}

// Grupos e memberships numa transação: o trigger de owner julga o commit.
// member = [actor, role, status, isMonthly?].
async function createGroups(admin, specs) {
  await admin.query('begin');
  try {
    await admin.query(
      `insert into public.groups (id, name, owner_id, monthly_enabled, suspended_at)
       select id, 'Membership ' || id::text, owner_id, monthly, suspended
       from unnest($1::uuid[], $2::uuid[], $3::boolean[], $4::timestamptz[])
         as fixture(id, owner_id, monthly, suspended)`,
      [
        specs.map((spec) => spec.id),
        specs.map((spec) => spec.owner.id),
        specs.map((spec) => spec.monthlyEnabled ?? false),
        specs.map((spec) => spec.suspendedAt ?? null),
      ],
    );
    const rows = specs.flatMap((spec) =>
      spec.members.map(([actor, role, status, isMonthly = false]) => ({
        groupId: spec.id,
        profileId: actor.id,
        role,
        status,
        isMonthly,
        removedAt: status === 'removed' ? (spec.removedAt?.get(actor.id) ?? new Date()) : null,
      })),
    );
    await admin.query(
      `insert into public.group_members
         (group_id, profile_id, role, status, is_monthly, removed_at, joined_at)
       select group_id, profile_id, role, status, is_monthly, removed_at,
              '2025-01-01T00:00:00Z'
       from unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::boolean[],
                   $6::timestamptz[])
         as fixture(group_id, profile_id, role, status, is_monthly, removed_at)`,
      [
        rows.map((row) => row.groupId),
        rows.map((row) => row.profileId),
        rows.map((row) => row.role),
        rows.map((row) => row.status),
        rows.map((row) => row.isMonthly),
        rows.map((row) => row.removedAt),
      ],
    );
    await admin.query('commit');
  } catch (error) {
    await rollbackAfter(admin, error);
  }
}

// Desfaz a transação e propaga a causa. Uma falha do rollback não a
// substitui: as duas sobem juntas.
async function rollbackAfter(client, error) {
  try {
    await client.query('rollback');
  } catch (rollbackError) {
    throw new AggregateError([error, rollbackError], `${error.message}; the rollback also failed`);
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Chamadas: RPC interna sob service_role, em conexão dedicada
// ---------------------------------------------------------------------------

const RPC_PARAMS = {
  approve_member: ['p_group_id', 'p_profile_id', 'p_approve'],
  remove_member: ['p_group_id', 'p_profile_id', 'p_reason'],
  set_role: ['p_group_id', 'p_profile_id', 'p_role'],
  set_monthly: ['p_group_id', 'p_profile_id', 'p_enabled'],
  set_ratings_visibility: ['p_group_id', 'p_visibility', 'p_confirm_members_visibility'],
  transfer_ownership: ['p_group_id', 'p_new_owner_id'],
  leave_group: ['p_group_id'],
};

function rpcStatement(operation) {
  const names = [
    'p_actor_auth_user_id',
    'p_actor_session_id',
    'p_request_id',
    'p_input_hmac',
    'p_canonical_version',
    'p_hash_key_version',
    ...(RPC_PARAMS[operation] ?? []),
  ];
  return `select public.${operation}(${names
    .map((name, index) => `${name} => $${index + 1}`)
    .join(', ')}) as response`;
}

async function callRpc(client, operation, actor, requestId, args) {
  const result = await client.query(rpcStatement(operation), [
    actor.authId,
    actor.sessionId,
    requestId,
    hmacOf(operation, args),
    1,
    1,
    ...args,
  ]);
  return result.rows[0].response;
}

async function inServiceTransaction(client, work, { commit = true } = {}) {
  await client.query('begin isolation level read committed');
  try {
    await client.query('set local role service_role');
    const value = await work();
    if (commit) await client.query('commit');
    return value;
  } catch (error) {
    return rollbackAfter(client, error);
  }
}

// Uma RPC numa transação própria, com commit real.
function rpcTx(client, operation, actor, args, requestId = newRequestId()) {
  return inServiceTransaction(client, () => callRpc(client, operation, actor, requestId, args));
}

// A mesma RPC, deixada aberta: a transação segura os locks até o commit de
// quem chamou. É o detentor das provas ordenadas.
function rpcOpen(client, operation, actor, args, requestId = newRequestId()) {
  return inServiceTransaction(client, () => callRpc(client, operation, actor, requestId, args), {
    commit: false,
  });
}

function deleteAccountTx(client, actor, requestId = newRequestId()) {
  return inServiceTransaction(client, async () => {
    const result = await client.query(
      'select public.delete_account($1, $2, $3, $4, 1, 1) as response',
      [actor.authId, actor.sessionId, requestId, hmacOf('delete_account', [requestId])],
    );
    return result.rows[0].response;
  });
}

function deleteAccountOpen(client, actor, requestId = newRequestId()) {
  return inServiceTransaction(
    client,
    async () => {
      const result = await client.query(
        'select public.delete_account($1, $2, $3, $4, 1, 1) as response',
        [actor.authId, actor.sessionId, requestId, hmacOf('delete_account', [requestId])],
      );
      return result.rows[0].response;
    },
    { commit: false },
  );
}

// 'ok', '40P01' ou o código estável da recusa.
function kindOf(result) {
  if (result === undefined) return 'pending';
  if (result.status === 'fulfilled') return 'ok';
  if (result.reason?.code === '40P01') return '40P01';
  return result.reason?.message ?? `${result.reason}`;
}

function assertKind(result, expected, label) {
  assert.equal(
    kindOf(result),
    expected,
    `${label}: expected ${expected}, got ${describeResult(result)}`,
  );
}

async function membership(admin, groupId, profileId) {
  return (
    await admin.query(
      `select status, role, is_monthly, removed_at is not null as has_removed_at, removal_count
         from public.group_members where group_id = $1 and profile_id = $2`,
      [groupId, profileId],
    )
  ).rows[0];
}

async function ownerOf(admin, groupId) {
  return (await admin.query('select owner_id::text from public.groups where id = $1', [groupId]))
    .rows[0]?.owner_id;
}

async function activeGroups(admin, profileId) {
  return (
    await admin.query(
      `select count(*)::integer as count from public.group_members m
         join public.groups g on g.id = m.group_id
        where m.profile_id = $1 and m.status = 'active' and g.archived_at is null`,
      [profileId],
    )
  ).rows[0].count;
}

// Estado de owner inválido: grupo não arquivado cujo dono não tem membership
// active. O trigger diferido o recusa no commit; aqui ele é medido.
async function invalidOwnerGroups(admin, groupIds) {
  return (
    await admin.query(
      `select grp.id::text from public.groups grp
        where grp.id = any($1::uuid[]) and grp.archived_at is null
          and not exists (select 1 from public.group_members m
                           where m.group_id = grp.id and m.profile_id = grp.owner_id
                             and m.status = 'active')`,
      [groupIds],
    )
  ).rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Barreira de concorrência (docs/25 §2)
// ---------------------------------------------------------------------------

function awaitLockWait(observer, competitor, competitorPid, blockers, label) {
  return awaitBarrierWait(observer, competitor, competitorPid, blockers, label, APPLICATION_PREFIX);
}

// Depois de A ser observada esperando, B ou termina sem esperar ou é observada
// em espera de Lock. As duas coisas são legítimas e ficam registradas; o que
// reprova é o prazo sem nenhuma delas.
async function awaitDoneOrLockWait(observer, competitor, competitorPid, label) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (competitor.state.done) return 'finished';
    const { rows } = await observer.query(
      `select wait_event_type, pg_blocking_pids(pid) as blockers
         from pg_stat_activity where pid = $1`,
      [competitorPid],
    );
    if (rows[0]?.wait_event_type === 'Lock' && rows[0].blockers.length > 0) return 'waited';
    if (Date.now() > deadline) {
      throw new Error(`${label}: B neither finished nor waited on a lock within the deadline`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assertNoDeadlock(results, label) {
  for (const result of results) {
    if (kindOf(result) === '40P01') {
      throw new Error(
        `${label}: the barrier observed a deadlock (SQLSTATE 40P01): ${result.reason?.message}`,
      );
    }
  }
}

// Par cruzado da M2-D13: o detentor segura FOR NO KEY UPDATE o perfil alheio
// que A trava. A grava a idempotência (FOR KEY SHARE no próprio perfil pela FK
// actor_id) e fica parada nesse perfil; só então B começa. A idempotência de B
// toma FOR KEY SHARE no perfil que o detentor segura e não pode ser bloqueada.
async function crossBarrier(connections, pair) {
  const { observer, holder, first, second } = connections;
  const pids = await assertDistinctConnections({ observer, holder, first, second }, pair.label);
  await holder.query('begin');
  await holder.query('select 1 from public.profiles where id = $1 for no key update', [
    pair.holdProfileId,
  ]);
  let a;
  let b;
  let secondState = 'not started';
  try {
    a = track(pair.runFirst(first));
    await awaitLockWait(observer, a, pids.first, pids.holder, `${pair.label} A`);
    b = track(pair.runSecond(second));
    secondState = await awaitDoneOrLockWait(observer, b, pids.second, `${pair.label} B`);
  } finally {
    await holder.query('commit');
  }
  const settled = await Promise.allSettled([a.settled, b?.settled ?? Promise.resolve(undefined)]);
  const results = settled.map((entry) => entry.value);
  assertNoDeadlock(results.filter(Boolean), pair.label);
  return { results, secondState };
}

// Exclusão × transferência exige uma ordem semântica: A adquire o primeiro
// perfil; o detentor segura o segundo. B só começa depois de A esperar e só
// vale quando pg_blocking_pids mostra que B espera A.
async function orderedCrossBarrier(connections, pair) {
  const { observer, holder, first, second } = connections;
  const pids = await assertDistinctConnections({ observer, holder, first, second }, pair.label);
  await holder.query('begin');
  await holder.query('select 1 from public.profiles where id = $1 for no key update', [
    pair.holdProfileId,
  ]);
  let a;
  let b;
  try {
    a = track(pair.runFirst(first));
    await awaitLockWait(observer, a, pids.first, pids.holder, `${pair.label} A`);
    b = track(pair.runSecond(second));
    await awaitLockWait(observer, b, pids.second, pids.first, `${pair.label} B`);
  } finally {
    await holder.query('commit');
  }
  const settled = await Promise.allSettled([a.settled, b?.settled ?? Promise.resolve(undefined)]);
  const results = settled.map((entry) => entry.value);
  assertNoDeadlock(results.filter(Boolean), pair.label);
  return results;
}

// Par do mesmo ator (M2-D14): duas chamadas com request_id diferentes. O
// detentor segura a primeira linha que as duas travam; A é observada esperando
// por ele, e B, pelo detentor ou por A, que chegou antes na mesma linha.
async function sameActorBarrier(connections, pair) {
  const { observer, holder, first, second } = connections;
  const pids = await assertDistinctConnections({ observer, holder, first, second }, pair.label);
  await holder.query('begin');
  await holder.query('select 1 from public.profiles where id = $1 for no key update', [
    pair.holdProfileId,
  ]);
  let a;
  let b;
  try {
    a = track(pair.runFirst(first));
    await awaitLockWait(observer, a, pids.first, pids.holder, `${pair.label} A`);
    b = track(pair.runSecond(second));
    await awaitLockWait(observer, b, pids.second, [pids.holder, pids.first], `${pair.label} B`);
  } finally {
    await holder.query('commit');
  }
  const settled = await Promise.allSettled([a.settled, b?.settled ?? Promise.resolve(undefined)]);
  const results = settled.map((entry) => entry.value);
  assertNoDeadlock(results.filter(Boolean), pair.label);
  return results;
}

// Par ordenado: A roda até o fim e fica aberta, segurando todos os seus
// locks; B precisa ser observada esperando por A. Depois do commit de A, B
// decide sob lock contra o estado novo.
async function orderedPair(connections, pair) {
  const { observer, first, second } = connections;
  const pids = await assertDistinctConnections({ observer, first, second }, pair.label);
  const opened = await pair.openFirst(first);
  let b;
  try {
    b = track(pair.runSecond(second));
    await awaitLockWait(observer, b, pids.second, pids.first, `${pair.label} B`);
  } finally {
    await first.query('commit');
  }
  const [bResult] = await Promise.all([b.settled]);
  assertNoDeadlock([bResult], pair.label);
  return { first: opened, second: bResult };
}

// 20 pares sem barreira: as duas chamadas de cada par partem ao mesmo tempo.
// A contagem é impressa antes das asserções para que a contraprova mostre
// quantos pares fecharam ciclo.
async function storm(connections, label, pairs) {
  const { first, second } = connections;
  const outcomes = [];
  for (const pair of pairs) {
    const a = track(pair.runFirst(first));
    const b = track(pair.runSecond(second));
    outcomes.push({ entry: pair, results: await Promise.all([a.settled, b.settled]) });
  }
  const deadlocks = outcomes.filter(({ results }) =>
    results.some((result) => kindOf(result) === '40P01'),
  ).length;
  const tally = {};
  for (const kind of outcomes.flatMap(({ results }) => results.map(kindOf))) {
    tally[kind] = (tally[kind] ?? 0) + 1;
  }
  console.log(
    `${label} storm without barrier: ${pairs.length} pairs, pairs with 40P01=${deadlocks}, outcomes=${JSON.stringify(tally)}`,
  );
  assert.equal(deadlocks, 0, `${label} storm: ${deadlocks} of ${pairs.length} pairs hit 40P01`);
  return outcomes;
}

// ---------------------------------------------------------------------------
// Prova: texto canônico e modo das travas
// ---------------------------------------------------------------------------

function migrationFunctions(fileName) {
  const text = fs.readFileSync(path.join(migrationsDirectory, fileName), 'utf8');
  const pattern =
    /create (?:or replace )?function ([a-z_]+)\.([a-z_]+)\s*\(([\s\S]*?)\)\s*returns ([\s\S]*?)\bas \$function\$([\s\S]*?)\$function\$;/g;
  const functions = new Map();
  for (const match of text.matchAll(pattern)) {
    const [, schema, name, , header, body] = match;
    const attributes = header.toLowerCase();
    functions.set(`${schema}.${name}`, {
      body,
      securityDefiner: /\bsecurity definer\b/.test(attributes),
      volatility: /\bstable\b/.test(attributes)
        ? 's'
        : /\bimmutable\b/.test(attributes)
          ? 'i'
          : 'v',
      language: attributes.match(/\blanguage (\w+)/)?.[1],
      searchPathEmpty: /set search_path = ''/.test(attributes),
    });
  }
  return functions;
}

async function liveFunction(admin, qualifiedName) {
  const [schema, name] = qualifiedName.split('.');
  const { rows } = await admin.query(
    `select p.prosrc, p.provolatile, p.prosecdef, l.lanname,
            coalesce(p.proconfig, '{}') as proconfig,
            pg_get_functiondef(p.oid) as definition
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_language l on l.oid = p.prolang
      where n.nspname = $1 and p.proname = $2`,
    [schema, name],
  );
  assert.equal(rows.length, 1, `${qualifiedName} has ${rows.length} live overloads`);
  return rows[0];
}

function compareDefinition(expected, live) {
  const differences = [];
  if (live.definition.split('$function$')[1] !== expected.body) differences.push('body');
  if (live.prosrc !== expected.body) differences.push('prosrc');
  if (live.provolatile !== expected.volatility) differences.push('volatility');
  if (live.prosecdef !== expected.securityDefiner) differences.push('security definer');
  if (live.lanname !== expected.language) differences.push('language');
  if (expected.searchPathEmpty !== live.proconfig.includes('search_path=""')) {
    differences.push('search_path');
  }
  return differences;
}

const DEFINED_0016 = [
  'private.acquire_group_idempotency',
  'private.complete_group_idempotency',
  'private.enforce_idempotency_conclusion',
  'private.group_actor_authority',
  'private.purge_removed_memberships',
  'private.require_group_actor_after_locks',
  'private.require_group_not_suspended',
  'private.validate_idempotency_outcome',
  'private.worker_job_slot',
  'public.approve_member',
  'public.leave_group',
  'public.remove_member',
  'public.set_monthly',
  'public.set_ratings_visibility',
  'public.set_role',
  'public.transfer_ownership',
  'public.worker_execute_database_job',
];

const EXPECTED_0017_OVERRIDES = new Set([
  'private.acquire_group_idempotency',
  'private.complete_group_idempotency',
  'private.enforce_idempotency_conclusion',
  'private.validate_idempotency_outcome',
  'private.worker_job_slot',
  'public.worker_execute_database_job',
]);
const EXPECTED_0018_OVERRIDES = new Set([
  'private.acquire_group_idempotency',
  'private.complete_group_idempotency',
  'private.enforce_idempotency_conclusion',
  'private.validate_idempotency_outcome',
]);

// 0021 (Rachas v1) adds create_match to the same four lists, in the current
// idempotency pattern (D63.5 deferred, docs/25 section 8.1).
const EXPECTED_0021_OVERRIDES = new Set([
  'private.acquire_group_idempotency',
  'private.complete_group_idempotency',
  'private.enforce_idempotency_conclusion',
  'private.validate_idempotency_outcome',
]);

// 0022 (Racha completo) adds join_match, leave_match and set_match_payment to
// the same four lists, still in the current pattern.
const EXPECTED_0022_OVERRIDES = EXPECTED_0021_OVERRIDES;

// 0027 (ícone e cor do grupo) adds set_group_appearance to the same four lists,
// still in the current pattern.
const EXPECTED_0027_OVERRIDES = EXPECTED_0021_OVERRIDES;

// 0028 (editar e cancelar racha) adds update_match and cancel_match to the same
// four lists, still in the current pattern.
const EXPECTED_0028_OVERRIDES = EXPECTED_0021_OVERRIDES;

// 0029 (apagar grupo) adds delete_group to the same four lists, makes
// group_actor_authority refuse a deleted group before anything else, and keeps
// the seven membership RPCs from locking a deleted group's rows (P1 of the
// review of #80).
const EXPECTED_0029_OVERRIDES = new Set([
  ...EXPECTED_0021_OVERRIDES,
  'private.group_actor_authority',
  'public.approve_member',
  'public.leave_group',
  'public.remove_member',
  'public.set_monthly',
  'public.set_ratings_visibility',
  'public.set_role',
  'public.transfer_ownership',
]);

// 0030 (fotos de perfil e do grupo) adds the five photo operations to the same
// four lists and the reclaim job to the worker's slot and dispatcher.
const EXPECTED_0030_OVERRIDES = new Set([
  ...EXPECTED_0021_OVERRIDES,
  'private.worker_job_slot',
  'public.worker_execute_database_job',
]);

// 0031 (notas) adds set_rating to the same four lists and purge_ratings to the
// worker's slot and dispatcher.
const EXPECTED_0031_OVERRIDES = EXPECTED_0030_OVERRIDES;

// 0032 (sorteio de times) adds draw_teams to the same four lists, still in the
// current pattern.
const EXPECTED_0032_OVERRIDES = EXPECTED_0021_OVERRIDES;

// 0033 (D63.5) is the last redefinition of the four: the operation lists move
// to private.idempotency_operations, the validator turns stable and reads it,
// and the helpers and the conclusion trigger read the registry too.
const EXPECTED_0033_OVERRIDES = EXPECTED_0021_OVERRIDES;

async function proveCanonicalText(admin) {
  const defined = migrationFunctions(MIGRATION);
  const overrides = migrationFunctions('0017_group_invites.sql');
  const renameOverrides = migrationFunctions('0018_rename_group.sql');
  const matchOverrides = migrationFunctions('0021_matches_v1.sql');
  const playerOverrides = migrationFunctions('0022_match_players.sql');
  const appearanceOverrides = migrationFunctions('0027_group_appearance.sql');
  const editOverrides = migrationFunctions('0028_edit_cancel_match.sql');
  const deleteOverrides = migrationFunctions('0029_delete_group.sql');
  const photoOverrides = migrationFunctions('0030_photos.sql');
  const ratingOverrides = migrationFunctions('0031_ratings.sql');
  const drawOverrides = migrationFunctions('0032_draw_teams.sql');
  const registryOverrides = migrationFunctions('0033_idempotency_operations.sql');
  assert.deepEqual(
    [...defined.keys()].sort(),
    DEFINED_0016,
    'the extractor did not find exactly the functions defined by 0016',
  );
  for (const [qualifiedName, expected] of defined) {
    const expectedLive = EXPECTED_0033_OVERRIDES.has(qualifiedName)
      ? registryOverrides.get(qualifiedName)
      : EXPECTED_0032_OVERRIDES.has(qualifiedName)
        ? drawOverrides.get(qualifiedName)
        : EXPECTED_0031_OVERRIDES.has(qualifiedName)
          ? ratingOverrides.get(qualifiedName)
          : EXPECTED_0030_OVERRIDES.has(qualifiedName)
            ? photoOverrides.get(qualifiedName)
            : EXPECTED_0029_OVERRIDES.has(qualifiedName)
              ? deleteOverrides.get(qualifiedName)
              : EXPECTED_0028_OVERRIDES.has(qualifiedName)
                ? editOverrides.get(qualifiedName)
                : EXPECTED_0027_OVERRIDES.has(qualifiedName)
                  ? appearanceOverrides.get(qualifiedName)
                  : EXPECTED_0022_OVERRIDES.has(qualifiedName)
                    ? playerOverrides.get(qualifiedName)
                    : EXPECTED_0021_OVERRIDES.has(qualifiedName)
                      ? matchOverrides.get(qualifiedName)
                      : EXPECTED_0018_OVERRIDES.has(qualifiedName)
                        ? renameOverrides.get(qualifiedName)
                        : EXPECTED_0017_OVERRIDES.has(qualifiedName)
                          ? overrides.get(qualifiedName)
                          : expected;
    assert.ok(expectedLive, `${qualifiedName} has no expected live definition`);
    const differences = compareDefinition(expectedLive, await liveFunction(admin, qualifiedName));
    assert.deepEqual(
      differences,
      [],
      `${qualifiedName} diverges from its latest migration: ${differences}`,
    );
  }
  const later = fs
    .readdirSync(migrationsDirectory)
    .filter((file) => file > MIGRATION && file.endsWith('.sql'));
  for (const file of later) {
    for (const qualifiedName of migrationFunctions(file).keys()) {
      if (defined.has(qualifiedName)) {
        assert.ok(
          (file === '0017_group_invites.sql' && EXPECTED_0017_OVERRIDES.has(qualifiedName)) ||
            (file === '0018_rename_group.sql' && EXPECTED_0018_OVERRIDES.has(qualifiedName)) ||
            (file === '0021_matches_v1.sql' && EXPECTED_0021_OVERRIDES.has(qualifiedName)) ||
            (file === '0022_match_players.sql' && EXPECTED_0022_OVERRIDES.has(qualifiedName)) ||
            (file === '0027_group_appearance.sql' && EXPECTED_0027_OVERRIDES.has(qualifiedName)) ||
            (file === '0028_edit_cancel_match.sql' && EXPECTED_0028_OVERRIDES.has(qualifiedName)) ||
            (file === '0029_delete_group.sql' && EXPECTED_0029_OVERRIDES.has(qualifiedName)) ||
            (file === '0030_photos.sql' && EXPECTED_0030_OVERRIDES.has(qualifiedName)) ||
            (file === '0031_ratings.sql' && EXPECTED_0031_OVERRIDES.has(qualifiedName)) ||
            (file === '0032_draw_teams.sql' && EXPECTED_0032_OVERRIDES.has(qualifiedName)) ||
            (file === '0033_idempotency_operations.sql' &&
              EXPECTED_0033_OVERRIDES.has(qualifiedName)),
          `${file} unexpectedly redefines ${qualifiedName}`,
        );
      }
    }
  }
  assert.deepEqual(
    [...overrides.keys()].filter((name) => defined.has(name)).sort(),
    [...EXPECTED_0017_OVERRIDES].sort(),
    '0017 must redefine exactly the six expected 0016 functions',
  );
  assert.deepEqual(
    [...renameOverrides.keys()].filter((name) => defined.has(name)).sort(),
    [...EXPECTED_0018_OVERRIDES].sort(),
    '0018 must redefine exactly the four expected 0016 functions',
  );
  assert.deepEqual(
    [...matchOverrides.keys()].filter((name) => defined.has(name)).sort(),
    [...EXPECTED_0021_OVERRIDES].sort(),
    '0021 must redefine exactly the four expected 0016 functions',
  );
  assert.deepEqual(
    [...playerOverrides.keys()].filter((name) => defined.has(name)).sort(),
    [...EXPECTED_0022_OVERRIDES].sort(),
    '0022 must redefine exactly the four expected 0016 functions',
  );
  assert.deepEqual(
    [...appearanceOverrides.keys()].filter((name) => defined.has(name)).sort(),
    [...EXPECTED_0027_OVERRIDES].sort(),
    '0027 must redefine exactly the four expected 0016 functions',
  );
  assert.deepEqual(
    [...editOverrides.keys()].filter((name) => defined.has(name)).sort(),
    [...EXPECTED_0028_OVERRIDES].sort(),
    '0028 must redefine exactly the four expected 0016 functions',
  );
  assert.deepEqual(
    [...deleteOverrides.keys()].filter((name) => defined.has(name)).sort(),
    [...EXPECTED_0029_OVERRIDES].sort(),
    '0029 must redefine exactly the twelve expected 0016 functions',
  );
  assert.deepEqual(
    [...photoOverrides.keys()].filter((name) => defined.has(name)).sort(),
    [...EXPECTED_0030_OVERRIDES].sort(),
    '0030 must redefine exactly the six expected 0016 functions',
  );
  assert.deepEqual(
    [...ratingOverrides.keys()].filter((name) => defined.has(name)).sort(),
    [...EXPECTED_0031_OVERRIDES].sort(),
    '0031 must redefine exactly the six expected 0016 functions',
  );
  assert.deepEqual(
    [...drawOverrides.keys()].filter((name) => defined.has(name)).sort(),
    [...EXPECTED_0032_OVERRIDES].sort(),
    '0032 must redefine exactly the four expected 0016 functions',
  );
  assert.deepEqual(
    [...registryOverrides.keys()].filter((name) => defined.has(name)).sort(),
    [...EXPECTED_0033_OVERRIDES].sort(),
    '0033 must redefine exactly the four expected 0016 functions',
  );
  // Nenhuma função que a 0015 fixou é redefinida pela 0016.
  for (const qualifiedName of migrationFunctions('0015_group_foundation.sql').keys()) {
    assert.ok(!defined.has(qualifiedName), `0016 redefines ${qualifiedName} fixed by 0015`);
  }
  console.log(
    `ok - ${defined.size} functions: pg_get_functiondef equals the latest migration byte for byte`,
  );
}

// ---------------------------------------------------------------------------
// Prova: o registro de operações (0033, D63.5) e as listas da Edge
// ---------------------------------------------------------------------------

/** The string literals of one exported `as const` array of a Edge module. */
function edgeList(file, name) {
  const text = fs.readFileSync(
    path.join(repositoryRoot, 'supabase', 'functions', '_shared', file),
    'utf8',
  );
  const match = text.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  assert.ok(match, `${file} has no ${name} list`);
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((item) => item[1]);
}

// The reads of the invite and photo gateways: no idempotency record, so no row
// in the registry. A new read lands here on purpose; a new mutation missing
// from the registry fails the comparison below.
const EDGE_READS = [
  'get_group_members',
  'get_invite_share_link',
  'get_my_pending_group_requests',
  'get_photo_urls',
  'preview_group_by_code',
  'preview_group_by_invite',
];

async function proveRegistryMatchesEdge(admin) {
  const identity = edgeList('operations.ts', 'IDENTITY_OPERATIONS');
  const edgeGroup = [
    ...edgeList('operations.ts', 'GROUP_OPERATIONS'),
    ...edgeList('invite-gateway.ts', 'INVITE_OPERATIONS'),
    ...edgeList('photo-gateway.ts', 'PHOTO_OPERATIONS'),
  ];
  const { rows } = await admin.query(
    'select operation, family from private.idempotency_operations order by operation',
  );
  const byFamily = (families) =>
    rows
      .filter((row) => families.includes(row.family))
      .map((row) => row.operation)
      .sort();
  // The Edge's identity list is the registry's identity and account families.
  assert.deepEqual(
    [...identity].sort(),
    byFamily(['identity', 'account']),
    'the Edge identity operations are the registry identity and account families',
  );
  const mutations = edgeGroup.filter((operation) => !EDGE_READS.includes(operation));
  assert.deepEqual(
    [...new Set(mutations)].sort(),
    byFamily(['group']),
    'the Edge group, invite and photo mutations are the registry group family',
  );
  assert.deepEqual(
    edgeGroup.filter((operation) => EDGE_READS.includes(operation)).sort(),
    [...EDGE_READS].sort(),
    'every declared read is still in a Edge list',
  );
  console.log(
    `ok - registry matches the Edge: ${identity.length} identity and account, ${mutations.length} group`,
  );
}

// 0033: the deferred conclusion trigger reads the registry at a real COMMIT.
// Each case passes the three FKs and breaks the rule, so only the trigger can
// refuse it; the transaction must not commit and must leave nothing behind.
async function proveRegistryCommitReal(admin) {
  const cases = [
    {
      label: 'a resource_id different from the outcome',
      operation: 'approve_member',
      outcomeCode: 'member_approved',
      resourceId: '01890f7e-e948-4c53-b13a-4a36e4b7d210',
      outcome: {
        group_id: '01890f7e-e948-4c53-b13a-4a36e4b7d21e',
        logical_result: 'member_approved',
        profile_id: '01890f7e-e948-4c53-b13a-4a36e4b7d21f',
      },
    },
    {
      label: 'an outcome_code different from the logical_result, within valid pairs',
      operation: 'approve_member',
      outcomeCode: 'member_refused',
      resourceId: '01890f7e-e948-4c53-b13a-4a36e4b7d21e',
      outcome: {
        group_id: '01890f7e-e948-4c53-b13a-4a36e4b7d21e',
        logical_result: 'member_approved',
        profile_id: '01890f7e-e948-4c53-b13a-4a36e4b7d21f',
      },
    },
    {
      // rev92 P2-1: only the resource_is_actor clause refuses this one; the
      // profile is created in the same transaction, so the refusal undoes it.
      label: 'a resource that matches the outcome but is not the actor',
      operation: 'set_profile_photo',
      outcomeCode: 'profile_photo_set',
      resourceType: 'profile',
      resourceId: '01890f7e-e948-4c53-b13a-4a36e4b7d220',
      actor: true,
      outcome: {
        logical_result: 'profile_photo_set',
        profile_id: '01890f7e-e948-4c53-b13a-4a36e4b7d220',
      },
    },
  ];
  for (const [index, item] of cases.entries()) {
    const requestId = `33000000-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`;
    const actorId = idFor('a0', 0x635, index + 1);
    const authId = idFor('e0', 0x635, index + 1);
    await admin.query('begin');
    let error;
    try {
      if (item.actor) {
        await admin.query('insert into auth.users (id, email) values ($1, $2)', [
          authId,
          harnessEmail(AUTH_EMAIL_PREFIX, `0635-${index + 1}`),
        ]);
        await admin.query(
          `insert into public.profiles (id, auth_user_id, name, account_status)
           values ($1::uuid, $2, 'Membership ' || $1::uuid::text, 'active')`,
          [actorId, authId],
        );
      }
      await admin.query(
        `insert into private.idempotency_records
           (actor_key, actor_id, operation, request_id, request_hash, hash_key_version)
         values ($1, $2, $3, $4, repeat('a', 64), 1)`,
        [
          item.actor ? `profile:${actorId}` : 'system:d635_commit',
          item.actor ? actorId : null,
          item.operation,
          requestId,
        ],
      );
      await admin.query(
        `update private.idempotency_records
            set state = 'completed', outcome_code = $1, completed_at = now(),
                resource_type = $2, resource_id = $3, outcome = $4
          where request_id = $5`,
        [item.outcomeCode, item.resourceType ?? 'group', item.resourceId, item.outcome, requestId],
      );
      await admin.query('commit');
    } catch (caught) {
      error = caught;
      await admin.query('rollback').catch(() => {});
    }
    assert.ok(error, `${item.label}: the COMMIT went through`);
    assert.equal(error.message, 'IDEMPOTENCY_OUTCOME_INVALID', `${item.label}: ${error.message}`);
    const { rows } = await admin.query(
      'select count(*)::int as n from private.idempotency_records where request_id = $1',
      [requestId],
    );
    assert.equal(rows[0].n, 0, `${item.label}: the refused record stayed`);
    if (item.actor) {
      const { rows: profiles } = await admin.query(
        'select count(*)::int as n from public.profiles where id = $1',
        [actorId],
      );
      assert.equal(profiles[0].n, 0, `${item.label}: the actor fixture stayed`);
    }
  }
  console.log(`ok - the deferred trigger refuses ${cases.length} records at a real COMMIT`);
}

// M2-D13: toda cláusula de lock das funções da 0016, lida do banco vivo. A
// única exceção é o expurgo, que apaga a linha e nunca espera.
async function proveLockModes(admin) {
  const clauses = [];
  for (const qualifiedName of DEFINED_0016) {
    const live = await liveFunction(admin, qualifiedName);
    // Comentários citam os modos por extenso; só o código conta.
    const code = live.definition.replace(/--[^\n]*/g, '');
    for (const match of code.matchAll(
      /\bfor\s+(no\s+key\s+update|update|share|key\s+share)(\s+skip\s+locked|\s+nowait)?/gi,
    )) {
      clauses.push({
        function: qualifiedName,
        clause: match[0].replace(/\s+/g, ' ').toLowerCase(),
      });
    }
  }
  const outside = clauses.filter(
    ({ function: name, clause }) =>
      clause !== 'for no key update' &&
      !(name === 'private.purge_removed_memberships' && clause === 'for update skip locked'),
  );
  assert.deepEqual(outside, [], `lock clauses outside M2-D13: ${JSON.stringify(outside)}`);
  const summary = {};
  for (const { function: name, clause } of clauses) {
    summary[name] = [...(summary[name] ?? []), clause];
  }
  console.log(`# lock clauses of the 0016 functions: ${JSON.stringify(summary)}`);
  console.log(
    `ok - ${clauses.length} lock clauses: FOR NO KEY UPDATE everywhere, FOR UPDATE SKIP LOCKED only in the retention purge`,
  );
}

// ---------------------------------------------------------------------------
// Prova: commit real sob service_role e idempotência concluída
// ---------------------------------------------------------------------------

async function proveCommitReal(admin, client) {
  const [owner, organizer, player, pending, monthly] = await createActors(admin, 0x0001, 5);
  const groupId = idFor('b0', 0x0001, 1);
  await createGroups(admin, [
    {
      id: groupId,
      owner,
      monthlyEnabled: true,
      members: [
        [owner, 'organizer', 'active'],
        [organizer, 'organizer', 'active'],
        [player, 'player', 'active'],
        [pending, 'player', 'pending'],
        [monthly, 'player', 'active'],
      ],
    },
  ]);
  // Cada chamada leva também uma entrada diferente e válida para o mesmo
  // request_id, que precisa dar IDEMPOTENCY_CONFLICT antes do domínio.
  const calls = [
    ['approve_member', organizer, [groupId, pending.id, true], [groupId, pending.id, false]],
    ['set_role', owner, [groupId, player.id, 'organizer'], [groupId, player.id, 'player']],
    ['set_monthly', organizer, [groupId, monthly.id, true], [groupId, monthly.id, false]],
    ['set_ratings_visibility', owner, [groupId, 'members', true], [groupId, 'private', false]],
    [
      'remove_member',
      organizer,
      [groupId, monthly.id, 'motivo de fixture'],
      [groupId, monthly.id, 'outro motivo'],
    ],
    ['transfer_ownership', owner, [groupId, organizer.id], [groupId, player.id]],
    ['leave_group', owner, [groupId], [idFor('b0', 0x0001, 99)]],
  ];
  for (const [operation, actor, args, otherArgs] of calls) {
    const requestId = newRequestId();
    const response = await rpcTx(client, operation, actor, args, requestId);
    const { rows } = await admin.query(
      `select state, outcome, resource_type, resource_id::text
         from private.idempotency_records
        where actor_id = $1 and operation = $2 and request_id = $3`,
      [actor.id, operation, requestId],
    );
    assert.deepEqual(
      rows[0],
      {
        state: 'completed',
        outcome: response.outcome,
        resource_type: 'group',
        resource_id: groupId,
      },
      `${operation}: the committed idempotency record`,
    );
    const keys = Object.keys(rows[0].outcome).sort();
    const idKey = ['approve_member', 'remove_member', 'set_role', 'set_monthly'].includes(operation)
      ? 'profile_id'
      : operation === 'transfer_ownership'
        ? 'new_owner_id'
        : undefined;
    assert.deepEqual(
      keys,
      ['group_id', 'logical_result', ...(idKey === undefined ? [] : [idKey])].sort(),
      `${operation}: only stable IDs and logical_result in the book`,
    );
    assert.equal(rows[0].outcome.group_id, groupId);
    if (idKey !== undefined) assert.equal(rows[0].outcome[idKey], args[1]);
    console.log(`# recorded outcome keys ${operation}: ${JSON.stringify(keys)}`);
    const replay = await rpcTx(client, operation, actor, args, requestId);
    assert.deepEqual(replay.outcome, response.outcome, `${operation}: replay after commit`);
    if (operation === 'transfer_ownership' || operation === 'leave_group') {
      assert.deepEqual(replay, { outcome: response.outcome }, `${operation}: outcome only`);
      const code = operation === 'transfer_ownership' ? 'OWNER_ONLY' : 'NOT_MEMBER';
      await assert.rejects(
        rpcTx(client, operation, actor, args),
        (error) => error.message === code,
        `${operation}: new call denies lost authority`,
      );
    } else {
      assert.ok(Object.hasOwn(replay, 'current'), `${operation}: authorized projection`);
    }
    await assert.rejects(
      rpcTx(client, operation, actor, otherArgs, requestId),
      (error) => error.message === 'IDEMPOTENCY_CONFLICT',
      `${operation}: same request_id with another input`,
    );
  }
  assert.equal(await ownerOf(admin, groupId), organizer.id);
  assert.deepEqual(await invalidOwnerGroups(admin, [groupId]), []);
  assert.equal((await membership(admin, groupId, owner.id)).status, 'removed');
  console.log(
    'ok - the seven RPCs commit under service_role: completed record with resource group, replay with current authority, conflict on another input',
  );
}

// ---------------------------------------------------------------------------
// Pares cruzados da M2-D13
// ---------------------------------------------------------------------------

// Topologia simétrica: x e y, cada um dono do próprio grupo, e o outro membro
// dele. O par de índice i usa os perfis 2i+1 (menor byte) e 2i+2.
const CROSS = {
  'cross-approve': {
    code: 0x0100,
    otherStatus: 'pending',
    call: (groupId, target) => ['approve_member', [groupId, target.id, true]],
    expected: 'ok',
    after: async (admin, pair) => {
      assert.equal((await membership(admin, pair.gx, pair.y.id)).status, 'active');
      assert.equal((await membership(admin, pair.gy, pair.x.id)).status, 'active');
    },
  },
  'cross-remove': {
    code: 0x0200,
    otherStatus: 'active',
    call: (groupId, target) => ['remove_member', [groupId, target.id, 'motivo do par cruzado']],
    expected: 'ok',
    after: async (admin, pair) => {
      assert.equal((await membership(admin, pair.gx, pair.y.id)).status, 'removed');
      assert.equal((await membership(admin, pair.gy, pair.x.id)).status, 'removed');
    },
  },
  'cross-role': {
    code: 0x0300,
    otherStatus: 'active',
    call: (groupId, target) => ['set_role', [groupId, target.id, 'organizer']],
    expected: 'ok',
    after: async (admin, pair) => {
      assert.equal((await membership(admin, pair.gx, pair.y.id)).role, 'organizer');
      assert.equal((await membership(admin, pair.gy, pair.x.id)).role, 'organizer');
    },
  },
  'cross-monthly': {
    code: 0x0400,
    otherStatus: 'active',
    monthlyEnabled: true,
    call: (groupId, target) => ['set_monthly', [groupId, target.id, true]],
    expected: 'ok',
    after: async (admin, pair) => {
      assert.equal((await membership(admin, pair.gx, pair.y.id)).is_monthly, true);
      assert.equal((await membership(admin, pair.gy, pair.x.id)).is_monthly, true);
    },
  },
  'cross-transfer': {
    code: 0x0500,
    otherStatus: 'active',
    call: (groupId, target) => ['transfer_ownership', [groupId, target.id]],
    expected: 'ok',
    after: async (admin, pair) => {
      assert.equal(await ownerOf(admin, pair.gx), pair.y.id);
      assert.equal(await ownerOf(admin, pair.gy), pair.x.id);
      assert.deepEqual(await invalidOwnerGroups(admin, [pair.gx, pair.gy]), []);
    },
  },
};

async function crossFixture(admin, spec, count) {
  const actors = await createActors(admin, spec.code, count * 2);
  const pairs = Array.from({ length: count }, (_, index) => ({
    x: actors[index * 2],
    y: actors[index * 2 + 1],
    gx: idFor('b0', spec.code, index * 2 + 1),
    gy: idFor('b0', spec.code, index * 2 + 2),
  }));
  await createGroups(
    admin,
    pairs.flatMap((pair) => [
      {
        id: pair.gx,
        owner: pair.x,
        monthlyEnabled: spec.monthlyEnabled,
        members: [
          [pair.x, 'organizer', 'active'],
          [pair.y, 'player', spec.otherStatus],
        ],
      },
      {
        id: pair.gy,
        owner: pair.y,
        monthlyEnabled: spec.monthlyEnabled,
        members: [
          [pair.y, 'organizer', 'active'],
          [pair.x, 'player', spec.otherStatus],
        ],
      },
    ]),
  );
  return pairs;
}

async function proveCrossPair(name, connections, admin) {
  const spec = CROSS[name];
  const pairs = await crossFixture(admin, spec, 2 + STORM_PAIRS);
  const run = (actor, groupId, target) => (connection) => {
    const [operation, args] = spec.call(groupId, target);
    return rpcTx(connection, operation, actor, args);
  };
  // Ordem 1: A é o perfil de menor byte; ordem 2: o de maior byte.
  for (const [index, label, aSide] of [
    [0, `${name} order 1: low → high`, 'x'],
    [1, `${name} order 2: high → low`, 'y'],
  ]) {
    if (!runPart(`order${index + 1}`)) continue;
    const pair = pairs[index];
    const [a, b] = aSide === 'x' ? [pair.x, pair.y] : [pair.y, pair.x];
    const [ga, gb] = aSide === 'x' ? [pair.gx, pair.gy] : [pair.gy, pair.gx];
    const { results, secondState } = await crossBarrier(connections, {
      label,
      holdProfileId: b.id,
      runFirst: run(a, ga, b),
      runSecond: run(b, gb, a),
    });
    assertKind(results[0], spec.expected, `${label} A`);
    assertKind(results[1], spec.expected, `${label} B`);
    await spec.after(admin, pair);
    console.log(`# ${label}: A waited on the holder; B ${secondState} while A was held`);
  }
  console.log(`ok - ${name}: cross pair through the barrier, no 40P01`);
  if (!runPart('storm')) return;

  const outcomes = await storm(
    connections,
    name,
    pairs.slice(2).map((pair, index) => {
      const [a, b] = index % 2 === 0 ? [pair.x, pair.y] : [pair.y, pair.x];
      const [ga, gb] = index % 2 === 0 ? [pair.gx, pair.gy] : [pair.gy, pair.gx];
      return { pair, runFirst: run(a, ga, b), runSecond: run(b, gb, a) };
    }),
  );
  for (const { entry, results } of outcomes) {
    for (const result of results) assertKind(result, spec.expected, `${name} storm`);
    await spec.after(admin, entry.pair);
  }
  console.log(
    `ok - ${name}: ${STORM_PAIRS} simultaneous pairs, zero 40P01, both effects in every pair`,
  );
}

// Exclusão × transferência, forma cruzada (docs/25 §4.3): x exclui a conta com
// y entre os candidatos (y organizador ativo no grupo de x) enquanto y
// transfere a x o próprio grupo (x ativo nele).
async function proveCrossDeletionTransfer(connections, admin, inverse = false) {
  const code = inverse ? 0x0610 : 0x0600;
  const topology = inverse ? 'deleting UUID greater' : 'deleting UUID smaller';
  const count = 2 + STORM_PAIRS;
  const actors = await createActors(admin, code, count * 2);
  const pairs = Array.from({ length: count }, (_, index) => ({
    x: actors[index * 2 + (inverse ? 1 : 0)],
    y: actors[index * 2 + (inverse ? 0 : 1)],
    gx: idFor('b0', code, index * 2 + 1),
    gy: idFor('b0', code, index * 2 + 2),
  }));
  await createGroups(
    admin,
    pairs.flatMap((pair) => [
      {
        id: pair.gx,
        owner: pair.x,
        members: [
          [pair.x, 'organizer', 'active'],
          [pair.y, 'organizer', 'active'],
        ],
      },
      {
        id: pair.gy,
        owner: pair.y,
        members: [
          [pair.y, 'organizer', 'active'],
          [pair.x, 'player', 'active'],
        ],
      },
    ]),
  );
  const deletion = (pair, requestId) => (connection) =>
    deleteAccountTx(connection, pair.x, requestId);
  const transfer = (pair) => (connection) =>
    rpcTx(connection, 'transfer_ownership', pair.y, [pair.gy, pair.x.id]);

  // Ordem 1: o detentor segura o segundo perfil por bytes da exclusão.
  // Na topologia inversa é x; A já segura y antes de B começar.
  if (runPart('order1')) {
    const pair = pairs[0];
    const label = `cross-deletion-transfer (${topology}) order 1: deletion → transfer`;
    const results = await orderedCrossBarrier(connections, {
      label,
      holdProfileId: inverse ? pair.x.id : pair.y.id,
      runFirst: deletion(pair, newRequestId()),
      runSecond: transfer(pair),
    });
    assertKind(results[0], 'ok', `${label} deletion`);
    assertKind(results[1], 'NOT_ACTIVE_MEMBER', `${label} transfer`);
    assert.equal(await ownerOf(admin, pair.gx), pair.y.id, `${label}: x's group goes to y`);
    assert.equal(await ownerOf(admin, pair.gy), pair.y.id, `${label}: y keeps its group`);
    console.log(`# ${label}: A waited on the holder's second profile; B waited on A`);
  }
  // Ordem 2: a transferência primeiro; o detentor segura o segundo perfil de A.
  if (runPart('order2')) {
    const pair = pairs[1];
    const label = `cross-deletion-transfer (${topology}) order 2: transfer → deletion`;
    const deletionRequest = newRequestId();
    const results = await orderedCrossBarrier(connections, {
      label,
      holdProfileId: inverse ? pair.x.id : pair.y.id,
      runFirst: transfer(pair),
      runSecond: deletion(pair, deletionRequest),
    });
    assertKind(results[0], 'ok', `${label} transfer`);
    // x resolveu os grupos próprios antes de receber gy: a revalidação sob lock
    // aborta (docs/25 §3.3, caso 1) e o retry com o mesmo request_id conclui.
    assertKind(results[1], 'CONCURRENT_CHANGE', `${label} deletion`);
    await deleteAccountTx(connections.first, pair.x, deletionRequest);
    assert.deepEqual(await invalidOwnerGroups(admin, [pair.gx, pair.gy]), []);
    assert.equal(await ownerOf(admin, pair.gy), pair.y.id, `${label}: gy returns to y`);
    console.log(`# ${label}: A waited on the holder's second profile; B waited on A`);
  }
  console.log(`ok - cross-deletion-transfer (${topology}): through the barrier, no 40P01`);
  if (!runPart('storm')) return;

  const requests = new Map();
  const outcomes = await storm(
    connections,
    `cross-deletion-transfer (${topology})`,
    pairs.slice(2).map((pair, index) => {
      requests.set(pair, newRequestId());
      const runDeletion = deletion(pair, requests.get(pair));
      const runTransfer = transfer(pair);
      return index % 2 === 0
        ? { pair, runFirst: runDeletion, runSecond: runTransfer, deletionAt: 0 }
        : { pair, runFirst: runTransfer, runSecond: runDeletion, deletionAt: 1 };
    }),
  );
  for (const { entry, results } of outcomes) {
    const { pair, deletionAt } = entry;
    const deletionKind = kindOf(results[deletionAt]);
    const transferKind = kindOf(results[1 - deletionAt]);
    assert.ok(
      ['ok', 'CONCURRENT_CHANGE'].includes(deletionKind),
      `cross-deletion-transfer storm: deletion ${deletionKind}`,
    );
    assert.ok(
      ['ok', 'NOT_ACTIVE_MEMBER'].includes(transferKind),
      `cross-deletion-transfer storm: transfer ${transferKind}`,
    );
    if (deletionKind === 'CONCURRENT_CHANGE') {
      await deleteAccountTx(connections.first, pair.x, requests.get(pair));
    }
    assert.deepEqual(await invalidOwnerGroups(admin, [pair.gx, pair.gy]), []);
  }
  console.log(
    `ok - cross-deletion-transfer (${topology}): ${STORM_PAIRS} simultaneous pairs, zero 40P01, every CONCURRENT_CHANGE retry converged`,
  );
}

// ---------------------------------------------------------------------------
// Pares do mesmo ator (M2-D14): dois cliques, request_id diferentes
// ---------------------------------------------------------------------------

// Cada fixture tem dono o, alvo t e grupo g. hold diz qual perfil o detentor
// segura: a primeira linha que as duas chamadas travam.
const SAME = {
  'same-approve': {
    code: 0x0700,
    targetStatus: 'pending',
    hold: 'target',
    calls: (g, o, t) => [
      ['approve_member', o, [g, t.id, true]],
      ['approve_member', o, [g, t.id, true]],
    ],
    expected: ['MEMBERSHIP_ALREADY_DECIDED', 'ok'],
  },
  'same-remove': {
    code: 0x0800,
    targetStatus: 'active',
    hold: 'target',
    calls: (g, o, t) => [
      ['remove_member', o, [g, t.id, 'motivo do primeiro clique']],
      ['remove_member', o, [g, t.id, 'motivo do segundo clique']],
    ],
    expected: ['NOT_ACTIVE_MEMBER', 'ok'],
  },
  'same-role': {
    code: 0x0900,
    targetStatus: 'active',
    hold: 'target',
    calls: (g, o, t) => [
      ['set_role', o, [g, t.id, 'organizer']],
      ['set_role', o, [g, t.id, 'player']],
    ],
    expected: ['ok', 'ok'],
  },
  'same-monthly': {
    code: 0x0a00,
    targetStatus: 'active',
    monthlyEnabled: true,
    hold: 'owner',
    // O alvo é o próprio ator: a variante em que set_monthly trava o perfil
    // de quem chama, depois do FOR KEY SHARE da idempotência.
    calls: (g, o) => [
      ['set_monthly', o, [g, o.id, true]],
      ['set_monthly', o, [g, o.id, false]],
    ],
    expected: ['ok', 'ok'],
  },
  'same-visibility': {
    code: 0x0b00,
    targetStatus: 'active',
    hold: 'owner',
    calls: (g, o) => [
      ['set_ratings_visibility', o, [g, 'members', true]],
      ['set_ratings_visibility', o, [g, 'private', false]],
    ],
    expected: ['ok', 'ok'],
  },
  'same-transfer': {
    code: 0x0c00,
    targetStatus: 'active',
    hold: 'owner',
    calls: (g, o, t) => [
      ['transfer_ownership', o, [g, t.id]],
      ['transfer_ownership', o, [g, t.id]],
    ],
    expected: ['OWNER_ONLY', 'ok'],
  },
  'same-leave': {
    code: 0x0d00,
    targetStatus: 'active',
    hold: 'target',
    // O ator é o jogador t, que sai duas vezes do grupo de o.
    calls: (g, o, t) => [
      ['leave_group', t, [g]],
      ['leave_group', t, [g]],
    ],
    expected: ['NOT_MEMBER', 'ok'],
  },
};

async function proveSameActorPair(name, connections, admin) {
  const spec = SAME[name];
  const count = 2 + STORM_PAIRS;
  const actors = await createActors(admin, spec.code, count * 2);
  const fixtures = Array.from({ length: count }, (_, index) => ({
    o: actors[index * 2],
    t: actors[index * 2 + 1],
    g: idFor('b0', spec.code, index + 1),
  }));
  await createGroups(
    admin,
    fixtures.map((fixture) => ({
      id: fixture.g,
      owner: fixture.o,
      monthlyEnabled: spec.monthlyEnabled,
      members: [
        [fixture.o, 'organizer', 'active'],
        [fixture.t, 'player', spec.targetStatus],
      ],
    })),
  );
  const runners = (fixture) =>
    spec.calls(fixture.g, fixture.o, fixture.t).map(
      ([operation, actor, args]) =>
        (connection) =>
          rpcTx(connection, operation, actor, args),
    );
  const check = (results, label) => {
    const kinds = results.map(kindOf).sort();
    assert.deepEqual(kinds, spec.expected, `${label}: expected ${spec.expected}, got ${kinds}`);
  };
  const { observer, holder, first, second } = connections;
  for (const [index, label, a, b] of [
    [0, `${name} order 1`, first, second],
    [1, `${name} order 2`, second, first],
  ]) {
    if (!runPart(`order${index + 1}`)) continue;
    const fixture = fixtures[index];
    const [runFirst, runSecond] = runners(fixture);
    const results = await sameActorBarrier(
      { observer, holder, first: a, second: b },
      {
        label,
        holdProfileId: spec.hold === 'owner' ? fixture.o.id : fixture.t.id,
        runFirst,
        runSecond,
      },
    );
    check(results, label);
  }
  console.log(`ok - ${name}: same-actor pair through the barrier, no 40P01`);
  if (!runPart('storm')) return;

  const outcomes = await storm(
    connections,
    name,
    fixtures.slice(2).map((fixture) => {
      const [runFirst, runSecond] = runners(fixture);
      return { fixture, runFirst, runSecond };
    }),
  );
  for (const { results } of outcomes) check(results, `${name} storm`);
  console.log(
    `ok - ${name}: ${STORM_PAIRS} simultaneous pairs, zero 40P01, contract outcome in every pair`,
  );
}

// ---------------------------------------------------------------------------
// Cota pessoal: quinta e sexta membership
// ---------------------------------------------------------------------------

// Alvo t com quatro memberships ativas e pedido pendente em dois grupos, cada
// um com organizador próprio. A primeira aprovação abre a quinta; a segunda
// precisa esperar pelo perfil de t e recontar: GROUP_LIMIT. Sem o lock-pai do
// perfil alvo, a segunda não espera e a sexta membership aparece.
async function proveQuotaPair(connections, admin) {
  const code = 0x0e00;
  const actors = await createActors(admin, code, 2 * 7);
  for (const [order, label] of [
    [0, 'quota pair order 1: first group → second group'],
    [1, 'quota pair order 2: second group → first group'],
  ]) {
    const [t, ...owners] = actors.slice(order * 7, order * 7 + 7);
    const groups = owners.map((_, index) => idFor('b0', code, order * 10 + index + 1));
    await createGroups(
      admin,
      owners.map((owner, index) => ({
        id: groups[index],
        owner,
        members: [
          [owner, 'organizer', 'active'],
          [t, 'player', index < 4 ? 'active' : 'pending'],
        ],
      })),
    );
    assert.equal(await activeGroups(admin, t.id), 4);
    const [gA, gB] = order === 0 ? [groups[4], groups[5]] : [groups[5], groups[4]];
    const [oA, oB] = order === 0 ? [owners[4], owners[5]] : [owners[5], owners[4]];
    let paired;
    try {
      paired = await orderedPair(connections, {
        label,
        openFirst: (connection) => rpcOpen(connection, 'approve_member', oA, [gA, t.id, true]),
        runSecond: (connection) => rpcTx(connection, 'approve_member', oB, [gB, t.id, true]),
      });
    } catch (error) {
      error.message += `; active memberships of the target after the pair: ${await activeGroups(admin, t.id)}`;
      throw error;
    }
    assert.equal(paired.first.outcome.logical_result, 'member_approved', label);
    const active = await activeGroups(admin, t.id);
    assert.equal(active, 5, `${label}: ${active} active memberships (sixth membership)`);
    assertKind(paired.second, 'GROUP_LIMIT', label);
  }
  console.log(
    'ok - quota pair: the fifth is approved, the sixth waits on the profile and gets GROUP_LIMIT, both orders',
  );
}

// Sob 25 conexões: 25 organizadores aprovam ao mesmo tempo o mesmo perfil,
// cada um no próprio grupo. O detentor segura o perfil alvo; ao menos 24 são
// observadas esperando lock; liberado o detentor, exatamente uma vira a quinta.
async function proveQuotaRacers(connections, admin, racers) {
  const code = 0x0f00;
  const actors = await createActors(admin, code, 1 + 4 + RACERS);
  const [t, ...others] = actors;
  const activeOwners = others.slice(0, 4);
  const organizers = others.slice(4);
  const groups = others.map((_, index) => idFor('b0', code, index + 1));
  await createGroups(
    admin,
    others.map((owner, index) => ({
      id: groups[index],
      owner,
      members: [
        [owner, 'organizer', 'active'],
        [t, 'player', index < 4 ? 'active' : 'pending'],
      ],
    })),
  );
  assert.equal(activeOwners.length, 4);
  const { observer, holder } = connections;
  const pids = await Promise.all(racers.map(backendPid));
  const holderPid = await backendPid(holder);
  await holder.query('begin');
  await holder.query('select 1 from public.profiles where id = $1 for no key update', [t.id]);
  let tracked = [];
  let waited = 0;
  let barrierError;
  try {
    tracked = racers.map((racer, index) =>
      track(rpcTx(racer, 'approve_member', organizers[index], [groups[index + 4], t.id, true])),
    );
    const deadline = Date.now() + 15_000;
    for (;;) {
      const done = tracked.filter((entry) => entry.state.done);
      if (done.length > 0) {
        throw new Error(
          `quota racers: ${done.length} racers finished while the target profile was held: ${describeResult(done[0].state.result)}`,
        );
      }
      const { rows } = await observer.query(
        `select count(*)::integer as waiting from pg_stat_activity
          where pid = any($1::int[]) and wait_event_type = 'Lock'`,
        [pids],
      );
      waited = rows[0].waiting;
      if (waited >= RACERS - 1) break;
      if (Date.now() > deadline) {
        throw new Error(`quota racers: only ${waited} of ${RACERS} observed waiting on a lock`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } catch (error) {
    barrierError = error;
  } finally {
    await holder.query('commit');
    const settled = await Promise.allSettled(tracked.map((entry) => entry.settled));
    tracked = settled.map((entry) => entry.value);
  }
  if (barrierError !== undefined) {
    barrierError.message += `; active memberships after every racer settled: ${await activeGroups(admin, t.id)}`;
    throw barrierError;
  }
  const kinds = tracked.map(kindOf);
  const tally = {};
  for (const kind of kinds) tally[kind] = (tally[kind] ?? 0) + 1;
  const active = await activeGroups(admin, t.id);
  console.log(
    `quota racers: ${RACERS} connections, ${waited} observed waiting on a lock (holder ${holderPid}), outcomes=${JSON.stringify(tally)}, active memberships=${active}`,
  );
  assert.equal(tally['40P01'] ?? 0, 0, 'quota racers: 40P01');
  assert.equal(active, 5, `quota racers: ${active} active memberships (sixth membership)`);
  assert.deepEqual(tally, { GROUP_LIMIT: RACERS - 1, ok: 1 });
  console.log(
    `ok - quota under ${RACERS} connections: at least ${RACERS - 1} waited, exactly one fifth membership, ${RACERS - 1} GROUP_LIMIT`,
  );
}

// ---------------------------------------------------------------------------
// Titularidade: transferência × saída e exclusões
// ---------------------------------------------------------------------------

// O dono o transfere o grupo a n enquanto n sai. Nas duas ordens, o estado
// final tem dono com membership active. A contraprova de docs/25 §4.3 retira
// os locks de leave_group: o trigger diferido recusa o commit; sem o trigger,
// o lock serializa; sem os dois, o estado inválido aparece aqui.
async function proveOwnerRace(connections, admin) {
  const code = 0x1000;
  const actors = await createActors(admin, code, 4);
  const specs = [0, 1].map((order) => ({
    o: actors[order * 2],
    n: actors[order * 2 + 1],
    g: idFor('b0', code, order + 1),
  }));
  await createGroups(
    admin,
    specs.map(({ o, n, g }) => ({
      id: g,
      owner: o,
      members: [
        [o, 'organizer', 'active'],
        [n, 'organizer', 'active'],
      ],
    })),
  );
  {
    const { o, n, g } = specs[0];
    const label = 'transfer × leave order 1: transfer → leave';
    const paired = await orderedPair(connections, {
      label,
      openFirst: (connection) => rpcOpen(connection, 'transfer_ownership', o, [g, n.id]),
      runSecond: (connection) => rpcTx(connection, 'leave_group', n, [g]),
    });
    assert.equal(paired.first.outcome.logical_result, 'ownership_transferred');
    const invalid = await invalidOwnerGroups(admin, [g]);
    assert.deepEqual(invalid, [], `${label}: invalid owner state in ${invalid}`);
    assertKind(paired.second, 'OWNER_MUST_TRANSFER', label);
    assert.equal(await ownerOf(admin, g), n.id);
  }
  {
    const { o, n, g } = specs[1];
    const label = 'transfer × leave order 2: leave → transfer';
    const paired = await orderedPair(connections, {
      label,
      openFirst: (connection) => rpcOpen(connection, 'leave_group', n, [g]),
      runSecond: (connection) => rpcTx(connection, 'transfer_ownership', o, [g, n.id]),
    });
    assert.equal(paired.first.outcome.logical_result, 'group_left');
    assert.deepEqual(await invalidOwnerGroups(admin, [g]), [], `${label}: invalid owner state`);
    assertKind(paired.second, 'NOT_ACTIVE_MEMBER', label);
    assert.equal(await ownerOf(admin, g), o.id);
  }
  console.log(
    'ok - transfer × leave: both orders serialize; the owner always keeps an active membership',
  );
}

// Exclusão × transferência: o dono o transfere o grupo a n enquanto n exclui a
// conta. Exclusão do dono × exclusão do organizador escolhido: o dono o sai
// com n como único candidato enquanto n também sai.
async function proveDeletionPairs(connections, admin) {
  const code = 0x1100;
  const actors = await createActors(admin, code, 8);
  const specs = [0, 1, 2, 3].map((index) => ({
    o: actors[index * 2],
    n: actors[index * 2 + 1],
    g: idFor('b0', code, index + 1),
  }));
  await createGroups(
    admin,
    specs.map(({ o, n, g }) => ({
      id: g,
      owner: o,
      members: [
        [o, 'organizer', 'active'],
        [n, 'organizer', 'active'],
      ],
    })),
  );
  {
    const { o, n, g } = specs[0];
    const label = 'deletion × transfer order 1: transfer → deletion';
    const deletionRequest = newRequestId();
    const paired = await orderedPair(connections, {
      label,
      openFirst: (connection) => rpcOpen(connection, 'transfer_ownership', o, [g, n.id]),
      runSecond: (connection) => deleteAccountTx(connection, n, deletionRequest),
    });
    assertKind(paired.second, 'CONCURRENT_CHANGE', label);
    await deleteAccountTx(connections.first, n, deletionRequest);
    assert.equal(await ownerOf(admin, g), o.id, `${label}: the deletion hands the group back`);
    assert.deepEqual(await invalidOwnerGroups(admin, [g]), []);
  }
  {
    const { o, n, g } = specs[1];
    const label = 'deletion × transfer order 2: deletion → transfer';
    const paired = await orderedPair(connections, {
      label,
      openFirst: (connection) => deleteAccountOpen(connection, n),
      runSecond: (connection) => rpcTx(connection, 'transfer_ownership', o, [g, n.id]),
    });
    assertKind(paired.second, 'NOT_ACTIVE_MEMBER', label);
    assert.equal(await ownerOf(admin, g), o.id);
    assert.deepEqual(await invalidOwnerGroups(admin, [g]), []);
  }
  console.log('ok - deletion × transfer: both orders serialize without 40P01');
  {
    const { o, n, g } = specs[2];
    const label = 'owner deletion × chosen organizer deletion order 1';
    const organizerRequest = newRequestId();
    const paired = await orderedPair(connections, {
      label,
      openFirst: (connection) => deleteAccountOpen(connection, o),
      runSecond: (connection) => deleteAccountTx(connection, n, organizerRequest),
    });
    assertKind(paired.second, 'CONCURRENT_CHANGE', label);
    await deleteAccountTx(connections.first, n, organizerRequest);
    const { rows } = await admin.query(
      'select archived_at is not null as archived from public.groups where id = $1',
      [g],
    );
    assert.equal(rows[0].archived, true, `${label}: the retry archives the group as solo`);
  }
  {
    const { o, n, g } = specs[3];
    const label = 'owner deletion × chosen organizer deletion order 2';
    const ownerRequest = newRequestId();
    const paired = await orderedPair(connections, {
      label,
      openFirst: (connection) => deleteAccountOpen(connection, n),
      runSecond: (connection) => deleteAccountTx(connection, o, ownerRequest),
    });
    // O organizador saiu antes: o dono resolveu n como candidato, e a
    // revalidação sob lock o encontra inelegível.
    assertKind(paired.second, 'CONCURRENT_CHANGE', label);
    await deleteAccountTx(connections.first, o, ownerRequest);
    const { rows } = await admin.query(
      'select archived_at is not null as archived from public.groups where id = $1',
      [g],
    );
    assert.equal(rows[0].archived, true, `${label}: the retry archives the group as solo`);
  }
  console.log(
    'ok - owner deletion × chosen organizer deletion: both orders serialize without 40P01',
  );
}

// ---------------------------------------------------------------------------
// HTTP real: gateway produtivo, JWT do GoTrue
// ---------------------------------------------------------------------------

async function createRealUsers(status, admin, code, names) {
  const users = {};
  for (const [index, name] of names.entries()) {
    const email = harnessEmail(AUTH_EMAIL_PREFIX, `http-${hex4(code)}-${Date.now()}-${name}`);
    const created = await fetch(`${status.apiUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: status.secretKey,
        Authorization: `Bearer ${status.secretKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
    });
    const createdBody = await created.text();
    assert.equal(created.status, 200, `admin create user ${name}: ${created.status}`);
    const authId = JSON.parse(createdBody).id;
    const signedIn = await fetch(`${status.apiUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: status.publishableKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    assert.equal(signedIn.status, 200, `password grant ${name}: ${signedIn.status}`);
    const session = await signedIn.json();
    const claims = JSON.parse(
      Buffer.from(session.access_token.split('.')[1], 'base64url').toString('utf8'),
    );
    assert.equal(claims.sub, authId);
    users[name] = {
      id: idFor('a0', code, index + 1),
      authId,
      sessionId: claims.session_id,
      token: session.access_token,
    };
  }
  await admin.query(
    `insert into public.profiles (id, auth_user_id, name, account_status)
     select id, auth_id, 'Membership HTTP', 'active'
     from unnest($1::uuid[], $2::uuid[]) as fixture(id, auth_id)`,
    [Object.values(users).map((user) => user.id), Object.values(users).map((user) => user.authId)],
  );
  return users;
}

async function edge(status, route, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${status.functionsUrl}/${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

function groupsCall(status, user, operation, fields, requestId = crypto.randomUUID()) {
  return edge(status, `groups/${operation}`, { request_id: requestId, ...fields }, user.token);
}

async function restGroups(status, user) {
  const response = await fetch(`${status.apiUrl}/rest/v1/groups?select=id`, {
    headers: { apikey: status.publishableKey, Authorization: `Bearer ${user.token}` },
  });
  assert.equal(response.status, 200, `PostgREST groups read: ${response.status}`);
  return (await response.json()).map((row) => row.id);
}

function assertEdgeError(response, httpStatus, code, label) {
  assert.equal(response.status, httpStatus, `${label}: ${response.text}`);
  assert.equal(response.body.error?.code, code, `${label}: ${response.text}`);
}

// M2-D20 ajustada: autenticação negada é erro; autoridade negada conserva o outcome.
// Todas as sete RPCs: conta/sessão/aceite atuais, perda de papel e de membership.
async function proveReplayAuthority(admin, client) {
  for (const [index, operation] of Object.keys(RPC_PARAMS).entries()) {
    const code = 0x1800 + index;
    const [owner, organizer, target] = await createActors(admin, code, 3);
    const groupId = idFor('b0', code, 1);
    await createGroups(admin, [
      {
        id: groupId,
        owner,
        monthlyEnabled: true,
        members: [
          [owner, 'organizer', 'active'],
          [organizer, 'organizer', 'active'],
          [target, 'player', operation === 'approve_member' ? 'pending' : 'active'],
        ],
      },
    ]);
    const ownerOnly = ['set_role', 'set_ratings_visibility', 'transfer_ownership'].includes(
      operation,
    );
    const actor = ownerOnly ? owner : organizer;
    const args = {
      approve_member: [groupId, target.id, true],
      remove_member: [groupId, target.id, 'fixture de autoridade'],
      set_role: [groupId, target.id, 'organizer'],
      set_monthly: [groupId, target.id, true],
      set_ratings_visibility: [groupId, 'members', true],
      transfer_ownership: [groupId, owner.id],
      leave_group: [groupId],
    }[operation];
    const requestId = newRequestId();
    const original = await rpcTx(client, operation, actor, args, requestId);
    const deniedAuthority = async (expected) => {
      const replay = await rpcTx(client, operation, actor, args, requestId);
      assert.deepEqual(replay, { outcome: original.outcome }, `${operation}: replay ${expected}`);
      await assert.rejects(
        rpcTx(client, operation, actor, args),
        (error) => error.message === expected,
        `${operation}: new call ${expected}`,
      );
    };
    const deniedAuthentication = async (expected) => {
      for (const id of [requestId, newRequestId()]) {
        await assert.rejects(
          rpcTx(client, operation, actor, args, id),
          (error) => error.message === expected,
          `${operation}: replay and new call deny authentication with ${expected}`,
        );
      }
    };
    // Só fixtures do estado da conta; nenhuma rotina produtiva de suspensão no M2.
    for (const [status, expected] of [
      ['suspended', 'PROFILE_SUSPENDED'],
      ['banned', 'PROFILE_SUSPENDED'],
      ['deletion_pending', 'FORBIDDEN'],
    ]) {
      await admin.query('update public.profiles set account_status=$1 where id=$2', [
        status,
        actor.id,
      ]);
      await deniedAuthentication(expected);
    }
    await admin.query("update public.profiles set account_status='active' where id=$1", [actor.id]);
    await rpcTx(client, 'revoke_current_session', actor, []);
    await deniedAuthentication('UNAUTHENTICATED');
    await admin.query('delete from private.revoked_auth_sessions where session_id=$1', [
      actor.sessionId,
    ]);
    try {
      assert.equal(
        Number((await admin.query('select count(*) from private.policy_documents')).rows[0].count),
        0,
      );
      await admin.query(`insert into private.policy_documents
        (document_type, version, content_sha256, published_at, mandatory)
        values ('terms', 'membership-auth-40d', decode(repeat('a',64),'hex'), now(), true),
               ('privacy', 'membership-auth-40d', decode(repeat('b',64),'hex'), now(), true)`);
      await deniedAuthentication('VALIDATION');
    } finally {
      await admin.query("delete from private.policy_documents where version='membership-auth-40d'");
    }
    if (ownerOnly) {
      await rpcTx(client, 'transfer_ownership', owner, [groupId, organizer.id]);
      await deniedAuthority('OWNER_ONLY');
      await rpcTx(client, 'remove_member', organizer, [groupId, owner.id, 'fixture de remoção']);
    } else if (operation !== 'leave_group') {
      await rpcTx(client, 'set_role', owner, [groupId, organizer.id, 'player']);
      await deniedAuthority('NOT_ORGANIZER');
      await rpcTx(client, 'remove_member', owner, [groupId, organizer.id, 'fixture de remoção']);
    }
    await deniedAuthority('NOT_MEMBER');
    const records = (
      await admin.query(
        `select state, outcome from private.idempotency_records
      where actor_id=$1 and operation=$2 and request_id=$3`,
        [actor.id, operation, requestId],
      )
    ).rows;
    assert.deepEqual(
      records,
      [{ state: 'completed', outcome: original.outcome }],
      `${operation}: denied replay preserves the committed outcome`,
    );
    console.log(
      `ok - ${operation}: replay and new call deny account, session and policy authentication; lost group authority preserves outcome only`,
    );
  }
}

async function proveReplayHttp(status, admin) {
  const code = 0x1500;
  const users = await createRealUsers(status, admin, code, ['owner', 'organizer', 'target']);
  const groupId = idFor('b0', code, 1);
  await createGroups(admin, [
    {
      id: groupId,
      owner: users.owner,
      monthlyEnabled: true,
      members: [
        [users.owner, 'organizer', 'active'],
        [users.organizer, 'organizer', 'active'],
        [users.target, 'player', 'active'],
      ],
    },
  ]);
  const fields = { group_id: groupId, profile_id: users.target.id, enabled: true };
  const requestId = crypto.randomUUID();
  const original = await groupsCall(status, users.organizer, 'set_monthly', fields, requestId);
  assert.equal(original.status, 200);
  assert.deepEqual(original.body.data.current, { enabled: true });
  const removed = await groupsCall(status, users.owner, 'remove_member', {
    group_id: groupId,
    profile_id: users.organizer.id,
    reason: 'fixture de autoridade',
  });
  assert.equal(removed.status, 200);
  const changed = await groupsCall(status, users.owner, 'set_monthly', {
    ...fields,
    enabled: false,
  });
  assert.equal(changed.status, 200);
  const marker = 'estado-atual-alvo-40c';
  await admin.query('update public.profiles set nickname=$1 where id=$2', [
    marker,
    users.target.id,
  ]);
  const replay = await groupsCall(status, users.organizer, 'set_monthly', fields, requestId);
  const fresh = await groupsCall(status, users.organizer, 'set_monthly', fields);
  // Diagnóstico allowlisted, sem credencial ou identificador Auth.
  console.log(
    `# removed organizer replay: ${JSON.stringify({
      replayStatus: replay.status,
      replayCode: replay.body.error?.code,
      replayCurrent: replay.body.data?.current,
      newStatus: fresh.status,
      newCode: fresh.body.error?.code,
    })}`,
  );
  const authorizedRequest = crypto.randomUUID();
  const authorized = await groupsCall(
    status,
    users.owner,
    'set_monthly',
    fields,
    authorizedRequest,
  );
  assert.equal(authorized.status, 200);
  assert.equal(
    (await groupsCall(status, users.owner, 'set_monthly', { ...fields, enabled: false })).status,
    200,
  );
  const authorizedReplay = await groupsCall(
    status,
    users.owner,
    'set_monthly',
    fields,
    authorizedRequest,
  );
  assert.equal(authorizedReplay.status, 200);
  assert.deepEqual(authorizedReplay.body.data.outcome, authorized.body.data.outcome);
  assert.deepEqual(authorizedReplay.body.data.current, { enabled: false });
  assert.equal(authorizedReplay.body.request_id, authorizedRequest);
  console.log('ok - authorized HTTP replay: recorded outcome and fresh enabled=false');
  assertEdgeError(fresh, 403, 'NOT_MEMBER', 'removed organizer new call');
  console.log('ok - removed organizer new HTTP call: 403 NOT_MEMBER');
  assert.equal(replay.status, 200, 'removed organizer replay status');
  assert.equal(replay.body.request_id, requestId);
  // Percorre valores: o false atual e o marcador não podem sair nem em outro campo.
  const values = (value) =>
    value !== null && typeof value === 'object' ? Object.values(value).flatMap(values) : [value];
  assert.ok(!values(replay.body).includes(false), 'fresh enabled=false leaked by value');
  assert.ok(!values(replay.body).includes(marker), 'fresh profile marker leaked by value');
  assert.deepEqual(replay.body, {
    data: { outcome: original.body.data.outcome },
    request_id: requestId,
  });
  console.log('ok - removed organizer HTTP replay: 200 recorded outcome only; fresh values absent');
}

// N2: resposta perdida depois de a própria operação retirar a autoridade.
async function proveSelfRevokedReplayHttp(status, admin) {
  const users = await createRealUsers(status, admin, 0x1510, ['owner', 'successor', 'player']);
  const groupId = idFor('b0', 0x1510, 1);
  await createGroups(admin, [
    {
      id: groupId,
      owner: users.owner,
      members: [
        [users.owner, 'organizer', 'active'],
        [users.successor, 'organizer', 'active'],
        [users.player, 'player', 'active'],
      ],
    },
  ]);
  const cases = [];
  for (const [operation, actor, fields, newCode] of [
    ['leave_group', users.player, { group_id: groupId }, 'NOT_MEMBER'],
    [
      'transfer_ownership',
      users.owner,
      { group_id: groupId, new_owner_id: users.successor.id },
      'OWNER_ONLY',
    ],
  ]) {
    const requestId = crypto.randomUUID();
    const original = await groupsCall(status, actor, operation, fields, requestId);
    assert.equal(original.status, 200, `${operation}: first call`);
    const replay = await groupsCall(status, actor, operation, fields, requestId);
    const fresh = await groupsCall(status, actor, operation, fields);
    console.log(
      `# self-revoked HTTP replay: ${JSON.stringify({
        operation,
        replayStatus: replay.status,
        replayCode: replay.body.error?.code,
        hasCurrent: Object.hasOwn(replay.body.data ?? {}, 'current'),
        newStatus: fresh.status,
        newCode: fresh.body.error?.code,
      })}`,
    );
    cases.push({ operation, original, replay, fresh, requestId, newCode });
  }
  for (const { operation, original, replay, fresh, requestId, newCode } of cases) {
    assertEdgeError(fresh, 403, newCode, `${operation}: new call`);
    assert.equal(replay.status, 200, `${operation}: replay status`);
    assert.deepEqual(replay.body, {
      data: { outcome: original.body.data.outcome },
      request_id: requestId,
    });
    console.log(
      `ok - ${operation} HTTP replay: 200 recorded outcome only; new call 403 ${newCode}`,
    );
  }
}

// Observação pós-piloto: mede precedências ainda não normativas sem fixá-las
// como contrato nem alterar a produção.
async function measureGatewayOrder(status, admin) {
  const users = await createRealUsers(status, admin, 0x1521, ['owner', 'target']);
  const groupId = idFor('b0', 0x1521, 1);
  await createGroups(admin, [
    {
      id: groupId,
      owner: users.owner,
      monthlyEnabled: true,
      members: [
        [users.owner, 'organizer', 'active'],
        [users.target, 'player', 'active'],
      ],
    },
  ]);
  const fields = { group_id: groupId, profile_id: users.target.id, enabled: true };
  const request = crypto.randomUUID();
  const original = await groupsCall(status, users.owner, 'set_monthly', fields, request);
  assert.equal(original.status, 200, 'measurement fixture must complete');
  const measure = async (label, promise) => {
    const result = await promise;
    console.log(
      `# gateway order measured, not normative: ${JSON.stringify({
        label,
        status: result.status,
        code: result.body.error?.code ?? null,
        outcome: Object.hasOwn(result.body.data ?? {}, 'outcome'),
        current: Object.hasOwn(result.body.data ?? {}, 'current'),
      })}`,
    );
  };
  const invalid = { ...fields, request_id: 'invalid-request-id' };
  await measure('invalid-envelope+no-token', edge(status, 'groups/set_monthly', invalid));
  await measure(
    'invalid-envelope+invalid-token',
    edge(status, 'groups/set_monthly', invalid, 'invalid-token'),
  );
  for (const [label, column] of [
    ['suspended', 'suspended_at'],
    ['archived', 'archived_at'],
  ]) {
    await admin.query(`update public.groups set ${column}=now() where id=$1`, [groupId]);
    await measure(
      `${label}+replay`,
      groupsCall(status, users.owner, 'set_monthly', fields, request),
    );
    await measure(`${label}+new`, groupsCall(status, users.owner, 'set_monthly', fields));
    await admin.query(`update public.groups set ${column}=null where id=$1`, [groupId]);
  }
  const holder = newClient(status.databaseUrl, 'gateway_measure_holder');
  await holder.connect();
  try {
    const waitingRequest = crypto.randomUUID();
    await holder.query('begin');
    await holder.query('set local role service_role');
    await holder.query('select public.set_monthly($1,$2,$3,$4,1,1,$5,$6,true)', [
      users.owner.authId,
      users.owner.sessionId,
      waitingRequest,
      'c'.repeat(64),
      groupId,
      users.target.id,
    ]);
    const revoked = await edge(
      status,
      'identity/revoke_current_session',
      { request_id: crypto.randomUUID() },
      users.owner.token,
    );
    assert.equal(revoked.status, 200);
    await measure(
      'idempotency-wait+revoked-session',
      groupsCall(status, users.owner, 'set_monthly', fields, waitingRequest),
    );
  } finally {
    await holder.query('rollback');
    await holder.end();
  }
  await admin.query('delete from private.revoked_auth_sessions where session_id=$1', [
    users.owner.sessionId,
  ]);
  await admin.query('update public.groups set archived_at=now() where id=$1', [groupId]);
  await admin.query('delete from public.group_members where group_id=$1', [groupId]);
  await admin.query('delete from public.groups where id=$1', [groupId]);
  await measure(
    'missing-group+replay',
    groupsCall(status, users.owner, 'set_monthly', fields, request),
  );
  await measure('missing-group+new', groupsCall(status, users.owner, 'set_monthly', fields));
}

// 40d (e): o mesmo JWT ainda verificável após revogação pelo gateway.
// Mede todos os replays antes de afirmar: a contraprova não oculta os demais.
async function proveRevokedSessionReplayHttp(status, admin) {
  const users = await createRealUsers(status, admin, 0x1520, ['owner', 'organizer', 'target']);
  const cases = [];
  for (const [index, operation] of Object.keys(RPC_PARAMS).entries()) {
    const groupId = idFor('b0', 0x1520, index + 1);
    await createGroups(admin, [
      {
        id: groupId,
        owner: users.owner,
        monthlyEnabled: true,
        members: [
          [users.owner, 'organizer', 'active'],
          [users.organizer, 'organizer', 'active'],
          [users.target, 'player', operation === 'approve_member' ? 'pending' : 'active'],
        ],
      },
    ]);
    const actor = operation === 'leave_group' ? users.organizer : users.owner;
    const fields = {
      approve_member: { group_id: groupId, profile_id: users.target.id, approve: true },
      remove_member: {
        group_id: groupId,
        profile_id: users.target.id,
        reason: 'fixture de autenticação',
      },
      set_role: { group_id: groupId, profile_id: users.target.id, role: 'organizer' },
      set_monthly: { group_id: groupId, profile_id: users.target.id, enabled: true },
      set_ratings_visibility: {
        group_id: groupId,
        visibility: 'members',
        confirm_members_visibility: true,
      },
      transfer_ownership: { group_id: groupId, new_owner_id: users.owner.id },
      leave_group: { group_id: groupId },
    }[operation];
    const requestId = crypto.randomUUID();
    const original = await groupsCall(status, actor, operation, fields, requestId);
    assert.equal(original.status, 200, `${operation}: original authenticated call`);
    cases.push({ operation, actor, fields, requestId, original });
  }
  for (const actor of [users.owner, users.organizer]) {
    const revoked = await edge(
      status,
      'identity/revoke_current_session',
      { request_id: crypto.randomUUID() },
      actor.token,
    );
    assert.equal(revoked.status, 200, 'session revocation through the real gateway');
  }
  for (const entry of cases) {
    assertEdgeError(
      await groupsCall(
        status,
        entry.actor,
        entry.operation,
        { ...entry.fields, group_id: crypto.randomUUID() },
        entry.requestId,
      ),
      409,
      'IDEMPOTENCY_CONFLICT',
      `${entry.operation}: changed input before revoked-session 401`,
    );
    assertEdgeError(
      await groupsCall(status, entry.actor, entry.operation, entry.fields, 'invalid-request-id'),
      422,
      'VALIDATION',
      `${entry.operation}: invalid envelope before revoked-session 401`,
    );
    console.log(
      `ok - ${entry.operation} HTTP envelope: conflict 409 and validation 422 precede revoked-session 401`,
    );
    entry.replay = await groupsCall(
      status,
      entry.actor,
      entry.operation,
      entry.fields,
      entry.requestId,
    );
    entry.fresh = await groupsCall(status, entry.actor, entry.operation, entry.fields);
    console.log(
      `# revoked session HTTP: ${JSON.stringify({
        operation: entry.operation,
        replayStatus: entry.replay.status,
        replayCode: entry.replay.body.error?.code,
        hasOutcome: Object.hasOwn(entry.replay.body.data ?? {}, 'outcome'),
        newStatus: entry.fresh.status,
        newCode: entry.fresh.body.error?.code,
      })}`,
    );
  }
  for (const { operation, actor, requestId, original, replay, fresh } of cases) {
    assertEdgeError(fresh, 401, 'UNAUTHENTICATED', `${operation}: revoked session new call`);
    assertEdgeError(replay, 401, 'UNAUTHENTICATED', `${operation}: revoked session replay`);
    assert.ok(!Object.hasOwn(replay.body, 'data'), `${operation}: no outcome or projection`);
    assert.deepEqual(
      replay.body,
      { ...fresh.body, request_id: requestId },
      `${operation}: replay returns exactly the normal authentication error`,
    );
    const records = (
      await admin.query(
        `select state, outcome from private.idempotency_records
       where actor_id=$1 and operation=$2`,
        [actor.id, operation],
      )
    ).rows;
    assert.deepEqual(
      records,
      [{ state: 'completed', outcome: original.body.data.outcome }],
      `${operation}: original book entry unchanged; denied fresh call leaves no entry`,
    );
    console.log(
      `ok - ${operation} HTTP: revoked session replay and new call 401 UNAUTHENTICATED, no data; completed outcome unchanged`,
    );
  }
}

// 40d (f): a mesma intenção UUID pertence à chave do ator, não ao UUID sozinho.
async function proveActorScopedRequestHttp(status, admin) {
  const users = await createRealUsers(status, admin, 0x1530, ['owner', 'organizer', 'player']);
  const groupIds = [idFor('b0', 0x1530, 1), idFor('b0', 0x1530, 2)];
  await createGroups(
    admin,
    groupIds.map((id) => ({
      id,
      owner: users.owner,
      monthlyEnabled: true,
      members: [
        [users.owner, 'organizer', 'active'],
        [users.organizer, 'organizer', 'active'],
        [users.player, 'player', 'active'],
      ],
    })),
  );
  const requestId = crypto.randomUUID();
  const fields = { group_id: groupIds[0], profile_id: users.player.id, enabled: true };
  const first = await groupsCall(status, users.owner, 'set_monthly', fields, requestId);
  assert.equal(first.status, 200);
  const second = await groupsCall(
    status,
    users.organizer,
    'set_monthly',
    { ...fields, group_id: groupIds[1] },
    requestId,
  );
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, {
    data: {
      outcome: {
        group_id: groupIds[1],
        profile_id: users.player.id,
        logical_result: 'monthly_set',
      },
      current: { enabled: true },
    },
    request_id: requestId,
  });
  assert.notDeepEqual(second.body.data.outcome, first.body.data.outcome);
  const denied = await groupsCall(status, users.player, 'set_monthly', fields, requestId);
  assertEdgeError(denied, 403, 'NOT_ORGANIZER', 'another actor with no authority');
  assert.ok(!Object.hasOwn(denied.body, 'data'));
  const records = (
    await admin.query(
      `select actor_id::text, outcome from private.idempotency_records
     where operation='set_monthly' and request_id=$1 order by actor_id`,
      [requestId],
    )
  ).rows;
  assert.deepEqual(records, [
    { actor_id: users.owner.id, outcome: first.body.data.outcome },
    { actor_id: users.organizer.id, outcome: second.body.data.outcome },
  ]);
  console.log(
    'ok - HTTP actor-scoped request_id: second actor gets own distinct group outcome; unauthorized third actor 403 NOT_ORGANIZER without data; exactly two actor-scoped completed entries',
  );
}

// M2-D19 (4): commit real; xmin, updated_at, membership e triggers observados.
async function proveSelfTransfer(admin, client) {
  const [owner] = await createActors(admin, 0x1600, 1);
  const groupId = idFor('b0', 0x1600, 1);
  await createGroups(admin, [{ id: groupId, owner, members: [[owner, 'organizer', 'active']] }]);
  // groups não tem updated_at produtivo (0015). Esta coluna é uma sonda
  // de teste, removida no finally; o trigger BEFORE a mudaria em todo UPDATE.
  assert.equal(
    (
      await admin.query(`select count(*)::int n from information_schema.columns
    where table_schema='public' and table_name='groups' and column_name='updated_at'`)
    ).rows[0].n,
    0,
  );
  await admin.query(`alter table public.groups add column updated_at timestamptz
    not null default '2025-01-01T00:00:00Z';
    create function private.membership_updated_at_probe() returns trigger language plpgsql as $probe$
    begin NEW.updated_at := clock_timestamp(); return NEW; end; $probe$;
    create trigger membership_updated_at_probe before update on public.groups
      for each row execute function private.membership_updated_at_probe()`);
  const snapshot = async () =>
    (
      await admin.query(
        'select xmin::text, updated_at::text, owner_id::text from public.groups where id=$1',
        [groupId],
      )
    ).rows[0];
  const before = await snapshot();
  const memberBefore = await membership(admin, groupId, owner.id);
  // Sondas temporárias: a de statement detecta até UPDATE com zero linhas.
  await admin.query(`create table private.membership_update_probe (level text);
    create function private.membership_update_probe() returns trigger language plpgsql as $probe$
    begin insert into private.membership_update_probe values (TG_LEVEL); return null; end; $probe$;
    create trigger membership_update_probe_row after update on public.groups
      for each row execute function private.membership_update_probe();
    create trigger membership_update_probe_statement after update on public.groups
      for each statement execute function private.membership_update_probe()`);
  try {
    const requestId = newRequestId();
    const response = await rpcTx(
      client,
      'transfer_ownership',
      owner,
      [groupId, owner.id],
      requestId,
    );
    const after = await snapshot();
    const triggers = (await admin.query('select level from private.membership_update_probe')).rows;
    console.log(
      `# self transfer: ${JSON.stringify({
        xminUnchanged: before.xmin === after.xmin,
        updatedAtUnchanged: before.updated_at === after.updated_at,
        triggers: triggers.length,
      })}`,
    );
    assert.deepEqual(after, before, 'M2-D19: self transfer must not rewrite groups');
    assert.deepEqual(triggers, [], 'M2-D19: no row or statement UPDATE trigger fires');
    assert.deepEqual(await membership(admin, groupId, owner.id), memberBefore);
    assert.deepEqual(response, {
      outcome: {
        group_id: groupId,
        new_owner_id: owner.id,
        logical_result: 'ownership_transferred',
      },
      current: { owner_id: owner.id },
    });
    const record = (
      await admin.query(
        `select state, outcome from private.idempotency_records
      where actor_id=$1 and operation='transfer_ownership' and request_id=$2`,
        [owner.id, requestId],
      )
    ).rows[0];
    assert.deepEqual(record, { state: 'completed', outcome: response.outcome });
    assert.deepEqual(
      await rpcTx(client, 'transfer_ownership', owner, [groupId, owner.id], requestId),
      response,
    );
    assert.deepEqual(
      (await admin.query('select level from private.membership_update_probe')).rows,
      [],
    );
    console.log(
      'ok - self transfer: completed record, identical xmin/updated_at/membership, zero UPDATE triggers',
    );
  } finally {
    await admin.query(`drop trigger membership_update_probe_row on public.groups;
      drop trigger membership_update_probe_statement on public.groups;
      drop function private.membership_update_probe(); drop table private.membership_update_probe;
      drop trigger membership_updated_at_probe on public.groups;
      drop function private.membership_updated_at_probe();
      alter table public.groups drop column updated_at`);
  }
}

async function proveSuspendedRoleRemove(status, admin) {
  const code = 0x1700;
  const users = await createRealUsers(status, admin, code, ['owner', 'target']);
  const groupId = idFor('b0', code, 1);
  await createGroups(admin, [
    {
      id: groupId,
      owner: users.owner,
      suspendedAt: new Date('2026-09-01T00:00:00Z'), // Única escrita da suspensão: setup postgres.
      members: [
        [users.owner, 'organizer', 'active'],
        [users.target, 'player', 'active'],
      ],
    },
  ]);
  for (const [operation, fields] of [
    ['set_role', { role: 'organizer' }],
    ['remove_member', { reason: 'fixture de suspensão' }],
  ]) {
    const before = await membership(admin, groupId, users.target.id);
    const response = await groupsCall(status, users.owner, operation, {
      group_id: groupId,
      profile_id: users.target.id,
      ...fields,
    });
    assertEdgeError(response, 403, 'GROUP_SUSPENDED', `${operation} in suspended group`);
    assert.deepEqual(await membership(admin, groupId, users.target.id), before);
    console.log(`ok - ${operation} over HTTP: GROUP_SUSPENDED and target unchanged`);
  }
}

async function proveHttp(status, admin) {
  const code = 0x1200;
  const users = await createRealUsers(status, admin, code, [
    'owner',
    'organizer',
    'player',
    'pending',
    'target',
    'outsider',
    'suspendedPending',
  ]);
  const hg = idFor('b0', code, 1);
  const hs = idFor('b0', code, 2);
  await createGroups(admin, [
    {
      id: hg,
      owner: users.owner,
      monthlyEnabled: true,
      members: [
        [users.owner, 'organizer', 'active'],
        [users.organizer, 'organizer', 'active'],
        [users.player, 'player', 'active'],
        [users.pending, 'player', 'pending'],
        [users.target, 'player', 'active'],
      ],
    },
    {
      // suspended_at só por fixture, como postgres, no setup (docs/25 §4.1).
      id: hs,
      owner: users.owner,
      suspendedAt: new Date('2026-09-01T00:00:00Z'),
      members: [
        [users.owner, 'organizer', 'active'],
        [users.player, 'player', 'active'],
        [users.suspendedPending, 'player', 'pending'],
      ],
    },
  ]);

  // Fronteira do gateway: sem token, função errada, chave interna.
  assertEdgeError(
    await edge(status, 'groups/leave_group', { request_id: crypto.randomUUID(), group_id: hg }),
    401,
    'UNAUTHENTICATED',
    'no token',
  );
  assertEdgeError(
    await edge(
      status,
      'identity/approve_member',
      {
        request_id: crypto.randomUUID(),
        group_id: hg,
        profile_id: users.pending.id,
        approve: true,
      },
      users.organizer.token,
    ),
    404,
    'NOT_FOUND',
    'identity does not serve group operations',
  );
  assertEdgeError(
    await edge(
      status,
      'groups/update_profile',
      { request_id: crypto.randomUUID(), patch: {} },
      users.organizer.token,
    ),
    404,
    'NOT_FOUND',
    'groups does not serve identity operations',
  );
  assertEdgeError(
    await groupsCall(status, users.player, 'leave_group', {
      group_id: hg,
      actor_session_id: users.owner.sessionId,
    }),
    422,
    'VALIDATION',
    'an internal key in the body',
  );
  console.log(
    'ok - HTTP boundary: 401 without token, NOT_FOUND across functions, internal keys refused',
  );

  // approve_member, replay e conflito.
  const approveRequest = crypto.randomUUID();
  const approved = await groupsCall(
    status,
    users.organizer,
    'approve_member',
    { group_id: hg, profile_id: users.pending.id, approve: true },
    approveRequest,
  );
  assert.equal(approved.status, 200, approved.text);
  assert.deepEqual(approved.body, {
    data: {
      outcome: { group_id: hg, profile_id: users.pending.id, logical_result: 'member_approved' },
      current: { status: 'active' },
    },
    request_id: approveRequest,
  });
  const replayed = await groupsCall(
    status,
    users.organizer,
    'approve_member',
    { group_id: hg, profile_id: users.pending.id, approve: true },
    approveRequest,
  );
  assert.deepEqual(replayed.body, approved.body, 'HTTP replay');
  assertEdgeError(
    await groupsCall(
      status,
      users.organizer,
      'approve_member',
      { group_id: hg, profile_id: users.pending.id, approve: false },
      approveRequest,
    ),
    409,
    'IDEMPOTENCY_CONFLICT',
    'HTTP conflict',
  );
  assertEdgeError(
    await groupsCall(status, users.owner, 'approve_member', {
      group_id: hs,
      profile_id: users.suspendedPending.id,
      approve: true,
    }),
    403,
    'GROUP_SUSPENDED',
    'approval in a suspended group',
  );
  console.log('ok - approve_member over HTTP: success, replay, conflict and GROUP_SUSPENDED');

  // set_role, set_monthly, set_ratings_visibility.
  const promoted = await groupsCall(status, users.owner, 'set_role', {
    group_id: hg,
    profile_id: users.player.id,
    role: 'organizer',
  });
  assert.equal(promoted.status, 200, promoted.text);
  assert.deepEqual(promoted.body.data.current, { role: 'organizer' });
  assertEdgeError(
    await groupsCall(status, users.organizer, 'set_role', {
      group_id: hg,
      profile_id: users.pending.id,
      role: 'organizer',
    }),
    403,
    'OWNER_ONLY',
    'set_role by an organizer',
  );
  assertEdgeError(
    await groupsCall(status, users.owner, 'set_role', {
      group_id: hg,
      profile_id: users.outsider.id,
      role: 'organizer',
    }),
    409,
    'NOT_ACTIVE_MEMBER',
    'M2-D17 over HTTP',
  );
  const monthly = await groupsCall(status, users.organizer, 'set_monthly', {
    group_id: hg,
    profile_id: users.pending.id,
    enabled: true,
  });
  assert.equal(monthly.status, 200, monthly.text);
  assert.deepEqual(monthly.body.data.current, { enabled: true });
  assertEdgeError(
    await groupsCall(status, users.owner, 'set_ratings_visibility', {
      group_id: hg,
      visibility: 'members',
      confirm_members_visibility: false,
    }),
    422,
    'VISIBILITY_CONFIRMATION_REQUIRED',
    'visibility without confirmation',
  );
  const visibility = await groupsCall(status, users.owner, 'set_ratings_visibility', {
    group_id: hg,
    visibility: 'members',
    confirm_members_visibility: true,
  });
  assert.equal(visibility.status, 200, visibility.text);
  assert.deepEqual(visibility.body.data.current, { visibility: 'members' });
  console.log(
    'ok - set_role, set_monthly and set_ratings_visibility over HTTP with their contract errors',
  );

  // remove_member e a negação ao removido na chamada seguinte.
  assert.deepEqual(await restGroups(status, users.target), [hg], 'RLS control before removal');
  assertEdgeError(
    await groupsCall(status, users.organizer, 'remove_member', {
      group_id: hg,
      profile_id: users.target.id,
      reason: '   ',
    }),
    422,
    'VALIDATION',
    'M2-D18: blank reason',
  );
  const removed = await groupsCall(status, users.organizer, 'remove_member', {
    group_id: hg,
    profile_id: users.target.id,
    reason: 'motivo do teste HTTP',
  });
  assert.equal(removed.status, 200, removed.text);
  assert.deepEqual(removed.body.data.current, { ok: true, refunds: [], invalidated_matches: [] });
  assert.deepEqual(await restGroups(status, users.target), [], 'RLS denies the removed member');
  assertEdgeError(
    await groupsCall(status, users.target, 'leave_group', { group_id: hg }),
    403,
    'NOT_MEMBER',
    'the removed member has no authority on the next call',
  );
  assertEdgeError(
    await groupsCall(status, users.organizer, 'remove_member', {
      group_id: hg,
      profile_id: users.owner.id,
      reason: 'motivo',
    }),
    409,
    'IS_OWNER',
    'the owner is never removed',
  );
  console.log('ok - remove_member over HTTP; RLS and RPC deny the removed member on the next call');

  // transfer_ownership e leave_group.
  const transferred = await groupsCall(status, users.owner, 'transfer_ownership', {
    group_id: hg,
    new_owner_id: users.organizer.id,
  });
  assert.equal(transferred.status, 200, transferred.text);
  assert.deepEqual(transferred.body.data.current, { owner_id: users.organizer.id });
  assertEdgeError(
    await groupsCall(status, users.organizer, 'leave_group', { group_id: hg }),
    409,
    'OWNER_MUST_TRANSFER',
    'the new owner must transfer before leaving',
  );
  const left = await groupsCall(status, users.owner, 'leave_group', { group_id: hg });
  assert.equal(left.status, 200, left.text);
  assert.deepEqual(left.body.data, {
    outcome: { group_id: hg, logical_result: 'group_left' },
    current: { ok: true, refunds: [], invalidated_matches: [] },
  });
  const suspendedLeave = await groupsCall(status, users.player, 'leave_group', { group_id: hs });
  assert.equal(
    suspendedLeave.status,
    200,
    `a non-owner leaves a suspended group: ${suspendedLeave.text}`,
  );
  assert.deepEqual(await invalidOwnerGroups(admin, [hg, hs]), []);
  console.log(
    'ok - transfer_ownership and leave_group over HTTP, including leaving a suspended group',
  );
}

// O job de retenção pelo worker Edge real (docs/17 §4, docs/25 §4.1).
async function proveRetentionThroughWorker(status, admin) {
  const code = 0x1300;
  const [owner, expired, recent, pending, active] = await createActors(admin, code, 5);
  const groupId = idFor('b0', code, 1);
  const removedAt = new Map([
    [expired.id, new Date(Date.now() - 400 * 24 * 3600 * 1000)],
    [recent.id, new Date(Date.now() - 330 * 24 * 3600 * 1000)],
  ]);
  await createGroups(admin, [
    {
      id: groupId,
      owner,
      removedAt,
      members: [
        [owner, 'organizer', 'active'],
        [expired, 'player', 'removed'],
        [recent, 'player', 'removed'],
        [pending, 'player', 'pending'],
        [active, 'player', 'active'],
      ],
    },
  ]);
  const response = await fetch(`${status.functionsUrl}/worker/purge_removed_memberships`, {
    method: 'POST',
    headers: {
      apikey: status.publishableKey,
      Authorization: `Bearer ${localWorkerCronSecret()}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const text = await response.text();
  assert.equal(response.status, 200, `the worker returned ${response.status}: ${text}`);
  const { rows } = await admin.query(
    `select profile_id::text, status from public.group_members where group_id = $1 order by profile_id`,
    [groupId],
  );
  assert.deepEqual(
    rows,
    [
      { profile_id: owner.id, status: 'active' },
      { profile_id: recent.id, status: 'removed' },
      { profile_id: pending.id, status: 'pending' },
      { profile_id: active.id, status: 'active' },
    ],
    'only the membership removed more than 12 months ago leaves',
  );
  const run = await admin.query(
    `select status, summary from private.job_runs
      where job_name = 'purge_removed_memberships' order by id desc limit 1`,
  );
  assert.equal(run.rows[0]?.status, 'succeeded', `job run ${JSON.stringify(run.rows[0])}`);
  assert.ok(run.rows[0].summary.changed >= 1, JSON.stringify(run.rows[0].summary));
  console.log(
    'ok - purge_removed_memberships through the real worker Edge: expired removed out, recent removed, pending and active kept',
  );
}

// ---------------------------------------------------------------------------
// M2-D18: censo do motivo por valor
// ---------------------------------------------------------------------------

// docker logs escreve o stderr do contêiner no stderr do comando; os dois
// fluxos são lidos juntos.
function dockerLogs(container, since) {
  return execFileSync('sh', ['-c', 'docker logs --since "$1" "$2" 2>&1', 'sh', since, container], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

async function markerInTables(client, marker) {
  const { rows: tables } = await client.query(
    `select format('%I.%I', n.nspname, c.relname) as relation
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'm')
        and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
        and n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast_temp%'
      order by 1`,
  );
  const hits = [];
  for (const { relation } of tables) {
    const { rows } = await client.query(
      `select count(*)::integer as count from ${relation} as t where t::text like $1`,
      [`%${marker}%`],
    );
    if (rows[0].count > 0) hits.push([relation, rows[0].count]);
  }
  return { scanned: tables.length, hits };
}

async function proveReasonCensus(status, admin, client) {
  const code = 0x1400;
  const since = new Date(Date.now() - 2_000).toISOString();
  const marker = `m2d18-${crypto.randomUUID()}`;
  const users = await createRealUsers(status, admin, code, ['owner', 'organizer', 'target']);
  const groupId = idFor('b0', code, 1);
  await createGroups(admin, [
    {
      id: groupId,
      owner: users.owner,
      members: [
        [users.owner, 'organizer', 'active'],
        [users.organizer, 'organizer', 'active'],
        [users.target, 'player', 'active'],
      ],
    },
  ]);
  const bodies = [];
  const removed = await groupsCall(status, users.organizer, 'remove_member', {
    group_id: groupId,
    profile_id: users.target.id,
    reason: `  Motivo ${marker} privado  `,
  });
  assert.equal(removed.status, 200, removed.text);
  bodies.push(removed.text);
  // Recusa no banco (IS_OWNER), com o motivo que passou pela Edge: o erro do
  // PostgreSQL, o log dele e a resposta do PostgREST não podem carregar o valor.
  const refused = await groupsCall(status, users.organizer, 'remove_member', {
    group_id: groupId,
    profile_id: users.owner.id,
    reason: `Motivo ${marker} recusado`,
  });
  assertEdgeError(refused, 409, 'IS_OWNER', 'M2-D18 refusal in the database');
  bodies.push(refused.text);
  // Recusa na Edge (mais de 500 caracteres).
  const tooLong = await groupsCall(status, users.organizer, 'remove_member', {
    group_id: groupId,
    profile_id: users.target.id,
    reason: `${marker}${'x'.repeat(500)}`,
  });
  assertEdgeError(tooLong, 422, 'VALIDATION', 'M2-D18 refusal at the Edge');
  bodies.push(tooLong.text);
  // Recusa pela validação do banco, direto na RPC interna.
  let databaseError;
  try {
    await rpcTx(client, 'remove_member', users.organizer, [
      groupId,
      users.target.id,
      `${marker}${'y'.repeat(500)}`,
    ]);
  } catch (error) {
    databaseError = error;
  }
  assert.equal(databaseError?.message, 'VALIDATION', 'M2-D18 refusal by the database validation');
  bodies.push(JSON.stringify({ ...databaseError, message: databaseError.message }));

  // Sentinela: uma linha de log de erro do Postgres emitida depois de tudo. O
  // log só vale como evidência se ela aparece nele.
  const sentinel = `m2d18-sentinel-${crypto.randomUUID()}`;
  await assert.rejects(admin.query(`select 1 / 0 as "${sentinel}"`), /division by zero/);

  const tables = await markerInTables(admin, marker);
  const { rows: statements } = await admin.query(
    `select count(*)::integer as count from extensions.pg_stat_statements where query like $1`,
    [`%${marker}%`],
  );
  const logs = {};
  for (const service of ['db', 'rest', 'edge_runtime', 'kong', 'auth']) {
    const text = dockerLogs(`supabase_${service}_colete`, since);
    logs[service] = {
      marker: text.split(marker).length - 1,
      sentinel: text.split(sentinel).length - 1,
    };
  }
  assert.ok(
    logs.db.sentinel > 0,
    `the Postgres log did not capture the sentinel: ${JSON.stringify(logs)}`,
  );

  const inBodies = bodies.filter((body) => body.includes(marker)).length;
  console.log(
    `# M2-D18 census: tables scanned=${tables.scanned}, table hits=${JSON.stringify(tables.hits)}, pg_stat_statements hits=${statements[0].count}, response/error bodies with the marker=${inBodies} of ${bodies.length}, docker logs=${JSON.stringify(logs)}`,
  );
  assert.deepEqual(
    tables.hits,
    [],
    `M2-D18: the reason was persisted: ${JSON.stringify(tables.hits)}`,
  );
  assert.equal(statements[0].count, 0, 'M2-D18: the reason reached pg_stat_statements');
  assert.equal(inBodies, 0, 'M2-D18: the reason reached a response or an error');
  for (const [service, counts] of Object.entries(logs)) {
    assert.equal(counts.marker, 0, `M2-D18: the reason reached the ${service} log`);
  }
  assert.equal((await membership(admin, groupId, users.target.id)).status, 'removed');
  console.log(
    'ok - M2-D18: the reason is in no table, Postgres or service log, response or error; the sentinel proves the logs were read',
  );
}

// ---------------------------------------------------------------------------
// Setup e limpeza
// ---------------------------------------------------------------------------

// Tudo pelo prefixo exclusivo deste harness, em ordem de FK. Os usuários Auth
// saem depois, pela marca, na varredura do guard.
async function cleanupDatabase(client, baselines) {
  await client.query('begin');
  try {
    await client.query(
      `delete from private.external_effects
        where resource_id in (select id from private.deletion_requests
                               where profile_id::text like $1)`,
      [`${PROFILE_PREFIX}%`],
    );
    await client.query('delete from private.idempotency_records where actor_id::text like $1', [
      `${PROFILE_PREFIX}%`,
    ]);
    await client.query('delete from private.revoked_auth_sessions where profile_id::text like $1', [
      `${PROFILE_PREFIX}%`,
    ]);
    await client.query('delete from private.deletion_requests where profile_id::text like $1', [
      `${PROFILE_PREFIX}%`,
    ]);
    await client.query(
      'delete from public.group_members where group_id::text like $1 or profile_id::text like $2',
      [`${GROUP_PREFIX}%`, `${PROFILE_PREFIX}%`],
    );
    await client.query('delete from public.groups where id::text like $1', [`${GROUP_PREFIX}%`]);
    await client.query('delete from public.profiles where id::text like $1', [
      `${PROFILE_PREFIX}%`,
    ]);
    await client.query("delete from private.policy_documents where version='membership-auth-40d'");
    if (baselines.job !== undefined) {
      await client.query('delete from private.job_runs where id > $1', [baselines.job]);
    }
    if (baselines.retention !== undefined) {
      await client.query('delete from private.retention_runs where id > $1', [baselines.retention]);
    }
    await client.query('commit');
  } catch (error) {
    await rollbackAfter(client, error);
  }
}

async function tableCounts(client, schemas) {
  const tables = await client.query(
    `select table_schema, table_name
       from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema = any($1::text[])
      order by table_schema, table_name`,
    [schemas],
  );
  const counts = new Map();
  for (const { table_schema: schema, table_name: table } of tables.rows) {
    const identifier = [schema, table].map((part) => `"${part.replaceAll('"', '""')}"`).join('.');
    const result = await client.query(`select count(*)::integer as count from ${identifier}`);
    counts.set(`${schema}.${table}`, result.rows[0].count);
  }
  return counts;
}

async function assertNoResidue(client, tableBaseline) {
  const tableAfter = await tableCounts(client, ['public', 'private', 'auth', 'storage']);
  const changed = [...tableAfter].filter(([table, count]) => count !== tableBaseline.get(table));
  assert.ok(
    changed.every(([table]) => table === 'auth.audit_log_entries'),
    `an undeclared table changed across the harness: ${JSON.stringify(changed)}`,
  );
  const residue = await client.query(
    `select
       (select count(*)::integer from public.groups where id::text like $1) as groups,
       (select count(*)::integer from public.profiles where id::text like $2) as profiles,
       (select count(*)::integer from auth.users where email like $3) as marked_auth_users`,
    [`${GROUP_PREFIX}%`, `${PROFILE_PREFIX}%`, `${AUTH_EMAIL_PREFIX}%@colete.test`],
  );
  assert.deepEqual(residue.rows[0], { groups: 0, profiles: 0, marked_auth_users: 0 });
  const auditBefore = tableBaseline.get('auth.audit_log_entries') ?? 0;
  const auditAfter = tableAfter.get('auth.audit_log_entries') ?? 0;
  console.log(
    `ok - no residual row; accepted GoTrue auth.audit_log_entries residue: added=${auditAfter - auditBefore}`,
  );
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

const PROOFS = [
  ['canonical', 'the 0016 text is the canonical definition'],
  ['registry-edge', 'the 0033 operation registry matches the Edge lists'],
  ['registry-commit-real', 'the 0033 conclusion rule holds at a real COMMIT'],
  ['lock-modes', 'every 0016 lock clause follows M2-D13'],
  ['commit-real', 'real commits under service_role and concluded idempotency'],
  ...Object.keys(CROSS).map((name) => [name, 'M2-D13 cross pair, barrier and simultaneous']),
  ['cross-deletion-transfer', 'deletion × transfer in the cross form'],
  ['cross-deletion-transfer-inverse', 'deletion UUID greater, both orders'],
  ['replay-http', 'M2-D20: current authority over HTTP'],
  ['gateway-order-measured', 'post-pilot non-normative gateway precedence measurements'],
  ['replay-revoked-session-http', '40d: authentication before replay'],
  ['actor-scoped-request-http', '40d: actor-scoped idempotency over HTTP'],
  ['replay-authority', 'M2-D20: all seven RPCs'],
  ['replay-self-revoked-http', 'N2: leave and transfer replay over HTTP'],
  ['self-transfer', 'M2-D19: no UPDATE when transferring to self'],
  ['suspended-role-remove', 'GROUP_SUSPENDED in set_role and remove_member'],
  ...Object.keys(SAME).map((name) => [name, 'M2-D14 same-actor pair, barrier and simultaneous']),
  ['quota-pair', 'fifth and sixth membership of the same profile'],
  ['quota-racers', 'fifth membership under 25 connections'],
  ['owner-race', 'transfer × leave in both orders'],
  ['deletion-pairs', 'deletion × transfer and owner × chosen organizer deletion'],
  ['http', 'every route through the groups Edge with a GoTrue JWT'],
  ['retention-worker', 'purge_removed_memberships through the real worker Edge'],
  ['reason-census', 'M2-D18 census of the removal reason'],
];

async function main() {
  if (selectedProof !== undefined && !PROOFS.some(([name]) => name === selectedProof)) {
    throw new Error(`Unknown COLETE_MEMBERSHIP_PROOF ${selectedProof}`);
  }
  const status = localStatus();
  const connectionString = status.databaseUrl;
  const admin = newClient(connectionString, 'admin');
  const observer = newClient(connectionString, 'observer');
  const holder = newClient(connectionString, 'holder');
  const first = newClient(connectionString, 'first');
  const second = newClient(connectionString, 'second');
  const racers = Array.from({ length: RACERS }, (_, index) =>
    newClient(connectionString, `racer_${index + 1}`),
  );
  const all = [admin, observer, holder, first, second, ...racers];
  const baselines = {};
  let tableBaseline;
  guard.useDatabase(connectionString);
  guard.onCleanup((client) => cleanupDatabase(client, baselines));
  guard.onCensus(async (client) => {
    if (tableBaseline === undefined) {
      console.error('# db:test:membership: no baseline was taken; residue census skipped');
      return;
    }
    await assertNoResidue(client, tableBaseline);
  });
  let failure;
  try {
    await Promise.all(all.map((client) => client.connect()));
    const pids = await Promise.all(all.map(backendPid));
    assert.equal(new Set(pids).size, pids.length, 'the harness did not open independent backends');
    console.log(
      `ok - ${pids.length} dedicated connections with distinct PIDs and application_name`,
    );

    // Varredura inicial: o que uma execução interrompida deixou.
    await cleanupDatabase(admin, baselines);
    await sweepMarkedAuthUsers(admin, AUTH_EMAIL_PREFIX);
    baselines.job = Number(
      (await admin.query('select coalesce(max(id), 0)::text as id from private.job_runs')).rows[0]
        .id,
    );
    baselines.retention = Number(
      (await admin.query('select coalesce(max(id), 0)::text as id from private.retention_runs'))
        .rows[0].id,
    );
    tableBaseline = await tableCounts(admin, ['public', 'private', 'auth', 'storage']);

    const connections = { observer, holder, first, second };
    const run = (name) => selectedProof === undefined || selectedProof === name;
    if (run('canonical')) await proveCanonicalText(admin);
    if (run('registry-edge')) await proveRegistryMatchesEdge(admin);
    if (run('registry-commit-real')) await proveRegistryCommitReal(admin);
    if (run('lock-modes')) await proveLockModes(admin);
    if (run('commit-real')) await proveCommitReal(admin, first);
    for (const name of Object.keys(CROSS)) {
      if (run(name)) await proveCrossPair(name, connections, admin);
    }
    if (run('cross-deletion-transfer')) await proveCrossDeletionTransfer(connections, admin);
    if (run('cross-deletion-transfer-inverse')) {
      await proveCrossDeletionTransfer(connections, admin, true);
    }
    if (run('replay-authority')) await proveReplayAuthority(admin, first);
    if (run('replay-http')) await proveReplayHttp(status, admin);
    if (run('gateway-order-measured')) await measureGatewayOrder(status, admin);
    if (run('replay-revoked-session-http')) await proveRevokedSessionReplayHttp(status, admin);
    if (run('actor-scoped-request-http')) await proveActorScopedRequestHttp(status, admin);
    if (run('replay-self-revoked-http')) await proveSelfRevokedReplayHttp(status, admin);
    if (run('self-transfer')) await proveSelfTransfer(admin, first);
    if (run('suspended-role-remove')) await proveSuspendedRoleRemove(status, admin);
    for (const name of Object.keys(SAME)) {
      if (run(name)) await proveSameActorPair(name, connections, admin);
    }
    if (run('quota-pair')) await proveQuotaPair(connections, admin);
    if (run('quota-racers')) await proveQuotaRacers(connections, admin, racers);
    if (run('owner-race')) await proveOwnerRace(connections, admin);
    if (run('deletion-pairs')) await proveDeletionPairs(connections, admin);
    if (run('http')) await proveHttp(status, admin);
    if (run('retention-worker')) await proveRetentionThroughWorker(status, admin);
    if (run('reason-census')) await proveReasonCensus(status, admin, first);
  } catch (error) {
    failure = error;
  }
  // Uma falha ao fechar as conexões não substitui a causa: as duas sobem
  // juntas, a causa primeiro.
  const closed = await Promise.allSettled(all.map((client) => client.end()));
  const closing = closed
    .filter((entry) => entry.status === 'rejected')
    .map((entry) => entry.reason);
  if (closing.length > 0) {
    throw new AggregateError(
      failure === undefined ? closing : [failure, ...closing],
      'closing the harness connections failed',
    );
  }
  if (failure !== undefined) throw failure;
}

if (await guard.run(main)) {
  console.log(
    selectedProof === undefined
      ? 'Group membership harness passed.'
      : `Group membership proof ${selectedProof} passed.`,
  );
}
