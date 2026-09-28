import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { buildDataExport } from '../supabase/functions/_shared/data-export.ts';
import { dataExportBuildHandler } from '../supabase/functions/_shared/data-export.ts';
import { accountDeletionHandlers } from '../supabase/functions/_shared/deletion.ts';
import { createDeletionProviders } from '../supabase/functions/_shared/worker-providers.ts';
import { harnessEmail, installHarnessGuard, sweepMarkedAuthUsers } from './harness-guard.mjs';
import { localWorkerCronSecret } from './local-worker-test-config.mjs';
import { outcomeOf, sameActorPair, track } from './lock-barrier.mjs';

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supabase = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
);
const PASSWORD = 'colete-local-export-harness-password';
const profileIds = Array.from(
  { length: 9 },
  (_, index) => `13600000-0000-4000-8000-00000000000${index + 1}`,
);
const requestIds = Array.from(
  { length: 9 },
  (_, index) => `13700000-0000-4000-8000-00000000000${index + 1}`,
);
const exportIds = Array.from(
  { length: 9 },
  (_, index) => `13800000-0000-4000-8000-00000000000${index + 1}`,
);
const sessionIds = [];
const userIds = [];
const userEmails = [];
const selectedReviewProof = process.env.COLETE_EXPORT_REVIEW_PROOF;
// Marca dos usuários Auth deste harness (scripts/harness-guard.mjs), criados
// pela API admin ou por SQL.
const AUTH_EMAIL_PREFIX = 'export-harness-';

// Toda falha, inclusive a rejeição sem tratador, reprova com a causa, para o
// trabalho novo, espera o que está em voo e só então limpa
// (scripts/harness-guard.mjs). Toda conexão leva o prefixo colete_export_.
const guard = installHarnessGuard('db:test:export', {
  applicationPrefix: 'colete_export_',
  authEmailPrefix: AUTH_EMAIL_PREFIX,
});

// groups.json pelo caminho de produção (docs/25 §3.4): pedido pelo gateway
// Edge, build pelo worker Edge, download pela Edge de export. O titular tem
// uma membership própria de dono e uma removida num grupo alheio; o terceiro,
// o dono alheio, a foto e o convite existem para que a allowlist negativa
// tenha o que recusar.
const GROUPS_ACTOR_INDEX = profileIds.length;
const groupsFixture = {
  titular: '13a00000-0000-4000-8000-000000000001',
  third: '13a00000-0000-4000-8000-000000000002',
  otherOwner: '13a00000-0000-4000-8000-000000000003',
  ownGroup: '13b00000-0000-4000-8000-000000000001',
  otherGroup: '13b00000-0000-4000-8000-000000000002',
  invite: '13b10000-0000-4000-8000-000000000001',
  photo: 'groups/13b00000-0000-4000-8000-000000000001/export-census-photo.webp',
  digest: 'export-census-token-digest-0015',
  nonceHex: 'c0ffee00c0ffee00c0ffee00c0ffee00',
  thirdName: 'Terceiro do censo do export',
  otherOwnerName: 'Dono alheio do censo do export',
};
const groupsProfiles = [groupsFixture.titular, groupsFixture.third, groupsFixture.otherOwner];
const groupsIds = [groupsFixture.ownGroup, groupsFixture.otherGroup];
// Bytes esperados, escritos à mão e não pelo formatador: JCS com chaves em
// ordem, entradas por group_id, instantes como o PostgreSQL emite timestamptz
// em jsonb sob UTC, UTF-8 cru e quebra de linha final.
const EXPECTED_GROUPS_JSON =
  '[{"group_id":"13b00000-0000-4000-8000-000000000001","group_name":"Pelada da Várzea — sábado",' +
  '"is_monthly":true,"joined_at":"2026-01-02T03:04:05.123456+00:00","removal_count":0,' +
  '"removed_at":null,"role":"organizer","status":"active"},' +
  '{"group_id":"13b00000-0000-4000-8000-000000000002","group_name":"Grupo alheio",' +
  '"is_monthly":false,"joined_at":"2026-03-01T00:00:00+00:00","removal_count":2,' +
  '"removed_at":"2026-04-05T06:07:08.654321+00:00","role":"player","status":"removed"}]\n';

