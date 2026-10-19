// Harness da fatia 0017. Usuários HTTP nascem na API admin local de GoTrue,
// perfis pela Edge identity, e todas as rotas de domínio passam pela Edge groups.
// A guarda comum aborta queries/fetches novos depois de qualquer falha.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  deriveInviteMaterial,
  makeInviteMaterial,
} from '../supabase/functions/_shared/invite-material.ts';
import {
  harnessEmail,
  harnessEmailPattern,
  installHarnessGuard,
  sweepMarkedAuthUsers,
} from './harness-guard.mjs';
import { localWorkerCronSecret } from './local-worker-test-config.mjs';

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supabase = path.join(root, 'node_modules', '.bin', 'supabase');
const AUTH_PREFIX = 'group-invites-';
const APP_PREFIX = 'colete_invites_';
const PASSWORD = 'colete-local-invite-harness-password';
const censusResponses = [];
const authorisedShareResponses = [];
const syntheticKey = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index));
const guard = installHarnessGuard('db:test:invites', {
  applicationPrefix: APP_PREFIX,
  authEmailPrefix: AUTH_PREFIX,
});

async function allValues(promises, label) {
  const results = await Promise.allSettled(promises);
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length)
    throw new AggregateError(errors, `${label}: ${errors.length} concurrent errors`);
  return results.map((result) => result.value);
}

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
    await db.query(
      `delete from private.external_effects where resource_id in
       (select id from private.deletion_requests where profile_id in (${profiles}))`,
      [pattern],
    );
    await db.query(`delete from private.deletion_requests where profile_id in (${profiles})`, [
      pattern,
    ]);
    await db.query(`delete from private.revoked_auth_sessions where profile_id in (${profiles})`, [
      pattern,
    ]);
    await db.query(`delete from private.invite_rate_limits where profile_id in (${profiles})`, [
      pattern,
    ]);
    await db.query(`delete from private.idempotency_records where actor_id in (${profiles})`, [
      pattern,
    ]);
    await db.query(`delete from public.group_invites where group_id in (${groups})`, [pattern]);
    await db.query(`delete from public.group_members where group_id in (${groups})`, [pattern]);
    await db.query(`delete from public.groups where id in (${groups})`, [pattern]);
    await db.query(`delete from public.profiles where id in (${profiles})`, [pattern]);
    await db.query('commit');
  } catch (error) {
    try {
      await db.query('rollback');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'invite cleanup and rollback failed');
    }
    throw error;
  }
  await sweepMarkedAuthUsers(db, AUTH_PREFIX);
}
async function edge(status, route, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${status.functionsUrl}/${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (route === 'groups/get_invite_share_link' && response.status === 200)
    authorisedShareResponses.push(raw);
  else censusResponses.push(raw);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${route}: non-JSON response HTTP ${response.status}`);
  }
  return {
    status: response.status,
    body: parsed,
    headers: Object.fromEntries(response.headers.entries()),
  };
}
function groups(status, actor, operation, body) {
  return edge(status, `groups/${operation}`, body, actor.token);
}
async function groupsRaw(status, actor, operation, body) {
  const response = await fetch(`${status.functionsUrl}/groups/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${actor.token}` },
    body,
  });
  const raw = await response.text();
  censusResponses.push(raw);
  return { status: response.status, body: JSON.parse(raw) };
}
function mutate(status, actor, operation, body, requestId = crypto.randomUUID()) {
  return groups(status, actor, operation, { ...body, request_id: requestId });
}
function ok(result, label) {
  assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);
  assert.equal(typeof result.body.request_id, 'string', label);
  return result.body.data;
}
function denied(result, status, code, label) {
  assert.equal(result.status, status, `${label}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error?.code, code, label);
}
async function createActor(status, label) {
  const email = harnessEmail(AUTH_PREFIX, `${Date.now()}-${crypto.randomUUID()}-${label}`);
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
  const signIn = await fetch(`${status.apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: status.publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(signIn.status, 200, `sign in ${label}: ${signIn.status}`);
  const session = await signIn.json();
  const claims = JSON.parse(
    Buffer.from(session.access_token.split('.')[1], 'base64url').toString('utf8'),
  );
  assert.equal(claims.sub, user.id);
  const actor = { authId: user.id, token: session.access_token, sessionId: claims.session_id };
  const profile = ok(
    await edge(
      status,
      'identity/complete_profile',
      {
        request_id: crypto.randomUUID(),
        profile: { name: `Invite ${label}` },
      },
      actor.token,
    ),
    `complete_profile ${label}`,
  );
  actor.profileId = profile.outcome.profile_id;
  return actor;
}
async function materialFromDb(db, inviteId) {
  const result = await db.query(
    `select encode(public_nonce,'hex') as nonce,token_digest,code_digest
     from public.group_invites where id=$1`,
    [inviteId],
  );
  assert.equal(result.rowCount, 1);
  const row = result.rows[0];
  const material = await deriveInviteMaterial(
    syntheticKey,
    inviteId,
    Uint8Array.from(Buffer.from(row.nonce, 'hex')),
  );
  assert.equal(material.tokenDigest, row.token_digest);
  assert.equal(material.codeDigest, row.code_digest);
  return material;
}
async function proveHttp(status, db) {
  const owner = await createActor(status, 'owner');
  const joiner = await createActor(status, 'joiner');
  const createId = crypto.randomUUID();
  const created = ok(
    await mutate(status, owner, 'create_group', { name: '  Racha　do　Bairro  ' }, createId),
    'create_group',
  );
  assert.equal(created.outcome.logical_result, 'group_created');
  assert.equal(created.current.group_name, 'Racha do Bairro');
  const { group_id: groupId, invite_id: inviteId } = created.outcome;
  const material = await materialFromDb(db, inviteId);
  const shareResponse = await groups(status, owner, 'get_invite_share_link', {
    invite_id: inviteId,
  });
  const share = ok(shareResponse, 'get_invite_share_link');
  const shared = new URL(share.share_url);
  assert.equal(shared.search, '');
  assert.equal(shared.hash, `#token=${material.token}`);
  assert.equal(share.code, material.code);
  assert.equal(share.code_format, 'v1');
  assert.deepEqual(
    Object.keys(share).sort(),
    ['invite_id', 'expires_at', 'remaining_uses', 'share_url', 'code', 'code_format'].sort(),
  );
  assert.equal(shareResponse.headers['cache-control'], 'no-store');
  assert.equal(shareResponse.headers['referrer-policy'], 'no-referrer');
  const replay = ok(
    await mutate(status, owner, 'create_group', { name: 'Racha do Bairro' }, createId),
    'create_group replay',
  );
  assert.deepEqual(replay.outcome, created.outcome);
  assert.equal(
    (
      await db.query(
        'select count(*)::integer as count from public.group_invites where group_id=$1',
        [groupId],
      )
    ).rows[0].count,
    1,
  );
  console.log('ok - HTTP create_group commits initial invite and replays stable IDs');

  const before = (
    await db.query('select used_count from public.group_invites where id=$1', [inviteId])
  ).rows[0].used_count;
  const previewCode = ok(
    await groups(status, joiner, 'preview_group_by_code', { code: material.code }),
    'preview code',
  );
  const previewLink = ok(
    await groups(status, joiner, 'preview_group_by_invite', { token: material.token }),
    'preview link',
  );
  // 0026: the invitation page, no member list or ID; 0027 adds icon and colour.
  assert.deepEqual(previewCode, {
    group_name: 'Racha do Bairro',
    member_count: 1,
    owner_name: 'Invite owner',
    viewer_status: null,
    group_id: null,
    refusal: null,
    group_icon: 'ball',
    group_color: 'blue',
  });
  assert.deepEqual(previewLink, previewCode);
  assert.equal(
    (await db.query('select used_count from public.group_invites where id=$1', [inviteId])).rows[0]
      .used_count,
    before,
  );
  console.log('ok - HTTP preview by code and link returns only the invitation page, without use');

  const joinId = crypto.randomUUID();
  const joined = ok(
    await mutate(status, joiner, 'join_by_code', { code: material.code }, joinId),
    'join_by_code',
  );
  assert.equal(joined.outcome.logical_result, 'membership_requested');
  assert.equal(joined.outcome.reentry, false);
  assert.deepEqual(joined.current, {
    group_id: groupId,
    group_name: 'Racha do Bairro',
    status: 'pending',
  });
  const joinReplay = ok(
    await mutate(status, joiner, 'join_by_code', { code: material.code }, joinId),
    'join replay',
  );
  assert.deepEqual(joinReplay.outcome, joined.outcome);
  const pending = ok(
    await groups(status, joiner, 'get_my_pending_group_requests', {}),
    'my pending',
  );
  assert.deepEqual(pending, [
    { group_id: groupId, group_name: 'Racha do Bairro', status: 'pending' },
  ]);
  denied(
    await groups(status, joiner, 'get_invite_share_link', { invite_id: inviteId }),
    403,
    'NOT_MEMBER',
    'pending cannot share',
  );
  const unchanged = ok(
    await mutate(status, joiner, 'join_by_invite', { token: material.token }),
    'pending repeated',
  );
  assert.equal(unchanged.outcome.logical_result, 'membership_request_unchanged');
  assert.equal(
    (await db.query('select used_count from public.group_invites where id=$1', [inviteId])).rows[0]
      .used_count,
    before + 1,
  );
  console.log('ok - HTTP join, replay, own pending request and repeated pending');

  await db.query(
    "update private.app_limits set limit_value=5 where limit_key='invite_attempts_per_hour'",
  );
  const rate = await groups(status, joiner, 'preview_group_by_code', { code: 'INVALID' });
  denied(rate, 429, 'RATE_LIMITED', 'N+1 quota');
  assert.equal(rate.headers['retry-after'], String(rate.body.error.retry_after));
  assert.equal(typeof rate.body.error.available_at, 'string');
  assert.equal(
    (
      await db.query(
        'select count(*)::integer as count from private.invite_rate_limits where profile_id=$1',
        [joiner.profileId],
      )
    ).rows[0].count,
    6,
  );
  const limitedRequestId = crypto.randomUUID();
  const limitedJoin = await mutate(
    status,
    joiner,
    'join_by_code',
    { code: material.code },
    limitedRequestId,
  );
  denied(limitedJoin, 429, 'RATE_LIMITED', 'join quota');
  assert.equal(limitedJoin.body.request_id, limitedRequestId);
  assert.equal(
    (
      await db.query(
        `select result_class from private.invite_rate_limits
    where profile_id=$1 order by attempted_at desc limit 1`,
        [joiner.profileId],
      )
    ).rows[0].result_class,
    'failure',
    'quota row must stay failure',
  );
  console.log('ok - HTTP N+1 is 429 before parsing and still debits the same limiter');

  // Restore the pilot limit for further HTTP operations; the test only changed
  // a local app_limits row and the guard will restore it again on cleanup.
  await db.query(
    "update private.app_limits set limit_value=20 where limit_key='invite_attempts_per_hour'",
  );
  const debitCount = async () =>
    (
      await db.query(
        'select count(*)::integer as count from private.invite_rate_limits where profile_id=$1',
        [joiner.profileId],
      )
    ).rows[0].count;
  const beforeValidation = await debitCount();
  for (const invalidBody of [null, []]) {
    denied(
      await groups(status, joiner, 'join_by_code', invalidBody),
      422,
      'VALIDATION',
      'non-object body',
    );
  }
  denied(
    await groupsRaw(status, joiner, 'join_by_code', '{'),
    422,
    'VALIDATION',
    'invalid JSON body',
  );
  assert.equal(await debitCount(), beforeValidation, 'non-object or invalid JSON body was debited');
  denied(
    await mutate(status, joiner, 'join_by_code', { code: 'not a code!' }),
    400,
    'CODE_INVALID',
    'invalid code format',
  );
  assert.equal(await debitCount(), beforeValidation + 1, 'invalid code did not debit');
  for (const field of ['profile_id', 'p_actor_auth_user_id']) {
    denied(
      await mutate(status, joiner, 'join_by_code', {
        code: material.code,
        [field]: joiner.profileId,
      }),
      422,
      'VALIDATION',
      `${field} internal field`,
    );
  }
  assert.equal(await debitCount(), beforeValidation + 3, 'internal fields must fail after debit');
  const revoked = ok(
    await mutate(status, owner, 'revoke_group_invite', { invite_id: inviteId }),
    'revoke',
  );
  assert.equal(revoked.outcome.logical_result, 'invite_revoked');
  denied(
    await groups(status, joiner, 'preview_group_by_code', { code: material.code }),
    400,
    'CODE_INVALID',
    'revoked preview is generic (0026)',
  );
  assert.equal(
    (
      await db.query(
        `select result_class from private.invite_rate_limits
    where profile_id=$1 order by attempted_at desc limit 1`,
        [joiner.profileId],
      )
    ).rows[0].result_class,
    'failure',
    'domain error row must stay failure',
  );
  const issued = ok(
    await mutate(status, owner, 'issue_group_invite', { group_id: groupId }),
    'issue',
  );
  assert.equal(issued.outcome.logical_result, 'invite_issued');
  const newMaterial = await materialFromDb(db, issued.outcome.invite_id);
  ok(
    await groups(status, joiner, 'preview_group_by_code', { code: newMaterial.code }),
    'new preview',
  );
  const regenerated = ok(
    await mutate(status, owner, 'regenerate_group_invite', { invite_id: issued.outcome.invite_id }),
    'regenerate',
  );
  assert.equal(regenerated.outcome.logical_result, 'invite_regenerated');
  denied(
    await groups(status, joiner, 'preview_group_by_code', { code: newMaterial.code }),
    400,
    'CODE_INVALID',
    'old material invalidated',
  );
  console.log('ok - HTTP revoke, issue and regenerate invalidate prior material');
  return {
    owner,
    joiner,
    groupId,
    censusMaterial: material,
    liveInviteId: issued.outcome.invite_id,
    liveMaterial: await materialFromDb(db, issued.outcome.invite_id),
  };
}

async function proveTerminalRevocationAndEmptyIssue(status, db) {
  const owner = await createActor(status, 'terminal-owner');
  const created = ok(
    await mutate(status, owner, 'create_group', { name: 'Terminal invite proofs' }),
    'terminal fixture',
  );
  const groupId = created.outcome.group_id;
  let inviteId = created.outcome.invite_id;
  const snapshot = async () =>
    (
      await db.query(
        'select revoked_at,expires_at,used_count from public.group_invites where id=$1',
        [inviteId],
      )
    ).rows[0];
  for (const state of ['revoked', 'expired', 'used']) {
    if (state === 'revoked') {
      ok(
        await mutate(status, owner, 'revoke_group_invite', { invite_id: inviteId }),
        'first revoke',
      );
    } else if (state === 'expired') {
      await db.query(
        "update public.group_invites set expires_at=now()-interval '1 minute',used_count=3 where id=$1",
        [inviteId],
      );
    } else {
      await db.query('update public.group_invites set used_count=max_uses where id=$1', [inviteId]);
    }
    const before = await snapshot();
    const result = ok(
      await mutate(status, owner, 'revoke_group_invite', { invite_id: inviteId }),
      `${state} unchanged`,
    );
    assert.equal(result.outcome.logical_result, 'invite_revocation_unchanged');
    assert.deepEqual(await snapshot(), before, `${state}: terminal fields changed`);
    if (state !== 'used') {
      const issued = ok(
        await mutate(status, owner, 'issue_group_invite', { group_id: groupId }),
        `issue after ${state}`,
      );
      assert.equal(issued.outcome.logical_result, 'invite_issued');
      inviteId = issued.outcome.invite_id;
    }
  }
  await db.query('delete from public.group_invites where group_id=$1', [groupId]);
  assert.equal(
    (
      await db.query(
        'select count(*)::integer as count from public.group_invites where group_id=$1',
        [groupId],
      )
    ).rows[0].count,
    0,
  );
  const issued = ok(
    await mutate(status, owner, 'issue_group_invite', { group_id: groupId }),
    'issue with no invite row',
  );
  assert.equal(issued.outcome.logical_result, 'invite_issued');
  assert.equal(
    (
      await db.query(
        'select count(*)::integer as count from public.group_invites where group_id=$1',
        [groupId],
      )
    ).rows[0].count,
    1,
  );
  const signature =
    'private.mutate_group_invite(text,uuid,uuid,uuid,text,integer,integer,uuid,uuid,uuid,smallint,text,text,text)';
  const original = (
    await db.query('select pg_get_functiondef($1::regprocedure) as definition', [signature])
  ).rows[0].definition;
  const unchangedBranch = /v_result:='invite_revocation_unchanged';/i;
  const emptyCheck = /if exists \(select 1 from public\.group_invites where group_id=v_group_id/i;
  assert.match(original, unchangedBranch);
  assert.match(original, emptyCheck);
  // Mutante 1: o resultado permanece unchanged, mas regrava revoked_at.
  inviteId = issued.outcome.invite_id;
  await db.query(
    "update public.group_invites set expires_at=now()-interval '1 minute' where id=$1",
    [inviteId],
  );
  const beforeMutant = await snapshot();
  await db.query(
    original.replace(
      unchangedBranch,
      "update public.group_invites set revoked_at=now() where id=v_invite_id; v_result:='invite_revocation_unchanged';",
    ),
  );
  try {
    const result = ok(
      await mutate(status, owner, 'revoke_group_invite', { invite_id: inviteId }),
      'rewriting mutant',
    );
    assert.equal(result.outcome.logical_result, 'invite_revocation_unchanged');
    const snapshotAfterMutant = await snapshot();
    assert.throws(
      () => assert.deepEqual(snapshotAfterMutant, beforeMutant),
      'field-preservation assertion must reject revoked_at mutant',
    );
  } finally {
    await db.query(original);
  }
  // Mutante 2: estado terminal devolve erro em vez de unchanged.
  await db.query(
    original.replace(
      unchangedBranch,
      "raise exception using errcode='P0001',message='INVITE_REVOKED';",
    ),
  );
  try {
    const result = await mutate(status, owner, 'revoke_group_invite', { invite_id: inviteId });
    denied(result, 409, 'INVITE_REVOKED', 'terminal error mutant');
    assert.throws(
      () => assert.equal(result.status, 200),
      'successful unchanged assertion must reject error mutant',
    );
  } finally {
    await db.query(original);
  }
  // Mutante 3: emitir com zero linhas é recusado como já ativo.
  await db.query('delete from public.group_invites where group_id=$1', [groupId]);
  await db.query(
    original.replace(
      emptyCheck,
      'if not exists (select 1 from public.group_invites where group_id=v_group_id',
    ),
  );
  try {
    const result = await mutate(status, owner, 'issue_group_invite', { group_id: groupId });
    denied(result, 409, 'INVITE_ALREADY_ACTIVE', 'empty-issue mutant');
    assert.throws(
      () => assert.equal(result.status, 200),
      'empty-issue success assertion must reject no-row mutant',
    );
  } finally {
    await db.query(original);
  }
  console.log('ok - M2-D35 terminal revocations preserve three fields; M2-D34 issues from no row');
}

async function proveNameVectorsHttp(status) {
  const actor = await createActor(status, 'name-vectors');
  const requestId = crypto.randomUUID();
  const composed = ok(
    await mutate(status, actor, 'create_group', { name: 'Cafe\u0301' }, requestId),
    'NFD name',
  );
  assert.equal(composed.current.group_name, 'Café');
  const replay = ok(
    await mutate(status, actor, 'create_group', { name: 'Café' }, requestId),
    'NFC replay',
  );
  assert.deepEqual(replay.outcome, composed.outcome);
  const separators = ok(
    await mutate(status, actor, 'create_group', { name: 'A\u00a0\u3000\u2028B' }),
    'Unicode separators',
  );
  assert.equal(separators.current.group_name, 'A B');
  const joiners = ok(
    await mutate(status, actor, 'create_group', { name: 'A\u200cB\u200dC' }),
    'allowed zero-width joiners',
  );
  assert.equal(joiners.current.group_name, 'A\u200cB\u200dC');
  for (const name of ['A', 'x'.repeat(41), 'A\tB', 'A\nB', 'A\u061cB', 'A\u200bB']) {
    denied(
      await mutate(status, actor, 'create_group', { name }),
      422,
      'VALIDATION',
      'invalid group name',
    );
  }
  console.log(
    'ok - HTTP group-name NFC fingerprint, separators, allowed joiners and forbidden vectors',
  );
}
const RPC_TYPES = {
  create_group: [
    'uuid',
    'uuid',
    'uuid',
    'text',
    'integer',
    'integer',
    'text',
    'uuid',
    'smallint',
    'text',
    'text',
    'text',
  ],
  join_by_code: ['uuid', 'uuid', 'uuid', 'text', 'integer', 'integer', 'text'],
  join_by_invite: [
    'uuid',
    'uuid',
    'uuid',
    'text',
    'integer',
    'integer',
    'uuid',
    'smallint',
    'text',
  ],
  revoke_group_invite: ['uuid', 'uuid', 'uuid', 'text', 'integer', 'integer', 'uuid'],
  regenerate_group_invite: [
    'uuid',
    'uuid',
    'uuid',
    'text',
    'integer',
    'integer',
    'uuid',
    'smallint',
    'text',
    'text',
    'text',
  ],
  issue_group_invite: [
    'uuid',
    'uuid',
    'uuid',
    'text',
    'integer',
    'integer',
    'uuid',
    'uuid',
    'smallint',
    'text',
    'text',
    'text',
  ],
  approve_member: ['uuid', 'uuid', 'uuid', 'text', 'integer', 'integer', 'uuid', 'uuid', 'boolean'],
};
async function rpcTx(connection, operation, actor, business, requestId = crypto.randomUUID()) {
  const signature = RPC_TYPES[operation];
  assert.ok(signature, `no SQL signature for ${operation}`);
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify({ operation, business }))
    .digest('hex');
  const args = [actor.authId, actor.sessionId, requestId, digest, 1, 1, ...business];
  assert.equal(args.length, signature.length);
  const placeholders = signature.map((type, index) => `$${index + 1}::${type}`).join(',');
  await connection.query('begin');
  try {
    await connection.query('set local role service_role');
    const result = await connection.query(
      `select public.${operation}(${placeholders}) as result`,
      args,
    );
    await connection.query('commit');
    return result.rows[0].result;
  } catch (error) {
    try {
      await connection.query('rollback');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `${operation} and rollback failed`);
    }
    throw error;
  }
}
function commonArguments(actor, operation, business) {
  return (connection) => rpcTx(connection, operation, actor, business);
}
async function materialArgs(inviteId) {
  const material = await makeInviteMaterial(syntheticKey, inviteId);
  return [
    material.inviteId,
    material.tokenVersion,
    material.nonceHex,
    material.tokenDigest,
    material.codeDigest,
  ];
}
async function proveSameActorRaces(status, db, connections, context) {
  const { sameActorPair } = await import('./lock-barrier.mjs');
  const { owner, joiner, groupId } = context;
  const cases = [
    [
      'create_group',
      owner,
      async (index) => {
        const material = await materialArgs(crypto.randomUUID());
        return [`Race ${index}`, ...material];
      },
      ['group_created', 'group_created'],
    ],
    [
      'join_by_code',
      joiner,
      async () => [context.liveMaterial.codeDigest],
      ['membership_request_unchanged', 'membership_request_unchanged'],
    ],
    [
      'join_by_invite',
      joiner,
      async () => [context.liveInviteId, 1, context.liveMaterial.tokenDigest],
      ['membership_request_unchanged', 'membership_request_unchanged'],
    ],
    [
      'revoke_group_invite',
      owner,
      async () => [context.liveInviteId],
      ['invite_revoked', 'invite_revocation_unchanged'],
    ],
    [
      'regenerate_group_invite',
      owner,
      async () => {
        const material = await materialArgs(context.liveInviteId);
        return [context.liveInviteId, ...material.slice(1)];
      },
      ['invite_regenerated', 'invite_regenerated'],
    ],
    [
      'issue_group_invite',
      owner,
      async () => {
        const material = await materialArgs(crypto.randomUUID());
        return [groupId, ...material];
      },
      ['invite_issued', 'INVITE_ALREADY_ACTIVE'],
    ],
  ];
  for (const [operation, actor, makeBusiness, expected] of cases) {
    for (const order of [1, 2]) {
      if (operation === 'regenerate_group_invite' && order === 1) {
        const issued = ok(
          await mutate(status, owner, 'issue_group_invite', { group_id: groupId }),
          'issue before regeneration race',
        );
        context.liveInviteId = issued.outcome.invite_id;
        context.liveMaterial = await materialFromDb(db, context.liveInviteId);
      }
      if (operation === 'issue_group_invite') {
        ok(
          await mutate(status, owner, 'revoke_group_invite', { invite_id: context.liveInviteId }),
          'terminal before issue race',
        );
      }
      if (operation === 'revoke_group_invite' && order === 2) {
        const issued = ok(
          await mutate(status, owner, 'issue_group_invite', { group_id: groupId }),
          'issue before second revoke race',
        );
        context.liveInviteId = issued.outcome.invite_id;
        context.liveMaterial = await materialFromDb(db, context.liveInviteId);
      }
      const left = await makeBusiness(`${operation}-${order}-A`);
      const right = await makeBusiness(`${operation}-${order}-B`);
      const firstArgs = order === 1 ? left : right;
      const secondArgs = order === 1 ? right : left;
      const results = await sameActorPair(
        { ...connections, applicationPrefix: APP_PREFIX },
        {
          label: `${operation} order ${order}`,
          profileId: actor.profileId,
          runFirst: commonArguments(actor, operation, firstArgs),
          runSecond: commonArguments(actor, operation, secondArgs),
        },
      );
      const actual = results
        .map((item) =>
          item.status === 'fulfilled' ? item.value.outcome.logical_result : item.reason?.message,
        )
        .sort();
      assert.deepEqual(actual, [...expected].sort(), `${operation} order ${order}`);
      if (operation === 'issue_group_invite') {
        const winner = results.find((item) => item.status === 'fulfilled');
        context.liveInviteId = winner.value.outcome.invite_id;
        context.liveMaterial = await materialFromDb(db, context.liveInviteId);
      }
      console.log(`ok - ${operation} same actor order ${order}: ${actual.join('/')}, no 40P01`);
    }
  }
}

