// Fatia 0030 (fotos de perfil e do grupo), pelo caminho HTTP real: Edge
// groups e identity com JWT GoTrue, URL de upload assinada do Storage local,
// worker Edge real e o ZIP da exportação. Prova o que o pgTAP não alcança:
//
// - o caminho do objeto é imposto pelo servidor: a URL assinada não grava em
//   outro caminho, nem duas vezes, e o corpo não escolhe caminho;
// - o Storage recusa outro tipo e mais de 1 MB, e a Edge recusa o JPEG com
//   GPS no Exif antes da troca, apagando o objeto;
// - quem vê: o colega de grupo recebe a URL e lê os bytes; o estranho não
//   recebe nada e nenhum dos dois lê pelo endereço direto do objeto;
// - trocar e remover apagam o objeto antigo pelo worker; a sessão nunca
//   confirmada é recolhida e apagada;
// - a foto do grupo é do dono; o grupo apagado (0029) deixa de mostrá-la;
// - a exportação leva a própria foto; a exclusão de conta não deixa objeto;
// - contraprova executável: sem a regra de grupo em comum, o estranho vê.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import sharp from 'sharp';

import { harnessEmail, harnessEmailPattern, installHarnessGuard } from './harness-guard.mjs';
import { localWorkerCronSecret } from './local-worker-test-config.mjs';

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supabase = path.join(root, 'node_modules', '.bin', 'supabase');
const AUTH_PREFIX = 'photos-';
const APP_PREFIX = 'colete_photos_';
const PASSWORD = 'colete-local-photos-harness-password';
const VISIBLE = 'public.get_visible_photos(uuid,uuid,uuid[],uuid[],boolean)';
const guard = installHarnessGuard('db:test:photos', {
  applicationPrefix: APP_PREFIX,
  authEmailPrefix: AUTH_PREFIX,
});

// Tudo o que o harness cria, para a limpeza achar também o perfil
// desidentificado pela exclusão de conta, que já não tem e-mail.
const created = { profiles: new Set(), authIds: new Set() };

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
    serviceRoleKey: read('SERVICE_ROLE_KEY'),
  };
}
function client(dbUrl, name) {
  return new Client({
    connectionString: dbUrl,
    application_name: `${APP_PREFIX}${name}`,
    connectionTimeoutMillis: 5000,
  });
}