function environment() {
  const raw = execFileSync(supabase, ['status', '-o', 'env'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const read = (name) =>
    raw.match(new RegExp(`^${name}="([^"]+)"$`, 'm'))?.[1] ?? assert.fail(`missing ${name}`);
  return {
    api: read('API_URL'),
    db: read('DB_URL'),
    functions: read('FUNCTIONS_URL'),
    publishable: read('PUBLISHABLE_KEY'),
    secret: read('SECRET_KEY'),
    serviceRole: read('SERVICE_ROLE_KEY'),
  };
}

async function createActor(env, index) {
  const email = harnessEmail(AUTH_EMAIL_PREFIX, `${Date.now()}-${index}`);
  const created = await fetch(`${env.api}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: env.secret,
      Authorization: `Bearer ${env.secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  assert.equal(created.status, 200);
  const user = await created.json();
  const signed = await fetch(`${env.api}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.publishable, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(signed.status, 200);
  const session = await signed.json();
  const claims = JSON.parse(
    Buffer.from(session.access_token.split('.')[1], 'base64url').toString('utf8'),
  );
  assert.ok(Array.isArray(claims.amr) && claims.amr.some((entry) => entry.method === 'password'));
  userIds[index] = user.id;
  userEmails[index] = email;
  sessionIds[index] = claims.session_id;
  return session.access_token;
}

async function allCreated(creations) {
  const settled = await Promise.allSettled(creations);
  const failure = settled.find((entry) => entry.status === 'rejected');
  if (failure) throw failure.reason;
  return settled.map((entry) => entry.value);
}

const objectPath = (profileId, exportId) => `exports/${profileId}/${exportId}.zip`;
async function upload(env, index, bytes) {
  const response = await fetch(
    `${env.api}/storage/v1/object/data-exports/${objectPath(profileIds[index], exportIds[index])}`,
    {
      method: 'POST',
      headers: {
        apikey: env.secret,
        Authorization: `Bearer ${env.secret}`,
        'content-type': 'application/zip',
        'cache-control': 'no-store',
        'x-upsert': 'false',
      },
      body: bytes,
    },
  );
  assert.equal(response.status, 200, await response.text());
}
async function download(env, index, token) {
  return fetch(`${env.functions}/data-exports/${exportIds[index]}/content`, {
    headers: { apikey: env.publishable, Authorization: `Bearer ${token}` },
    redirect: 'manual',
  });
}

const effectId = (index) => `13900000-0000-4000-8000-00000000000${index + 1}`;
const initialLeaseToken = (index) => `13900000-0000-4000-8000-00000000001${index + 1}`;

async function completeEffect(db, effect) {
  await db.query('select public.worker_complete_external_effect($1,$2,$3,$4)', [
    effect.id,
    effect.lease_token,
    'succeeded',
    null,
  ]);
}

function exportBuildHandler(db) {
  return dataExportBuildHandler(
    {
      getBuildTarget: async (id, leaseToken) =>
        (
          await db.query('select public.worker_get_data_export_build_target($1,$2) as target', [
            id,
            leaseToken,
          ])
        ).rows[0].target,
      publish: async () => assert.fail('an aborted build must not publish ready'),
      enqueuePurge: async (id) => {
        await db.query('select public.enqueue_data_export_purge($1)', [id]);
      },
    },
    {
      read: async () => assert.fail('a cancelled build must not read Storage as a build'),
      upload: async () => assert.fail('a cancelled build must not upload again'),
      remove: async () => assert.fail('a cancelled build must enqueue the fenced purge'),
    },
    { projection: async () => assert.fail('a cancelled build must not read Auth') },
  );
}

function deletionHandler(db, env, observedPaths) {
  const providers = createDeletionProviders(env.api, env.serviceRole);
  const handlers = accountDeletionHandlers(
    {
      getTarget: async (id, leaseToken) =>
        (
          await db.query('select public.worker_get_deletion_effect_target($1,$2) as target', [
            id,
            leaseToken,
          ])
        ).rows[0].target,
      confirmEffect: async (id, leaseToken) => {
        await db.query('select public.worker_confirm_deletion_effect($1,$2)', [id, leaseToken]);
      },
      finalizeDeletion: async () => assert.fail('an export purge must not finalize Auth directly'),
    },
    {
      storage: {
        exists: async (bucket, storagePath) => {
          observedPaths.push(storagePath);
          return providers.storage.exists(bucket, storagePath);
        },
        remove: (bucket, storagePath) => providers.storage.remove(bucket, storagePath),
      },
      auth: {
        exists: async () => assert.fail('an export purge must not inspect Auth'),
        remove: async () => assert.fail('an export purge must not delete Auth'),
      },
    },
  );
  return async (effect) => {
    const handler = handlers[effect.kind];
    assert.equal(typeof handler, 'function', `missing deletion handler for ${effect.kind}`);
    await handler(effect);
  };
}

async function completeDeletionSaga(db, env, index, label) {
  const request = await db.query(
    'select id,status from private.deletion_requests where profile_id=$1',
    [profileIds[index]],
  );
  assert.equal(
    request.rows[0]?.status,
    'deleting_auth',
    `${label}: saga did not advance after the purge effect became terminal`,
  );
  const authEffect = (
    await db.query(
      "select public.worker_acquire_external_effect(array['delete_auth_user']::text[]) as effect",
    )
  ).rows[0].effect;
  assert.equal(
    authEffect?.resource_id,
    request.rows[0].id,
    `${label}: Auth deletion was not acquired after Storage completed`,
  );
  const target = (
    await db.query('select public.worker_get_deletion_effect_target($1,$2) as target', [
      authEffect.id,
      authEffect.lease_token,
    ])
  ).rows[0].target;
  assert.equal(target.action, 'auth', `${label}: Auth target was not published`);
  const removed = await fetch(`${env.api}/auth/v1/admin/users/${userIds[index]}`, {
    method: 'DELETE',
    headers: { apikey: env.secret, Authorization: `Bearer ${env.secret}` },
  });
  assert.ok(
    removed.ok || removed.status === 404,
    `${label}: Auth delete returned ${removed.status}`,
  );
  await db.query('select public.worker_confirm_deletion_effect($1,$2)', [
    authEffect.id,
    authEffect.lease_token,
  ]);
  await db.query('select public.finalize_deletion($1)', [request.rows[0].id]);
  await completeEffect(db, authEffect);
  const completed = await db.query(
    `select request.status,profile.account_status
       from private.deletion_requests request
       join public.profiles profile on profile.id=request.profile_id
      where request.id=$1`,
    [request.rows[0].id],
  );
  assert.deepEqual(
    completed.rows[0],
    { status: 'completed', account_status: 'deleted' },
    `${label}: deletion did not complete after Storage and Auth reconciliation`,
  );
}

async function retryAbortedBuildAndPurge(db, env, index, label, expectedStatus) {
  await db.query(
    "update private.external_effects set lease_until=clock_timestamp()-interval '1 second' where id=$1",
    [effectId(index)],
  );
  const buildEffect = (
    await db.query(
      "select public.worker_acquire_external_effect(array['build_data_export']::text[]) as effect",
    )
  ).rows[0].effect;
  assert.equal(buildEffect?.id, effectId(index), `${label}: the crashed build was not retried`);
  await exportBuildHandler(db)(buildEffect);
  await completeEffect(db, buildEffect);

  if (label === 'cancelled-after-upload') {
    const requestState = await db.query(
      'select status from private.deletion_requests where profile_id=$1',
      [profileIds[index]],
    );
    assert.equal(
      requestState.rows[0]?.status,
      'cleaning_storage',
      'export-orphan: deletion left cleaning_storage before deterministic purge completed',
    );
    const prematureAuth = (
      await db.query(
        "select public.worker_acquire_external_effect(array['delete_auth_user']::text[]) as effect",
      )
    ).rows[0].effect;
    assert.equal(
      prematureAuth,
      null,
      'export-orphan: delete_auth_user became acquirable before deterministic purge completed',
    );
  }

  const purgeEffect = (
    await db.query(
      "select public.worker_acquire_external_effect(array['delete_data_export']::text[]) as effect",
    )
  ).rows[0].effect;
  assert.ok(purgeEffect, `${label}: build retry did not enqueue deterministic purge`);
  assert.equal(
    purgeEffect.resource_id,
    exportIds[index],
    `${label}: purge targeted another export`,
  );
  const observedPaths = [];
  await deletionHandler(db, env, observedPaths)(purgeEffect);

  if (label === 'cancelled-after-upload') {
    const whileLeased = await db.query(
      'select status from private.deletion_requests where profile_id=$1',
      [profileIds[index]],
    );
    assert.equal(
      whileLeased.rows[0]?.status,
      'cleaning_storage',
      'export-orphan: purge confirmation advanced before its leased effect became terminal',
    );
    const prematureAuth = (
      await db.query(
        "select public.worker_acquire_external_effect(array['delete_auth_user']::text[]) as effect",
      )
    ).rows[0].effect;
    assert.equal(
      prematureAuth,
      null,
      'export-orphan: delete_auth_user became acquirable while purge was leased',
    );
  }
  await completeEffect(db, purgeEffect);

  if (label === 'cancelled-after-upload') {
    await completeDeletionSaga(db, env, index, label);
  }

  assert.ok(
    observedPaths.length >= 1 &&
      observedPaths.every((value) => value === objectPath(profileIds[index], exportIds[index])),
    `${label}: purge did not probe the deterministic path`,
  );
  const object = await fetch(
    `${env.api}/storage/v1/object/data-exports/${objectPath(profileIds[index], exportIds[index])}`,
    { headers: { apikey: env.secret, Authorization: `Bearer ${env.secret}` } },
  );
  assert.notEqual(object.status, 200, `${label}: orphan remained in Storage`);
  const state = await db.query(
    `select export.status, export.storage_path, export.content_digest,
            (select status from private.external_effects where id=$2) build_effect_status,
            (select status from private.external_effects where id=$3) purge_effect_status
       from private.data_exports export where export.id=$1`,
    [exportIds[index], effectId(index), purgeEffect.id],
  );
  assert.deepEqual(state.rows[0], {
    status: expectedStatus,
    storage_path: null,
    content_digest: null,
    build_effect_status: 'succeeded',
    purge_effect_status: 'succeeded',
  });
  console.log(
    `ok - ${label}: retry probed ${objectPath(profileIds[index], exportIds[index])} and purge converged`,
  );
}

// M2-D14: pedidos concorrentes de export do mesmo titular, com request_id
// diferentes. Dois atores para a barreira, um por ordem, e vinte para os
// disparos simultâneos. Os usuários Auth nascem por SQL: a prova é da RPC
// interna, e o Auth só precisa existir para a FK de profiles.
const SAME_ACTOR_STORM = 20;
const sameActorFixture = Array.from({ length: SAME_ACTOR_STORM + 2 }, (_, index) => {
  const suffix = (index + 1).toString(16).padStart(12, '0');
  return {
    profile: `13d00000-0000-4000-8000-${suffix}`,
    auth: `13d10000-0000-4000-8000-${suffix}`,
    session: `13d20000-0000-4000-8000-${suffix}`,
    requests: [`13d30000-0000-4000-8000-${suffix}`, `13d40000-0000-4000-8000-${suffix}`],
  };
});
const sameActorProfiles = sameActorFixture.map((actor) => actor.profile);
const sameActorAuth = sameActorFixture.map((actor) => actor.auth);

async function requestExportTx(client, actor, requestId, hmac) {
  await client.query('begin isolation level read committed');
  try {
    await client.query('set local role service_role');
    const result = await client.query(
      'select public.request_data_export($1,$2,$3,$4,1,1) as response',
      [actor.auth, actor.session, requestId, hmac],
    );
    await client.query('commit');
    return result.rows[0].response;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

function assertOneExportWinner(results, label) {
  const kinds = results.map(outcomeOf).sort();
  assert.deepEqual(
    kinds,
    ['P0001 EXPORT_ALREADY_PENDING', 'ok'],
    `${label}: expected one winner and EXPORT_ALREADY_PENDING, got ${kinds}`,
  );
}

async function cleanupSameActorFixture(db) {
  await db
    .query(
      `delete from private.external_effects
        where resource_id in (select id from private.data_exports where profile_id=any($1::uuid[]))`,
      [sameActorProfiles],
    )
    .catch(() => {});
  await db
    .query('delete from private.idempotency_records where actor_id=any($1::uuid[])', [
      sameActorProfiles,
    ])
    .catch(() => {});
  await db
    .query('delete from private.data_exports where profile_id=any($1::uuid[])', [sameActorProfiles])
    .catch(() => {});
  await db
    .query('delete from public.privacy_requests where profile_id=any($1::uuid[])', [
      sameActorProfiles,
    ])
    .catch(() => {});
  await db
    .query('delete from public.profiles where id=any($1::uuid[])', [sameActorProfiles])
    .catch(() => {});
  await db
    .query('delete from auth.users where id=any($1::uuid[])', [sameActorAuth])
    .catch(() => {});
}

// M2-D14. request_data_export grava a idempotência, que toma FOR KEY SHARE no
// perfil do titular pela FK actor_id, e depois trava o mesmo perfil. Com FOR
// UPDATE, dois pedidos do mesmo titular (dois cliques, duas abas) esperam um
// pelo FOR KEY SHARE do outro: deadlock por upgrade. Com FOR NO KEY UPDATE, um
// vence e o outro recebe EXPORT_ALREADY_PENDING, o resultado do contrato.
async function proveSameActorExport(db, env) {
  await db.query(
    `insert into auth.users(id,instance_id,aud,role,email)
     select auth_id,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
            $2 || 'lock-' || ordinality || '@colete.test'
       from unnest($1::uuid[]) with ordinality as fixture(auth_id,ordinality)`,
    [sameActorAuth, AUTH_EMAIL_PREFIX],
  );
  await db.query(
    `insert into public.profiles(id,auth_user_id,name)
     select profile_id,auth_id,'Pedido concorrente de export'
       from unnest($1::uuid[],$2::uuid[]) as fixture(profile_id,auth_id)`,
    [sameActorProfiles, sameActorAuth],
  );
  const applicationPrefix = 'colete_export_lock_';
  const clients = Object.fromEntries(
    ['observer', 'holder', 'first', 'second'].map((role) => [
      role,
      new Client({ connectionString: env.db, application_name: `${applicationPrefix}${role}` }),
    ]),
  );
  await Promise.all(Object.values(clients).map((client) => client.connect()));
  try {
    const { observer, holder, first, second } = clients;
    for (const [index, label, a, b] of [
      [0, 'same-actor export order 1', first, second],
      [1, 'same-actor export order 2', second, first],
    ]) {
      const actor = sameActorFixture[index];
      const results = await sameActorPair(
        { observer, holder, first: a, second: b, applicationPrefix },
        {
          label,
          profileId: actor.profile,
          runFirst: (connection) =>
            requestExportTx(connection, actor, actor.requests[0], 'a'.repeat(64)),
          runSecond: (connection) =>
            requestExportTx(connection, actor, actor.requests[1], 'b'.repeat(64)),
        },
      );
      assertOneExportWinner(results, label);
      const exports = await db.query(
        'select count(*)::integer as count from private.data_exports where profile_id=$1',
        [actor.profile],
      );
      assert.equal(exports.rows[0].count, 1, `${label}: the actor must have exactly one export`);
    }
    console.log(
      'ok - same-actor export pair: waits observed in both orders, no 40P01; one winner, the other EXPORT_ALREADY_PENDING',
    );

    const outcomes = [];
    for (const actor of sameActorFixture.slice(2)) {
      const a = track(requestExportTx(first, actor, actor.requests[0], 'a'.repeat(64)));
      const b = track(requestExportTx(second, actor, actor.requests[1], 'b'.repeat(64)));
      outcomes.push(await Promise.all([a.settled, b.settled]));
    }
    const deadlocks = outcomes.filter((pair) =>
      pair.some((result) => outcomeOf(result) === '40P01'),
    ).length;
    const pending = outcomes
      .flat()
      .filter((result) => outcomeOf(result) === 'P0001 EXPORT_ALREADY_PENDING').length;
    console.log(
      `same-actor export storm without barrier: ${SAME_ACTOR_STORM} pairs, pairs with 40P01=${deadlocks}, EXPORT_ALREADY_PENDING=${pending}`,
    );
    assert.equal(
      deadlocks,
      0,
      `same-actor export storm: ${deadlocks} of ${SAME_ACTOR_STORM} pairs hit 40P01`,
    );
    outcomes.forEach((pair, index) =>
      assertOneExportWinner(pair, `export storm pair ${index + 1}`),
    );
    const perActor = await db.query(
      `select count(*)::integer as count from private.data_exports
        where profile_id=any($1::uuid[]) group by profile_id having count(*) <> 1`,
      [sameActorProfiles],
    );
    assert.equal(perActor.rowCount, 0, 'an actor ended with more or less than one export');
    console.log(
      `ok - same-actor export storm: ${SAME_ACTOR_STORM} simultaneous pairs, zero 40P01, one export per actor`,
    );
  } finally {
    await Promise.allSettled(Object.values(clients).map((client) => client.end()));
    await cleanupSameActorFixture(db);
  }
}

// Leitor mínimo de ZIP stored (método 0), o formato que zipStore escreve.
function readStoredZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0, 'the export ZIP entry is not stored');
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    const dataStart = nameStart + nameLength + extraLength;
    entries.set(name, bytes.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

async function insertGroupsFixture(db) {
  await db.query(
    `insert into public.profiles(id,auth_user_id,name) values
       ($1,$2,'Titular do censo do export'),($3,$4,$5),($6,$7,$8)`,
    [
      groupsFixture.titular,
      userIds[GROUPS_ACTOR_INDEX],
      groupsFixture.third,
      userIds[GROUPS_ACTOR_INDEX + 1],
      groupsFixture.thirdName,
      groupsFixture.otherOwner,
      userIds[GROUPS_ACTOR_INDEX + 2],
      groupsFixture.otherOwnerName,
    ],
  );
  // Um grafo por transação: o trigger diferido de owner julga cada commit.
  await db.query('begin');
  try {
    await db.query(
      `insert into public.groups(id,name,owner_id,photo_url,monthly_enabled)
       values($1,'Pelada da Várzea — sábado',$2,$3,true)`,
      [groupsFixture.ownGroup, groupsFixture.titular, groupsFixture.photo],
    );
    await db.query(
      `insert into public.group_members(group_id,profile_id,role,status,is_monthly,joined_at)
       values($1,$2,'organizer','active',true,'2026-01-02T03:04:05.123456Z'),
             ($1,$3,'player','active',false,'2025-12-01T00:00:00Z')`,
      [groupsFixture.ownGroup, groupsFixture.titular, groupsFixture.third],
    );
    await db.query(
      `insert into public.group_invites(id,group_id,public_nonce,token_digest,created_by,expires_at)
       values($1,$2,decode($3,'hex'),$4,$5,now()+interval '1 day')`,
      [
        groupsFixture.invite,
        groupsFixture.ownGroup,
        groupsFixture.nonceHex,
        groupsFixture.digest,
        groupsFixture.titular,
      ],
    );
    await db.query('commit');
  } catch (error) {
    await db.query('rollback').catch(() => {});
    throw error;
  }
  await db.query('begin');
  try {
    await db.query(`insert into public.groups(id,name,owner_id) values($1,'Grupo alheio',$2)`, [
      groupsFixture.otherGroup,
      groupsFixture.otherOwner,
    ]);
    await db.query(
      `insert into public.group_members
         (group_id,profile_id,role,status,is_monthly,joined_at,removed_at,removal_count)
       values($1,$2,'organizer','active',false,'2026-01-01T00:00:00Z',null,0),
             ($1,$3,'player','removed',false,'2026-03-01T00:00:00Z','2026-04-05T06:07:08.654321Z',2),
             ($1,$4,'player','active',false,'2026-02-01T00:00:00Z',null,0)`,
      [
        groupsFixture.otherGroup,
        groupsFixture.otherOwner,
        groupsFixture.titular,
        groupsFixture.third,
      ],
    );
    await db.query('commit');
  } catch (error) {
    await db.query('rollback').catch(() => {});
    throw error;
  }
}

async function proveGroupsThroughEdge(db, env, token) {
  await insertGroupsFixture(db);
  const queued = await db.query(
    `select count(*)::integer as count from private.external_effects
      where status in ('pending','failed_retryable')`,
  );
  assert.equal(queued.rows[0].count, 0, 'another pending effect would reach the real worker');

  const requested = await fetch(`${env.functions}/identity/request_data_export`, {
    method: 'POST',
    headers: {
      apikey: env.publishable,
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ request_id: crypto.randomUUID() }),
  });
  assert.equal(requested.status, 200, `request_data_export failed: ${await requested.text()}`);
  const exportRow = (
    await db.query('select id from private.data_exports where profile_id=$1', [
      groupsFixture.titular,
    ])
  ).rows[0];
  assert.ok(exportRow, 'the gateway did not create the export');

  // O slot deste minuto pode ter sido consumido por outro harness.
  await db.query(
    `delete from private.job_runs
      where job_name='process_external_effects'
        and scheduled_for=date_trunc('minute', clock_timestamp())`,
  );
  const worker = await fetch(`${env.functions}/worker/process_external_effects`, {
    method: 'POST',
    headers: {
      apikey: env.publishable,
      Authorization: `Bearer ${localWorkerCronSecret()}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(worker.status, 200, `the worker returned ${worker.status}`);
  const built = await db.query(
    `select export.status,
            (select status from private.external_effects
              where dedupe_key='build_data_export:'||export.id::text) as build_status
       from private.data_exports export where export.id=$1`,
    [exportRow.id],
  );
  assert.deepEqual(built.rows[0], { status: 'ready', build_status: 'succeeded' });

  const downloaded = await fetch(`${env.functions}/data-exports/${exportRow.id}/content`, {
    headers: { apikey: env.publishable, Authorization: `Bearer ${token}` },
    redirect: 'manual',
  });
  assert.equal(downloaded.status, 200, 'the real export was not delivered');
  const zip = new Uint8Array(await downloaded.arrayBuffer());
  const entries = readStoredZip(zip);
  const groupsBytes = entries.get('groups.json');
  assert.ok(groupsBytes, 'the real ZIP has no groups.json');
  assert.equal(
    Buffer.from(groupsBytes).toString('hex'),
    Buffer.from(EXPECTED_GROUPS_JSON, 'utf8').toString('hex'),
    `groups.json differs byte for byte: ${new TextDecoder().decode(groupsBytes)}`,
  );
  const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));
  const listed = manifest.files.find((file) => file.name === 'groups.json');
  assert.deepEqual(listed, {
    name: 'groups.json',
    size: groupsBytes.length,
    sha256: Buffer.from(await crypto.subtle.digest('SHA-256', groupsBytes)).toString('hex'),
  });
  console.log(
    `ok - real Edge export: groups.json equals the expected ${groupsBytes.length} bytes and matches the manifest`,
  );

  // Allowlist negativa sobre o ZIP inteiro: nenhum membro terceiro, dono
  // alheio, localizador de foto, digest, nonce ou chave proibida.
  const zipText = Buffer.from(zip).toString('latin1');
  const zipUtf8 = new TextDecoder().decode(zip);
  for (const forbidden of [
    groupsFixture.third,
    groupsFixture.otherOwner,
    groupsFixture.thirdName,
    groupsFixture.otherOwnerName,
    groupsFixture.photo,
    groupsFixture.digest,
    groupsFixture.nonceHex,
    groupsFixture.invite,
    'photo_url',
    'owner_id',
    'profile_id',
    'token_digest',
    'public_nonce',
    'created_by',
    '"token',
  ]) {
    assert.ok(
      !zipText.includes(forbidden) && !zipUtf8.includes(forbidden),
      `the real export ZIP carries a forbidden value: ${forbidden}`,
    );
  }
  for (const row of JSON.parse(new TextDecoder().decode(groupsBytes))) {
    assert.deepEqual(Object.keys(row).sort(), [
      'group_id',
      'group_name',
      'is_monthly',
      'joined_at',
      'removal_count',
      'removed_at',
      'role',
      'status',
    ]);
  }
  console.log(
    'ok - real Edge export: no third member, foreign owner, photo locator, digest, nonce or forbidden key',
  );
  await cleanupGroupsFixture(db, env);
}

async function tableCounts(client, schemas) {
  const tables = await client.query(
    `select table_schema, table_name
       from information_schema.tables
      where table_type='BASE TABLE' and table_schema=any($1::text[])
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

// Remove o export real, o purge que o download enfileirou, o objeto e o
// grafo de grupos. Roda ao fim da prova, para que o purge pendente não chegue
// às aquisições seguintes do harness, e de novo na limpeza final.
async function cleanupGroupsFixture(db, env) {
  const groupObjects = await db
    .query(
      `select name from storage.objects
        where bucket_id='data-exports' and name like 'exports/' || $1 || '/%'`,
      [groupsFixture.titular],
    )
    .catch(() => ({ rows: [] }));
  if (groupObjects.rows.length > 0) {
    await fetch(`${env.api}/storage/v1/object/data-exports`, {
      method: 'DELETE',
      headers: {
        apikey: env.secret,
        Authorization: `Bearer ${env.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prefixes: groupObjects.rows.map((row) => row.name) }),
    }).catch(() => {});
  }
  await db
    .query(
      `delete from private.external_effects
        where resource_id in (select id from private.data_exports where profile_id=any($1::uuid[]))`,
      [groupsProfiles],
    )
    .catch(() => {});
  await db
    .query('delete from private.idempotency_records where actor_id=any($1::uuid[])', [
      groupsProfiles,
    ])
    .catch(() => {});
  await db
    .query('delete from private.data_exports where profile_id=any($1::uuid[])', [groupsProfiles])
    .catch(() => {});
  await db
    .query('delete from public.privacy_requests where profile_id=any($1::uuid[])', [groupsProfiles])
    .catch(() => {});
  await db.query('begin').catch(() => {});
  await db
    .query('delete from public.group_invites where group_id=any($1::uuid[])', [groupsIds])
    .catch(() => {});
  await db
    .query('delete from public.group_members where group_id=any($1::uuid[])', [groupsIds])
    .catch(() => {});
  await db.query('delete from public.groups where id=any($1::uuid[])', [groupsIds]).catch(() => {});
  await db.query('commit').catch(() => {});
  await db
    .query('delete from public.profiles where id=any($1::uuid[])', [groupsProfiles])
    .catch(() => {});
}