async function proveLockCounterexamples(db, connections, context) {
  const { sameActorPair } = await import('./lock-barrier.mjs');
  const functions = [
    {
      signature:
        'public.create_group(uuid,uuid,uuid,text,integer,integer,text,uuid,smallint,text,text,text)',
      operations: ['create_group'],
    },
    {
      signature:
        'private.join_group_invite(text,uuid,uuid,uuid,text,integer,integer,uuid,smallint,text,text)',
      operations: ['join_by_code', 'join_by_invite'],
    },
    {
      signature:
        'private.mutate_group_invite(text,uuid,uuid,uuid,text,integer,integer,uuid,uuid,uuid,smallint,text,text,text)',
      operations: ['revoke_group_invite', 'regenerate_group_invite', 'issue_group_invite'],
    },
  ];
  for (const group of functions) {
    const result = await db.query('select pg_get_functiondef($1::regprocedure) as definition', [
      group.signature,
    ]);
    const original = result.rows[0]?.definition;
    assert.equal(typeof original, 'string');
    const profileLock =
      /perform 1 from public\.profiles where id\s*=\s*v_actor_id for no key update;/i;
    assert.match(original, profileLock);
    const mutant = original.replace(profileLock, (match) =>
      match.replace(/for no key update;/i, 'for update;'),
    );
    assert.notEqual(mutant, original);
    await db.query(mutant);
    try {
      for (const operation of group.operations) {
        const actor = operation.startsWith('join') ? context.joiner : context.owner;
        for (const order of [1, 2]) {
          const business = async (side) => {
            if (operation === 'create_group') {
              return [`Counter ${side}`, ...(await materialArgs(crypto.randomUUID()))];
            }
            if (operation === 'join_by_code') return [context.liveMaterial.codeDigest];
            if (operation === 'join_by_invite')
              return [context.liveInviteId, 1, context.liveMaterial.tokenDigest];
            if (operation === 'revoke_group_invite') return [context.liveInviteId];
            if (operation === 'regenerate_group_invite') {
              const material = await materialArgs(context.liveInviteId);
              return [context.liveInviteId, ...material.slice(1)];
            }
            return [context.groupId, ...(await materialArgs(crypto.randomUUID()))];
          };
          const a = await business('A');
          const b = await business('B');
          const firstArgs = order === 1 ? a : b;
          const secondArgs = order === 1 ? b : a;
          let failure;
          try {
            await sameActorPair(
              { ...connections, applicationPrefix: APP_PREFIX },
              {
                label: `mutant ${operation} order ${order}`,
                profileId: actor.profileId,
                runFirst: commonArguments(actor, operation, firstArgs),
                runSecond: commonArguments(actor, operation, secondArgs),
              },
            );
          } catch (caught) {
            failure = caught;
          }
          assert.match(
            failure?.message ?? '',
            /deadlock.*40P01|40P01.*deadlock/i,
            `${operation} order ${order}: FOR UPDATE counterproof did not deadlock`,
          );
          console.log(`ok - mutant ${operation} order ${order}: FOR UPDATE reproduced 40P01`);
        }
      }
    } finally {
      await db.query(original);
    }
  }
}

