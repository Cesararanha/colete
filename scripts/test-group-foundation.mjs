// Harness da fatia 1 do M2 (docs/25 §3.5). Prova com commit real, conexões
// dedicadas e o Storage local o que o rollback do pgTAP esconderia:
//
// - a 0015 é a fonte textual canônica das funções que redefine;
// - o trigger diferido de owner recusa no commit, inclusive quando a mudança
//   toca somente group_members;
// - a saga de exclusão transfere (M2-D8, M2-D10), bloqueia, arquiva (M2-D9) e
//   libera as vagas das memberships não-donas, medido depois do commit;
// - delete_account trava os grupos antes das memberships e do guard, o guard
//   volatile trava o grupo quando chamado diretamente, e os pares
//   concorrentes, incluindo a candidatura mútua, não produzem 40P01 nas duas
//   ordens pela barreira de docs/25 §2 nem em disparo simultâneo;
// - a foto de grupo pendente impede o Auth, e crash e retry do
//   delete_storage_object de group_photo convergem pelo Storage real;
// - duas exclusões do mesmo titular com request_id diferentes (duas abas) não
//   produzem 40P01: uma cria a saga e a outra recebe DELETION_ALREADY_PENDING.
//
// COLETE_GROUP_PROOF=<nome> executa uma única prova; é assim que as
// contraprovas rodam contra uma implementação mutada.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  outcomeOf as barrierOutcome,
  sameActorPair,
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
const PASSWORD = 'colete-local-group-foundation-password';
const PHOTO_BUCKET = 'group-photos';
const selectedProof = process.env.COLETE_GROUP_PROOF;
// Marca dos usuários Auth deste harness (scripts/harness-guard.mjs).
const AUTH_EMAIL_PREFIX = 'group-foundation-';
const APPLICATION_PREFIX = 'colete_groups_';

// Toda falha, inclusive a rejeição sem tratador, reprova com a causa, para o
// trabalho novo, espera o que está em voo e só então limpa
// (scripts/harness-guard.mjs). Toda conexão leva o APPLICATION_PREFIX.
const guard = installHarnessGuard('db:test:groups', {
  applicationPrefix: APPLICATION_PREFIX,
  authEmailPrefix: AUTH_EMAIL_PREFIX,
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const hex4 = (value) => value.toString(16).padStart(4, '0');
const uuidFor = (prefix, index) => `${prefix}${hex4(index)}-0000-4000-8000-000000000000`;

// A ordem de bytes só importa nas duas fixtures da M2-D8. Nas demais, os IDs
// seguem a posição na lista.
// Pares de candidatura mútua disparados ao mesmo tempo, sem barreira.
const STORM_PAIRS = Array.from({ length: 20 }, (_, index) => `storm${index + 1}`);
const MUTUAL_PAIRS = ['mut1', 'mut2', ...STORM_PAIRS];
// Mesmo titular em duas abas: dois titulares para a barreira, um por ordem, e
// vinte para os disparos simultâneos. Nenhum tem grupo.
const SAME_TITULAR_ORDERS = ['same1', 'same2'];
const SAME_TITULAR_STORM = Array.from({ length: 20 }, (_, index) => `samestorm${index + 1}`);

const PROFILES = [
  'trig_owner',
  'trig_member',
  'd8_owner',
  'd8_new',
  'd8_old',
  'tie_owner',
  'tie_big',
  'tie_small',
  'susp_owner',
  'susp_org',
  'block_owner',
  'block_player',
  'solo_owner',
  'solo_pending',
  'titular',
  'other_owner_1',
  'other_member_1',
  'other_owner_2',
  'guard_owner_ab',
  'guard_owner_ba',
  'pair1_owner',
  'pair1_org',
  'pair2_owner',
  'pair2_org',
  'export_titular_ab',
  'export_titular_ba',
  'photo_owner',
  'photo_owner_worker',
  'guard_direct_owner',
  'guard_direct_player',
  // Candidatura mútua: cada titular é organizador ativo no grupo do outro. O
  // nome termina em low ou high pela ordem de bytes do perfil, que segue a
  // posição nesta lista.
  'mut1_low',
  'mut1_high',
  'mut2_low',
  'mut2_high',
  ...STORM_PAIRS.flatMap((pair) => [`${pair}_low`, `${pair}_high`]),
  ...SAME_TITULAR_ORDERS,
  ...SAME_TITULAR_STORM,
];
const EXPLICIT_PROFILE_IDS = {
  // Organizador de joined_at mais antigo, inserido por último e de maior ID.
  d8_old: '15a1ffff-0000-4000-8000-000000000000',
  // Organizador mais novo, inserido primeiro e de menor ID.
  d8_new: '15a10000-0000-4000-8000-000000000000',
  // Empate de joined_at: o maior ID é inserido primeiro.
  tie_big: '15a2ffff-0000-4000-8000-000000000000',
  tie_small: '15a20000-0000-4000-8000-000000000000',
};
const profile = Object.fromEntries(
  PROFILES.map((name, index) => [name, EXPLICIT_PROFILE_IDS[name] ?? uuidFor('15a0', index + 1)]),
);
const profileIds = Object.values(profile);
const authId = {};
const authEmail = {};
const sessionId = Object.fromEntries(PROFILES.map((name, i) => [name, uuidFor('15c0', i + 1)]));
const requestId = Object.fromEntries(PROFILES.map((name, i) => [name, uuidFor('15d0', i + 1)]));
// Segundo request_id do mesmo titular: a outra aba.
const secondRequestId = Object.fromEntries(
  PROFILES.map((name, i) => [name, uuidFor('15d1', i + 1)]),
);
const hmacFor = (name) => (PROFILES.indexOf(name) + 1).toString(16).padStart(2, '0').repeat(32);

const GROUPS = [
  'trig_1',
  'trig_2',
  'trig_3',
  'trig_4',
  'trig_ok',
  'd8',
  'tie',
  'susp',
  'block',
  'solo',
  'other_1',
  'other_2',
  'guard_ab',
  'guard_ba',
  'pair1',
  'pair2',
  'export_ab',
  'export_ba',
  'photo',
  'photo_worker',
  'guard_direct',
  // Cada titular de candidatura mútua é dono do grupo de mesmo nome.
  ...MUTUAL_PAIRS.flatMap((pair) => [`${pair}_low`, `${pair}_high`]),
];
const group = Object.fromEntries(GROUPS.map((name, index) => [name, uuidFor('15b0', index + 1)]));
const groupIds = Object.values(group);
const exportFixture = {
  export_titular_ab: {
    privacy: uuidFor('15e0', 1),
    export: uuidFor('15f0', 1),
    effect: uuidFor('15f1', 1),
    lease: uuidFor('15f2', 1),
  },
  export_titular_ba: {
    privacy: uuidFor('15e0', 2),
    export: uuidFor('15f0', 2),
    effect: uuidFor('15f1', 2),
    lease: uuidFor('15f2', 2),
  },
};
const photoPath = {
  photo: `groups/${group.photo}/photo.webp`,
  photo_worker: `groups/${group.photo_worker}/photo.webp`,
  // Grupo que a exclusão transfere: a foto é do grupo e precisa ficar.
  susp: `groups/${group.susp}/photo.webp`,
};

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
    serviceRoleKey: read('SERVICE_ROLE_KEY'),
  };
}

function newClient(connectionString, name) {
  return new Client({
    application_name: `${APPLICATION_PREFIX}${name}`,
    connectionString,
    connectionTimeoutMillis: 5_000,
  });
}

async function storageRequest(status, method, objectPath, body, headers = {}) {
  return fetch(`${status.apiUrl}/storage/v1/object/${objectPath}`, {
    method,
    headers: {
      apikey: status.serviceRoleKey,
      Authorization: `Bearer ${status.serviceRoleKey}`,
      ...headers,
    },
    body,
  });
}

async function uploadPhoto(status, objectPath) {
  const response = await storageRequest(
    status,
    'POST',
    `${PHOTO_BUCKET}/${objectPath}`,
    new TextEncoder().encode('local-group-photo-fixture'),
    { 'content-type': 'image/webp', 'x-upsert': 'false' },
  );
  assert.equal(response.status, 200, `group photo upload returned ${response.status}`);
}

async function photoExists(status, objectPath) {
  const response = await storageRequest(status, 'HEAD', `${PHOTO_BUCKET}/${objectPath}`);
  return response.status === 200;
}

async function removePhoto(status, objectPath) {
  const response = await storageRequest(
    status,
    'DELETE',
    PHOTO_BUCKET,
    JSON.stringify({ prefixes: [objectPath] }),
    { 'content-type': 'application/json' },
  );
  assert.ok(response.ok || response.status === 404, `photo delete returned ${response.status}`);
}