// ---------------------------------------------------------------------------
// Imagens: JPEG limpo, JPEG com GPS no Exif, PNG
// ---------------------------------------------------------------------------
async function jpeg(width, height, { gps = false, hue = 120 } = {}) {
  let image = sharp({
    create: { width, height, channels: 3, background: { r: 30, g: hue, b: 200 } },
  });
  if (gps) {
    image = image.withExif({
      IFD0: { Make: 'Colete Harness Camera' },
      IFD3: {
        GPSLatitudeRef: 'S',
        GPSLatitude: '23/1 33/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '46/1 38/1 0/1',
      },
    });
  }
  return new Uint8Array(await image.jpeg({ quality: 80 }).toBuffer());
}
// O IFD0 do Exif aponta para o diretório de GPS (tag 0x8825).
function hasGpsPointer(bytes) {
  const buffer = Buffer.from(bytes);
  const exif = buffer.indexOf('Exif\0\0', 0, 'latin1');
  if (exif < 0) return false;
  const tiff = exif + 6;
  const little = buffer.readUInt16BE(tiff) === 0x4949;
  const u16 = (at) => (little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at));
  const u32 = (at) => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
  const ifd = tiff + u32(tiff + 4);
  for (let entry = 0; entry < u16(ifd); entry += 1) {
    if (u16(ifd + 2 + entry * 12) === 0x8825) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function edge(status, route, body, token) {
  const response = await fetch(`${status.functionsUrl}/${route}`, {
    method: 'POST',
    headers: {
      apikey: status.publishableKey,
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
function mutate(status, actor, operation, body = {}, requestId = crypto.randomUUID()) {
  return edge(status, `groups/${operation}`, { ...body, request_id: requestId }, actor.token);
}
function ok(response, label) {
  assert.equal(response.status, 200, `${label}: ${JSON.stringify(response.body)}`);
  return response.body.data;
}
function denied(response, status, code, label) {
  assert.equal(response.status, status, `${label}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.error?.code, code, label);
  assert.equal(Object.hasOwn(response.body, 'data'), false, label);
}
async function putSigned(status, url, bytes, contentType = 'image/jpeg') {
  const response = await fetch(`${status.apiUrl}${url}`, {
    method: 'PUT',
    headers: { 'content-type': contentType, 'x-upsert': 'false' },
    body: bytes,
  });
  await response.arrayBuffer();
  return response.status;
}
async function getBytes(url, headers = {}) {
  const response = await fetch(url, { headers });
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}
async function photoUrls(status, actor, profileIds = [], groupIds = []) {
  return ok(
    await edge(
      status,
      'groups/get_photo_urls',
      { profile_ids: profileIds, group_ids: groupIds },
      actor.token,
    ),
    'get_photo_urls',
  );
}
async function objects(db, bucket, prefix) {
  return (
    await db.query(
      `select name from storage.objects where bucket_id = $1 and name like $2 order by name`,
      [bucket, `${prefix}%`],
    )
  ).rows.map((row) => row.name);
}
async function removeObjects(status, bucket, names) {
  if (names.length === 0) return;
  const response = await fetch(`${status.apiUrl}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: {
      apikey: status.serviceRoleKey,
      Authorization: `Bearer ${status.serviceRoleKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prefixes: names }),
  });
  assert.ok(response.ok || response.status === 404, `Storage cleanup returned ${response.status}`);
}

async function createActor(status, label) {
  const email = harnessEmail(AUTH_PREFIX, `${crypto.randomUUID()}-${label}`);
  const made = await fetch(`${status.apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: status.secretKey,
      Authorization: `Bearer ${status.secretKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  assert.equal(made.status, 200, `create ${label}: ${made.status}`);
  const user = await made.json();
  created.authIds.add(user.id);
  const signed = await fetch(`${status.apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: status.publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(signed.status, 200, `sign in ${label}: ${signed.status}`);
  const session = await signed.json();
  const actor = { authId: user.id, token: session.access_token, label };
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
  created.profiles.add(actor.profileId);
  return actor;
}

async function worker(db, status, job) {
  // O slot corrente pode ter sido consumido por outro harness ou pelo cron
  // local; a linha é estado de teste e sai para esta invocação valer.
  await db.query(
    `delete from private.job_runs where job_name = $1
      and scheduled_for > clock_timestamp() - interval '6 minutes'`,
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

/** Opens a session, sends `bytes` to its signed URL and returns the session. */
async function upload(status, actor, bytes, target = { target: 'profile' }) {
  const started = ok(await mutate(status, actor, 'begin_photo_upload', target), 'begin');
  assert.ok(started.upload, 'a new session carries its signed URL');
  assert.equal(await putSigned(status, started.upload.url, bytes), 200, 'signed upload');
  return started.upload;
}
async function setProfilePhoto(status, actor, bytes) {
  const session = await upload(status, actor, bytes);
  ok(await mutate(status, actor, 'set_profile_photo', { upload_id: session.upload_id }), 'set');
  return session;
}
async function photoUrl(db, profileId) {
  return (await db.query('select photo_url from public.profiles where id = $1', [profileId]))
    .rows[0].photo_url;
}

// ---------------------------------------------------------------------------
// Prova 1: caminho imposto pelo servidor; tipo, tamanho e Exif recusados
// ---------------------------------------------------------------------------
async function proveUploadRules(status, db, owner) {
  denied(
    await mutate(status, owner, 'begin_photo_upload', {
      target: 'profile',
      path: `${owner.profileId}/escolhido.jpg`,
    }),
    422,
    'VALIDATION',
    'the body cannot choose a path',
  );
  const started = ok(
    await mutate(status, owner, 'begin_photo_upload', { target: 'profile' }),
    'begin',
  );
  const session = started.upload;
  const expected = `/storage/v1/object/upload/sign/avatars/${owner.profileId}/${session.upload_id}.jpg?token=`;
  assert.ok(
    session.url.startsWith(expected),
    `the signed URL names the server path: ${session.url}`,
  );
  const row = (
    await db.query('select object_path, state from private.photo_uploads where id = $1', [
      session.upload_id,
    ])
  ).rows[0];
  assert.deepEqual(row, {
    object_path: `${owner.profileId}/${session.upload_id}.jpg`,
    state: 'pending',
  });
  console.log('ok - the database decides <profile_id>/<upload_id>.jpg; the body cannot name one');

  const token = session.url.split('?token=')[1];
  const elsewhere = `/storage/v1/object/upload/sign/avatars/${owner.profileId}/escolhido.jpg?token=${token}`;
  assert.notEqual(await putSigned(status, elsewhere, await jpeg(64, 64)), 200);
  assert.deepEqual(await objects(db, 'avatars', `${owner.profileId}/escolhido`), []);
  const png = new Uint8Array(
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
      .png()
      .toBuffer(),
  );
  assert.notEqual(await putSigned(status, session.url, png, 'image/png'), 200, 'PNG accepted');
  const oversized = new Uint8Array(1_048_577);
  oversized.set([0xff, 0xd8, 0xff]);
  assert.notEqual(await putSigned(status, session.url, oversized), 200, 'more than 1 MB accepted');
  assert.deepEqual(await objects(db, 'avatars', `${owner.profileId}/`), []);
  console.log(
    'ok - the signed URL writes no other path; Storage refuses image/png and 1 MB + 1 byte',
  );

  const withGps = await jpeg(400, 300, { gps: true });
  assert.ok(hasGpsPointer(withGps), 'the fixture really carries a GPS directory');
  assert.equal(await putSigned(status, session.url, withGps), 200, 'Storage trusts the type');
  assert.notEqual(await putSigned(status, session.url, await jpeg(64, 64)), 200, 'rewrite');
  denied(
    await mutate(status, owner, 'set_profile_photo', { upload_id: session.upload_id }),
    422,
    'VALIDATION',
    'a photo with GPS in its Exif',
  );
  assert.deepEqual(await objects(db, 'avatars', `${owner.profileId}/`), [], 'GPS photo kept');
  assert.equal(await photoUrl(db, owner.profileId), null, 'GPS photo swapped in');
  console.log(
    'ok - a JPEG with GPS in its Exif is deleted by the Edge before the swap; the photo stays as it was',
  );

  const notJpeg = await upload(status, owner, new TextEncoder().encode('not really a jpeg'));
  denied(
    await mutate(status, owner, 'set_profile_photo', { upload_id: notJpeg.upload_id }),
    422,
    'VALIDATION',
    'bytes that are not a JPEG',
  );
  const tooLarge = await upload(status, owner, await jpeg(800, 600));
  denied(
    await mutate(status, owner, 'set_profile_photo', { upload_id: tooLarge.upload_id }),
    422,
    'VALIDATION',
    'more than 512 px',
  );
  const neverSent = ok(
    await mutate(status, owner, 'begin_photo_upload', { target: 'profile' }),
    'b',
  );
  denied(
    await mutate(status, owner, 'set_profile_photo', { upload_id: neverSent.upload.upload_id }),
    422,
    'VALIDATION',
    'a session whose object never arrived',
  );
  console.log('ok - declared JPEG that is not one, 800 px and a missing object are refused');

  const clean = await jpeg(512, 384);
  const good = await upload(status, owner, clean);
  assert.notEqual(await putSigned(status, good.url, await jpeg(64, 64)), 200, 'second write');
  const requestId = crypto.randomUUID();
  const swapped = ok(
    await mutate(status, owner, 'set_profile_photo', { upload_id: good.upload_id }, requestId),
    'set',
  );
  assert.equal(swapped.outcome.logical_result, 'profile_photo_set');
  assert.equal(await photoUrl(db, owner.profileId), `${owner.profileId}/${good.upload_id}.jpg`);
  const replay = ok(
    await mutate(status, owner, 'set_profile_photo', { upload_id: good.upload_id }, requestId),
    'replay',
  );
  assert.deepEqual(replay.outcome, swapped.outcome, 'the replay returns the recorded outcome');
  assert.equal(JSON.stringify(swapped).includes('.jpg'), false, 'a path left the Edge');
  console.log(
    'ok - a clean 512 px JPEG becomes the photo; the signed URL writes once; the replay repeats the outcome',
  );
  return { bytes: clean, path: `${owner.profileId}/${good.upload_id}.jpg` };
}

// ---------------------------------------------------------------------------
// Prova 2: quem vê, inclusive pelo endereço direto
// ---------------------------------------------------------------------------
async function proveVisibility(status, db, { owner, member, stranger, groupId }, photo) {
  const forMember = await photoUrls(status, member, [owner.profileId]);
  const url = forMember.profiles[owner.profileId];
  assert.equal(forMember.expires_in, 300);
  assert.ok(url?.startsWith('/storage/v1/object/sign/avatars/'), JSON.stringify(forMember));
  const read = await getBytes(`${status.apiUrl}${url}`);
  assert.equal(read.status, 200, 'the member reads the photo by its signed URL');
  assert.deepEqual(Buffer.from(read.bytes), Buffer.from(photo.bytes));
  assert.deepEqual(await photoUrls(status, stranger, [owner.profileId]), {
    expires_in: 300,
    self: null,
    profiles: {},
    groups: {},
  });
  const own = ok(
    await edge(status, 'groups/get_photo_urls', { self: true }, owner.token),
    'own photo',
  );
  assert.ok(own.self?.startsWith('/storage/v1/object/sign/avatars/'), JSON.stringify(own));
  assert.deepEqual(own.profiles, {}, 'the own photo is never keyed by the own ID');
  assert.equal((await getBytes(`${status.apiUrl}${own.self}`)).status, 200);
  console.log(
    'ok - a co-member gets a 5-minute signed URL and the exact bytes; a stranger gets none; the owner gets their own by the self flag',
  );

  for (const [label, token] of [
    ['stranger', stranger.token],
    ['member', member.token],
    ['owner', owner.token],
  ]) {
    for (const route of ['object', 'object/authenticated']) {
      const direct = await getBytes(`${status.apiUrl}/storage/v1/${route}/avatars/${photo.path}`, {
        apikey: status.publishableKey,
        Authorization: `Bearer ${token}`,
      });
      assert.notEqual(direct.status, 200, `${label} read ${route} directly`);
    }
  }
  const publicRead = await getBytes(
    `${status.apiUrl}/storage/v1/object/public/avatars/${photo.path}`,
  );
  assert.notEqual(publicRead.status, 200, 'the public endpoint served a private photo');
  const token = url.split('?token=')[1];
  const forged = await getBytes(
    `${status.apiUrl}/storage/v1/object/sign/avatars/${stranger.profileId}/x.jpg?token=${token}`,
  );
  assert.notEqual(forged.status, 200, 'a signed token opened another object');
  console.log(
    'ok - no JWT (stranger, member, owner) and no public URL reads the object directly; a token opens only its object',
  );

  ok(await mutate(status, member, 'leave_group', { group_id: groupId }), 'leave');
  assert.deepEqual((await photoUrls(status, member, [owner.profileId])).profiles, {});
  await db.query(
    `update public.group_members set status = 'active', removed_at = null
      where group_id = $1 and profile_id = $2`,
    [groupId, member.profileId],
  );
  console.log('ok - leaving the last shared group ends the right to see the photo');
}

// Contraprova: sem a condição de grupo em comum, o estranho recebe a URL.
async function proveVisibilityMutant(status, db, { owner, stranger }) {
  const original = (await db.query('select pg_get_functiondef($1::regprocedure) as d', [VISIBLE]))
    .rows[0].d;
  const rule = 'and (p.id = v_actor or exists (';
  assert.ok(original.includes(rule));
  try {
    await db.query(original.replace(rule, 'and (true or exists ('));
    const leaked = await photoUrls(status, stranger, [owner.profileId]);
    assert.ok(leaked.profiles[owner.profileId], 'the mutant must leak the photo');
  } finally {
    await db.query(original);
  }
  const live = (await db.query('select pg_get_functiondef($1::regprocedure) as d', [VISIBLE]))
    .rows[0].d;
  assert.equal(live, original, 'get_visible_photos restored byte for byte');
  assert.deepEqual((await photoUrls(status, stranger, [owner.profileId])).profiles, {});
  console.log(
    'ok - mutant without the shared-group rule: the stranger gets the URL; restored, nothing',
  );
}

// ---------------------------------------------------------------------------
// Prova 3: trocar e remover apagam o objeto antigo; a sessão vencida é recolhida
// ---------------------------------------------------------------------------
async function proveOldObjectDeleted(status, db, owner, first) {
  const second = await setProfilePhoto(status, owner, await jpeg(300, 300, { hue: 40 }));
  const secondPath = `${owner.profileId}/${second.upload_id}.jpg`;
  const retired = (
    await db.query(
      `select u.state, e.status from private.photo_uploads u
         join private.external_effects e on e.resource_id = u.id and e.resource_type = 'photo_upload'
        where u.object_path = $1`,
      [first.path],
    )
  ).rows[0];
  assert.deepEqual(retired, { state: 'retired', status: 'pending' }, 'the old photo is retired');
  await worker(db, status, 'process_external_effects');
  assert.deepEqual(await objects(db, 'avatars', first.path), [], 'the old object survived');
  assert.deepEqual(await objects(db, 'avatars', secondPath), [secondPath]);
  const gone = (
    await db.query(
      `select u.state, u.object_path, e.status from private.photo_uploads u
         join private.external_effects e on e.resource_id = u.id and e.resource_type = 'photo_upload'
        where u.profile_id = $1 and u.state = 'deleted'`,
      [owner.profileId],
    )
  ).rows;
  assert.ok(
    gone.some((row) => row.object_path === null && row.status === 'succeeded'),
    JSON.stringify(gone),
  );
  console.log('ok - swapping the photo deletes the old object through the real worker');

  const removed = ok(await mutate(status, owner, 'remove_profile_photo'), 'remove');
  assert.equal(removed.outcome.logical_result, 'profile_photo_removed');
  assert.equal(await photoUrl(db, owner.profileId), null);
  await worker(db, status, 'process_external_effects');
  assert.deepEqual(await objects(db, 'avatars', secondPath), [], 'the removed object survived');
  const again = ok(await mutate(status, owner, 'remove_profile_photo'), 'remove again');
  assert.equal(again.outcome.logical_result, 'profile_photo_unchanged');
  console.log('ok - removing the photo deletes its object; removing again changes nothing');

  const abandoned = await upload(status, owner, await jpeg(200, 200));
  const abandonedPath = `${owner.profileId}/${abandoned.upload_id}.jpg`;
  await db.query(
    `update private.photo_uploads
        set created_at = now() - interval '3 hours',
            commit_before = now() - interval '165 minutes',
            reclaim_after = now() - interval '55 minutes'
      where id = $1`,
    [abandoned.upload_id],
  );
  await worker(db, status, 'reclaim_photo_uploads');
  assert.equal(
    (await db.query('select state from private.photo_uploads where id = $1', [abandoned.upload_id]))
      .rows[0].state,
    'retired',
  );
  await worker(db, status, 'process_external_effects');
  assert.deepEqual(
    await objects(db, 'avatars', abandonedPath),
    [],
    'the abandoned object survived',
  );
  console.log('ok - an upload never confirmed is reclaimed by the job and deleted by the worker');
  // As sessões recusadas da prova 1 também passam pelo recolhimento.
  await db.query(
    `update private.photo_uploads
        set created_at = now() - interval '3 hours',
            commit_before = now() - interval '165 minutes',
            reclaim_after = now() - interval '55 minutes'
      where profile_id = $1 and state = 'pending'`,
    [owner.profileId],
  );
  await worker(db, status, 'reclaim_photo_uploads');
  await worker(db, status, 'process_external_effects');
  assert.deepEqual(await objects(db, 'avatars', `${owner.profileId}/`), []);
  assert.equal(
    (
      await db.query(
        `select count(*)::integer as n from private.photo_uploads
          where profile_id = $1 and state <> 'deleted'`,
        [owner.profileId],
      )
    ).rows[0].n,
    0,
  );
  console.log('ok - every refused or abandoned session ends deleted, with no object left');
}

// ---------------------------------------------------------------------------
// Prova 4: foto do grupo
// ---------------------------------------------------------------------------
async function proveGroupPhoto(status, db, { owner, organizer, member, stranger, groupId }) {
  denied(
    await mutate(status, organizer, 'begin_photo_upload', { target: 'group', group_id: groupId }),
    403,
    'OWNER_ONLY',
    'organizer opens a group session',
  );
  const session = await upload(status, owner, await jpeg(480, 480, { hue: 200 }), {
    target: 'group',
    group_id: groupId,
  });
  assert.ok(session.url.includes(`/group-photos/${groupId}/${session.upload_id}.jpg?token=`));
  denied(
    await mutate(status, organizer, 'set_group_photo', {
      group_id: groupId,
      upload_id: session.upload_id,
    }),
    403,
    'OWNER_ONLY',
    'organizer uses the owner session',
  );
  ok(
    await mutate(status, owner, 'set_group_photo', {
      group_id: groupId,
      upload_id: session.upload_id,
    }),
    'set group photo',
  );
  const forMember = await photoUrls(status, member, [], [groupId]);
  assert.ok(forMember.groups[groupId]?.startsWith('/storage/v1/object/sign/group-photos/'));
  assert.equal((await getBytes(`${status.apiUrl}${forMember.groups[groupId]}`)).status, 200);
  assert.deepEqual((await photoUrls(status, stranger, [], [groupId])).groups, {});
  console.log('ok - only the owner sets the group photo; members see it, a stranger does not');

  ok(await mutate(status, owner, 'delete_group', { group_id: groupId }), 'delete group');
  assert.deepEqual((await photoUrls(status, member, [], [groupId])).groups, {});
  assert.deepEqual((await photoUrls(status, owner, [], [groupId])).groups, {});
  denied(
    await mutate(status, owner, 'remove_group_photo', { group_id: groupId }),
    404,
    'NOT_FOUND',
    'remove the photo of a deleted group',
  );
  console.log(
    'ok - a deleted group shows its photo to nobody, owner included, and refuses changes',
  );
}

// Correção do P1 do #80 (4c930a2): o grupo apagado responde como um grupo que
// não existe, pelo mesmo caminho e sem esperar trava. Uma conexão segura o
// grupo apagado e as memberships dele FOR UPDATE enquanto cada operação de
// foto é chamada, pelo dono e por um estranho, contra o ID apagado e um ID
// desconhecido: mesma resposta, e nenhuma espera.
async function proveDeletedGroupWithoutWait(status, holder, { owner, stranger, groupId }) {
  const unknown = crypto.randomUUID();
  const calls = [
    ['begin_photo_upload', (group) => ({ target: 'group', group_id: group }), false],
    ['set_group_photo', (group) => ({ group_id: group, upload_id: crypto.randomUUID() }), false],
    ['remove_group_photo', (group) => ({ group_id: group }), false],
    ['get_photo_urls', (group) => ({ group_ids: [group] }), true],
  ];
  await holder.query('begin');
  let slowest = 0;
  try {
    await holder.query('select 1 from public.groups where id = $1 for update', [groupId]);
    await holder.query('select 1 from public.group_members where group_id = $1 for update', [
      groupId,
    ]);
    for (const actor of [owner, stranger]) {
      for (const [operation, body, read] of calls) {
        const answers = [];
        for (const group of [groupId, unknown]) {
          const started = Date.now();
          const response = await fetch(`${status.functionsUrl}/groups/${operation}`, {
            method: 'POST',
            headers: {
              apikey: status.publishableKey,
              'content-type': 'application/json',
              Authorization: `Bearer ${actor.token}`,
            },
            body: JSON.stringify(
              read ? body(group) : { ...body(group), request_id: crypto.randomUUID() },
            ),
            signal: AbortSignal.timeout(5000),
          });
          const json = await response.json();
          const elapsed = Date.now() - started;
          slowest = Math.max(slowest, elapsed);
          assert.ok(elapsed < 1500, `${operation} by ${actor.label} waited ${elapsed} ms`);
          answers.push({ status: response.status, answer: read ? json.data : json.error });
        }
        assert.deepEqual(
          answers[0],
          answers[1],
          `${operation} by ${actor.label}: deleted ≠ unknown`,
        );
      }
    }
  } finally {
    await holder.query('rollback');
  }
  console.log(
    `ok - with the deleted group and its memberships held FOR UPDATE, 16 photo calls (owner and stranger, deleted and unknown ID) answer alike without waiting; slowest ${slowest} ms`,
  );
}

// ---------------------------------------------------------------------------
// Prova 5: exportação e exclusão de conta
// ---------------------------------------------------------------------------
function readStoredZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
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

async function proveExport(status, db, titular) {
  const bytes = await jpeg(256, 256, { hue: 90 });
  const session = await setProfilePhoto(status, titular, bytes);
  const photoPath = `${titular.profileId}/${session.upload_id}.jpg`;
  ok(
    await edge(
      status,
      'identity/request_data_export',
      { request_id: crypto.randomUUID() },
      titular.token,
    ),
    'request export',
  );
  const exportId = (
    await db.query('select id from private.data_exports where profile_id = $1', [titular.profileId])
  ).rows[0].id;
  await worker(db, status, 'process_external_effects');
  assert.equal(
    (await db.query('select status from private.data_exports where id = $1', [exportId])).rows[0]
      .status,
    'ready',
  );
  const response = await fetch(`${status.functionsUrl}/data-exports/${exportId}/content`, {
    headers: { apikey: status.publishableKey, Authorization: `Bearer ${titular.token}` },
    redirect: 'manual',
  });
  assert.equal(response.status, 200, 'the export was not delivered');
  const entries = readStoredZip(new Uint8Array(await response.arrayBuffer()));
  assert.deepEqual(Buffer.from(entries.get('profile-photo.jpg') ?? []), Buffer.from(bytes));
  const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));
  const listed = manifest.files.find((file) => file.name === 'profile-photo.jpg');
  assert.deepEqual(listed, {
    name: 'profile-photo.jpg',
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
  for (const [name, content] of entries) {
    if (!name.endsWith('.json') && !name.endsWith('.txt')) continue;
    const text = new TextDecoder().decode(content);
    assert.equal(text.includes(photoPath), false, `${name} carries the photo path`);
    assert.equal(text.includes(session.upload_id), false, `${name} carries the session ID`);
  }
  console.log(
    'ok - the export carries profile-photo.jpg byte for byte, listed in the manifest; no JSON names its path',
  );
}

async function proveAccountDeletion(status, db, deletee) {
  await setProfilePhoto(status, deletee, await jpeg(300, 200, { hue: 10 }));
  // Uma troca deixa um objeto retired, e uma sessão aberta com objeto
  // enviado e nunca confirmado: a URL assinada ainda poderia gravar.
  await setProfilePhoto(status, deletee, await jpeg(300, 200, { hue: 70 }));
  const open = await upload(status, deletee, await jpeg(100, 100));
  const before = await objects(db, 'avatars', `${deletee.profileId}/`);
  assert.equal(before.length, 3, `three objects before the deletion: ${before}`);

  ok(
    await edge(
      status,
      'identity/delete_account',
      { request_id: crypto.randomUUID() },
      deletee.token,
    ),
    'delete account',
  );
  const requestId = (
    await db.query('select id from private.deletion_requests where profile_id = $1', [
      deletee.profileId,
    ])
  ).rows[0].id;
  // O worker apaga a foto corrente e a trocada; a sessão aberta segura o
  // Auth até o recolhimento.
  await worker(db, status, 'process_external_effects');
  await worker(db, status, 'process_external_effects');
  const fenced = (
    await db.query(
      `select status, private.deletion_has_pending_storage(id) as pending
         from private.deletion_requests where id = $1`,
      [requestId],
    )
  ).rows[0];
  assert.deepEqual(fenced, { status: 'cleaning_storage', pending: true }, 'open session fence');
  assert.equal(
    (
      await db.query('select count(*)::integer as n from auth.users where id = $1', [
        deletee.authId,
      ])
    ).rows[0].n,
    1,
    'Auth was deleted while a signed upload URL could still write',
  );
  assert.deepEqual(await objects(db, 'avatars', `${deletee.profileId}/`), [
    `${deletee.profileId}/${open.upload_id}.jpg`,
  ]);
  console.log(
    'ok - the deletion removes the current and the swapped photo, and Auth waits for the open session',
  );

  await db.query(
    `update private.photo_uploads
        set created_at = now() - interval '3 hours',
            commit_before = now() - interval '165 minutes',
            reclaim_after = now() - interval '55 minutes'
      where id = $1`,
    [open.upload_id],
  );
  await worker(db, status, 'reclaim_photo_uploads');
  for (let round = 0; round < 4; round += 1) {
    await worker(db, status, 'process_external_effects');
    const saga = (
      await db.query('select status from private.deletion_requests where id = $1', [requestId])
    ).rows[0];
    if (saga?.status === 'completed') break;
  }
  const after = (
    await db.query(
      `select p.account_status, p.photo_url,
              (select status from private.deletion_requests where id = $2) as saga,
              exists (select 1 from auth.users where id = $3) as auth_exists,
              (select count(*)::integer from private.photo_uploads
                where profile_id = p.id and state <> 'deleted') as open_rows
         from public.profiles p where p.id = $1`,
      [deletee.profileId, requestId, deletee.authId],
    )
  ).rows[0];
  assert.deepEqual(after, {
    account_status: 'deleted',
    photo_url: null,
    saga: 'completed',
    auth_exists: false,
    open_rows: 0,
  });
  assert.deepEqual(await objects(db, 'avatars', `${deletee.profileId}/`), [], 'orphan object');
  console.log(
    'ok - account deletion completes with no photo object left: current, swapped and abandoned',
  );
}

// ---------------------------------------------------------------------------
// Limpeza e censo
// ---------------------------------------------------------------------------
async function cleanup(db, status) {
  const pattern = harnessEmailPattern(AUTH_PREFIX);
  const marked = (
    await db.query(
      `select p.id from public.profiles p join auth.users u on u.id = p.auth_user_id
        where u.email like $1 escape '\\'`,
      [pattern],
    )
  ).rows.map((row) => row.id);
  const profiles = [...new Set([...created.profiles, ...marked])];
  const groups = (
    await db.query(
      `select id from public.groups where owner_id = any($1::uuid[])
       union select group_id from public.group_members where profile_id = any($1::uuid[])`,
      [profiles],
    )
  ).rows.map((row) => row.id);
  for (const id of profiles)
    await removeObjects(status, 'avatars', await objects(db, 'avatars', `${id}/`));
  for (const id of groups) {
    await removeObjects(status, 'group-photos', await objects(db, 'group-photos', `${id}/`));
  }
  for (const id of profiles) {
    await removeObjects(
      status,
      'data-exports',
      await objects(db, 'data-exports', `exports/${id}/`),
    );
  }
  await db.query('begin');
  try {
    await db.query(
      `delete from private.external_effects
        where resource_id in (select id from private.photo_uploads
                               where profile_id = any($1::uuid[]) or group_id = any($2::uuid[]))
           or resource_id in (select id from private.data_exports where profile_id = any($1::uuid[]))
           or resource_id in (select id from private.deletion_requests where profile_id = any($1::uuid[]))
           or resource_id = any($1::uuid[]) or resource_id = any($2::uuid[])`,
      [profiles, groups],
    );
    await db.query(
      'delete from private.photo_uploads where profile_id = any($1::uuid[]) or group_id = any($2::uuid[])',
      [profiles, groups],
    );
    for (const statement of [
      'delete from private.idempotency_records where actor_id = any($1::uuid[])',
      'delete from private.revoked_auth_sessions where profile_id = any($1::uuid[])',
      'delete from private.invite_rate_limits where profile_id = any($1::uuid[])',
      'delete from private.data_exports where profile_id = any($1::uuid[])',
      'delete from private.deletion_requests where profile_id = any($1::uuid[])',
      'delete from public.privacy_requests where profile_id = any($1::uuid[])',
      'delete from public.policy_acceptances where profile_id = any($1::uuid[])',
    ]) {
      await db.query(statement, [profiles]);
    }
    for (const statement of [
      'delete from private.group_deletions where group_id = any($1::uuid[])',
      'delete from public.group_invites where group_id = any($1::uuid[])',
      'delete from public.group_members where group_id = any($1::uuid[])',
      'delete from public.groups where id = any($1::uuid[])',
    ]) {
      await db.query(statement, [groups]);
    }
    await db.query('delete from public.group_members where profile_id = any($1::uuid[])', [
      profiles,
    ]);
    await db.query('delete from public.profiles where id = any($1::uuid[])', [profiles]);
    await db.query('delete from auth.users where id = any($1::uuid[])', [[...created.authIds]]);
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

async function tableCounts(db) {
  const tables = await db.query(
    `select table_schema, table_name from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema in ('public', 'private', 'auth', 'storage')
      order by table_schema, table_name`,
  );
  const counts = new Map();
  for (const { table_schema: schema, table_name: table } of tables.rows) {
    const identifier = [schema, table].map((part) => `"${part.replaceAll('"', '""')}"`).join('.');
    counts.set(
      `${schema}.${table}`,
      (await db.query(`select count(*)::integer as n from ${identifier}`)).rows[0].n,
    );
  }
  return counts;
}

async function main() {
  const status = localStatus();
  const db = client(status.dbUrl, 'admin');
  const holder = client(status.dbUrl, 'holder');
  guard.useDatabase(status.dbUrl);
  guard.onCleanup((census) => cleanup(census, status));
  let baseline;
  let jobBaseline;
  let retentionBaseline;
  guard.onCensus(async (census) => {
    if (baseline === undefined) return;
    await census.query('delete from private.job_runs where id > $1', [jobBaseline]);
    await census.query('delete from private.retention_runs where id > $1', [retentionBaseline]);
    const after = await tableCounts(census);
    const changed = [...after].filter(
      ([table, n]) => table !== 'auth.audit_log_entries' && n !== baseline.get(table),
    );
    assert.deepEqual(changed, [], `tables changed across the harness: ${JSON.stringify(changed)}`);
    const photos = (
      await census.query(
        `select count(*)::integer as n from storage.objects
          where bucket_id in ('avatars', 'group-photos')`,
      )
    ).rows[0].n;
    console.log(
      `ok - census: every table back to its baseline (GoTrue audit log aside); photo objects=${photos}`,
    );
  });
  await db.connect();
  await holder.connect();
  try {
    await cleanup(db, status);
    baseline = await tableCounts(db);
    jobBaseline = (
      await db.query('select coalesce(max(id), 0)::bigint as id from private.job_runs')
    ).rows[0].id;
    retentionBaseline = (
      await db.query('select coalesce(max(id), 0)::bigint as id from private.retention_runs')
    ).rows[0].id;
    const queued = (
      await db.query(
        `select count(*)::integer as n from private.external_effects
          where status in ('pending', 'leased', 'failed_retryable')`,
      )
    ).rows[0].n;
    assert.equal(queued, 0, 'another pending effect would reach the real worker');

    const owner = await createActor(status, 'owner');
    const organizer = await createActor(status, 'organizer');
    const member = await createActor(status, 'member');
    const stranger = await createActor(status, 'stranger');
    const titular = await createActor(status, 'titular');
    const deletee = await createActor(status, 'deletee');
    const groupId = ok(
      await mutate(status, owner, 'create_group', { name: 'Grupo das Fotos' }),
      'create group',
    ).outcome.group_id;
    await db.query(
      `insert into public.group_members (group_id, profile_id, role, status)
       values ($1, $2, 'organizer', 'active'), ($1, $3, 'player', 'active')`,
      [groupId, organizer.profileId, member.profileId],
    );
    const people = { owner, organizer, member, stranger, groupId };

    const photo = await proveUploadRules(status, db, owner);
    await proveVisibility(status, db, people, photo);
    await proveVisibilityMutant(status, db, people);
    await proveOldObjectDeleted(status, db, owner, photo);
    await proveGroupPhoto(status, db, people);
    await proveDeletedGroupWithoutWait(status, holder, people);
    await proveExport(status, db, titular);
    await proveAccountDeletion(status, db, deletee);
  } finally {
    await holder.end();
    await db.end();
  }
}

if (await guard.run(main)) console.log('Photos harness passed.');