// P1 da revisão do #76: a prévia é só leitura e não espera trava nenhuma.
// Com o grupo, o convite e as memberships presos por outra transação, todo
// código que responde CODE_INVALID (inexistente, revogado, expirado,
// esgotado), por código e por link, e também o convite vivo, precisam
// terminar enquanto a trava ainda está presa, sem nunca aparecer em espera
// de Lock no pg_stat_activity. Antes, só o código que existiu esperava.
const PREVIEW_SIGNATURE = 'private.preview_group_invite(uuid,uuid,uuid,smallint,text,text)';
const PREVIEW_HOLD_MS = 1500;
async function previewWhileGroupHeld({ observer, holder, first }, fixture, call) {
  const { track, backendPid } = await import('./lock-barrier.mjs');
  const firstPid = await backendPid(first);
  const holderPid = await backendPid(holder);
  await holder.query('begin');
  let running;
  let finished;
  let waited = false;
  let doneWhileHeld = false;
  try {
    await holder.query('select 1 from public.groups where id=$1 for update', [fixture.groupId]);
    await holder.query('select 1 from public.group_invites where id=$1 for update', [
      fixture.inviteId,
    ]);
    await holder.query('select 1 from public.group_members where group_id=$1 for update', [
      fixture.groupId,
    ]);
    const started = performance.now();
    running = track(call(first));
    finished = running.settled.then((result) => ({ result, ms: performance.now() - started }));
    const deadline = Date.now() + PREVIEW_HOLD_MS;
    while (!running.state.done && !waited && Date.now() < deadline) {
      const { rows } = await observer.query(
        `select wait_event_type, pg_blocking_pids(pid) as blockers
           from pg_stat_activity where pid=$1`,
        [firstPid],
      );
      waited =
        rows[0]?.wait_event_type === 'Lock' && rows[0].blockers.map(Number).includes(holderPid);
      if (!waited) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    doneWhileHeld = running.state.done;
  } finally {
    await holder.query('rollback');
  }
  const { result, ms } = await finished;
  return { waited, doneWhileHeld, result, ms: Math.round(ms * 10) / 10 };
}
async function setInviteState(db, inviteId, state) {
  await db.query(
    `update public.group_invites
        set revoked_at=case when $2='revogado' then now() end,
            expires_at=case when $2='expirado' then now()-interval '1 second'
                            else now()+interval '1 day' end,
            used_count=case when $2='esgotado' then max_uses else 0 end
      where id=$1`,
    [inviteId, state],
  );
}
function previewCalls(fixture, visitor) {
  const strangerDigest = crypto.randomBytes(32).toString('hex');
  return {
    code: (state) => (connection) =>
      connection.query('select public.preview_group_by_code($1,$2,$3) as page', [
        visitor.authId,
        visitor.sessionId,
        state === 'inexistente' ? strangerDigest : fixture.material.codeDigest,
      ]),
    link: (state) => (connection) =>
      connection.query(
        'select public.preview_group_by_invite($1,$2,$3,1::smallint,$4) as page',
        state === 'inexistente'
          ? [visitor.authId, visitor.sessionId, crypto.randomUUID(), strangerDigest]
          : [visitor.authId, visitor.sessionId, fixture.inviteId, fixture.material.tokenDigest],
      ),
  };
}
async function provePreviewWithoutLocks(db, connections) {
  const [owner, visitor] = await createSqlRaceActors(db, 2, 'preview-lock');
  const fixture = await createRaceGroup(db, owner);
  const calls = previewCalls(fixture, visitor);
  const timings = {};
  for (const state of ['inexistente', 'revogado', 'expirado', 'esgotado', 'vivo']) {
    await setInviteState(db, fixture.inviteId, state);
    for (const kind of ['code', 'link']) {
      const probe = await previewWhileGroupHeld(connections, fixture, calls[kind](state));
      const label = `preview ${kind} ${state} under held group`;
      assert.equal(probe.waited, false, `${label}: waited on the holder's lock`);
      assert.equal(probe.doneWhileHeld, true, `${label}: did not finish while the lock was held`);
      assert.ok(probe.ms < PREVIEW_HOLD_MS, `${label}: took ${probe.ms} ms`);
      if (state === 'vivo') {
        assert.equal(probe.result.status, 'fulfilled', `${label}: live invite must show the page`);
        // 0027 adds the group's icon and colour to the same unlocked read.
        assert.deepEqual(Object.keys(probe.result.value.rows[0].page).sort(), [
          'group_color',
          'group_icon',
          'group_id',
          'group_name',
          'member_count',
          'owner_name',
          'refusal',
          'viewer_status',
        ]);
      } else {
        assert.equal(probe.result.status, 'rejected', `${label}: must be refused`);
        assert.equal(probe.result.reason.code, '22023', label);
        assert.equal(probe.result.reason.message, 'CODE_INVALID', label);
      }
      timings[`${kind}:${state}`] = probe.ms;
    }
  }
  console.log(
    `ok - preview never waits on held group/invite/member locks; ms with lock held ${JSON.stringify(timings)}`,
  );

  // Contraprova: a trava do grupo antes da decisão (o caminho do c118363)
  // reabre o canal. Em STABLE o PostgreSQL recusa a trava; em VOLATILE o
  // detector acima precisa ver o convite revogado esperando pelo detentor.
  const original = (
    await db.query('select pg_get_functiondef($1::regprocedure) as definition', [PREVIEW_SIGNATURE])
  ).rows[0].definition;
  const decision = /\n(\s*)-- Inexistente, material divergente/u;
  assert.match(original, decision);
  assert.match(original, /\bSTABLE\b/u);
  const locked = original.replace(
    decision,
    (match, indent) =>
      `\n${indent}perform 1 from public.groups where id=v_invite.group_id for no key update;${match}`,
  );
  await setInviteState(db, fixture.inviteId, 'revogado');
  try {
    await db.query(locked);
    await assert.rejects(
      calls.code('revogado')(connections.first),
      /not allowed in a non-volatile function/u,
      'a lock inside the STABLE preview must be refused by PostgreSQL',
    );
    console.log('ok - mutant: a lock in the STABLE preview is refused by PostgreSQL');
    await db.query(locked.replace(/\bSTABLE\b/u, 'VOLATILE'));
    for (const state of ['revogado', 'expirado', 'esgotado']) {
      await setInviteState(db, fixture.inviteId, state);
      const probe = await previewWhileGroupHeld(connections, fixture, calls.code(state));
      assert.equal(probe.waited, true, `mutant ${state}: the detector missed the lock wait`);
      assert.equal(probe.doneWhileHeld, false, `mutant ${state}: finished under the lock`);
      const unknown = await previewWhileGroupHeld(connections, fixture, calls.code('inexistente'));
      assert.equal(unknown.waited, false, `mutant ${state}: unknown code also waited`);
      console.log(
        `ok - mutant with group lock: ${state} seen waiting on the holder, unknown code did not wait (${unknown.ms} ms)`,
      );
    }
  } finally {
    await db.query(original);
  }
}

async function proveUnbarrieredStorm(status, db, connections, phase) {
  const owner = await createActor(status, `storm-${phase}-owner`);
  const joiner = await createActor(status, `storm-${phase}-joiner`);
  const created = ok(
    await mutate(status, owner, 'create_group', { name: `Storm ${phase}` }),
    `${phase} storm group`,
  );
  const groupId = created.outcome.group_id;
  const inviteId = created.outcome.invite_id;
  const material = await materialFromDb(db, inviteId);
  ok(
    await mutate(status, joiner, 'join_by_code', { code: material.code }),
    `${phase} storm pending`,
  );
  const operations = [
    [
      'create_group',
      owner,
      async (side) => [`Storm ${side}`, ...(await materialArgs(crypto.randomUUID()))],
      new Set(['group_created', 'GROUP_LIMIT']),
    ],
    [
      'join_by_code',
      joiner,
      async () => [material.codeDigest],
      new Set(['membership_request_unchanged']),
    ],
    [
      'join_by_invite',
      joiner,
      async () => [inviteId, 1, material.tokenDigest],
      new Set(['membership_request_unchanged']),
    ],
    [
      'regenerate_group_invite',
      owner,
      async () => [inviteId, ...(await materialArgs(inviteId)).slice(1)],
      new Set(['invite_regenerated']),
    ],
    [
      'revoke_group_invite',
      owner,
      async () => [inviteId],
      new Set(['invite_revoked', 'invite_revocation_unchanged']),
    ],
    [
      'issue_group_invite',
      owner,
      async () => [groupId, ...(await materialArgs(crypto.randomUUID()))],
      new Set(['invite_issued', 'INVITE_ALREADY_ACTIVE']),
    ],
  ];
  for (const [operation, actor, business, expected] of operations) {
    const counts = new Map();
    for (let index = 0; index < 20; index += 1) {
      const [left, right] = await allValues(
        [business(`${phase}-${index}-A`), business(`${phase}-${index}-B`)],
        `${operation} business pair`,
      );
      const [a, b] = await Promise.allSettled([
        rpcTx(connections.first, operation, actor, left),
        rpcTx(connections.second, operation, actor, right),
      ]);
      for (const result of [a, b]) {
        const outcome =
          result.status === 'fulfilled'
            ? result.value.outcome.logical_result
            : result.reason?.message;
        assert.notEqual(result.reason?.code, '40P01', `${operation} ${phase} pair ${index}`);
        assert.ok(expected.has(outcome), `${operation} ${phase} pair ${index}: ${outcome}`);
        counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
      }
    }
    assert.equal(
      [...counts.values()].reduce((total, count) => total + count, 0),
      40,
    );
    console.log(
      `ok - ${phase} ${operation}: 20 unbarriered pairs, ${JSON.stringify(Object.fromEntries(counts))}, no 40P01`,
    );
  }
}

async function createSqlRaceActors(db, count, label) {
  const actors = Array.from({ length: count }, (_, index) => ({
    id: crypto.randomUUID(),
    authId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    email: harnessEmail(AUTH_PREFIX, `${label}-${index}-${crypto.randomUUID()}`),
  }));
  await db.query(
    `insert into auth.users(id,email)
    select id,email from unnest($1::uuid[],$2::text[]) as fixture(id,email)`,
    [actors.map((item) => item.authId), actors.map((item) => item.email)],
  );
  await db.query(
    `insert into public.profiles(id,auth_user_id,name,account_status)
    select id,auth_id,'Invite race','active'
    from unnest($1::uuid[],$2::uuid[]) as fixture(id,auth_id)`,
    [actors.map((item) => item.id), actors.map((item) => item.authId)],
  );
  return actors.map((item) => ({ ...item, profileId: item.id }));
}
async function createRaceGroup(db, owner, fillers = [], usedCount = 0) {
  const groupId = crypto.randomUUID();
  const inviteId = crypto.randomUUID();
  const material = await makeInviteMaterial(syntheticKey, inviteId);
  await db.query('begin');
  try {
    await db.query(
      `insert into public.groups(id,name,owner_id) values($1,'Invite race group',$2)`,
      [groupId, owner.profileId],
    );
    await db.query(
      `insert into public.group_members(group_id,profile_id,role,status)
      values($1,$2,'organizer','active')`,
      [groupId, owner.profileId],
    );
    if (fillers.length > 0) {
      await db.query(
        `insert into public.group_members(group_id,profile_id,role,status)
        select $1,id,'player','pending' from unnest($2::uuid[]) as fixture(id)`,
        [groupId, fillers.map((actor) => actor.profileId)],
      );
    }
    await db.query(
      `insert into public.group_invites
      (id,group_id,token_version,public_nonce,token_digest,code_digest,
       created_by,expires_at,used_count)
      values($1,$2,1,decode($3,'hex'),$4,$5,$6,now()+interval '30 days',$7)`,
      [
        inviteId,
        groupId,
        material.nonceHex,
        material.tokenDigest,
        material.codeDigest,
        owner.profileId,
        usedCount,
      ],
    );
    await db.query('commit');
  } catch (error) {
    try {
      await db.query('rollback');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'race fixture rollback failed');
    }
    throw error;
  }
  return { groupId, inviteId, material };
}
async function raceNWay(connections, actors, groupId, codeDigest, expectedWaits, label) {
  const { track, awaitLockWait, backendPid, assertDistinctConnections } =
    await import('./lock-barrier.mjs');
  const { observer, holder, racers } = connections;
  assert.ok(actors.length <= racers.length);
  const activeRacers = racers.slice(0, actors.length);
  await assertDistinctConnections(
    {
      observer,
      holder,
      ...Object.fromEntries(activeRacers.map((connection, index) => [`racer${index}`, connection])),
    },
    label,
  );
  const holderPid = await backendPid(holder);
  const pids = await allValues(activeRacers.map(backendPid), `${label} backend pids`);
  await holder.query('begin');
  await holder.query('select 1 from public.groups where id=$1 for no key update', [groupId]);
  let running = [];
  try {
    running = activeRacers.map((connection, index) =>
      track(rpcTx(connection, 'join_by_code', actors[index], [codeDigest])),
    );
    // A fila de tuple locks pode bloquear cada competidor no anterior; o
    // requisito N-way é N-1 esperas Lock, não N-1 bloqueios diretos pelo holder.
    for (let index = 0; index < expectedWaits; index += 1) {
      await awaitLockWait(
        observer,
        running[index],
        pids[index],
        [holderPid, ...pids],
        `${label} racer ${index}`,
        APP_PREFIX,
      );
    }
    const waiting = await observer.query(
      `select count(*)::integer as count from pg_stat_activity
      where pid=any($1::integer[]) and wait_event_type='Lock'`,
      [pids],
    );
    assert.ok(
      waiting.rows[0].count >= expectedWaits,
      `${label}: only ${waiting.rows[0].count} of ${expectedWaits} observed waiting`,
    );
  } finally {
    await holder.query('commit');
  }
  return allValues(
    running.map((item) => item.settled),
    `${label} tracked outcomes`,
  );
}
async function proveNWay(db, connections) {
  const actors = await createSqlRaceActors(db, 125, 'nway');
  const owner = actors[0];
  const lastUse = await createRaceGroup(db, owner, [], 99);
  const last = await raceNWay(
    connections,
    actors.slice(1, 26),
    lastUse.groupId,
    lastUse.material.codeDigest,
    24,
    'last use 25',
  );
  const lastResults = last.map((item) =>
    item.status === 'fulfilled' ? item.value.outcome.logical_result : item.reason?.message,
  );
  assert.equal(lastResults.filter((item) => item === 'membership_requested').length, 1);
  assert.equal(lastResults.filter((item) => item === 'INVITE_USED').length, 24);
  assert.equal(
    (await db.query('select used_count from public.group_invites where id=$1', [lastUse.inviteId]))
      .rows[0].used_count,
    100,
  );
  console.log(
    'ok - 25 simultaneous last-use redemptions: 24 lock waits, one use 100 and 24 INVITE_USED',
  );

  // Owner + 97 pending fillers = 98. The next two consume slots 99/100;
  // the third request is the 101st and must be denied after the group lock.
  const capacity = await createRaceGroup(db, actors[26], actors.slice(27, 124), 0);
  const reached = await raceNWay(
    connections,
    actors.slice(124, 125).concat(actors.slice(1, 3)),
    capacity.groupId,
    capacity.material.codeDigest,
    2,
    'capacity 99 100 101',
  );
  const capacityResults = reached.map((item) =>
    item.status === 'fulfilled' ? item.value.outcome.logical_result : item.reason?.message,
  );
  assert.equal(capacityResults.filter((item) => item === 'membership_requested').length, 2);
  assert.equal(capacityResults.filter((item) => item === 'GROUP_FULL').length, 1);
  assert.equal(
    (
      await db.query(
        `select count(*)::integer as count from public.group_members
    where group_id=$1 and status in ('pending','active')`,
        [capacity.groupId],
      )
    ).rows[0].count,
    100,
  );
  console.log('ok - capacity 99/100/101: two admitted, one GROUP_FULL, group remains at 100');
}