async function cleanup(db, env) {
  await cleanupGroupsFixture(db, env);
  await cleanupSameActorFixture(db);
  for (let index = 0; index < profileIds.length; index += 1) {
    await fetch(`${env.api}/storage/v1/object/data-exports`, {
      method: 'DELETE',
      headers: {
        apikey: env.secret,
        Authorization: `Bearer ${env.secret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prefixes: [objectPath(profileIds[index], exportIds[index])] }),
    }).catch(() => {});
  }
  await db
    .query(
      `delete from private.external_effects
       where resource_id=any($1::uuid[])
          or resource_id=any($2::uuid[])
          or resource_id in (select id from private.deletion_requests where profile_id=any($2::uuid[]))`,
      [exportIds, profileIds],
    )
    .catch(() => {});
  await db
    .query('delete from private.revoked_auth_sessions where profile_id=any($1::uuid[])', [
      profileIds,
    ])
    .catch(() => {});
  await db
    .query('delete from private.idempotency_records where actor_id=any($1::uuid[])', [profileIds])
    .catch(() => {});
  await db
    .query('delete from private.deletion_requests where profile_id=any($1::uuid[])', [profileIds])
    .catch(() => {});
  await db
    .query('delete from private.data_exports where id=any($1::uuid[])', [exportIds])
    .catch(() => {});
  await db
    .query('delete from public.privacy_requests where id=any($1::uuid[])', [requestIds])
    .catch(() => {});
  await db
    .query('delete from public.profiles where id=any($1::uuid[])', [profileIds])
    .catch(() => {});
  for (const userId of userIds)
    if (userId) {
      await fetch(`${env.api}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          apikey: env.secret,
          Authorization: `Bearer ${env.secret}`,
        },
      }).catch(() => {});
    }
  // Usuários com a marca que a API não removeu ou que uma execução
  // interrompida deixou. Usuário sem a marca nunca é tocado.
  await sweepMarkedAuthUsers(db, AUTH_EMAIL_PREFIX);
}

