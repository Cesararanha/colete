import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { buildDataExport } from '../supabase/functions/_shared/data-export.ts';
import { dataExportBuildHandler } from '../supabase/functions/_shared/data-export.ts';
import { accountDeletionHandlers } from '../supabase/functions/_shared/deletion.ts';

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
  };
}

async function createActor(env, index) {
  const email = `export-harness-${Date.now()}-${index}@colete.test`;
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
  const headers = { apikey: env.secret, Authorization: `Bearer ${env.secret}` };
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
          const response = await fetch(
            `${env.api}/storage/v1/object/${bucket}/${storagePath
              .split('/')
              .map(encodeURIComponent)
              .join('/')}`,
            { method: 'HEAD', headers },
          );
          if (response.status === 400 || response.status === 404) return false;
          assert.equal(response.status, 200, `Storage probe returned ${response.status}`);
          return true;
        },
        remove: async (bucket, storagePath) => {
          const response = await fetch(`${env.api}/storage/v1/object/${bucket}`, {
            method: 'DELETE',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ prefixes: [storagePath] }),
          });
          assert.ok(
            response.ok || response.status === 404,
            `Storage delete returned ${response.status}`,
          );
        },
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

async function cleanup(db, env) {
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
}

async function main() {
  const env = environment();
  const db = new Client({ connectionString: env.db });
  await db.connect();
  let tableBaseline;
  try {
    tableBaseline = await tableCounts(db, ['public', 'private', 'auth', 'storage']);
    const tokens = await Promise.all(profileIds.map((_, index) => createActor(env, index)));
    await db.query(
      `insert into public.profiles(id,auth_user_id,name)
      select * from unnest($1::uuid[],$2::uuid[],$3::text[])`,
      [
        profileIds,
        userIds,
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
      application_name: 'export_deadlock_delete',
    });
    const builder = new Client({
      connectionString: env.db,
      application_name: 'export_deadlock_build',
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
    await cleanup(db, env);
    if (tableBaseline !== undefined) {
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
    await db.end();
  }
}

await main();