async function proveCapacityNoLockCounterexample(db, connections) {
  const { track, awaitLockWait, backendPid } = await import('./lock-barrier.mjs');
  const { observer, holder, racers } = connections;
  const actors = await createSqlRaceActors(db, 101, 'capacity-mutant');
  const fixture = await createRaceGroup(db, actors[0], actors.slice(1, 98));
  const signature =
    'private.join_group_invite(text,uuid,uuid,uuid,text,integer,integer,uuid,smallint,text,text)';
  const original = (
    await db.query('select pg_get_functiondef($1::regprocedure) as definition', [signature])
  ).rows[0].definition;
  const groupLock =
    /select \* into v_group from public\.groups where id=v_group_id for no key update;/i;
  const inviteLock =
    /select \* into v_invite from public\.group_invites where id=v_invite_id for no key update;/i;
  assert.match(original, groupLock);
  assert.match(original, inviteLock);
  const mutant = original
    .replace(groupLock, (match) => match.replace(/ for no key update;/i, ';'))
    .replace(inviteLock, (match) => match.replace(/ for no key update;/i, ';'));
  await db.query(mutant);
  try {
    const holderPid = await backendPid(holder);
    const activeRacers = racers.slice(0, 3);
    const pids = await allValues(activeRacers.map(backendPid), 'capacity mutant backend pids');
    await holder.query('begin');
    await holder.query('select 1 from public.group_invites where id=$1 for no key update', [
      fixture.inviteId,
    ]);
    const running = activeRacers.map((connection, index) =>
      track(rpcTx(connection, 'join_by_code', actors[98 + index], [fixture.material.codeDigest])),
    );
    let results;
    try {
      for (let index = 0; index < running.length; index += 1) {
        await awaitLockWait(
          observer,
          running[index],
          pids[index],
          [holderPid, ...pids],
          `capacity no-lock mutant racer ${index}`,
          APP_PREFIX,
        );
      }
    } finally {
      await holder.query('commit');
      results = await allValues(
        running.map((item) => item.settled),
        'capacity mutant outcomes',
      );
    }
    assert.equal(
      results.filter(
        (item) =>
          item.status === 'fulfilled' &&
          item.value.outcome.logical_result === 'membership_requested',
      ).length,
      3,
      'without group and invite read locks, all three stale capacity checks should admit',
    );
    assert.equal(
      (
        await db.query(
          `select count(*)::integer as count from public.group_members
           where group_id=$1 and status in ('pending','active')`,
          [fixture.groupId],
        )
      ).rows[0].count,
      101,
    );
    console.log(
      'ok - capacity mutant without group/invite read locks admits 101 after three waits',
    );
  } finally {
    await db.query(original);
  }
}