async function main() {
  const env = environment();
  const db = new Client({ connectionString: env.db, application_name: 'colete_export_main' });
  let tableBaseline;
  let jobBaseline;
  // A limpeza e o censo rodam pelo guard, numa conexão própria, depois de o
  // corpo terminar ou de o trabalho em voo assentar. Se o censo reprovar, o
  // guard o relata à parte, depois da causa original.
  guard.useDatabase(env.db);
  guard.onCleanup(async (client) => {
    await cleanup(client, env);
    if (jobBaseline !== undefined) {
      await client.query('delete from private.job_runs where id > $1', [jobBaseline]);
    }
  });
  guard.onCensus(async (client) => {
    if (tableBaseline === undefined) {
      console.error('# db:test:export: no baseline was taken; residue census skipped');
      return;
    }
    await assertResidueCensus(client, tableBaseline);
  });
  await db.connect();
  try {
    // Varredura inicial: fixture de IDs fixos e usuários com a marca que uma
    // execução interrompida tenha deixado.
    await cleanup(db, env);
    tableBaseline = await tableCounts(db, ['public', 'private', 'auth', 'storage']);
    jobBaseline = Number(
      (await db.query('select coalesce(max(id), 0)::text as id from private.job_runs')).rows[0].id,
    );
    // Cada lote assenta inteiro antes de uma falha subir: nenhuma criação de
    // usuário continua em voo durante a limpeza.
    const tokens = await allCreated(profileIds.map((_, index) => createActor(env, index)));
    const [groupsToken] = await allCreated(
      [0, 1, 2].map((offset) => createActor(env, GROUPS_ACTOR_INDEX + offset)),
    );
    await proveGroupsThroughEdge(db, env, groupsToken);
    await proveSameActorExport(db, env);
    await db.query(
      `insert into public.profiles(id,auth_user_id,name)
      select * from unnest($1::uuid[],$2::uuid[],$3::text[])`,
      [
        profileIds,
        userIds.slice(0, profileIds.length),
        [
          'Winner',
          'Expired',
          'Revoked',
          'Zero bytes',
          'Deterministic',
          'Deadlock',
          'Crash then delete',
          'Crash then expire',
          'Crash without upload',
        ],
      ],
    );
    if (selectedReviewProof === undefined || ['1', '3'].includes(selectedReviewProof)) {
      await db.query('update public.profiles set photo_url=$2 where id=$1', [
        profileIds[6],
        `avatars/${profileIds[6]}/avatar.webp`,
      ]);
    }
    await db.query(
      `insert into public.privacy_requests(id,profile_id,kind)
      select request_id,profile_id,'access' from unnest($1::uuid[],$2::uuid[]) fixture(request_id,profile_id)`,
      [requestIds, profileIds],
    );
    await db.query(
      `insert into private.data_exports(id,privacy_request_id,profile_id,status,storage_path,
      content_digest,ready_at,expires_at) select export_id,request_id,profile_id,'ready',
      'exports/'||profile_id||'/'||export_id||'.zip',repeat('a',64),now(),
      case when ordinality=2 then now()-interval '1 second' else now()+interval '1 hour' end
      from unnest($1::uuid[],$2::uuid[],$3::uuid[]) with ordinality fixture(export_id,request_id,profile_id,ordinality)`,
      [exportIds.slice(0, 4), requestIds.slice(0, 4), profileIds.slice(0, 4)],
    );
    await db.query(
      `insert into private.data_exports(id,privacy_request_id,profile_id)
       select * from unnest($1::uuid[],$2::uuid[],$3::uuid[])`,
      [exportIds.slice(4), requestIds.slice(4), profileIds.slice(4)],
    );
    await db.query(
      `insert into private.external_effects
        (id,kind,resource_type,resource_id,dedupe_key,status,attempts,lease_token,lease_until)
       values
        ('13900000-0000-4000-8000-000000000005','build_data_export','data_export',$1::uuid,
         'build_data_export:'||$1::uuid::text,'leased',1,'13900000-0000-4000-8000-000000000015',clock_timestamp()+interval '1 hour'),
        ('13900000-0000-4000-8000-000000000006','build_data_export','data_export',$2::uuid,
         'build_data_export:'||$2::uuid::text,'leased',1,'13900000-0000-4000-8000-000000000016',clock_timestamp()+interval '1 hour'),
        ('13900000-0000-4000-8000-000000000007','build_data_export','data_export',$3::uuid,
         'build_data_export:'||$3::uuid::text,'leased',1,'13900000-0000-4000-8000-000000000017',clock_timestamp()+interval '1 hour'),
        ('13900000-0000-4000-8000-000000000008','build_data_export','data_export',$4::uuid,
         'build_data_export:'||$4::uuid::text,'leased',1,'13900000-0000-4000-8000-000000000018',clock_timestamp()+interval '1 hour'),
        ('13900000-0000-4000-8000-000000000009','build_data_export','data_export',$5::uuid,
         'build_data_export:'||$5::uuid::text,'leased',1,'13900000-0000-4000-8000-000000000019',clock_timestamp()+interval '1 hour')`,
      [exportIds[4], exportIds[5], exportIds[6], exportIds[7], exportIds[8]],
    );
    await Promise.all(
      [0, 1, 2, 3].map((index) => upload(env, index, new TextEncoder().encode(`zip-${index}`))),
    );

    const firstTarget = (
      await db.query(`select public.worker_get_data_export_build_target($1,$2) as target`, [
        '13900000-0000-4000-8000-000000000005',
        '13900000-0000-4000-8000-000000000015',
      ])
    ).rows[0].target;
    const secondTarget = (
      await db.query(`select public.worker_get_data_export_build_target($1,$2) as target`, [
        '13900000-0000-4000-8000-000000000005',
        '13900000-0000-4000-8000-000000000015',
      ])
    ).rows[0].target;
    const exportAuth = { email: userEmails[4], providers: ['email'] };
    const firstArtifact = await buildDataExport({ ...firstTarget.snapshot, auth: exportAuth });
    const secondArtifact = await buildDataExport({ ...secondTarget.snapshot, auth: exportAuth });
    assert.deepEqual(
      firstArtifact.bytes,
      secondArtifact.bytes,
      'retry rebuilt different ZIP bytes',
    );
    assert.equal(
      firstArtifact.digest,
      secondArtifact.digest,
      'retry rebuilt a different ZIP digest',
    );
    assert.equal(
      firstTarget.snapshot.snapshot_at,
      secondTarget.snapshot.snapshot_at,
      'retry changed the persisted snapshot instant',
    );
    console.log(
      `ok - repeated real build target produced identical bytes and digest ${firstArtifact.digest}`,
    );

    if (selectedReviewProof === '4') {
      await db.query(
        "select public.worker_complete_external_effect($1,$2,'permanent_failure','STORAGE_REQUEST_INVALID')",
        [effectId(4), initialLeaseToken(4)],
      );
      const terminalState = await db.query('select status from private.data_exports where id=$1', [
        exportIds[4],
      ]);
      assert.equal(
        terminalState.rows[0].status,
        'failed',
        'terminal build left export active instead of failed',
      );
      await db.query('select public.request_data_export($1,$2,$3,$4,1,1)', [
        userIds[4],
        sessionIds[4],
        '13900000-0000-4000-8000-000000000030',
        '4'.repeat(64),
      ]);
      console.log('ok - terminal build releases the active slot for a replacement export');
    }

    for (const index of [6, 7, 8]) {
      await db.query('select public.worker_get_data_export_build_target($1,$2)', [
        effectId(index),
        initialLeaseToken(index),
      ]);
    }
    if (selectedReviewProof === undefined || ['1', '3'].includes(selectedReviewProof)) {
      await upload(env, 6, new TextEncoder().encode('uploaded-before-delete-crash'));
    }
    await upload(env, 7, new TextEncoder().encode('uploaded-before-expiry-crash'));
    if (selectedReviewProof === undefined || ['1', '3'].includes(selectedReviewProof)) {
      await db.query(
        "select public.worker_complete_external_effect($1,$2,'retryable_failure','STORAGE_UNAVAILABLE')",
        [effectId(6), initialLeaseToken(6)],
      );
      await db.query('select public.delete_account($1,$2,$3,$4,1,1)', [
        userIds[6],
        sessionIds[6],
        '13900000-0000-4000-8000-000000000027',
        'e'.repeat(64),
      ]);
      const avatarEffect = (
        await db.query(
          "select public.worker_acquire_external_effect(array['delete_storage_object']::text[]) as effect",
        )
      ).rows[0].effect;
      assert.equal(
        avatarEffect?.resource_id,
        profileIds[6],
        'export-orphan: avatar purge was not acquired first',
      );
      await deletionHandler(db, env, [])(avatarEffect);
      await completeEffect(db, avatarEffect);
      if (selectedReviewProof === undefined || selectedReviewProof === '1') {
        const afterAvatar = await db.query(
          `select request.status,profile.photo_url
             from private.deletion_requests request
             join public.profiles profile on profile.id=request.profile_id
            where request.profile_id=$1`,
          [profileIds[6]],
        );
        assert.deepEqual(
          afterAvatar.rows[0],
          { status: 'cleaning_storage', photo_url: null },
          'export-orphan: saga advanced after avatar purge while build was retryable',
        );
        const authBeforeBuildRetry = (
          await db.query(
            "select public.worker_acquire_external_effect(array['delete_auth_user']::text[]) as effect",
          )
        ).rows[0].effect;
        assert.equal(
          authBeforeBuildRetry,
          null,
          'export-orphan: delete_auth_user became acquirable while the crashed build could still reveal an object',
        );
      }
      await db.query(
        "update private.external_effects set next_attempt_at=clock_timestamp()-interval '1 second' where id=$1",
        [effectId(6)],
      );
      const terminalBuild = (
        await db.query(
          "select public.worker_acquire_external_effect(array['build_data_export']::text[]) as effect",
        )
      ).rows[0].effect;
      assert.equal(terminalBuild?.id, effectId(6), 'terminal build was not reacquired');
      await db.query(
        "select public.worker_complete_external_effect($1,$2,'permanent_failure','STORAGE_REQUEST_INVALID')",
        [terminalBuild.id, terminalBuild.lease_token],
      );
      const terminalPurge = (
        await db.query(
          "select public.worker_acquire_external_effect(array['delete_data_export']::text[]) as effect",
        )
      ).rows[0].effect;
      assert.equal(
        terminalPurge?.resource_id,
        exportIds[6],
        'terminal build did not enqueue deterministic purge',
      );
      const terminalPaths = [];
      await deletionHandler(db, env, terminalPaths)(terminalPurge);
      await completeEffect(db, terminalPurge);
      await completeDeletionSaga(db, env, 6, 'terminal-build-after-avatar');
      const terminalObject = await fetch(
        `${env.api}/storage/v1/object/data-exports/${objectPath(profileIds[6], exportIds[6])}`,
        { headers: { apikey: env.secret, Authorization: `Bearer ${env.secret}` } },
      );
      assert.notEqual(terminalObject.status, 200, 'terminal build left its uploaded object behind');
      assert.ok(
        terminalPaths.every((value) => value === objectPath(profileIds[6], exportIds[6])),
        'terminal build purge did not use the deterministic path',
      );
      console.log(
        'ok - avatar purge stayed fenced by retryable build; terminal build converted to deterministic purge and completed deletion',
      );
    }
    await db.query("update private.data_exports set status='expired',purged_at=now() where id=$1", [
      exportIds[7],
    ]);
    await db.query("update private.data_exports set status='failed',purged_at=now() where id=$1", [
      exportIds[8],
    ]);

    const selectedOrphanCase = process.env.COLETE_EXPORT_ORPHAN_CASE;
    const orphanCases = [
      [7, 'expired-after-upload', 'expired'],
      [8, 'cancelled-without-upload', 'failed'],
    ].filter(([, label]) => selectedOrphanCase === undefined || selectedOrphanCase === label);
    assert.ok(orphanCases.length > 0, `unknown COLETE_EXPORT_ORPHAN_CASE: ${selectedOrphanCase}`);
    for (const [index, label, expectedStatus] of orphanCases) {
      await retryAbortedBuildAndPurge(db, env, index, label, expectedStatus);
    }

    if (selectedReviewProof === '6') {
      const deletion = (
        await db.query('select public.delete_account($1,$2,$3,$4,1,1) response', [
          userIds[8],
          sessionIds[8],
          '13900000-0000-4000-8000-000000000029',
          '9'.repeat(64),
        ])
      ).rows[0].response;
      const requestId = deletion.outcome.deletion_request_id;
      await db.query(
        `insert into private.external_effects(kind,resource_type,resource_id,dedupe_key)
         values('delete_data_export','data_export',$1::uuid,
                'delete_data_export:'||$1::uuid::text||':'||$2::uuid::text)`,
        [exportIds[8], requestId],
      );
      await db.query(
        `update private.external_effects
            set status='dead',attempts=8,last_error_code='STORAGE_UNAVAILABLE',completed_at=now()
          where resource_id=$1::uuid
            and dedupe_key='delete_data_export:'||$1::uuid::text||':'||$2::uuid::text`,
        [exportIds[8], requestId],
      );
      await completeDeletionSaga(db, env, 8, 'pathless-dead-purge-marker');
      const projection = (
        await db.query('select private.deletion_request_projection($1) projection', [profileIds[8]])
      ).rows[0].projection;
      assert.equal(
        projection.has_operational_failure,
        true,
        'completed deletion lost durable operational failure marker',
      );
      console.log('ok - completed pathless dead purge preserves the durable failure marker');
    } else {
      await upload(env, 8, new TextEncoder().encode('known-path-dead-purge'));
      await db.query(
        `update private.data_exports
            set status='ready',storage_path=$2,content_digest=$3,ready_at=now(),
                expires_at=now()+interval '1 hour',downloaded_at=null,purged_at=null
          where id=$1`,
        [exportIds[8], objectPath(profileIds[8], exportIds[8]), '9'.repeat(64)],
      );
      await db.query('select public.delete_account($1,$2,$3,$4,1,1)', [
        userIds[8],
        sessionIds[8],
        '13900000-0000-4000-8000-000000000029',
        '9'.repeat(64),
      ]);
      const deadPurge = (
        await db.query(
          "select public.worker_acquire_external_effect(array['delete_data_export']::text[]) as effect",
        )
      ).rows[0].effect;
      assert.equal(deadPurge?.resource_id, exportIds[8], 'known-path purge was not acquired');
      await db.query(
        "select public.worker_complete_external_effect($1,$2,'permanent_failure','STORAGE_REQUEST_INVALID')",
        [deadPurge.id, deadPurge.lease_token],
      );
      await completeDeletionSaga(db, env, 8, 'known-path-dead-purge');
      const durableFailure = await db.query(
        `select request.status,request.auth_user_id,request.last_error_code,
                request.has_operational_failure,
                private.deletion_request_projection(request.profile_id) projection,
                export.status export_status,export.purged_at,export.storage_path
           from private.deletion_requests request
           join private.data_exports export on export.profile_id=request.profile_id
          where request.profile_id=$1`,
        [profileIds[8]],
      );
      assert.equal(durableFailure.rows[0].status, 'completed');
      assert.equal(durableFailure.rows[0].auth_user_id, null);
      assert.equal(durableFailure.rows[0].last_error_code, null);
      assert.equal(durableFailure.rows[0].has_operational_failure, true);
      assert.equal(durableFailure.rows[0].projection.has_operational_failure, true);
      assert.deepEqual(Object.keys(durableFailure.rows[0].projection).sort(), [
        'completed_at',
        'has_operational_failure',
        'id',
        'requested_at',
        'status',
      ]);
      assert.equal(durableFailure.rows[0].export_status, 'failed');
      assert.equal(durableFailure.rows[0].purged_at, null);
      assert.equal(
        durableFailure.rows[0].storage_path,
        objectPath(profileIds[8], exportIds[8]),
        'dead purge lost the private recovery locator',
      );
      const sensitiveOperationalText = await db.query(
        `select exists(
           select 1 from private.external_effects
            where last_error_code is not null
              and last_error_code ~* '(exports/|token|@|example[.]invalid)'
           union all
           select 1 from private.job_runs
            where coalesce(summary::text,'') ~* '(exports/|token|@|example[.]invalid)'
         ) leaked`,
      );
      assert.equal(sensitiveOperationalText.rows[0].leaked, false);
      console.log(
        'ok - known-path dead purge advances to completed with durable boolean, redacted text and purged_at null',
      );
    }

    const deleter = new Client({
      connectionString: env.db,
      application_name: 'colete_export_deadlock_delete',
    });
    const builder = new Client({
      connectionString: env.db,
      application_name: 'colete_export_deadlock_build',
    });
    await Promise.all([deleter.connect(), builder.connect()]);
    let deletionError;
    let deletionResponse;
    let buildResult;
    try {
      await deleter.query('begin isolation level read committed');
      await builder.query('begin isolation level read committed');
      await deleter.query('select id from public.profiles where id=$1 for update', [profileIds[5]]);
      const buildPending = builder
        .query('select public.worker_get_data_export_build_target($1,$2) as target', [
          '13900000-0000-4000-8000-000000000006',
          '13900000-0000-4000-8000-000000000016',
        ])
        .then(
          ({ rows }) => ({ target: rows[0].target }),
          (error) => ({ error }),
        );
      await new Promise((resolve) => setTimeout(resolve, 150));
      try {
        deletionResponse = (
          await deleter.query('select public.delete_account($1,$2,$3,$4,1,1) as response', [
            userIds[5],
            sessionIds[5],
            '13900000-0000-4000-8000-000000000026',
            'd'.repeat(64),
          ])
        ).rows[0].response;
        await deleter.query('commit');
      } catch (error) {
        deletionError = error;
        await deleter.query('rollback').catch(() => undefined);
      }
      buildResult = await buildPending;
      await builder.query('error' in buildResult ? 'rollback' : 'commit');
    } finally {
      await Promise.allSettled([deleter.end(), builder.end()]);
    }
    assert.equal(
      deletionError,
      undefined,
      `account deletion lost the lock race: ${deletionError?.code}`,
    );
    assert.equal(
      buildResult.error,
      undefined,
      `export build lost the lock race: ${buildResult.error?.code}`,
    );
    assert.equal(deletionResponse.outcome.logical_result, 'deletion_requested');
    const priority = await db.query(
      'select profile.account_status,export.status from public.profiles profile join private.data_exports export on export.profile_id=profile.id where profile.id=$1',
      [profileIds[5]],
    );
    assert.deepEqual(priority.rows[0], { account_status: 'deletion_pending', status: 'failed' });
    console.log(
      'ok - independent profile-first deletion and export build transactions avoid 40P01; deletion wins',
    );

    const foreign = await download(env, 0, tokens[1]);
    assert.equal(foreign.status, 410, 'another titular learned more than an expired capability');
    const expired = await download(env, 1, tokens[1]);
    assert.equal(expired.status, 410, 'an expired export was consumed');
    const logout = await fetch(`${env.functions}/identity/revoke_current_session`, {
      method: 'POST',
      headers: {
        apikey: env.publishable,
        Authorization: `Bearer ${tokens[2]}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ request_id: crypto.randomUUID() }),
    });
    assert.equal(logout.status, 200, `logout failed: ${await logout.text()}`);
    const revoked = await download(env, 2, tokens[2]);
    assert.equal(revoked.status, 401, 'a revoked session reached the CAS');
    const intact = await db.query(
      'select status,storage_path from private.data_exports where id=$1',
      [exportIds[2]],
    );
    assert.equal(intact.rows[0].status, 'ready');
    assert.ok(intact.rows[0].storage_path);

    const direct = await fetch(
      `${env.api}/storage/v1/object/data-exports/${objectPath(profileIds[0], exportIds[0])}`,
      {
        headers: { apikey: env.publishable, Authorization: `Bearer ${tokens[0]}` },
        redirect: 'manual',
      },
    );
    assert.notEqual(direct.status, 200, 'the owner accessed Storage directly');
    const concurrent = await Promise.all([
      download(env, 0, tokens[0]),
      download(env, 0, tokens[0]),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 410]);
    const winner = concurrent.find((response) => response.status === 200);
    assert.equal(winner.headers.get('cache-control'), 'private, no-store');
    assert.equal(winner.headers.get('content-type'), 'application/zip');
    assert.equal(winner.headers.has('location'), false, 'a redirect/signed URL escaped');
    assert.equal(new TextDecoder().decode(await winner.arrayBuffer()), 'zip-0');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const consumed = await db.query(
      'select status,downloaded_at from private.data_exports where id=$1',
      [exportIds[0]],
    );
    assert.equal(consumed.rows[0].status, 'downloaded');
    assert.ok(consumed.rows[0].downloaded_at);
    const purge = await db.query(
      `select count(*)::integer count from private.external_effects
      where resource_id=$1 and dedupe_key='delete_data_export:'||$1::text`,
      [exportIds[0]],
    );
    assert.equal(purge.rows[0].count, 1, 'stream completion did not enqueue stable purge');

    const zeroByte = await download(env, 3, tokens[3]);
    assert.equal(zeroByte.status, 200, 'post-CAS zero-byte request did not reach the stream');
    assert.ok(zeroByte.body);
    await zeroByte.body.cancel();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const zeroByteState = await db.query(
      `select export.status,
              (select count(*)::integer from private.external_effects effect
               where effect.resource_id=export.id
                 and effect.dedupe_key='delete_data_export:'||export.id::text) purge_count
       from private.data_exports export where export.id=$1`,
      [exportIds[3]],
    );
    assert.deepEqual(zeroByteState.rows[0], { status: 'downloaded', purge_count: 1 });
    console.log(
      'ok - post-CAS cancellation before reading application bytes consumes one-shot and enqueues purge',
    );
    console.log('ok - 2 concurrent HTTP requests, one CAS winner and one EXPORT_EXPIRED');
    console.log('ok - revoked, foreign and expired requests refused; direct Storage inaccessible');
    console.log(
      'ok - stream has attachment ZIP/private no-store, no redirect, and stable purge intent',
    );
  } finally {
    await db.end();
  }
}

async function assertResidueCensus(db, tableBaseline) {
  const tableAfter = await tableCounts(db, ['public', 'private', 'auth', 'storage']);
  const deltas = [...tableAfter].map(([table, count]) => ({
    table,
    before: tableBaseline.get(table) ?? 0,
    after: count,
    delta: count - (tableBaseline.get(table) ?? 0),
  }));
  const changed = deltas.filter(({ delta }) => delta !== 0);
  assert.ok(
    changed.every(({ table }) => table === 'auth.audit_log_entries'),
    `an undeclared table changed across the export harness: ${JSON.stringify(changed)}`,
  );
  const audit = deltas.find(({ table }) => table === 'auth.audit_log_entries');
  console.log(`ok - dynamic residue census by table: ${JSON.stringify(deltas)}`);
  console.log(
    `ok - accepted GoTrue auth.audit_log_entries residue: total=${audit?.after ?? 0}, added=${audit?.delta ?? 0}; every other table matches its baseline`,
  );
}

await guard.run(main);
