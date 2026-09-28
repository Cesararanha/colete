// Layer two of the gateway proof: the function, over HTTP, against the local
// stack, with a real GoTrue token.
//
// Layer one lives in supabase/functions/_shared/*.test.ts and proves the
// canonicalisation and the two published golden vectors without a network.
// This layer proves the thing layer one cannot: that the external boundary, the
// verified claims, the HMAC and the narrow RPC agree with each other and with
// the database. It runs against `supabase start`, which already serves the
// function, so there is no second process to supervise in CI.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { harnessEmail, harnessEmailPattern, sweepMarkedAuthUsers } from './harness-guard.mjs';

const { Client } = pg;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const supabaseBinary = path.join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
);

const PASSWORD = 'colete-local-gateway-test-password';
// Marca dos usuários Auth deste harness (scripts/harness-guard.mjs).
const AUTH_EMAIL_PREFIX = 'gateway-';
const EMAIL = harnessEmail(AUTH_EMAIL_PREFIX, `${Date.now()}`);

function localEnvironment() {
  let raw;
  try {
    raw = execFileSync(supabaseBinary, ['status', '-o', 'env'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('The local Supabase stack is unavailable. Run npm run db:start first.');
  }
  const read = (name) => {
    const match = raw.match(new RegExp(`^${name}="([^"]+)"$`, 'm'));
    if (!match) throw new Error(`supabase status did not expose ${name}`);
    return match[1];
  };
  return {
    apiUrl: read('API_URL'),
    dbUrl: read('DB_URL'),
    publishableKey: read('PUBLISHABLE_KEY'),
    secretKey: read('SECRET_KEY'),
  };
}

const uuid = () => crypto.randomUUID();

async function createUserAndSignIn(env) {
  const created = await fetch(`${env.apiUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: env.secretKey,
      Authorization: `Bearer ${env.secretKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
  });
  assert.equal(created.status, 200, `admin create user failed: ${created.status}`);
  const user = await created.json();

  const signedIn = await fetch(`${env.apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.publishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  assert.equal(signedIn.status, 200, `password grant failed: ${signedIn.status}`);
  const session = await signedIn.json();

  const claims = JSON.parse(
    Buffer.from(session.access_token.split('.')[1], 'base64url').toString('utf8'),
  );
  assert.equal(typeof claims.session_id, 'string', 'the access token carries no session_id');
  assert.equal(claims.sub, user.id, 'the token subject is not the created user');

  return { userId: user.id, token: session.access_token, sessionId: claims.session_id };
}

async function call(env, operation, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${env.apiUrl}/functions/v1/identity/${operation}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

// Remove o que pertence a usuários com a marca do harness: idempotência,
// revogações e perfis ligados a eles, depois os próprios usuários. Roda no
// início, para o que uma execução interrompida deixou, e no fim. Usuário sem a
// marca nunca é tocado.
async function cleanupMarked(db) {
  const markedProfiles = `select profile.id from public.profiles profile
      join auth.users account on account.id = profile.auth_user_id
     where account.email like $1 escape '\\'`;
  const pattern = harnessEmailPattern(AUTH_EMAIL_PREFIX);
  await db.query(`delete from private.idempotency_records where actor_id in (${markedProfiles})`, [
    pattern,
  ]);
  await db.query('delete from private.idempotency_records where actor_key like $1', [
    'bootstrap:%',
  ]);
  await db.query(
    `delete from private.revoked_auth_sessions where profile_id in (${markedProfiles})`,
    [pattern],
  );
  await db.query(`delete from public.profiles where id in (${markedProfiles})`, [pattern]);
  await sweepMarkedAuthUsers(db, AUTH_EMAIL_PREFIX);
}

async function main() {
  const env = localEnvironment();
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();

  let actor = null;
  try {
    await cleanupMarked(db);
    actor = await createUserAndSignIn(env);
    const { token } = actor;

    // 1. complete_profile creates the internal identity.
    const createId = uuid();
    const createBody = {
      request_id: createId,
      profile: { name: '  Ana Lucia  ', position: 'midfielder', shirt_number: 10 },
    };
    const created = await call(env, 'complete_profile', createBody, token);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.request_id, createId);
    assert.equal(created.body.data.outcome.logical_result, 'profile_created');
    assert.equal(typeof created.body.data.outcome.profile_id, 'string');
    assert.equal(created.body.data.current.name, 'Ana Lucia');
    const profileId = created.body.data.outcome.profile_id;
    const committedIdempotency = await db.query(
      `select state, actor_id
         from private.idempotency_records
        where operation = 'complete_profile'
          and request_id = $1`,
      [createId],
    );
    assert.equal(committedIdempotency.rowCount, 1, 'the idempotency row did not commit');
    assert.deepEqual(committedIdempotency.rows[0], {
      state: 'completed',
      actor_id: profileId,
    });
    const conclusionBoundary = await db.query(`
      select
        routine.prosecdef,
        pg_get_userbyid(routine.proowner) as owner,
        routine.proconfig,
        has_schema_privilege('service_role', 'private', 'usage') as service_private_usage,
        has_table_privilege(
          'service_role',
          'private.idempotency_records',
          'select'
        ) as service_idempotency_select,
        has_table_privilege(
          'service_role',
          'private.idempotency_records',
          'insert,update,delete'
        ) as service_idempotency_write,
        has_function_privilege(
          'service_role',
          'private.enforce_idempotency_conclusion()',
          'execute'
        ) as service_trigger_execute
      from pg_proc as routine
      where routine.oid = 'private.enforce_idempotency_conclusion()'::regprocedure
    `);
    assert.equal(conclusionBoundary.rowCount, 1);
    assert.equal(conclusionBoundary.rows[0].prosecdef, true, 'the trigger is not SECURITY DEFINER');
    assert.equal(conclusionBoundary.rows[0].owner, 'postgres');
    assert.ok(
      conclusionBoundary.rows[0].proconfig.includes('search_path=""'),
      'the SECURITY DEFINER trigger does not fix an empty search_path',
    );
    assert.equal(
      conclusionBoundary.rows[0].service_private_usage,
      false,
      'service_role unexpectedly gained USAGE on private',
    );
    assert.equal(
      conclusionBoundary.rows[0].service_idempotency_select,
      false,
      'service_role unexpectedly gained SELECT on the idempotency ledger',
    );
    assert.equal(
      conclusionBoundary.rows[0].service_idempotency_write,
      false,
      'service_role unexpectedly gained direct writes on the idempotency ledger',
    );
    assert.equal(
      conclusionBoundary.rows[0].service_trigger_execute,
      false,
      'service_role unexpectedly gained EXECUTE on the trigger function',
    );
    console.log(
      'ok - complete_profile commits under service_role through a postgres-owned, fixed-path trigger without widening privileges',
    );

    // 2. Replay of the same request_id reproduces the outcome, once.
    const replayed = await call(env, 'complete_profile', createBody, token);
    assert.equal(replayed.status, 200);
    assert.deepEqual(replayed.body.data.outcome, created.body.data.outcome);
    const profileCount = await db.query(
      'select count(*)::int c from public.profiles where auth_user_id = $1',
      [actor.userId],
    );
    assert.equal(profileCount.rows[0].c, 1, 'the replay created a second profile');
    console.log('ok - a replay returns the same outcome and creates no second profile');

    // 3. Same request_id, different input: the HMAC diverges and the domain is untouched.
    const conflicting = await call(
      env,
      'complete_profile',
      { request_id: createId, profile: { name: 'Outra Pessoa' } },
      token,
    );
    assert.equal(
      conflicting.body.error.code,
      'IDEMPOTENCY_CONFLICT',
      JSON.stringify(conflicting.body),
    );
    assert.equal(conflicting.body.request_id, createId);
    const afterConflict = await db.query('select name from public.profiles where id = $1', [
      profileId,
    ]);
    assert.equal(
      afterConflict.rows[0].name,
      'Ana Lucia',
      'the conflicting call touched the domain',
    );
    console.log('ok - the same request_id with a different input conflicts and changes nothing');

    // 4. Absence leaves a field alone; an explicit null clears it.
    const setNickname = await call(
      env,
      'update_profile',
      { request_id: uuid(), patch: { nickname: 'Aninha' } },
      token,
    );
    assert.equal(setNickname.status, 200, JSON.stringify(setNickname.body));
    assert.equal(setNickname.body.data.current.nickname, 'Aninha');
    const absent = await call(
      env,
      'update_profile',
      { request_id: uuid(), patch: { position: 'forward' } },
      token,
    );
    assert.equal(absent.body.data.current.nickname, 'Aninha', 'absence changed the field');
    assert.equal(absent.body.data.current.position, 'forward');
    const cleared = await call(
      env,
      'update_profile',
      { request_id: uuid(), patch: { nickname: null } },
      token,
    );
    assert.equal(cleared.body.data.current.nickname, null, 'explicit null did not clear the field');
    console.log('ok - absence leaves a field untouched and an explicit null clears it');

    // 5. A key outside the writable allowlist is refused at the boundary.
    const outsideAllowlist = await call(
      env,
      'update_profile',
      { request_id: uuid(), patch: { photo_url: 'https://example.test/a.png' } },
      token,
    );
    assert.equal(
      outsideAllowlist.body.error.code,
      'VALIDATION',
      JSON.stringify(outsideAllowlist.body),
    );
    console.log('ok - a key outside the allowlist is refused');

    // 7. accept_policies fails closed while the catalogue is empty.
    const catalogue = await db.query('select count(*)::int c from private.policy_documents');
    assert.equal(catalogue.rows[0].c, 0, 'the catalogue was expected to be empty');
    const accepted = await call(
      env,
      'accept_policies',
      { request_id: uuid(), versions: [{ document_type: 'terms', version: '2026-08-01' }] },
      token,
    );
    assert.equal(accepted.body.error.code, 'VALIDATION', JSON.stringify(accepted.body));
    console.log('ok - accept_policies fails closed over an empty catalogue');

    // 8. The external boundary refuses what belongs only to the internal call.
    const withHmac = await call(
      env,
      'update_profile',
      { request_id: uuid(), patch: {}, input_hmac: 'a'.repeat(64) },
      token,
    );
    assert.equal(withHmac.body.error.code, 'VALIDATION', JSON.stringify(withHmac.body));
    assert.equal(
      withHmac.body.error.fields.input_hmac,
      'belongs to the internal call and is never accepted from a client',
    );
    const withActor = await call(
      env,
      'update_profile',
      { request_id: uuid(), patch: {}, auth_user_id: actor.userId },
      token,
    );
    assert.equal(withActor.body.error.code, 'VALIDATION', JSON.stringify(withActor.body));
    const withoutJwt = await call(env, 'update_profile', { request_id: uuid(), patch: {} }, null);
    assert.equal(withoutJwt.status, 401);
    assert.equal(withoutJwt.body.error.code, 'UNAUTHENTICATED', JSON.stringify(withoutJwt.body));
    console.log('ok - no JWT is UNAUTHENTICATED, and internal-only keys are VALIDATION');

    // 6. Revocation lands on the denylist and never returns expires_at. Last,
    //    because it ends the session every check above depends on.
    const revokeId = uuid();
    const revoked = await call(env, 'revoke_current_session', { request_id: revokeId }, token);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.data.outcome.logical_result, 'session_revoked');
    assert.equal(revoked.body.data.outcome.session_id, actor.sessionId);
    assert.equal('expires_at' in revoked.body.data.outcome, false, 'the outcome leaked expires_at');
    assert.equal(revoked.body.data.current.session_active, false);
    const denylisted = await db.query(
      'select count(*)::int c from private.revoked_auth_sessions where session_id = $1',
      [actor.sessionId],
    );
    assert.equal(denylisted.rows[0].c, 1, 'the session did not reach the denylist');
    console.log('ok - revocation reaches the denylist and the outcome hides expires_at');

    const afterRevocation = await call(
      env,
      'update_profile',
      { request_id: uuid(), patch: { nickname: 'Tarde' } },
      token,
    );
    assert.equal(
      afterRevocation.body.error.code,
      'UNAUTHENTICATED',
      JSON.stringify(afterRevocation.body),
    );
    console.log('ok - a revoked session can no longer mutate');

    console.log('Identity gateway end-to-end checks passed against the local stack.');
  } finally {
    await cleanupMarked(db).catch((error) => {
      process.exitCode = 1;
      console.error('gateway cleanup failed', error);
    });
    await db.end();
  }
}

await main();