async function proveDeletionFreesOnePlace(db, connection) {
  const actors = await createSqlRaceActors(db, 102, 'deletion-capacity');
  const fixture = await createRaceGroup(db, actors[0], actors.slice(1, 100));
  const count = async () =>
    Number(
      (
        await db.query(
          `select count(*)::integer as count from public.group_members
           where group_id=$1 and status in ('pending','active')`,
          [fixture.groupId],
        )
      ).rows[0].count,
    );
  assert.equal(await count(), 100);
  const deletionId = crypto.randomUUID();
  const digest = crypto.createHash('sha256').update(deletionId).digest('hex');
  await connection.query('begin');
  try {
    await connection.query('set local role service_role');
    await connection.query('select public.delete_account($1,$2,$3,$4,1,1)', [
      actors[1].authId,
      actors[1].sessionId,
      deletionId,
      digest,
    ]);
    await connection.query('commit');
  } catch (error) {
    try {
      await connection.query('rollback');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'account deletion and rollback failed');
    }
    throw error;
  }
  assert.equal(await count(), 99, 'account deletion did not free one place');
  const admitted = await rpcTx(connection, 'join_by_code', actors[100], [
    fixture.material.codeDigest,
  ]);
  assert.equal(admitted.outcome.logical_result, 'membership_requested');
  assert.equal(await count(), 100);
  await assert.rejects(
    rpcTx(connection, 'join_by_code', actors[101], [fixture.material.codeDigest]),
    (error) => error.message === 'GROUP_FULL',
  );
  assert.equal(await count(), 100);
  assert.equal(
    (await db.query('select used_count from public.group_invites where id=$1', [fixture.inviteId]))
      .rows[0].used_count,
    1,
  );
  console.log('ok - delete_account frees exactly one place at capacity 100');
}

async function proveLimiterConcurrency(db, { observer, holder, racers }) {
  const { track, awaitLockWait, backendPid, assertDistinctConnections } =
    await import('./lock-barrier.mjs');
  const [actor, other] = await createSqlRaceActors(db, 2, 'limiter-concurrency');
  await db.query(
    "update private.app_limits set limit_value=2 where limit_key='invite_attempts_per_hour'",
  );
  const attempt = async (connection, subject = actor, profileId = subject.profileId) => {
    await connection.query('begin');
    try {
      await connection.query('set local role service_role');
      const result = await connection.query(
        'select public.check_and_debit_invite_attempt($1,$2,$3) as result',
        [profileId, subject.authId, subject.sessionId],
      );
      await connection.query('commit');
      return result.rows[0].result;
    } catch (error) {
      try {
        await connection.query('rollback');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'limiter attempt and rollback failed');
      }
      throw error;
    }
  };
  await assert.rejects(
    attempt(racers[0], actor, other.profileId),
    (error) => error.message === 'FORBIDDEN',
  );
  assert.equal(
    (
      await db.query(
        'select count(*)::integer as count from private.invite_rate_limits where profile_id=$1',
        [other.profileId],
      )
    ).rows[0].count,
    0,
  );
  await assertDistinctConnections(
    {
      observer,
      holder,
      ...Object.fromEntries(racers.map((connection, index) => [`racer${index}`, connection])),
    },
    'limiter barrier',
  );
  const holderPid = await backendPid(holder);
  const pids = await allValues(racers.map(backendPid), 'limiter backend pids');
  await holder.query('begin');
  await holder.query('select 1 from public.profiles where id=$1 for no key update', [
    actor.profileId,
  ]);
  const running = racers.map((connection) => track(attempt(connection)));
  try {
    for (let index = 0; index < running.length - 1; index += 1) {
      await awaitLockWait(
        observer,
        running[index],
        pids[index],
        [holderPid, ...pids],
        `limiter racer ${index}`,
        APP_PREFIX,
      );
    }
  } finally {
    await holder.query('commit');
  }
  const settled = await allValues(
    running.map((item) => item.settled),
    'limiter tracked attempts',
  );
  const errors = settled.filter((item) => item.status === 'rejected').map((item) => item.reason);
  if (errors.length) throw new AggregateError(errors, 'limiter competitors failed');
  const attempts = settled.map((item) => item.value);
  assert.equal(attempts.filter((item) => item.allowed).length, 2);
  assert.equal(attempts.filter((item) => !item.allowed).length, 23);
  assert.equal(
    (
      await db.query(
        'select count(*)::integer as count from private.invite_rate_limits where profile_id=$1',
        [actor.profileId],
      )
    ).rows[0].count,
    25,
  );
  // Contraprova determinística: sem o lock explícito, todos contam zero e
  // param no SEGUNDO recurso, o KEY SHARE da FK durante INSERT. O holder
  // segura o perfil em FOR UPDATE até as esperas serem observadas.
  const [mutantActor] = await createSqlRaceActors(db, 1, 'limiter-no-lock-mutant');
  const signature = 'public.check_and_debit_invite_attempt(uuid,uuid,uuid)';
  const original = (
    await db.query('select pg_get_functiondef($1::regprocedure) as definition', [signature])
  ).rows[0].definition;
  const profileLock = /perform 1 from public\.profiles where id = v_actor_id for no key update;/i;
  assert.match(original, profileLock);
  await db.query(
    original.replace(profileLock, 'perform 1 from public.profiles where id = v_actor_id;'),
  );
  try {
    const mutantRacers = racers.slice(0, 4);
    await holder.query('begin');
    await holder.query('select 1 from public.profiles where id=$1 for update', [
      mutantActor.profileId,
    ]);
    const runningMutant = mutantRacers.map((connection) => track(attempt(connection, mutantActor)));
    try {
      for (let index = 0; index < runningMutant.length; index += 1) {
        await awaitLockWait(
          observer,
          runningMutant[index],
          pids[index],
          [holderPid, ...pids],
          `no-lock limiter mutant ${index}`,
          APP_PREFIX,
        );
      }
    } finally {
      await holder.query('commit');
    }
    const mutantSettled = await allValues(
      runningMutant.map((item) => item.settled),
      'no-lock limiter mutant',
    );
    const mutantErrors = mutantSettled
      .filter((item) => item.status === 'rejected')
      .map((item) => item.reason);
    if (mutantErrors.length)
      throw new AggregateError(mutantErrors, 'no-lock limiter mutant failed');
    assert.ok(
      mutantSettled.filter((item) => item.value?.allowed).length > 2,
      'no-lock limiter mutant did not over-admit',
    );
  } finally {
    await db.query(original);
  }
  await db.query(
    "update private.app_limits set limit_value=20 where limit_key='invite_attempts_per_hour'",
  );
  console.log(
    'ok - limiter barrier admits two; no-lock mutant passes count before FK barrier and over-admits',
  );
}