async function invokeWorker(admin, status) {
  // O slot deste minuto pode ter sido consumido por outro harness. A linha é
  // estado de teste e sai para que esta invocação seja independente.
  await admin.query(
    `delete from private.job_runs
     where job_name='process_external_effects'
       and scheduled_for=date_trunc('minute', clock_timestamp())`,
  );
  const response = await fetch(`${status.functionsUrl}/worker/process_external_effects`, {
    method: 'POST',
    headers: {
      apikey: status.publishableKey,
      Authorization: `Bearer ${localWorkerCronSecret()}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(response.status, 200, `the worker returned ${response.status}`);
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

// ---------------------------------------------------------------------------
// Barreira de concorrência (docs/25 §2)
// ---------------------------------------------------------------------------

// track, describeResult e a espera vêm de scripts/lock-barrier.mjs: o tratador
// é anexado na mesma instrução síncrona que cria a promessa, e a espera é um
// laço com prazo que só vale se for de Lock com o detentor esperado em
// pg_blocking_pids do competidor.
function awaitLockWait(observer, competitor, competitorPid, blockerPid, label) {
  return awaitBarrierWait(
    observer,
    competitor,
    competitorPid,
    blockerPid,
    label,
    APPLICATION_PREFIX,
  );
}

function assertNoDeadlock(results, label) {
  for (const result of results) {
    assert.notEqual(
      result.status === 'rejected' ? result.reason?.code : undefined,
      '40P01',
      `${label}: the barrier observed a deadlock (SQLSTATE 40P01): ${result.reason?.message}`,
    );
  }
}

function assertDomainRejection(result, code, label) {
  assert.equal(
    result.status,
    'rejected',
    `${label}: expected ${code}, got ${describeResult(result)}`,
  );
  assert.equal(result.reason?.code, 'P0001', `${label}: ${describeResult(result)}`);
  assert.equal(result.reason?.message, code, `${label}: ${describeResult(result)}`);
}

function assertFulfilled(result, label) {
  assert.equal(result.status, 'fulfilled', `${label}: ${describeResult(result)}`);
  return result.value;
}

// ---------------------------------------------------------------------------
// Operações
// ---------------------------------------------------------------------------

// RPC interna sob service_role, em conexão dedicada, com commit real.
async function deleteAccountTx(client, name, request = requestId[name]) {
  await client.query('begin isolation level read committed');
  try {
    await client.query('set local role service_role');
    const result = await client.query(
      'select public.delete_account($1, $2, $3, $4, 1, 1) as response',
      [authId[name], sessionId[name], request, hmacFor(name)],
    );
    await client.query('commit');
    return result.rows[0].response;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

async function buildTargetTx(client, fixture) {
  await client.query('begin isolation level read committed');
  try {
    await client.query('set local role service_role');
    const result = await client.query(
      'select public.worker_get_data_export_build_target($1, $2) as target',
      [fixture.effect, fixture.lease],
    );
    await client.query('commit');
    return result.rows[0].target;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

async function openCount(admin, groupId) {
  return (
    await admin.query(
      `select count(*)::integer as count from public.group_members
       where group_id = $1 and status in ('pending', 'active')`,
      [groupId],
    )
  ).rows[0].count;
}

async function groupState(admin, groupId) {
  return (
    await admin.query(
      `select owner_id::text, archived_at is not null as archived, suspended_at
         from public.groups where id = $1`,
      [groupId],
    )
  ).rows[0];
}

async function membershipRows(admin, groupId) {
  return (
    await admin.query(
      `select profile_id::text, role, status, removed_at is not null as has_removed_at,
              removal_count
         from public.group_members where group_id = $1 order by profile_id`,
      [groupId],
    )
  ).rows;
}

async function requestIdOf(admin, name) {
  return (
    await admin.query('select id from private.deletion_requests where profile_id = $1', [
      profile[name],
    ])
  ).rows[0]?.id;
}

// ---------------------------------------------------------------------------
// Setup e limpeza
// ---------------------------------------------------------------------------

async function createAuthUsers(status) {
  const stamp = Date.now();
  // Lotes pequenos: o GoTrue local recusa rajadas grandes. Cada ID entra em
  // authId assim que o usuário existe, e o lote inteiro assenta antes de uma
  // falha subir, para que nenhuma criação continue em voo durante a limpeza.
  // A varredura pela marca alcança também o que uma execução interrompida
  // deixou.
  const batchSize = 8;
  for (let start = 0; start < PROFILES.length; start += batchSize) {
    const batch = await Promise.allSettled(
      PROFILES.slice(start, start + batchSize).map(async (name) => {
        const email = harnessEmail(AUTH_EMAIL_PREFIX, `${stamp}-${name.replaceAll('_', '-')}`);
        const response = await fetch(`${status.apiUrl}/auth/v1/admin/users`, {
          method: 'POST',
          headers: {
            apikey: status.secretKey,
            Authorization: `Bearer ${status.secretKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
        });
        const body = await response.text();
        assert.equal(response.status, 200, `admin create user ${name} failed: ${body}`);
        authId[name] = JSON.parse(body).id;
        authEmail[name] = email;
      }),
    );
    const failure = batch.find((entry) => entry.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

async function insertFixture(admin) {
  await admin.query(
    `insert into public.profiles (id, auth_user_id, name, account_status)
     select id, auth_id, 'Group foundation ' || name, 'active'
     from unnest($1::uuid[], $2::uuid[], $3::text[]) as fixture(id, auth_id, name)`,
    [PROFILES.map((name) => profile[name]), PROFILES.map((name) => authId[name]), PROFILES],
  );

  // Grupos e memberships nascem por fixture, como postgres, numa transação por
  // grafo: o trigger de owner julga cada commit.
  const graph = async (groupName, name, ownerName, members, extra = {}) => {
    await admin.query('begin');
    try {
      await admin.query(
        `insert into public.groups (id, name, owner_id, suspended_at, photo_url)
         values ($1, $2, $3, $4, $5)`,
        [
          group[groupName],
          name,
          profile[ownerName],
          extra.suspendedAt ?? null,
          extra.photo ?? null,
        ],
      );
      for (const member of members) {
        await admin.query(
          `insert into public.group_members
             (group_id, profile_id, role, status, joined_at, removal_count)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            group[groupName],
            profile[member.name],
            member.role ?? 'player',
            member.status ?? 'active',
            member.joinedAt ?? '2026-03-01T00:00:00Z',
            member.removalCount ?? 0,
          ],
        );
      }
      await admin.query('commit');
    } catch (error) {
      await admin.query('rollback').catch(() => {});
      throw error;
    }
  };
  const owner = (name) => ({ name, role: 'organizer', joinedAt: '2026-01-01T00:00:00Z' });

  for (const name of ['trig_1', 'trig_2', 'trig_3', 'trig_4', 'trig_ok']) {
    await graph(name, `Trigger ${name}`, 'trig_owner', [
      owner('trig_owner'),
      { name: 'trig_member' },
    ]);
  }
  // M2-D8: o mais antigo foi inserido por último e tem o maior profile_id.
  await graph('d8', 'M2-D8 antiguidade', 'd8_owner', [
    owner('d8_owner'),
    { name: 'd8_new', role: 'organizer', joinedAt: '2026-05-01T00:00:00Z' },
    { name: 'd8_old', role: 'organizer', joinedAt: '2026-02-01T00:00:00Z' },
  ]);
  // M2-D8, empate: inserção na ordem inversa dos bytes.
  await graph('tie', 'M2-D8 empate', 'tie_owner', [
    owner('tie_owner'),
    { name: 'tie_big', role: 'organizer', joinedAt: '2026-04-01T00:00:00Z' },
    { name: 'tie_small', role: 'organizer', joinedAt: '2026-04-01T00:00:00Z' },
  ]);
  await graph(
    'susp',
    'Suspenso',
    'susp_owner',
    [owner('susp_owner'), { name: 'susp_org', role: 'organizer' }],
    { suspendedAt: '2026-09-01T12:34:56.789012Z', photo: photoPath.susp },
  );
  await graph('block', 'Sem substituto', 'block_owner', [
    owner('block_owner'),
    { name: 'block_player' },
  ]);
  await graph('solo', 'Solo com pendente', 'solo_owner', [
    owner('solo_owner'),
    { name: 'solo_pending', status: 'pending', removalCount: 2 },
  ]);
  await graph('other_1', 'Titular membro ativo', 'other_owner_1', [
    owner('other_owner_1'),
    { name: 'titular' },
    { name: 'other_member_1', status: 'pending' },
  ]);
  await graph('other_2', 'Titular pendente', 'other_owner_2', [
    owner('other_owner_2'),
    { name: 'titular', status: 'pending' },
  ]);
  await graph('guard_ab', 'Guard A→B', 'guard_owner_ab', [owner('guard_owner_ab')]);
  await graph('guard_ba', 'Guard B→A', 'guard_owner_ba', [owner('guard_owner_ba')]);
  await graph('pair1', 'Par 1', 'pair1_owner', [
    owner('pair1_owner'),
    { name: 'pair1_org', role: 'organizer' },
  ]);
  await graph('pair2', 'Par 2', 'pair2_owner', [
    owner('pair2_owner'),
    { name: 'pair2_org', role: 'organizer' },
  ]);
  await graph('export_ab', 'Export A→B', 'export_titular_ab', [owner('export_titular_ab')]);
  await graph('export_ba', 'Export B→A', 'export_titular_ba', [owner('export_titular_ba')]);
  await graph('photo', 'Foto', 'photo_owner', [owner('photo_owner')], {
    photo: photoPath.photo,
  });
  await graph(
    'photo_worker',
    'Foto pelo worker',
    'photo_owner_worker',
    [owner('photo_owner_worker')],
    { photo: photoPath.photo_worker },
  );
  // Caso 3 para a chamada direta do guard: dono e um jogador ativo.
  await graph('guard_direct', 'Guard direto', 'guard_direct_owner', [
    owner('guard_direct_owner'),
    { name: 'guard_direct_player' },
  ]);
  for (const pair of MUTUAL_PAIRS) {
    await graph(`${pair}_low`, `Mútuo ${pair} low`, `${pair}_low`, [
      owner(`${pair}_low`),
      { name: `${pair}_high`, role: 'organizer' },
    ]);
    await graph(`${pair}_high`, `Mútuo ${pair} high`, `${pair}_high`, [
      owner(`${pair}_high`),
      { name: `${pair}_low`, role: 'organizer' },
    ]);
  }

  for (const [name, fixture] of Object.entries(exportFixture)) {
    await admin.query(
      `insert into public.privacy_requests (id, profile_id, kind) values ($1, $2, 'access')`,
      [fixture.privacy, profile[name]],
    );
    await admin.query(
      `insert into private.data_exports (id, privacy_request_id, profile_id) values ($1, $2, $3)`,
      [fixture.export, fixture.privacy, profile[name]],
    );
    await admin.query(
      `insert into private.external_effects
         (id, kind, resource_type, resource_id, dedupe_key, status, attempts, lease_token, lease_until)
       values ($1, 'build_data_export', 'data_export', $2::uuid, 'build_data_export:' || $2::uuid::text,
               'leased', 1, $3, clock_timestamp() + interval '1 hour')`,
      [fixture.effect, fixture.export, fixture.lease],
    );
  }
}

// A limpeza final só roda depois de o trabalho em voo assentar
// (scripts/harness-guard.mjs), então nenhuma exclusão concorrente commita no
// meio dela. Os usuários Auth saem pela marca do harness, mesmo quando a
// transação do banco falha, e nunca um usuário sem a marca.
async function cleanup(admin, status) {
  await admin.query('rollback').catch(() => {});
  try {
    await cleanupDatabase(admin);
  } finally {
    await sweepMarkedAuthUsers(admin, AUTH_EMAIL_PREFIX);
  }
  for (const objectPath of Object.values(photoPath)) {
    await removePhoto(status, objectPath);
  }
}

async function cleanupDatabase(admin) {
  await admin.query('begin');
  try {
    await admin.query(
      `delete from private.external_effects
       where resource_id = any($1::uuid[]) or resource_id = any($2::uuid[])
          or resource_id = any($3::uuid[])
          or resource_id in (select id from private.deletion_requests
                             where profile_id = any($1::uuid[]))`,
      [profileIds, groupIds, Object.values(exportFixture).map((fixture) => fixture.export)],
    );
    await admin.query('delete from private.idempotency_records where actor_id = any($1::uuid[])', [
      profileIds,
    ]);
    await admin.query(
      'delete from private.revoked_auth_sessions where profile_id = any($1::uuid[])',
      [profileIds],
    );
    await admin.query('delete from private.deletion_requests where profile_id = any($1::uuid[])', [
      profileIds,
    ]);
    await admin.query('delete from private.data_exports where profile_id = any($1::uuid[])', [
      profileIds,
    ]);
    await admin.query('delete from public.privacy_requests where profile_id = any($1::uuid[])', [
      profileIds,
    ]);
    // Uma transação só: o trigger de owner julga o estado final, sem grupos.
    await admin.query('delete from public.group_invites where group_id = any($1::uuid[])', [
      groupIds,
    ]);
    await admin.query('delete from public.group_members where group_id = any($1::uuid[])', [
      groupIds,
    ]);
    await admin.query('delete from public.groups where id = any($1::uuid[])', [groupIds]);
    await admin.query('delete from public.profiles where id = any($1::uuid[])', [profileIds]);
    await admin.query('commit');
  } catch (error) {
    await admin.query('rollback').catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Prova 1: a 0015 é a fonte textual canônica
// ---------------------------------------------------------------------------

// Extrai, de um arquivo de migration, a última definição textual de cada
// função: atributos do cabeçalho e o corpo exato entre os $function$.
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

// O comparador normaliza os dois lados para (atributos, corpo). O corpo de
// pg_get_functiondef é o texto entre os $function$; ele precisa ser idêntico,
// byte a byte, ao da migration.
function compareDefinition(expected, live) {
  const differences = [];
  const liveBody = live.definition.split('$function$')[1];
  if (liveBody !== expected.body) differences.push('body');
  if (live.prosrc !== expected.body) differences.push('prosrc');
  if (live.provolatile !== expected.volatility) differences.push('volatility');
  if (live.prosecdef !== expected.securityDefiner) differences.push('security definer');
  if (live.lanname !== expected.language) differences.push('language');
  if (expected.searchPathEmpty !== live.proconfig.includes('search_path=""')) {
    differences.push('search_path');
  }
  return differences;
}

async function proveCanonicalText(admin) {
  const defined = migrationFunctions('0015_group_foundation.sql');
  // Lista fechada: uma função nova ou esquecida na 0015 muda esta asserção.
  assert.deepEqual(
    [...defined.keys()].sort(),
    [
      'private.can_read_group_invites',
      'private.current_group_profile_id',
      'private.deletion_has_pending_storage',
      'private.enforce_group_owner_membership',
      'private.group_deletion_candidates',
      'private.group_photo_deletion_request',
      'private.is_active_group_member',
      'private.require_financial_deletion_substitute',
      'private.sync_deletion_failure_from_effect',
      'public.delete_account',
      'public.request_data_export',
      'public.update_profile',
      'public.worker_confirm_deletion_effect',
      'public.worker_get_data_export_build_target',
      'public.worker_get_deletion_effect_target',
    ],
    'the extractor did not find exactly the functions defined by 0015',
  );
  for (const [qualifiedName, expected] of defined) {
    const differences = compareDefinition(expected, await liveFunction(admin, qualifiedName));
    assert.deepEqual(differences, [], `${qualifiedName} diverges from 0015: ${differences}`);
  }
  // Nenhuma migration posterior pode redefinir o que a 0015 fixou.
  const later = fs
    .readdirSync(migrationsDirectory)
    .filter((file) => file > '0015_group_foundation.sql' && file.endsWith('.sql'));
  for (const file of later) {
    for (const qualifiedName of migrationFunctions(file).keys()) {
      assert.ok(!defined.has(qualifiedName), `${file} redefines ${qualifiedName}`);
    }
  }
  console.log(
    `ok - ${defined.size} functions: pg_get_functiondef equals the 0015 text byte for byte`,
  );

  // Contraprovas do comparador: um byte a mais e o texto da 0012 são acusados.
  const deleteAccount = defined.get('public.delete_account');
  const liveDelete = await liveFunction(admin, 'public.delete_account');
  const mutated = { ...deleteAccount, body: deleteAccount.body.replace('begin', 'begin ') };
  assert.deepEqual(compareDefinition(mutated, liveDelete), ['body', 'prosrc']);
  const from0012 = migrationFunctions('0012_account_deletion.sql').get('public.delete_account');
  assert.ok(from0012.body.includes('public.data_exports'));
  assert.deepEqual(compareDefinition(from0012, liveDelete), ['body', 'prosrc']);
  console.log(
    'ok - the comparator flags a one-byte mutation and the stale 0012 delete_account text',
  );
}

// ---------------------------------------------------------------------------
// Prova 2: trigger diferido de owner em commit real
// ---------------------------------------------------------------------------

// Executa as instruções e devolve onde a transação falhou: 'statement',
// 'commit' ou null quando commitou.
async function commitOutcome(client, statements) {
  await client.query('begin');
  for (const [sql, values] of statements) {
    try {
      await client.query(sql, values);
    } catch (error) {
      await client.query('rollback');
      return { phase: 'statement', error };
    }
  }
  try {
    await client.query('commit');
    return { phase: null };
  } catch (error) {
    return { phase: 'commit', error };
  }
}

function assertCommitRejected(outcome, label) {
  assert.equal(outcome.phase, 'commit', `${label}: the owner invariant was not enforced at commit`);
  assert.equal(outcome.error.code, '23514', label);
  assert.equal(outcome.error.message, 'GROUP_OWNER_MEMBERSHIP_REQUIRED', label);
}

async function proveOwnerTrigger(admin, client) {
  const ownerMembership = [group.trig_1, profile.trig_owner];

  // Contraprova central: um commit que só altera group_members.
  assertCommitRejected(
    await commitOutcome(client, [
      [
        `update public.group_members set status = 'removed', removed_at = now()
         where group_id = $1 and profile_id = $2`,
        ownerMembership,
      ],
    ]),
    'owner membership removed through group_members only',
  );
  assert.equal(
    (
      await admin.query(
        'select status from public.group_members where group_id = $1 and profile_id = $2',
        ownerMembership,
      )
    ).rows[0].status,
    'active',
  );
  console.log('ok - a real commit that only removes the owner membership is refused at commit');

  assertCommitRejected(
    await commitOutcome(client, [
      [
        'delete from public.group_members where group_id = $1 and profile_id = $2',
        [group.trig_2, profile.trig_owner],
      ],
    ]),
    'owner membership deleted',
  );
  assertCommitRejected(
    await commitOutcome(client, [
      [
        `update public.group_members set profile_id = $3
         where group_id = $1 and profile_id = $2`,
        [group.trig_3, profile.trig_owner, profile.titular],
      ],
    ]),
    'owner membership moved to another profile',
  );
  assertCommitRejected(
    await commitOutcome(client, [
      [
        `update public.group_members set status = 'pending'
         where group_id = $1 and profile_id = $2`,
        [group.trig_4, profile.trig_member],
      ],
      ['update public.groups set owner_id = $2 where id = $1', [group.trig_4, profile.trig_member]],
    ]),
    'ownership moved to a pending member',
  );
  assertCommitRejected(
    await commitOutcome(client, [
      [
        `insert into public.groups (id, name, owner_id)
         values ('15b0ffff-0000-4000-8000-000000000000', 'Sem membership', $1)`,
        [profile.trig_owner],
      ],
    ]),
    'group inserted without its owner membership',
  );
  console.log('ok - delete, key change, pending new owner and a bare insert are refused at commit');

  // Controles positivos do mesmo trigger.
  const transferred = await commitOutcome(client, [
    ['update public.groups set owner_id = $2 where id = $1', [group.trig_ok, profile.trig_member]],
    [
      `update public.group_members set status = 'removed', removed_at = now()
       where group_id = $1 and profile_id = $2`,
      [group.trig_ok, profile.trig_owner],
    ],
  ]);
  assert.equal(
    transferred.phase,
    null,
    `transfer to an active member: ${transferred.error?.message}`,
  );
  const archived = await commitOutcome(client, [
    [
      `update public.group_members set status = 'removed', removed_at = now()
       where group_id = $1 and profile_id = $2`,
      [group.trig_ok, profile.trig_member],
    ],
    ['update public.groups set archived_at = now() where id = $1', [group.trig_ok]],
  ]);
  assert.equal(archived.phase, null, `archived group: ${archived.error?.message}`);
  console.log('ok - transfer to an active member and archiving commit under the same trigger');
}

// ---------------------------------------------------------------------------
// Prova 3: extensão da saga, medida depois do commit real
// ---------------------------------------------------------------------------

async function proveDeletionOutcomes(admin, client, status) {
  await deleteAccountTx(client, 'd8_owner');
  assert.equal(
    (await groupState(admin, group.d8)).owner_id,
    profile.d8_old,
    'M2-D8: the oldest joined_at must win over insertion order and profile_id',
  );
  assert.deepEqual(
    (await membershipRows(admin, group.d8)).map(({ profile_id, status }) => [profile_id, status]),
    [
      [profile.d8_owner, 'removed'],
      [profile.d8_new, 'active'],
      [profile.d8_old, 'active'],
    ].sort(([left], [right]) => left.localeCompare(right)),
  );
  console.log('ok - M2-D8: the oldest organizer, inserted last with the largest id, becomes owner');

  await deleteAccountTx(client, 'tie_owner');
  assert.equal(
    (await groupState(admin, group.tie)).owner_id,
    profile.tie_small,
    'M2-D8 tie: the smallest profile_id in bytes must win',
  );
  console.log('ok - M2-D8 tie: equal joined_at picks the smallest profile_id, inserted second');

  // O grupo suspenso também tem foto: a transferência não pode tratá-la como
  // objeto do titular.
  await uploadPhoto(status, photoPath.susp);
  assert.equal(await photoExists(status, photoPath.susp), true);
  const suspendedBefore = (await groupState(admin, group.susp)).suspended_at;
  await deleteAccountTx(client, 'susp_owner');
  const suspendedAfter = await groupState(admin, group.susp);
  assert.equal(suspendedAfter.owner_id, profile.susp_org);
  assert.equal(suspendedAfter.archived, false);
  assert.equal(suspendedAfter.suspended_at.toISOString(), suspendedBefore.toISOString());
  console.log('ok - M2-D10: deletion transfers a suspended group and suspended_at is unchanged');

  // docs/25 §3.3: só grupo arquivado do titular recebe efeito de foto. O
  // grupo transferido segue vivo com o localizador e o objeto, sem efeito
  // group_photo, e o fence de Storage da saga fica livre para o Auth.
  const transferred = await admin.query(
    `select grp.photo_url,
            (select count(*)::integer from private.external_effects effect
              where effect.resource_type = 'group_photo'
                and effect.resource_id = grp.id) as photo_effects,
            private.deletion_has_pending_storage(request.id) as storage_pending,
            (select count(*)::integer from private.external_effects effect
              where effect.kind = 'delete_auth_user'
                and effect.resource_id = request.id) as auth_effects
       from public.groups grp
       cross join private.deletion_requests request
      where grp.id = $1 and request.profile_id = $2`,
    [group.susp, profile.susp_owner],
  );
  assert.deepEqual(transferred.rows[0], {
    photo_url: photoPath.susp,
    photo_effects: 0,
    storage_pending: false,
    auth_effects: 1,
  });
  assert.equal(
    await photoExists(status, photoPath.susp),
    true,
    'the transferred group lost its photo object',
  );
  console.log(
    'ok - the transferred group keeps photo_url and its object, with no group_photo effect and a free fence',
  );

  await assert.rejects(deleteAccountTx(client, 'block_owner'), (error) => {
    assert.equal(error.code, 'P0001');
    assert.equal(error.message, 'FINANCIAL_SUBSTITUTE_REQUIRED');
    return true;
  });
  const blocked = await admin.query(
    `select (select account_status from public.profiles where id = $1) as account_status,
            (select count(*)::integer from private.deletion_requests where profile_id = $1) as sagas,
            (select count(*)::integer from private.idempotency_records where actor_id = $1) as records`,
    [profile.block_owner],
  );
  assert.deepEqual(blocked.rows[0], { account_status: 'active', sagas: 0, records: 0 });
  assert.equal((await groupState(admin, group.block)).owner_id, profile.block_owner);
  console.log('ok - FINANCIAL_SUBSTITUTE_REQUIRED without an eligible organizer, with no residue');

  await deleteAccountTx(client, 'solo_owner');
  assert.equal((await groupState(admin, group.solo)).archived, true);
  assert.deepEqual(
    (await membershipRows(admin, group.solo)).map(
      ({ profile_id, status, has_removed_at, removal_count }) => [
        profile_id,
        status,
        has_removed_at,
        removal_count,
      ],
    ),
    [
      [profile.solo_owner, 'removed', true, 0],
      [profile.solo_pending, 'removed', true, 2],
    ].sort(([left], [right]) => left.localeCompare(right)),
  );
  console.log(
    'ok - M2-D9: the solo group with a pending request is archived; each pending becomes removed',
  );

  const before = [await openCount(admin, group.other_1), await openCount(admin, group.other_2)];
  await deleteAccountTx(client, 'titular');
  const after = [await openCount(admin, group.other_1), await openCount(admin, group.other_2)];
  assert.deepEqual(
    after,
    before.map((count) => count - 1),
    `pending + active must drop by exactly one: ${before} -> ${after}`,
  );
  const titularRows = await admin.query(
    `select group_id::text, status, removed_at is not null as has_removed_at
       from public.group_members where profile_id = $1 order by group_id`,
    [profile.titular],
  );
  assert.ok(titularRows.rows.every((row) => row.status === 'removed' && row.has_removed_at));
  console.log(
    `ok - non-owner memberships become removed; pending + active per group ${before} -> ${after}`,
  );
}

// ---------------------------------------------------------------------------
// Prova 4: o lock que protege o guard e o lock do próprio guard
// ---------------------------------------------------------------------------

// Tenta travar a linha sem esperar e desfaz em seguida. Devolve true quando a
// linha estava livre, false quando outra transação a segura.
async function rowIsFree(client, sql, values) {
  await client.query('begin');
  try {
    return (await client.query(sql, values)).rowCount === 1;
  } finally {
    await client.query('rollback');
  }
}

async function proveGuardLock(connections) {
  const { observer, holder, competitor } = connections;
  const { holder: holderPid, competitor: competitorPid } = await assertDistinctConnections(
    { observer, holder, competitor },
    'guard-lock',
  );

  // A→B. O guard recebe grupos que delete_account já travou (docs/25 §3.3,
  // caso 1): o lock que protege as linhas do guard é o de grupos de
  // delete_account, tomado depois dos perfis e antes das memberships. A prova
  // observa a espera e fixa em que passo ela está: o perfil do titular já
  // está travado e a membership do dono ainda não. Se delete_account não
  // travasse os grupos, a espera só aconteceria dentro do guard, depois das
  // memberships, e a segunda sonda reprovaria.
  await holder.query('begin');
  await holder.query('select id from public.groups where id = $1 for update', [group.guard_ab]);
  const deletion = track(deleteAccountTx(competitor, 'guard_owner_ab'));
  try {
    await awaitLockWait(observer, deletion, competitorPid, holderPid, 'guard A→B');
    assert.equal(
      await rowIsFree(
        observer,
        'select 1 from public.profiles where id = $1 for no key update skip locked',
        [profile.guard_owner_ab],
      ),
      false,
      'guard A→B: the wait happened before delete_account locked the titular profile',
    );
    assert.equal(
      await rowIsFree(
        observer,
        `select 1 from public.group_members where group_id = $1 and profile_id = $2
         for no key update skip locked`,
        [group.guard_ab, profile.guard_owner_ab],
      ),
      true,
      'guard A→B: the wait happened after the memberships lock, so delete_account did not lock the group',
    );
  } finally {
    await holder.query('commit');
  }
  const [deletionResult] = await Promise.all([deletion.settled]);
  assertFulfilled(deletionResult, 'guard A→B: the owner deletion');
  assert.equal((await groupState(observer, group.guard_ab)).archived, true);
  console.log(
    'ok - delete_account locks the owned group after the profiles and before the memberships and the guard',
  );

  // B→A: a exclusão travou o grupo e não commitou; o detentor espera por ela.
  await competitor.query('begin isolation level read committed');
  await competitor.query('set local role service_role');
  await competitor.query('select public.delete_account($1, $2, $3, $4, 1, 1)', [
    authId.guard_owner_ba,
    sessionId.guard_owner_ba,
    requestId.guard_owner_ba,
    hmacFor('guard_owner_ba'),
  ]);
  const waiting = track(
    (async () => {
      await holder.query('begin');
      const { rows } = await holder.query(
        'select archived_at is not null as archived from public.groups where id = $1 for update',
        [group.guard_ba],
      );
      await holder.query('commit');
      return rows[0].archived;
    })(),
  );
  try {
    await awaitLockWait(observer, waiting, holderPid, competitorPid, 'guard B→A');
  } finally {
    await competitor.query('commit');
  }
  const [waitingResult] = await Promise.all([waiting.settled]);
  assert.equal(assertFulfilled(waitingResult, 'guard B→A: the holder'), true);
  console.log('ok - the deletion holds the group until commit: B→A wait observed, no 40P01');

  // O lock do próprio guard, isolado. Chamado diretamente, como postgres, sobre
  // um grupo do caso 3, o guard não faz UPDATE: a única aquisição sobre o
  // grupo é a dele. Sem ela, a chamada responde sem esperar e a prova reprova.
  // É também a prova de que o guard é volatile: em função stable a aquisição
  // aborta com 0A000.
  await holder.query('begin');
  await holder.query('select id from public.groups where id = $1 for update', [group.guard_direct]);
  const direct = track(
    (async () => {
      await competitor.query('begin');
      try {
        await competitor.query(
          'select private.require_financial_deletion_substitute($1, $2::uuid[], $3::uuid[])',
          [profile.guard_direct_owner, [group.guard_direct], []],
        );
      } finally {
        await competitor.query('rollback');
      }
    })(),
  );
  try {
    await awaitLockWait(observer, direct, competitorPid, holderPid, 'guard direct call');
  } finally {
    await holder.query('commit');
  }
  const [directResult] = await Promise.all([direct.settled]);
  assertDomainRejection(directResult, 'FINANCIAL_SUBSTITUTE_REQUIRED', 'guard direct call');
  console.log(
    "ok - the guard's own lock waits for the holder when called directly, then answers FINANCIAL_SUBSTITUTE_REQUIRED",
  );
}

// ---------------------------------------------------------------------------
// Prova 5: pares concorrentes sem 40P01 (barreira de docs/25 §2)
// ---------------------------------------------------------------------------

// A trava o primeiro recurso e fica parada no segundo, segurado pelo detentor.
// Só então B começa e precisa esperar por A. Liberado o detentor, nenhum dos
// dois pode terminar com 40P01.
async function barrierPair({ observer, holder, first, second }, pair) {
  const {
    holder: holderPid,
    first: firstPid,
    second: secondPid,
  } = await assertDistinctConnections({ observer, holder, first, second }, pair.label);
  await holder.query('begin');
  await holder.query(pair.holdSql, pair.holdValues);
  const results = [];
  try {
    const a = track(pair.runFirst(first));
    const b = { state: { done: false }, settled: Promise.resolve(undefined) };
    try {
      await awaitLockWait(observer, a, firstPid, holderPid, `${pair.label} A`);
      const started = track(pair.runSecond(second));
      b.state = started.state;
      b.settled = started.settled;
      await awaitLockWait(observer, started, secondPid, firstPid, `${pair.label} B`);
    } finally {
      await holder.query('commit');
      results.push(...(await Promise.allSettled([a.settled, b.settled])).map((r) => r.value));
    }
  } catch (error) {
    await holder.query('rollback').catch(() => {});
    throw error;
  }
  assertNoDeadlock(results.filter(Boolean), pair.label);
  return results;
}

async function proveOwnerOrganizerPairs(connections, admin) {
  const client = connections.first;
  // A→B: o dono sai primeiro; o organizador escolhido tenta sair enquanto isso.
  const [ownerFirst, organizerSecond] = await barrierPair(connections, {
    label: 'owner deletion → chosen organizer deletion',
    holdSql: 'select id from public.groups where id = $1 for update',
    holdValues: [group.pair1],
    runFirst: (connection) => deleteAccountTx(connection, 'pair1_owner'),
    runSecond: (connection) => deleteAccountTx(connection, 'pair1_org'),
  });
  assertFulfilled(ownerFirst, 'pair 1 owner');
  // A trava os perfis FOR NO KEY UPDATE, compatível com o FOR KEY SHARE que a
  // FK idempotency_records.actor_id → profiles toma no perfil do organizador.
  // B passa pela idempotência, resolve sem grupos próprios e espera por A no
  // lock do próprio perfil. Depois do commit de A, a revalidação sob lock
  // encontra o grupo recebido fora do conjunto resolvido: CONCURRENT_CHANGE
  // (docs/25 §3.3, caso 1). O retry, com o mesmo request_id, arquiva o grupo
  // como solo.
  assertDomainRejection(organizerSecond, 'CONCURRENT_CHANGE', 'pair 1 organizer');
  const transferredOne = await groupState(admin, group.pair1);
  assert.deepEqual(
    { owner: transferredOne.owner_id, archived: transferredOne.archived },
    { owner: profile.pair1_org, archived: false },
  );
  await deleteAccountTx(client, 'pair1_org');
  const pairOne = await groupState(admin, group.pair1);
  assert.deepEqual(
    { owner: pairOne.owner_id, archived: pairOne.archived },
    { owner: profile.pair1_org, archived: true },
  );
  assert.ok((await membershipRows(admin, group.pair1)).every((row) => row.status === 'removed'));
  console.log(
    'ok - owner → organizer: no 40P01; the organizer gets CONCURRENT_CHANGE, then its retry archives',
  );

  // B→A: o organizador escolhido sai primeiro; o dono tenta sair em seguida.
  const [organizerFirst, ownerSecond] = await barrierPair(connections, {
    label: 'chosen organizer deletion → owner deletion',
    holdSql: 'select id from public.groups where id = $1 for update',
    holdValues: [group.pair2],
    runFirst: (connection) => deleteAccountTx(connection, 'pair2_org'),
    runSecond: (connection) => deleteAccountTx(connection, 'pair2_owner'),
  });
  assertFulfilled(organizerFirst, 'pair 2 organizer');
  assertDomainRejection(ownerSecond, 'CONCURRENT_CHANGE', 'pair 2 owner');
  await deleteAccountTx(client, 'pair2_owner');
  assert.equal((await groupState(admin, group.pair2)).archived, true);
  console.log(
    'ok - organizer → owner: no 40P01; the owner gets CONCURRENT_CHANGE, then its retry archives',
  );
}

// Estado final de um par de candidatura mútua depois das duas exclusões: os
// dois grupos arquivados, as quatro memberships removed e os dois titulares
// em deletion_pending, cada um com o seu pedido.
async function assertMutualPairSettled(admin, pair, label) {
  const low = `${pair}_low`;
  const high = `${pair}_high`;
  const { rows } = await admin.query(
    `select
       (select count(*)::integer from public.groups
         where id = any($1::uuid[]) and archived_at is not null) as archived,
       (select count(*)::integer from public.group_members
         where group_id = any($1::uuid[]) and status = 'removed' and removed_at is not null)
         as removed,
       (select count(*)::integer from public.profiles
         where id = any($2::uuid[]) and account_status = 'deletion_pending') as pending,
       (select count(*)::integer from private.deletion_requests
         where profile_id = any($2::uuid[])) as requests`,
    [
      [group[low], group[high]],
      [profile[low], profile[high]],
    ],
  );
  assert.deepEqual(
    rows[0],
    { archived: 2, removed: 4, pending: 2, requests: 2 },
    `${label}: the mutual pair did not converge`,
  );
}

function outcomeOf(result) {
  if (result.status === 'fulfilled') return 'ok';
  if (result.reason?.code === '40P01') return '40P01';
  if (result.reason?.code === 'P0001' && result.reason?.message === 'CONCURRENT_CHANGE') {
    return 'CONCURRENT_CHANGE';
  }
  return `other ${result.reason?.code} ${result.reason?.message}`;
}

// Candidatura mútua (achado 1 da revisão do PR #36). Cada titular é dono de um
// grupo em que o outro é organizador ativo, então cada exclusão trava os dois
// perfis, em bytes crescentes. Antes deles vem uma aquisição implícita: o
// INSERT da idempotência toma FOR KEY SHARE no perfil do próprio titular pela
// FK actor_id. Pela barreira de docs/25 §2, o detentor segura FOR NO KEY
// UPDATE o segundo recurso de A, que nas duas ordens é o perfil de maior
// byte, e só então B começa; B precisa ser observado esperando por A.
//
// Ordem 1: A é o titular de menor byte e para antes do perfil de B, depois de
// B já poder tomar FOR KEY SHARE no próprio perfil. Com FOR UPDATE nos
// perfis, A espera o FOR KEY SHARE de B e B espera A: 40P01 determinístico.
// Ordem 2: A é o de maior byte e para antes do próprio perfil, já segurando o
// de B. Com FOR UPDATE, B espera A no próprio INSERT da idempotência e não há
// ciclo; com FOR NO KEY UPDATE, B passa pela FK e espera A no lock de perfis.
// Com a correção, nas duas ordens A conclui, B recebe CONCURRENT_CHANGE e o
// retry de B arquiva os dois grupos.
async function proveMutualCandidacyPairs(connections, admin) {
  for (const [pair, firstName, secondName, label] of [
    ['mut1', 'mut1_low', 'mut1_high', 'mutual order 1: low → high'],
    ['mut2', 'mut2_high', 'mut2_low', 'mutual order 2: high → low'],
  ]) {
    const [first, second] = await barrierPair(connections, {
      label,
      holdSql: 'select id from public.profiles where id = $1 for no key update',
      holdValues: [profile[`${pair}_high`]],
      runFirst: (connection) => deleteAccountTx(connection, firstName),
      runSecond: (connection) => deleteAccountTx(connection, secondName),
    });
    assertFulfilled(first, `${label}: first titular`);
    assertDomainRejection(second, 'CONCURRENT_CHANGE', `${label}: second titular`);
    await deleteAccountTx(connections.first, secondName);
    await assertMutualPairSettled(admin, pair, label);
    console.log(
      `ok - ${label}: waits observed, no 40P01; the second gets CONCURRENT_CHANGE and its retry archives both groups`,
    );
  }
}

// Execução natural, sem barreira: as duas exclusões de cada par partem ao
// mesmo tempo. A contagem é impressa antes das asserções para que a
// contraprova mostre quantos pares fecharam ciclo.
async function proveMutualCandidacyStorm(connections, admin) {
  const { first, second } = connections;
  const outcomes = [];
  for (const [index, pair] of STORM_PAIRS.entries()) {
    const [left, right] = index % 2 === 0 ? ['low', 'high'] : ['high', 'low'];
    const a = track(deleteAccountTx(first, `${pair}_${left}`));
    const b = track(deleteAccountTx(second, `${pair}_${right}`));
    const results = await Promise.all([a.settled, b.settled]);
    outcomes.push({ pair, names: [`${pair}_${left}`, `${pair}_${right}`], results });
  }
  const flat = outcomes.flatMap(({ results }) => results.map(outcomeOf));
  const deadlocks = outcomes.filter(({ results }) =>
    results.some((result) => outcomeOf(result) === '40P01'),
  ).length;
  const conflicts = flat.filter((outcome) => outcome === 'CONCURRENT_CHANGE').length;
  const bothOk = outcomes.filter(({ results }) =>
    results.every((result) => outcomeOf(result) === 'ok'),
  ).length;
  console.log(
    `mutual storm without barrier: ${STORM_PAIRS.length} pairs, pairs with 40P01=${deadlocks}, CONCURRENT_CHANGE=${conflicts}, both ok=${bothOk}`,
  );
  assert.equal(deadlocks, 0, `mutual storm: ${deadlocks} of ${STORM_PAIRS.length} pairs hit 40P01`);
  for (const { pair, names, results } of outcomes) {
    const kinds = results.map(outcomeOf);
    assert.ok(
      kinds.every((kind) => kind === 'ok' || kind === 'CONCURRENT_CHANGE'),
      `${pair}: unexpected outcome ${kinds}`,
    );
    assert.ok(kinds.includes('ok'), `${pair}: neither deletion committed: ${kinds}`);
    for (const [position, kind] of kinds.entries()) {
      if (kind === 'CONCURRENT_CHANGE') await deleteAccountTx(first, names[position]);
    }
    await assertMutualPairSettled(admin, pair, `mutual storm ${pair}`);
  }
  console.log(
    `ok - mutual storm: ${STORM_PAIRS.length} simultaneous pairs, zero 40P01, every CONCURRENT_CHANGE retry converged`,
  );
}

async function proveExportDeletionPairs(connections, admin) {
  // A→B: a exclusão trava perfil, grupo e membership e fica parada no export;
  // o build espera pelo perfil.
  const ab = exportFixture.export_titular_ab;
  const [deletionFirst, buildSecond] = await barrierPair(connections, {
    label: 'deletion → export build',
    holdSql: 'select id from private.data_exports where id = $1 for update',
    holdValues: [ab.export],
    runFirst: (connection) => deleteAccountTx(connection, 'export_titular_ab'),
    runSecond: (connection) => buildTargetTx(connection, ab),
  });
  assertFulfilled(deletionFirst, 'export A→B deletion');
  assert.deepEqual(assertFulfilled(buildSecond, 'export A→B build'), { action: 'purge' });

  // B→A: o build trava efeito e perfil e fica parado no export; a exclusão
  // espera pelo perfil e depois cancela o export em construção.
  const ba = exportFixture.export_titular_ba;
  const [buildFirst, deletionSecond] = await barrierPair(connections, {
    label: 'export build → deletion',
    holdSql: 'select id from private.data_exports where id = $1 for update',
    holdValues: [ba.export],
    runFirst: (connection) => buildTargetTx(connection, ba),
    runSecond: (connection) => deleteAccountTx(connection, 'export_titular_ba'),
  });
  assert.equal(assertFulfilled(buildFirst, 'export B→A build').action, 'build');
  assertFulfilled(deletionSecond, 'export B→A deletion');
  const states = await admin.query(
    `select status from private.data_exports where id = any($1::uuid[]) order by id`,
    [[ab.export, ba.export]],
  );
  assert.deepEqual(
    states.rows.map((row) => row.status),
    ['failed', 'failed'],
  );
  console.log(
    'ok - deletion × export build: waits observed in both orders, no 40P01, deletion wins',
  );
}

// ---------------------------------------------------------------------------
// Prova 6: o mesmo titular em duas abas (docs/25 §2, M2-D13 e M2-D14)
// ---------------------------------------------------------------------------

// Resultado exigido pelo contrato (docs/13 §5.3): uma chamada cria a saga e a
// outra recebe DELETION_ALREADY_PENDING; nunca 40P01 e nunca duas sagas.
async function assertOneDeletion(admin, name, results, label) {
  const kinds = results.map(barrierOutcome).sort();
  assert.deepEqual(
    kinds,
    ['P0001 DELETION_ALREADY_PENDING', 'ok'],
    `${label}: expected one deletion and DELETION_ALREADY_PENDING, got ${kinds}`,
  );
  const winner = results.find((result) => result.status === 'fulfilled').value;
  assert.equal(winner.outcome.logical_result, 'deletion_requested', label);
  const { rows } = await admin.query(
    `select (select account_status from public.profiles where id = $1) as account_status,
            (select count(*)::integer from private.deletion_requests where profile_id = $1)
              as requests`,
    [profile[name]],
  );
  assert.deepEqual(rows[0], { account_status: 'deletion_pending', requests: 1 }, label);
}

// delete_account grava a idempotência, cuja FK actor_id toma FOR KEY SHARE no
// perfil do titular, e depois trava o mesmo perfil. Duas abas do mesmo
// titular, com request_id diferentes, seguram cada uma o próprio FOR KEY SHARE:
// com FOR UPDATE, cada uma espera o da outra (40P01 por upgrade); com FOR NO
// KEY UPDATE, uma trava, a outra espera o commit dela e encontra a saga. A
// barreira de scripts/lock-barrier.mjs segura o perfil em FOR NO KEY UPDATE e
// observa as duas esperando pelo detentor.
async function proveSameTitularDeletion(connections, admin) {
  const { observer, holder, first, second } = connections;
  for (const [name, label, a, b] of [
    ['same1', 'same-titular deletion order 1', first, second],
    ['same2', 'same-titular deletion order 2', second, first],
  ]) {
    const results = await sameActorPair(
      { observer, holder, first: a, second: b, applicationPrefix: APPLICATION_PREFIX },
      {
        label,
        profileId: profile[name],
        runFirst: (connection) => deleteAccountTx(connection, name, requestId[name]),
        runSecond: (connection) => deleteAccountTx(connection, name, secondRequestId[name]),
      },
    );
    await assertOneDeletion(admin, name, results, label);
  }
  console.log(
    'ok - same-titular deletion pair: waits observed in both orders, no 40P01; one saga, the other DELETION_ALREADY_PENDING',
  );

  // Sem barreira: as duas abas de cada titular partem ao mesmo tempo. A
  // contagem é impressa antes das asserções.
  const outcomes = [];
  for (const name of SAME_TITULAR_STORM) {
    const tabA = track(deleteAccountTx(first, name, requestId[name]));
    const tabB = track(deleteAccountTx(second, name, secondRequestId[name]));
    outcomes.push({ name, results: await Promise.all([tabA.settled, tabB.settled]) });
  }
  const deadlocks = outcomes.filter(({ results }) =>
    results.some((result) => barrierOutcome(result) === '40P01'),
  ).length;
  const pending = outcomes
    .flatMap(({ results }) => results.map(barrierOutcome))
    .filter((kind) => kind === 'P0001 DELETION_ALREADY_PENDING').length;
  console.log(
    `same-titular deletion storm without barrier: ${SAME_TITULAR_STORM.length} pairs, pairs with 40P01=${deadlocks}, DELETION_ALREADY_PENDING=${pending}`,
  );
  assert.equal(
    deadlocks,
    0,
    `same-titular deletion storm: ${deadlocks} of ${SAME_TITULAR_STORM.length} pairs hit 40P01`,
  );
  for (const { name, results } of outcomes) {
    await assertOneDeletion(admin, name, results, `same-titular storm ${name}`);
  }
  console.log(
    `ok - same-titular deletion storm: ${SAME_TITULAR_STORM.length} simultaneous pairs, zero 40P01, one saga per titular`,
  );
}

// ---------------------------------------------------------------------------
// Prova 7: fence de Storage da foto de grupo, crash e retry
// ---------------------------------------------------------------------------

async function authFenceState(admin, name) {
  const request = await requestIdOf(admin, name);
  const { rows } = await admin.query(
    `select request.status,
            private.deletion_has_pending_storage(request.id) as storage_pending,
            private.deletion_auth_effect_is_ready(request.id) as auth_ready,
            (select count(*)::integer from private.external_effects
             where kind = 'delete_auth_user' and resource_id = request.id) as auth_effects
       from private.deletion_requests request where request.id = $1`,
    [request],
  );
  return rows[0];
}

async function acquirePhotoEffect(admin, groupId) {
  const effect = (
    await admin.query(
      "select public.worker_acquire_external_effect(array['delete_storage_object']::text[]) as effect",
    )
  ).rows[0].effect;
  assert.equal(
    effect?.resource_type,
    'group_photo',
    `unexpected acquisition ${JSON.stringify(effect)}`,
  );
  assert.equal(effect.resource_id, groupId);
  return effect;
}

async function expireLease(admin, effect) {
  await admin.query(
    `update private.external_effects set lease_until = clock_timestamp() - interval '1 second'
     where id = $1`,
    [effect.id],
  );
}

async function assertAuthFenced(admin, name, label) {
  const state = await authFenceState(admin, name);
  assert.equal(state.storage_pending, true, `${label}: ${JSON.stringify(state)}`);
  assert.equal(state.auth_ready, false, `${label}: ${JSON.stringify(state)}`);
  assert.equal(state.auth_effects, 0, `${label}: Auth became acquirable with the photo pending`);
  const auth = (
    await admin.query(
      "select public.worker_acquire_external_effect(array['delete_auth_user']::text[]) as effect",
    )
  ).rows[0].effect;
  assert.equal(auth, null, `${label}: the worker acquired Auth ${JSON.stringify(auth)}`);
}

async function provePhotoFence(admin, client, status) {
  await uploadPhoto(status, photoPath.photo);
  assert.equal(await photoExists(status, photoPath.photo), true);
  const pendingAuth = await admin.query(
    `select count(*)::integer as count from private.external_effects
     where kind = 'delete_auth_user' and status in ('pending', 'failed_retryable')`,
  );
  assert.equal(pendingAuth.rows[0].count, 0, 'another Auth effect would pollute the fence proof');

  await deleteAccountTx(client, 'photo_owner');
  const request = await requestIdOf(admin, 'photo_owner');
  const key = (
    await admin.query(
      `select dedupe_key from private.external_effects
       where resource_type = 'group_photo' and resource_id = $1`,
      [group.photo],
    )
  ).rows[0].dedupe_key;
  assert.equal(key, `delete_storage_object:group_photo:${group.photo}:${request}`);
  await assertAuthFenced(admin, 'photo_owner', 'after deletion');
  console.log('ok - the pending group photo keeps Auth unacquirable after the deletion commit');

  // Crash antes do delete: o alvo foi lido, o objeto continua lá.
  const first = await acquirePhotoEffect(admin, group.photo);
  const firstTarget = (
    await admin.query('select public.worker_get_deletion_effect_target($1, $2) as target', [
      first.id,
      first.lease_token,
    ])
  ).rows[0].target;
  assert.deepEqual(firstTarget, { action: 'storage', bucket: PHOTO_BUCKET, path: photoPath.photo });
  await expireLease(admin, first);
  await assertAuthFenced(admin, 'photo_owner', 'crash before the provider delete');

  // Crash depois do delete e antes da confirmação.
  const second = await acquirePhotoEffect(admin, group.photo);
  const secondTarget = (
    await admin.query('select public.worker_get_deletion_effect_target($1, $2) as target', [
      second.id,
      second.lease_token,
    ])
  ).rows[0].target;
  assert.equal(secondTarget.path, photoPath.photo);
  await removePhoto(status, photoPath.photo);
  assert.equal(await photoExists(status, photoPath.photo), false);
  await expireLease(admin, second);
  await assertAuthFenced(admin, 'photo_owner', 'crash after delete, before confirmation');

  // Crash depois da confirmação e antes da conclusão.
  const third = await acquirePhotoEffect(admin, group.photo);
  const thirdTarget = (
    await admin.query('select public.worker_get_deletion_effect_target($1, $2) as target', [
      third.id,
      third.lease_token,
    ])
  ).rows[0].target;
  assert.equal(thirdTarget.path, photoPath.photo, 'the locator must survive until confirmation');
  assert.equal(await photoExists(status, photoPath.photo), false);
  await admin.query('select public.worker_confirm_deletion_effect($1, $2)', [
    third.id,
    third.lease_token,
  ]);
  await expireLease(admin, third);
  const afterConfirm = await authFenceState(admin, 'photo_owner');
  assert.equal(afterConfirm.storage_pending, true, 'a failed_retryable effect still fences Auth');
  assert.equal(afterConfirm.auth_effects, 0);

  // Retry final: observa ausência e conclui; só então o Auth fica adquirível.
  const fourth = await acquirePhotoEffect(admin, group.photo);
  assert.deepEqual(
    (
      await admin.query('select public.worker_get_deletion_effect_target($1, $2) as target', [
        fourth.id,
        fourth.lease_token,
      ])
    ).rows[0].target,
    { action: 'none', bucket: PHOTO_BUCKET, path: null },
  );
  await admin.query('select public.worker_complete_external_effect($1, $2, $3, $4)', [
    fourth.id,
    fourth.lease_token,
    'succeeded',
    null,
  ]);
  const released = await authFenceState(admin, 'photo_owner');
  assert.deepEqual(
    { status: released.status, pending: released.storage_pending, auth: released.auth_effects },
    { status: 'deleting_auth', pending: false, auth: 1 },
  );
  console.log(
    'ok - crash before delete, after delete and after confirmation all converge; Auth only after absence',
  );

  await invokeWorker(admin, status);
  const finished = await admin.query(
    `select profile.account_status, grp.photo_url, grp.archived_at is not null as archived,
            request.status as saga
       from public.profiles profile
       join public.groups grp on grp.owner_id = profile.id
       join private.deletion_requests request on request.profile_id = profile.id
      where profile.id = $1`,
    [profile.photo_owner],
  );
  assert.deepEqual(finished.rows[0], {
    account_status: 'deleted',
    photo_url: null,
    archived: true,
    saga: 'completed',
  });
  console.log(
    'ok - the real worker deletes Auth and finalizes after the photo is confirmed absent',
  );

  // Caminho inteiro pelo worker Edge real: handler genérico, bucket privado.
  await uploadPhoto(status, photoPath.photo_worker);
  await deleteAccountTx(client, 'photo_owner_worker');
  await assertAuthFenced(admin, 'photo_owner_worker', 'worker saga before processing');
  await invokeWorker(admin, status);
  assert.equal(await photoExists(status, photoPath.photo_worker), false);
  // O primeiro ciclo pode concluir a foto e o Auth no mesmo lote; um segundo
  // ciclo cobre o caso em que o Auth só ficou adquirível depois do lote.
  await invokeWorker(admin, status);
  const workerSaga = await admin.query(
    `select profile.account_status, grp.photo_url, request.status as saga,
            request.has_operational_failure
       from public.profiles profile
       join public.groups grp on grp.owner_id = profile.id
       join private.deletion_requests request on request.profile_id = profile.id
      where profile.id = $1`,
    [profile.photo_owner_worker],
  );
  assert.deepEqual(workerSaga.rows[0], {
    account_status: 'deleted',
    photo_url: null,
    saga: 'completed',
    has_operational_failure: false,
  });
  const leaked = await admin.query(
    `select count(*)::integer as count from (
       select dedupe_key as text from private.external_effects
       union all select coalesce(last_error_code, '') from private.external_effects
       union all select coalesce(outcome::text, '') from private.idempotency_records
       union all select coalesce(summary::text, '') || coalesce(error_code, '') from private.job_runs
     ) operational where text like '%' || $1 || '%'`,
    ['/photo.webp'],
  );
  assert.equal(leaked.rows[0].count, 0, 'a photo path reached an operational ledger');
  console.log('ok - the real Edge worker removes the group photo object and completes the saga');
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

const PROOFS = [
  ['canonical', 'the 0015 text is the canonical definition'],
  ['owner-trigger', 'deferred owner trigger in real commits'],
  ['deletion', 'deletion outcomes after real commits'],
  ['guard-lock', 'volatile guard locking under concurrency'],
  ['lock-order', 'owner × organizer deletion pairs without 40P01'],
  ['mutual-order', 'mutual candidacy deletion pairs without 40P01, barrier in both orders'],
  ['mutual-storm', 'mutual candidacy deletion pairs without 40P01, simultaneous'],
  ['export-order', 'deletion × export build pairs without 40P01'],
  ['same-titular', 'same-titular deletion pairs without 40P01, barrier and simultaneous'],
  ['photo-fence', 'group photo Storage fence, crash and retry'],
];

async function main() {
  if (selectedProof !== undefined && !PROOFS.some(([name]) => name === selectedProof)) {
    throw new Error(`Unknown COLETE_GROUP_PROOF ${selectedProof}`);
  }
  const status = localStatus();
  const connectionString = status.databaseUrl;
  const admin = newClient(connectionString, 'admin');
  const observer = newClient(connectionString, 'observer');
  const holder = newClient(connectionString, 'holder');
  const first = newClient(connectionString, 'first');
  const second = newClient(connectionString, 'second');
  const all = [admin, observer, holder, first, second];
  let jobBaseline;
  let tableBaseline;
  // A limpeza e o censo rodam pelo guard, numa conexão própria, depois de o
  // corpo terminar ou de o trabalho em voo assentar.
  guard.useDatabase(connectionString);
  guard.onCleanup(async (client) => {
    await cleanup(client, status);
    if (jobBaseline !== undefined) {
      await client.query('delete from private.job_runs where id > $1', [jobBaseline]);
    }
  });
  guard.onCensus(async (client) => {
    if (tableBaseline === undefined) {
      console.error('# db:test:groups: no baseline was taken; residue census skipped');
      return;
    }
    await assertNoResidue(client, tableBaseline);
  });
  try {
    await Promise.all(all.map((client) => client.connect()));
    jobBaseline = Number(
      (await admin.query('select coalesce(max(id), 0)::text as id from private.job_runs')).rows[0]
        .id,
    );
    const pids = await Promise.all(all.map(backendPid));
    assert.equal(new Set(pids).size, pids.length, 'the harness did not open independent backends');
    const names = await Promise.all(
      all.map(async (client) => (await client.query('show application_name')).rows[0]),
    );
    assert.equal(
      new Set(names.map((row) => row.application_name)).size,
      all.length,
      'every dedicated connection needs a distinct application_name',
    );
    console.log(
      `ok - ${pids.length} dedicated connections with distinct PIDs and application_name`,
    );

    // Varredura inicial: fixture de IDs fixos e usuários Auth com a marca que
    // uma execução interrompida tenha deixado.
    await cleanup(admin, status);
    tableBaseline = await tableCounts(admin, ['public', 'private', 'auth', 'storage']);
    await createAuthUsers(status);
    await insertFixture(admin);

    const run = (name) => selectedProof === undefined || selectedProof === name;
    if (run('canonical')) await proveCanonicalText(admin);
    if (run('owner-trigger')) await proveOwnerTrigger(admin, first);
    if (run('photo-fence')) await provePhotoFence(admin, first, status);
    if (run('deletion')) await proveDeletionOutcomes(admin, first, status);
    if (run('guard-lock')) await proveGuardLock({ observer, holder, competitor: first });
    if (run('lock-order')) {
      await proveOwnerOrganizerPairs({ observer, holder, first, second }, admin);
    }
    if (run('mutual-order')) {
      await proveMutualCandidacyPairs({ observer, holder, first, second }, admin);
    }
    if (run('mutual-storm')) await proveMutualCandidacyStorm({ first, second }, admin);
    if (run('export-order')) {
      await proveExportDeletionPairs({ observer, holder, first, second }, admin);
    }
    if (run('same-titular')) {
      await proveSameTitularDeletion({ observer, holder, first, second }, admin);
    }
  } finally {
    await Promise.allSettled(all.map((client) => client.end()));
  }
}

// Censo depois da limpeza final: só auth.audit_log_entries, escrito pelo
// GoTrue por desenho, pode mudar.
async function assertNoResidue(client, tableBaseline) {
  const tableAfter = await tableCounts(client, ['public', 'private', 'auth', 'storage']);
  const changed = [...tableAfter].filter(([table, count]) => count !== tableBaseline.get(table));
  assert.ok(
    changed.every(([table]) => table === 'auth.audit_log_entries'),
    `an undeclared table changed across the harness: ${JSON.stringify(changed)}`,
  );
  const residue = await client.query(
    `select
       (select count(*)::integer from public.groups where id = any($1::uuid[])) as groups,
       (select count(*)::integer from public.group_members where group_id = any($1::uuid[])) as members,
       (select count(*)::integer from public.profiles where id = any($2::uuid[])) as profiles,
       (select count(*)::integer from storage.objects where bucket_id = $3) as photos,
       (select count(*)::integer from auth.users where email like $4) as marked_auth_users`,
    [groupIds, profileIds, PHOTO_BUCKET, `${AUTH_EMAIL_PREFIX}%@colete.test`],
  );
  assert.deepEqual(residue.rows[0], {
    groups: 0,
    members: 0,
    profiles: 0,
    photos: 0,
    marked_auth_users: 0,
  });
  const auditBefore = tableBaseline.get('auth.audit_log_entries') ?? 0;
  const auditAfter = tableAfter.get('auth.audit_log_entries') ?? 0;
  console.log(
    `ok - no residual row or object; accepted GoTrue auth.audit_log_entries residue: added=${auditAfter - auditBefore}`,
  );
}

if (await guard.run(main)) {
  console.log(
    selectedProof === undefined
      ? 'Group foundation harness passed.'
      : `Group foundation proof ${selectedProof} passed.`,
  );
}