async function seedActiveGroups(db, owner, count) {
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  await db.query('begin');
  try {
    await db.query(
      `insert into public.groups(id,name,owner_id)
      select id,'Quota fixture',$1 from unnest($2::uuid[]) as fixture(id)`,
      [owner.profileId, ids],
    );
    await db.query(
      `insert into public.group_members(group_id,profile_id,role,status)
      select id,$1,'organizer','active' from unnest($2::uuid[]) as fixture(id)`,
      [owner.profileId, ids],
    );
    await db.query('commit');
  } catch (error) {
    try {
      await db.query('rollback');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'quota fixture rollback failed');
    }
    throw error;
  }
  return ids;
}
async function proveFifthSlot(db, connections) {
  const { sameActorPair } = await import('./lock-barrier.mjs');
  for (const order of [1, 2]) {
    const [actor] = await createSqlRaceActors(db, 1, `fifth-${order}`);
    await seedActiveGroups(db, actor, 4);
    const a = [`Fifth A ${order}`, ...(await materialArgs(crypto.randomUUID()))];
    const b = [`Fifth B ${order}`, ...(await materialArgs(crypto.randomUUID()))];
    const results = await sameActorPair(
      { ...connections, applicationPrefix: APP_PREFIX },
      {
        label: `two creates fifth slot order ${order}`,
        profileId: actor.profileId,
        runFirst: commonArguments(actor, 'create_group', order === 1 ? a : b),
        runSecond: commonArguments(actor, 'create_group', order === 1 ? b : a),
      },
    );
    const outcomes = results
      .map((item) =>
        item.status === 'fulfilled' ? item.value.outcome.logical_result : item.reason?.message,
      )
      .sort();
    assert.deepEqual(outcomes, ['GROUP_LIMIT', 'group_created'].sort());
    const count = await db.query(
      `select count(*)::integer as count from public.group_members m
      join public.groups g on g.id=m.group_id
      where m.profile_id=$1 and m.status='active' and g.archived_at is null`,
      [actor.profileId],
    );
    assert.equal(count.rows[0].count, 5);
    console.log(
      `ok - two create_group calls against fifth slot order ${order}: one group_created, one GROUP_LIMIT`,
    );
  }
}
async function proveCreateAgainstApproval(db, connections) {
  const { sameActorPair } = await import('./lock-barrier.mjs');
  for (const order of [1, 2]) {
    const [target, organizer] = await createSqlRaceActors(db, 2, `approve-create-${order}`);
    await seedActiveGroups(db, target, 4);
    const groupId = crypto.randomUUID();
    await db.query('begin');
    try {
      await db.query(
        `insert into public.groups(id,name,owner_id)
        values($1,'Approve versus create',$2)`,
        [groupId, organizer.profileId],
      );
      await db.query(
        `insert into public.group_members(group_id,profile_id,role,status)
        values($1,$2,'organizer','active'),($1,$3,'player','pending')`,
        [groupId, organizer.profileId, target.profileId],
      );
      await db.query('commit');
    } catch (error) {
      try {
        await db.query('rollback');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'cross fixture rollback failed');
      }
      throw error;
    }
    const createArgs = [
      `Create versus approve ${order}`,
      ...(await materialArgs(crypto.randomUUID())),
    ];
    const approveArgs = [groupId, target.profileId, true];
    const create = commonArguments(target, 'create_group', createArgs);
    const approve = commonArguments(organizer, 'approve_member', approveArgs);
    const results = await sameActorPair(
      { ...connections, applicationPrefix: APP_PREFIX },
      {
        label: `create vs approve order ${order}`,
        profileId: target.profileId,
        runFirst: order === 1 ? create : approve,
        runSecond: order === 1 ? approve : create,
      },
    );
    const outcomes = results
      .map((item) =>
        item.status === 'fulfilled' ? item.value.outcome.logical_result : item.reason?.message,
      )
      .sort();
    assert.deepEqual(
      outcomes,
      [
        'GROUP_LIMIT',
        outcomes.includes('group_created') ? 'group_created' : 'member_approved',
      ].sort(),
    );
    const quota = await db.query(
      `select count(*)::integer as count from public.group_members m
      join public.groups g on g.id=m.group_id
      where m.profile_id=$1 and m.status='active' and g.archived_at is null`,
      [target.profileId],
    );
    assert.equal(quota.rows[0].count, 5);
    console.log(
      `ok - create_group × approve_member order ${order}: ${outcomes.join('/')}, fifth slot preserved`,
    );
  }
}

async function callWorker(status, job) {
  const response = await fetch(`${status.functionsUrl}/worker/${job}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${localWorkerCronSecret()}`,
      apikey: status.publishableKey,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const raw = await response.text();
  assert.equal(response.status, 200, `${job}: ${response.status} ${raw}`);
  return JSON.parse(raw);
}

async function proveRateWindowAndAlarm(db, connection) {
  const [actor] = await createSqlRaceActors(db, 1, 'rate-window');
  await db.query('delete from private.invite_rate_limits');
  await db.query(
    "update private.app_limits set limit_value=2 where limit_key='invite_attempts_per_hour'",
  );
  await db.query(
    `insert into private.invite_rate_limits(profile_id,attempted_at)
    values($1,clock_timestamp()-interval '61 minutes'),
          ($1,clock_timestamp()-interval '59 minutes')`,
    [actor.profileId],
  );
  const admit = async () => {
    await connection.query('begin');
    try {
      await connection.query('set local role service_role');
      const result = await connection.query(
        'select public.check_and_debit_invite_attempt($1,$2,$3) as result',
        [actor.profileId, actor.authId, actor.sessionId],
      );
      await connection.query('commit');
      return result.rows[0].result;
    } catch (error) {
      try {
        await connection.query('rollback');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'rate window rollback failed');
      }
      throw error;
    }
  };
  assert.equal((await admit()).allowed, true, '61-minute attempt must leave sliding window');
  const deniedAttempt = await admit();
  assert.equal(deniedAttempt.allowed, false, '59-minute attempt must still count');
  assert.ok(deniedAttempt.retry_after >= 3595 && deniedAttempt.retry_after <= 3601);
  assert.ok(
    Math.abs(Date.parse(deniedAttempt.available_at) - Date.now() - 3_600_000) < 5000,
    'denied attempts also occupy budget, so two prior rows must expire',
  );

  await db.query('delete from private.invite_rate_limits');
  await db.query(
    `insert into private.invite_rate_limits(profile_id,attempted_at,result_class)
    select $1,clock_timestamp()-interval '30 minutes',
      case when n<=10 then 'failure' else 'success' end
    from generate_series(1,20) n`,
    [actor.profileId],
  );
  await db.query(
    `insert into private.invite_rate_limits(profile_id,attempted_at,result_class)
    values($1,clock_timestamp()-interval '30 seconds','failure')`,
    [actor.profileId],
  );
  const alarm = await db.query(`select count(*) as attempts,
    count(*) filter (where result_class is distinct from 'success') as failures
    from private.invite_rate_limits
    where attempted_at >= now()-interval '1 hour'
      and attempted_at < now()-interval '1 minute'`);
  assert.equal(Number(alarm.rows[0].attempts), 20);
  assert.equal(Number(alarm.rows[0].failures), 10);
  await db.query('delete from private.invite_rate_limits');
  await db.query(
    "update private.app_limits set limit_value=20 where limit_key='invite_attempts_per_hour'",
  );
  console.log('ok - sliding one-hour window and exact manual alarm query, 20 attempts/10 failures');
}
async function proveRetention(status, db) {
  const [owner] = await createSqlRaceActors(db, 1, 'retention');
  const { groupId, inviteId } = await createRaceGroup(db, owner);
  const terminal = [];
  for (const kind of ['old-revoked', 'old-expired', 'recent-revoked']) {
    const id = crypto.randomUUID();
    const material = await makeInviteMaterial(syntheticKey, id);
    await db.query(
      `insert into public.group_invites
      (id,group_id,token_version,public_nonce,token_digest,code_digest,
       created_by,expires_at,revoked_at)
      values($1,$2,1,decode($3,'hex'),$4,$5,$6,$7,$8)`,
      [
        id,
        groupId,
        material.nonceHex,
        material.tokenDigest,
        material.codeDigest,
        owner.profileId,
        kind === 'old-expired'
          ? new Date(Date.now() - 31 * 86400000)
          : new Date(Date.now() + 30 * 86400000),
        kind === 'old-revoked'
          ? new Date(Date.now() - 31 * 86400000)
          : kind === 'recent-revoked'
            ? new Date(Date.now() - 29 * 86400000)
            : null,
      ],
    );
    terminal.push({ id, kind });
  }
  const run = await callWorker(status, 'purge_terminal_group_invites');
  assert.equal(run.data?.status, 'succeeded');
  const rows = await db.query('select id from public.group_invites where group_id=$1', [groupId]);
  const remaining = new Set(rows.rows.map((row) => row.id));
  assert.equal(remaining.has(inviteId), true, 'live invitation was purged');
  assert.equal(remaining.has(terminal[0].id), false, 'old revoked invitation survived');
  assert.equal(remaining.has(terminal[1].id), false, 'old expired invitation survived');
  assert.equal(remaining.has(terminal[2].id), true, 'recent revoked invitation was purged');
  const job = await db.query(`select status,summary from private.job_runs
    where job_name='purge_terminal_group_invites' order by id desc limit 1`);
  assert.equal(job.rows[0].status, 'succeeded');
  assert.ok(job.rows[0].summary.changed >= 2);
  console.log(
    'ok - terminal invite retention through worker Edge: two old out, recent and live kept',
  );

  const fixedNow = '2030-01-02T03:04:05.000Z';
  const original = (
    await db.query(
      "select pg_get_functiondef('private.purge_invite_rate_limits()'::regprocedure) as definition",
    )
  ).rows[0].definition;
  const clockDeclaration = 'v_now timestamptz := clock_timestamp()';
  assert.equal(original.split(clockDeclaration).length, 2, 'purge clock declaration changed');
  let controlled = original.replace(
    clockDeclaration,
    `v_now timestamptz := '${fixedNow}'::timestamptz`,
  );
  const cutoff = "v_now - interval '1 hour'";
  assert.equal(controlled.split(cutoff).length, 4, 'purge eligibility shape changed');
  if (process.env.COLETE_TEST_PURGE_LATE_50S === '1') {
    let eligibilityUses = 0;
    controlled = controlled.replaceAll(cutoff, () => {
      eligibilityUses += 1;
      return eligibilityUses <= 2 ? "v_now - interval '1 hour 50 seconds'" : cutoff;
    });
  }
  const olderId = crypto.randomUUID();
  const youngerId = crypto.randomUUID();
  try {
    await db.query(controlled);
    await db.query(
      `insert into private.invite_rate_limits(attempt_id,profile_id,attempted_at)
       values($1,$3,$4::timestamptz - interval '1 hour 1 second'),
             ($2,$3,$4::timestamptz - interval '59 minutes 59 seconds')`,
      [olderId, youngerId, owner.profileId, fixedNow],
    );
    const rateRun = await callWorker(status, 'purge_invite_rate_limits');
    assert.equal(rateRun.data?.status, 'succeeded');
    const purged = await db.query(`select summary from private.job_runs
      where job_name='purge_invite_rate_limits' order by id desc limit 1`);
    const attempts = await db.query(
      `select attempt_id from private.invite_rate_limits
       where attempt_id = any($1::uuid[]) order by attempt_id`,
      [[olderId, youngerId]],
    );
    const remaining = new Set(attempts.rows.map((row) => row.attempt_id));
    console.log(
      `purge boundary at fixed ${fixedNow}: older=${remaining.has(olderId) ? 'kept' : 'deleted'}, ` +
        `younger=${remaining.has(youngerId) ? 'kept' : 'deleted'}, changed=${purged.rows[0].summary.changed}`,
    );
    assert.equal(remaining.has(youngerId), true, '1 h - 1 s must be preserved');
    assert.equal(remaining.has(olderId), false, '1 h + 1 s must be purged');
    assert.equal(Number(purged.rows[0].summary.changed), 1);
    console.log('ok - minute worker at fixed clock preserves 1 h - 1 s and purges 1 h + 1 s');
  } finally {
    await db.query(original);
  }
}

function dockerLogs(container, since) {
  return execFileSync('sh', ['-c', 'docker logs --since "$1" "$2" 2>&1', 'sh', since, container], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}
function dataOnlyDump() {
  return execFileSync(
    'docker',
    [
      'exec',
      'supabase_db_colete',
      'pg_dump',
      '--data-only',
      '--no-owner',
      '-U',
      'postgres',
      'postgres',
    ],
    {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    },
  );
}
function findSecret(text, values) {
  return values.filter(([name, value]) => text.includes(value)).map(([name]) => name);
}
async function proveLeakCensus(status, db, since, material, owner, groupId) {
  const secrets = [
    ['token', material.token],
    ['mac', material.macHex],
    ['code_display', material.code],
    ['code_normalised', material.code.replace('-', '')],
  ];
  const tableSentinel = `colete-census-table-${crypto.randomUUID()}`;
  await db.query('update public.groups set name=$1 where id=$2', [tableSentinel, groupId]);
  const dump = dataOnlyDump();
  assert.ok(dump.includes(tableSentinel), 'table channel was not demonstrably read');
  assert.deepEqual(findSecret(dump, secrets), [], 'material in pg_dump --data-only');
  const sentinel = `colete-invite-sentinel-${crypto.randomUUID()}`;
  let sentinelError;
  try {
    await db.query(`select 1 / 0 as "${sentinel}"`);
  } catch (error) {
    sentinelError = error;
  }
  assert.equal(sentinelError?.code, '22012', 'Postgres log sentinel query did not fail');
  const logs = {};
  // Some production images (notably PostgREST) are distroless and have no
  // shell to inject a line. Their own startup lines are positive controls for
  // the same Docker log stream; PostgreSQL also gets a fresh query marker.
  const startupSentinels = {
    rest: 'Starting PostgREST',
    edge_runtime: 'Serving functions on',
    kong: 'start worker process',
    auth: 'GoTrue migrations applied successfully',
  };
  for (const name of ['db', 'rest', 'edge_runtime', 'kong', 'auth']) {
    const logSentinel = name === 'db' ? sentinel : startupSentinels[name];
    const content = dockerLogs(
      `supabase_${name}_colete`,
      name === 'db' ? since : '1970-01-01T00:00:00Z',
    );
    logs[name] = {
      bytes: Buffer.byteLength(content),
      sentinel: content.includes(logSentinel),
      hits: findSecret(content, secrets),
    };
    assert.equal(logs[name].sentinel, true, `${name} log was not demonstrably read`);
    assert.deepEqual(logs[name].hits, [], `material in ${name} stdout`);
  }
  const errorRequestId = crypto.randomUUID();
  denied(
    await mutate(status, owner, 'create_group', { name: 'X' }, errorRequestId),
    422,
    'VALIDATION',
    'census error response',
  );
  assert.ok(
    censusResponses.some((body) => body.includes(errorRequestId)),
    'error response channel was not demonstrably read',
  );
  const successResponse = await groups(status, owner, 'get_my_pending_group_requests', {});
  ok(successResponse, 'census success response');
  assert.ok(
    censusResponses.some((body) => body.includes(successResponse.body.request_id)),
    'success response channel was not demonstrably read',
  );
  assert.deepEqual(
    findSecret(censusResponses.join('\n'), secrets),
    [],
    'material in ordinary HTTP response or error',
  );
  assert.equal(authorisedShareResponses.length, 1, 'sensitive share response census');
  assert.deepEqual(
    findSecret(authorisedShareResponses[0], secrets).sort(),
    ['token', 'code_display'].sort(),
    'authorized share must contain only the token and displayed code',
  );
  // Detector controls are independent of production channels; Sentry is not
  // integrated into this pilot Edge function.
  for (const [name, value] of secrets) {
    assert.deepEqual(findSecret(value, secrets), [name], `${name} detector control failed`);
  }
  console.log(
    `ok - single leak census: pg_dump ${Buffer.byteLength(dump)} bytes, ` +
      `HTTP bodies ${censusResponses.length}, table/response/error sentinels present, ` +
      `five service logs ${JSON.stringify(logs)}, four detector controls passed`,
  );
}

async function shareTx(connection, actor, inviteId) {
  await connection.query('begin');
  try {
    await connection.query('set local role service_role');
    const result = await connection.query(
      `select public.get_invite_share_link(
      $1::uuid,$2::uuid,$3::uuid) as result`,
      [actor.authId, actor.sessionId, inviteId],
    );
    await connection.query('commit');
    return result.rows[0].result;
  } catch (error) {
    try {
      await connection.query('rollback');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'share rollback failed');
    }
    throw error;
  }
}
async function proveShareRace(db, connections) {
  const { track, awaitLockWait, backendPid, assertDistinctConnections } =
    await import('./lock-barrier.mjs');
  const { observer, holder, first, second } = connections;
  const pids = await assertDistinctConnections({ observer, holder, first, second }, 'share races');
  for (const mutation of ['regenerate_group_invite', 'revoke_group_invite']) {
    for (const order of [1, 2]) {
      const [owner] = await createSqlRaceActors(db, 1, `share-${mutation}-${order}`);
      const fixture = await createRaceGroup(db, owner);
      const old = fixture.material;
      const mutationBusiness =
        mutation === 'regenerate_group_invite'
          ? [fixture.inviteId, ...(await materialArgs(fixture.inviteId)).slice(1)]
          : [fixture.inviteId];
      const mutator = (connection) => rpcTx(connection, mutation, owner, mutationBusiness);
      const reader = (connection) => shareTx(connection, owner, fixture.inviteId);
      const firstCall = order === 1 ? reader : mutator;
      const secondCall = order === 1 ? mutator : reader;
      await holder.query('begin');
      await holder.query('select 1 from public.group_invites where id=$1 for no key update', [
        fixture.inviteId,
      ]);
      let a;
      let b;
      try {
        a = track(firstCall(first));
        await awaitLockWait(
          observer,
          a,
          pids.first,
          pids.holder,
          `share ${mutation} order ${order} first`,
          APP_PREFIX,
        );
        b = track(secondCall(second));
        await awaitLockWait(
          observer,
          b,
          pids.second,
          [pids.holder, pids.first],
          `share ${mutation} order ${order} second`,
          APP_PREFIX,
        );
      } finally {
        await holder.query('commit');
      }
      const [firstResult, secondResult] = await allValues(
        [a.settled, b.settled],
        'share race outcomes',
      );
      const shareResult = order === 1 ? firstResult : secondResult;
      const mutationResult = order === 1 ? secondResult : firstResult;
      assert.equal(
        mutationResult.status,
        'fulfilled',
        `mutation failed: ${mutationResult.reason?.message}`,
      );
      if (mutation === 'regenerate_group_invite') {
        assert.equal(shareResult.status, 'fulfilled');
        const current = await materialFromDb(db, fixture.inviteId);
        assert.equal(
          shareResult.value.token_digest,
          order === 1 ? old.tokenDigest : current.tokenDigest,
        );
        assert.notEqual(current.tokenDigest, old.tokenDigest);
      } else if (order === 1) {
        assert.equal(shareResult.status, 'fulfilled');
        assert.equal(shareResult.value.token_digest, old.tokenDigest);
      } else {
        assert.equal(shareResult.status, 'rejected');
        assert.equal(shareResult.reason?.message, 'INVITE_REVOKED');
      }
      console.log(
        `ok - share × ${mutation} order ${order}: current material or terminal refusal under invite lock`,
      );
    }
  }
}

async function proveReentry(db, connection) {
  const [owner, target, blocked] = await createSqlRaceActors(db, 3, 'reentry');
  const fixture = await createRaceGroup(db, owner);
  const firstJoined = '2024-01-01T00:00:00Z';
  await db.query(
    `insert into public.group_members
    (group_id,profile_id,role,status,is_monthly,joined_at,last_requested_at,removed_at,removal_count)
    values($1,$2,'organizer','removed',true,$3,$3,now()-interval '1 day',2)`,
    [fixture.groupId, target.profileId, firstJoined],
  );
  const requestId = crypto.randomUUID();
  const entered = await rpcTx(
    connection,
    'join_by_code',
    target,
    [fixture.material.codeDigest],
    requestId,
  );
  assert.equal(entered.outcome.logical_result, 'membership_reentry_requested');
  assert.equal(entered.outcome.reentry, true);
  assert.equal(entered.current.status, 'pending');
  const row = await db.query(
    `select role,status,is_monthly,joined_at::text as joined_at,
    last_requested_at::text as requested,removed_at,removal_count
    from public.group_members where group_id=$1 and profile_id=$2`,
    [fixture.groupId, target.profileId],
  );
  assert.equal(row.rowCount, 1, 'reentry replaced membership line');
  assert.equal(row.rows[0].status, 'pending');
  assert.equal(row.rows[0].role, 'player');
  assert.equal(row.rows[0].is_monthly, false);
  assert.equal(row.rows[0].removed_at, null);
  assert.equal(row.rows[0].removal_count, 3);
  assert.ok(new Date(row.rows[0].joined_at).getTime() === new Date(firstJoined).getTime());
  assert.ok(new Date(row.rows[0].requested).getTime() > new Date(firstJoined).getTime());
  const replay = await rpcTx(
    connection,
    'join_by_code',
    target,
    [fixture.material.codeDigest],
    requestId,
  );
  assert.deepEqual(replay.outcome, entered.outcome);
  const repeated = await rpcTx(connection, 'join_by_invite', target, [
    fixture.inviteId,
    1,
    fixture.material.tokenDigest,
  ]);
  assert.equal(repeated.outcome.logical_result, 'membership_request_unchanged');
  const afterPending = await db.query(
    `select last_requested_at::text as requested,
    removal_count from public.group_members where group_id=$1 and profile_id=$2`,
    [fixture.groupId, target.profileId],
  );
  assert.equal(afterPending.rows[0].requested, row.rows[0].requested);
  assert.equal(afterPending.rows[0].removal_count, 3);
  assert.equal(
    (await db.query('select used_count from public.group_invites where id=$1', [fixture.inviteId]))
      .rows[0].used_count,
    1,
  );
  const fillers = await createSqlRaceActors(db, 98, 'reentry-full');
  await db.query(
    `insert into public.group_members(group_id,profile_id,role,status)
    select $1,id,'player','pending' from unnest($2::uuid[]) as fixture(id)`,
    [fixture.groupId, fillers.map((actor) => actor.profileId)],
  );
  assert.equal(
    (
      await db.query(
        `select count(*)::integer as count from public.group_members
    where group_id=$1 and status in ('active','pending')`,
        [fixture.groupId],
      )
    ).rows[0].count,
    100,
  );
  const fullPending = await rpcTx(connection, 'join_by_code', target, [
    fixture.material.codeDigest,
  ]);
  assert.equal(fullPending.outcome.logical_result, 'membership_request_unchanged');
  const approved = await rpcTx(connection, 'approve_member', owner, [
    fixture.groupId,
    target.profileId,
    true,
  ]);
  assert.equal(approved.outcome.logical_result, 'member_approved');
  const fullActive = await rpcTx(connection, 'join_by_code', target, [fixture.material.codeDigest]);
  assert.equal(fullActive.outcome.logical_result, 'membership_already_active');
  assert.equal(fullActive.current.status, 'active');
  const replayAfterApproval = await rpcTx(
    connection,
    'join_by_code',
    target,
    [fixture.material.codeDigest],
    requestId,
  );
  assert.equal(replayAfterApproval.outcome.reentry, true);
  assert.equal(replayAfterApproval.current.status, 'active');
  await db.query(
    `insert into public.group_members
    (group_id,profile_id,role,status,removed_at,removal_count)
    values($1,$2,'player','removed',now(),2)`,
    [fixture.groupId, blocked.profileId],
  );
  let refused;
  try {
    await rpcTx(connection, 'join_by_code', blocked, [fixture.material.codeDigest]);
  } catch (error) {
    refused = error;
  }
  assert.equal(refused?.message, 'GROUP_FULL');
  const blockedRow = await db.query(
    `select status,removal_count from public.group_members
    where group_id=$1 and profile_id=$2`,
    [fixture.groupId, blocked.profileId],
  );
  assert.deepEqual(blockedRow.rows[0], { status: 'removed', removal_count: 2 });
  assert.equal(
    (await db.query('select used_count from public.group_invites where id=$1', [fixture.inviteId]))
      .rows[0].used_count,
    1,
  );
  console.log(
    'ok - reentry preserves line/joined_at, increments once, pending and active no-op under full capacity, replay retains intent; refused reentry is atomic',
  );
}

async function proveReplayAuthorityHttp(status, db) {
  const creator = await createActor(status, 'authority-creator');
  const successor = await createActor(status, 'authority-successor');
  const createId = crypto.randomUUID();
  const created = ok(
    await mutate(status, creator, 'create_group', { name: 'Authority replay group' }, createId),
    'authority create',
  );
  const inviteId = created.outcome.invite_id;
  const material = await materialFromDb(db, inviteId);
  ok(await mutate(status, successor, 'join_by_code', { code: material.code }), 'successor join');
  ok(
    await mutate(status, creator, 'approve_member', {
      group_id: created.outcome.group_id,
      profile_id: successor.profileId,
      approve: true,
    }),
    'approve successor',
  );
  const revokeId = crypto.randomUUID();
  const revoked = ok(
    await mutate(status, creator, 'revoke_group_invite', { invite_id: inviteId }, revokeId),
    'authority revoke',
  );
  ok(
    await mutate(status, creator, 'transfer_ownership', {
      group_id: created.outcome.group_id,
      new_owner_id: successor.profileId,
    }),
    'transfer authority',
  );
  ok(
    await mutate(status, successor, 'set_role', {
      group_id: created.outcome.group_id,
      profile_id: creator.profileId,
      role: 'player',
    }),
    'demote creator',
  );
  denied(
    await groups(status, creator, 'get_invite_share_link', { invite_id: inviteId }),
    403,
    'NOT_ORGANIZER',
    'historical creator as player cannot share',
  );
  denied(
    await mutate(status, creator, 'issue_group_invite', { group_id: created.outcome.group_id }),
    403,
    'NOT_ORGANIZER',
    'historical creator as player cannot issue',
  );
  ok(
    await mutate(status, creator, 'leave_group', {
      group_id: created.outcome.group_id,
    }),
    'creator leaves',
  );
  denied(
    await groups(status, creator, 'get_invite_share_link', { invite_id: inviteId }),
    403,
    'NOT_MEMBER',
    'historical created_by does not authorize share',
  );
  const createdReplay = ok(
    await mutate(status, creator, 'create_group', { name: 'Authority replay group' }, createId),
    'creator replay after leave',
  );
  assert.deepEqual(createdReplay, { outcome: created.outcome });
  const revokedReplay = ok(
    await mutate(status, creator, 'revoke_group_invite', { invite_id: inviteId }, revokeId),
    'revoke replay after leave',
  );
  assert.deepEqual(revokedReplay, { outcome: revoked.outcome });
  console.log(
    'ok - HTTP player and removed creator lose invite authority; replay keeps stable outcomes only',
  );

  const sessionActor = await createActor(status, 'authority-session');
  const sessionCreateId = crypto.randomUUID();
  ok(
    await mutate(
      status,
      sessionActor,
      'create_group',
      { name: 'Revoked session group' },
      sessionCreateId,
    ),
    'session create',
  );
  ok(
    await edge(
      status,
      'identity/revoke_current_session',
      { request_id: crypto.randomUUID() },
      sessionActor.token,
    ),
    'revoke own session',
  );
  denied(
    await mutate(
      status,
      sessionActor,
      'create_group',
      { name: 'Revoked session group' },
      sessionCreateId,
    ),
    401,
    'UNAUTHENTICATED',
    'replay under revoked session',
  );
  console.log('ok - HTTP revoked session denies replay before outcome');
}

async function main() {
  const status = localStatus();
  const censusSince = new Date(Date.now() - 1000).toISOString();
  const db = client(status.dbUrl, 'admin');
  const observer = client(status.dbUrl, 'observer');
  const holder = client(status.dbUrl, 'holder');
  const first = client(status.dbUrl, 'first');
  const second = client(status.dbUrl, 'second');
  const racers = Array.from({ length: 25 }, (_, index) => client(status.dbUrl, `racer_${index}`));
  const all = [db, observer, holder, first, second, ...racers];
  guard.useDatabase(status.dbUrl);
  let baselineRuns = 0;
  let baselineRetention = 0;
  guard.onCleanup(async (cleanupClient) => {
    await cleanup(cleanupClient);
    await cleanupClient.query('delete from private.job_runs where id>$1 and job_name in ($2,$3)', [
      baselineRuns,
      'purge_terminal_group_invites',
      'purge_invite_rate_limits',
    ]);
    await cleanupClient.query(
      'delete from private.retention_runs where id>$1 and policy in ($2,$3)',
      [baselineRetention, 'purge_terminal_group_invites', 'purge_invite_rate_limits'],
    );
    await cleanupClient.query(
      "update private.app_limits set limit_value=20 where limit_key='invite_attempts_per_hour'",
    );
  });
  guard.onCensus(async (censusClient) => {
    const users = await censusClient.query('select count(*)::integer as count from auth.users');
    const remaining = await censusClient.query(
      'select count(*)::integer as count from public.groups',
    );
    assert.equal(users.rows[0].count, 0, 'auth.users residue after cleanup');
    assert.equal(remaining.rows[0].count, 0, 'groups residue after cleanup');
  });
  let error;
  try {
    await allValues(
      all.map((connection) => connection.connect()),
      'invite harness connections',
    );
    await cleanup(db);
    baselineRuns = Number(
      (await db.query('select coalesce(max(id),0)::text as id from private.job_runs')).rows[0].id,
    );
    baselineRetention = Number(
      (await db.query('select coalesce(max(id),0)::text as id from private.retention_runs')).rows[0]
        .id,
    );
    const baseline = await db.query('select count(*)::integer as count from auth.users');
    assert.equal(baseline.rows[0].count, 0, 'auth.users must start empty');
    if (process.env.COLETE_ONLY_PURGE_BOUNDARY === '1') {
      await proveRetention(status, db);
    } else {
      const context = await proveHttp(status, db);
      await proveTerminalRevocationAndEmptyIssue(status, db);
      await proveNameVectorsHttp(status);
      await provePreviewWithoutLocks(db, { observer, holder, first });
      await proveUnbarrieredStorm(status, db, { first, second }, 'before');
      await proveSameActorRaces(status, db, { observer, holder, first, second }, context);
      await proveLockCounterexamples(db, { observer, holder, first, second }, context);
      await proveUnbarrieredStorm(status, db, { first, second }, 'after');
      await proveNWay(db, { observer, holder, racers });
      await proveCapacityNoLockCounterexample(db, { observer, holder, racers });
      await proveDeletionFreesOnePlace(db, first);
      await proveLimiterConcurrency(db, { observer, holder, racers });
      await proveFifthSlot(db, { observer, holder, first, second });
      await proveCreateAgainstApproval(db, { observer, holder, first, second });
      await proveReplayAuthorityHttp(status, db);
      await proveReentry(db, first);
      await proveShareRace(db, { observer, holder, first, second });
      await proveRateWindowAndAlarm(db, first);
      await proveRetention(status, db);
      await proveLeakCensus(
        status,
        db,
        censusSince,
        context.censusMaterial,
        context.owner,
        context.groupId,
      );
    }
  } catch (caught) {
    error = caught;
  }
  const closed = await Promise.allSettled(all.map((connection) => connection.end()));
  const closeErrors = closed
    .filter((entry) => entry.status === 'rejected')
    .map((entry) => entry.reason);
  if (closeErrors.length > 0) {
    throw new AggregateError(
      error === undefined ? closeErrors : [error, ...closeErrors],
      'closing invite harness failed',
    );
  }
  if (error !== undefined) throw error;
}
if (await guard.run(main)) console.log('Group invite harness passed.');
