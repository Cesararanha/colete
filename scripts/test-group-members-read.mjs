// Fatia 0019: HTTP real com JWT GoTrue, commit sob service_role e barreira M2 §2.
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
const AUTH_PREFIX = 'group-members-';
const APP_PREFIX = 'colete_members_';
const PASSWORD = 'colete-local-members-harness-password';
const syntheticKey = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index));
const guard = installHarnessGuard('db:test:members', {
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
    await db.query(`delete from private.invite_rate_limits where profile_id in (${profiles})`, [
      pattern,
    ]);
    await db.query(`delete from private.idempotency_records where actor_id in (${profiles})`, [
      pattern,
    ]);
    await db.query(`delete from private.revoked_auth_sessions where profile_id in (${profiles})`, [
      pattern,
    ]);
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
function mutate(status, actor, operation, body, requestId = crypto.randomUUID()) {
  return edge(status, `groups/${operation}`, { ...body, request_id: requestId }, actor.token);
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
async function createActor(status, label, db) {
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
  // Fixed profile UUIDs make the case-fold order proof independent of randomness.
  const fixedProfiles = {
    player: '10000000-0000-4000-8000-000000000001',
    player2: '10000000-0000-4000-8000-000000000002',
  };
  if (Object.hasOwn(fixedProfiles, label)) {
    actor.profileId = fixedProfiles[label];
    await db.query('insert into public.profiles(id,auth_user_id,name) values($1,$2,$3)', [
      actor.profileId,
      actor.authId,
      `Member ${label}`,
    ]);
    return actor;
  }
  const completed = ok(
    await edge(
      status,
      'identity/complete_profile',
      {
        request_id: crypto.randomUUID(),
        profile: { name: `Member ${label}` },
      },
      actor.token,
    ),
    `complete ${label}`,
  );
  actor.profileId = completed.outcome.profile_id;
  return actor;
}

function assertProjection(rows, expected, forbidden) {
  assert.deepEqual(
    rows.map((row) => row.profile_id),
    expected,
  );
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['display_name', 'profile_id', 'role', 'status']);
    assert.ok(row.display_name.trim().length > 0, 'display_name is never empty');
    assert.ok(['active', 'pending'].includes(row.status));
    assert.ok(['owner', 'organizer', 'player'].includes(row.role));
  }
  const serialized = JSON.stringify(rows);
  for (const marker of forbidden) assert.equal(serialized.includes(marker), false, 'value leak');
}
async function proveActorRevalidation(status, observer, actor, groupId) {
  const holder = client(status.dbUrl, 'revalidation_holder');
  const reader = client(status.dbUrl, 'revalidation_reader');
  await Promise.all([holder.connect(), reader.connect()]);
  try {
    const pids = await assertDistinctConnections(
      { observer, holder, reader },
      'actor-revalidation',
    );
    for (const change of ['revoked', 'deleting']) {
      await holder.query('begin');
      await holder.query('select id from public.profiles where id=$1 for no key update', [
        actor.profileId,
      ]);
      const contender = track(
        (async () => {
          await reader.query('begin');
          try {
            await reader.query('set local role service_role');
            const rows = await reader.query('select * from public.get_group_members($1,$2,$3)', [
              actor.authId,
              actor.sessionId,
              groupId,
            ]);
            await reader.query('commit');
            return rows.rows;
          } catch (error) {
            await reader.query('rollback');
            throw error;
          }
        })(),
      );
      try {
        await awaitLockWait(observer, contender, pids.reader, pids.holder, change, APP_PREFIX);
        if (change === 'revoked') {
          await holder.query(
            "insert into private.revoked_auth_sessions(session_id,profile_id,expires_at) values($1,$2,now()+interval '1 day')",
            [actor.sessionId, actor.profileId],
          );
        } else {
          await holder.query(
            "update public.profiles set account_status='deletion_pending' where id=$1",
            [actor.profileId],
          );
        }
        await holder.query('commit');
        const result = await contender.settled;
        assert.equal(result.status, 'rejected', 'actor must be revalidated after the profile lock');
        assert.equal(result.reason.message, change === 'revoked' ? 'UNAUTHENTICATED' : 'FORBIDDEN');
      } finally {
        await holder.query('rollback');
        await contender.settled;
        await observer.query('delete from private.revoked_auth_sessions where session_id=$1', [
          actor.sessionId,
        ]);
        await observer.query("update public.profiles set account_status='active' where id=$1", [
          actor.profileId,
        ]);
      }
    }
  } finally {
    await Promise.all([holder.end(), reader.end()]);
  }
  console.log(
    'ok - revoked session and deletion after observed lock wait reject before projection',
  );
}

async function prove(status, db) {
  const actors = {};
  for (const label of [
    'owner',
    'organizer',
    'player',
    'pending',
    'removed',
    'outsider',
    'suspended',
    'banned',
    'deleting',
    'pending2',
    'player2',
  ]) {
    actors[label] = await createActor(status, label, db);
  }
  const {
    owner,
    organizer,
    player,
    pending,
    removed,
    outsider,
    suspended,
    banned,
    deleting,
    pending2,
    player2,
  } = actors;
  const groupId = ok(
    await mutate(status, owner, 'create_group', { name: 'Members fixture' }),
    'create',
  ).outcome.group_id;
  ok(await mutate(status, outsider, 'create_group', { name: 'Other fixture' }), 'other group');
  const forbidden = [];
  await db.query('begin');
  try {
    for (const [label, actor] of Object.entries(actors)) {
      const full = `Full-${crypto.randomUUID()}`;
      const photo = `https://example.invalid/${crypto.randomUUID()}`;
      const nickname = label === 'player2' ? '  ' : ` Alias-${label} `;
      forbidden.push(full, photo, actor.authId);
      // Auth contact data and every non-allowlisted profile field carry distinct markers.
      const phone = `1555${Math.floor(Math.random() * 1e7)
        .toString()
        .padStart(7, '0')}`;
      await db.query('update auth.users set phone=$2 where id=$1', [actor.authId, phone]);
      forbidden.push(
        phone,
        (await db.query('select email from auth.users where id=$1', [actor.authId])).rows[0].email,
      );
      await db.query(
        `update public.profiles set name=$2,nickname=$3,photo_url=$4,
        position='goalkeeper',dominant_foot='both',shirt_number=987654 where id=$1`,
        [actor.profileId, full, nickname, photo],
      );
      if (label === 'player2') forbidden.splice(forbidden.indexOf(full), 1);
      if (!['owner', 'outsider'].includes(label)) {
        const state = ['pending', 'pending2'].includes(label)
          ? 'pending'
          : label === 'removed'
            ? 'removed'
            : 'active';
        await db.query(
          `insert into public.group_members(group_id,profile_id,role,status,removed_at,last_requested_at)
          values($1,$2,$3,$4,case when $4='removed' then now() else null end,
          case when $5='pending2' then now()-interval '1 hour' else now() end)`,
          [groupId, actor.profileId, label === 'organizer' ? 'organizer' : 'player', state, label],
        );
      }
    }
    forbidden.push('goalkeeper', 'both', '987654', 'account_status', 'suspended', 'banned');
    // Avoid account-state substrings in legitimate display names.
    for (const [label, actor] of [
      ['suspended', suspended],
      ['banned', banned],
      ['deleting', deleting],
    ]) {
      await db.query('update public.profiles set account_status=$2,nickname=$3 where id=$1', [
        actor.profileId,
        label === 'deleting' ? 'deletion_pending' : label,
        `Safe-${actor.profileId}`,
      ]);
    }
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
  const read = (actor) =>
    edge(
      status,
      'groups/get_group_members',
      { group_id: groupId },
      actor?.token ?? status.publishableKey,
    );
  const expectedRows = (
    await db.query(
      `select m.profile_id,m.status,
    coalesce(nullif(btrim(p.nickname),''),p.name) as display_name,
    case when m.profile_id=g.owner_id then 'owner' else m.role end as role
    from public.group_members m join public.profiles p on p.id=m.profile_id join public.groups g on g.id=m.group_id
    where g.id=$1 and m.status in ('active','pending') and p.account_status not in ('deletion_pending','deleted')
    order by case when m.status='pending' then 3 when m.profile_id=g.owner_id then 0 when m.role='organizer' then 1 else 2 end,
    case when m.status='active' then lower(coalesce(nullif(btrim(p.nickname),''),p.name)) end,
    case when m.status='pending' then m.last_requested_at end,m.profile_id`,
      [groupId],
    )
  ).rows;
  const active = expectedRows.filter((row) => row.status === 'active').map((row) => row.profile_id);
  const all = expectedRows.map((row) => row.profile_id);
  assert.equal(all.at(-2), pending2.profileId, 'oldest pending first');
  assert.equal(all.at(-1), pending.profileId);
  assert.equal(active[0], owner.profileId);
  assert.equal(active[1], organizer.profileId);
  for (const [label, actor] of Object.entries(actors)) {
    if (['pending', 'pending2', 'removed', 'outsider'].includes(label)) {
      denied(await read(actor), 403, 'NOT_MEMBER', label);
    } else if (label === 'deleting') {
      denied(await read(actor), 403, 'FORBIDDEN', label);
    } else {
      const rows = ok(await read(actor), label);
      assertProjection(rows, ['owner', 'organizer'].includes(label) ? all : active, forbidden);
      assert.equal(
        rows.find((row) => row.profile_id === owner.profileId).display_name,
        'Alias-owner',
      );
      assert.equal(
        rows.find((row) => row.profile_id === owner.profileId).role,
        'owner',
        'owner role derives from groups.owner_id, not organizer membership',
      );
      assert.equal(
        rows.find((row) => row.profile_id === organizer.profileId).role,
        'organizer',
        'organizer is not projected as owner',
      );
      assert.ok(rows.some((row) => row.profile_id === suspended.profileId));
      assert.ok(rows.some((row) => row.profile_id === banned.profileId));
    }
  }
  // Non-members and absent groups must be indistinguishable apart from correlation.
  const withoutCorrelation = ({ request_id: _requestId, ...body }) => body;
  const nonMemberBodies = [];
  for (const actor of [pending, removed, outsider]) {
    const response = await read(actor);
    denied(response, 403, 'NOT_MEMBER', 'non-member body');
    nonMemberBodies.push(withoutCorrelation(response.body));
  }
  const absentGroupId = '20000000-0000-4000-8000-000000000099';
  assert.equal(
    (
      await db.query('select count(*)::integer as n from public.groups where id=$1', [
        absentGroupId,
      ])
    ).rows[0].n,
    0,
  );
  const absent = await edge(
    status,
    'groups/get_group_members',
    { group_id: absentGroupId },
    owner.token,
  );
  denied(absent, 403, 'NOT_MEMBER', 'nonexistent group cannot be enumerated');
  nonMemberBodies.push(withoutCorrelation(absent.body));
  for (const body of nonMemberBodies)
    assert.deepEqual(body, nonMemberBodies[0], '403 bodies must be identical without request_id');
  for (const actor of [owner, organizer, player, pending, removed, outsider]) {
    const response = await fetch(`${status.apiUrl}/rest/v1/profiles?select=id`, {
      headers: { apikey: status.publishableKey, Authorization: `Bearer ${actor.token}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.json()).map((row) => row.id),
      [actor.profileId],
      'only own profile',
    );
  }
  denied(await read(), 401, 'UNAUTHENTICATED', 'anonymous');
  denied(
    await edge(
      status,
      'groups/get_group_members',
      { group_id: groupId, profile_id: owner.profileId },
      owner.token,
    ),
    422,
    'VALIDATION',
    'actor spoof',
  );
  await db.query('update public.groups set suspended_at=now() where id=$1', [groupId]);
  assertProjection(ok(await read(owner), 'suspended group'), all, forbidden);
  await db.query('update public.groups set archived_at=now() where id=$1', [groupId]);
  denied(await read(owner), 410, 'GROUP_ARCHIVED', 'archived group');
  for (const actor of [organizer, player])
    denied(await read(actor), 410, 'GROUP_ARCHIVED', 'archived active member');
  for (const actor of [outsider, pending, removed]) {
    const response = await read(actor);
    denied(response, 403, 'NOT_MEMBER', 'archived group must not be disclosed to non-members');
    assert.deepEqual(withoutCorrelation(response.body), nonMemberBodies[0], 'archived 403 body');
  }
  await db.query('update public.groups set archived_at=null,suspended_at=null where id=$1', [
    groupId,
  ]);

  // The same authority matrix runs as a caller explicitly lacking BYPASSRLS.
  await db.query('begin');
  try {
    await db.query('create role members_probe nologin nobypassrls');
    await db.query('grant members_probe to current_user');
    await db.query('grant usage on schema public to members_probe');
    await db.query(
      'grant execute on function public.get_group_members(uuid,uuid,uuid) to members_probe',
    );
    assert.equal(
      (await db.query("select rolbypassrls from pg_roles where rolname='members_probe'")).rows[0]
        .rolbypassrls,
      false,
    );
    for (const parameters of [
      [null, null, groupId],
      [owner.authId, null, groupId],
    ]) {
      await db.query('savepoint anonymous_probe');
      await db.query('set local role members_probe');
      await assert.rejects(
        db.query('select * from public.get_group_members($1,$2,$3)', parameters),
        /UNAUTHENTICATED/,
      );
      await db.query('rollback to savepoint anonymous_probe');
    }
    for (const [label, actor] of Object.entries(actors)) {
      await db.query('savepoint matrix_case');
      await db.query('set local role members_probe');
      try {
        const result = await db.query('select * from public.get_group_members($1,$2,$3)', [
          actor.authId,
          actor.sessionId,
          groupId,
        ]);
        assert.ok(
          !['pending', 'pending2', 'removed', 'outsider', 'deleting'].includes(label),
          'negative role must reject',
        );
        assertProjection(
          result.rows,
          ['owner', 'organizer'].includes(label) ? all : active,
          forbidden,
        );
      } catch (error) {
        assert.ok(['pending', 'pending2', 'removed', 'outsider', 'deleting'].includes(label));
        assert.equal(error.message, label === 'deleting' ? 'FORBIDDEN' : 'NOT_MEMBER');
      }
      await db.query('rollback to savepoint matrix_case');
    }
  } finally {
    await db.query('rollback');
  }
  console.log(
    'ok - HTTP and no-BYPASSRLS matrix, contacts/profile value census, nickname/fallback, account states and group states',
  );
  // Each fallback is observed over real HTTP, including blank and whitespace values.
  const fallbackName = expectedRows.find(
    (row) => row.profile_id === player2.profileId,
  ).display_name;
  for (const nickname of [null, '', '   ']) {
    await db.query('update public.profiles set nickname=$2 where id=$1', [
      player2.profileId,
      nickname,
    ]);
    const rows = ok(await read(owner), 'nickname fallback');
    const displayName = rows.find((row) => row.profile_id === player2.profileId).display_name;
    assert.equal(displayName, fallbackName, 'null, empty and whitespace nickname use name');
    assert.ok(displayName.trim().length > 0, 'fallback is never empty');
  }
  // Mixed initials distinguish lower() from case-sensitive collation C.
  await db.query(
    "update public.profiles set nickname=case when id=$1 then 'beta' else 'Zeta' end where id=any($2::uuid[])",
    [player.profileId, [player.profileId, player2.profileId]],
  );
  const mixed = ok(await read(owner), 'mixed-case initials').filter((row) =>
    [player.profileId, player2.profileId].includes(row.profile_id),
  );
  const cOrder = (
    await db.query(
      'select id from public.profiles where id=any($1::uuid[]) order by nickname collate "C",id',
      [[player.profileId, player2.profileId]],
    )
  ).rows.map((row) => row.id);
  assert.deepEqual(cOrder, [player2.profileId, player.profileId], 'C puts Zeta before beta');
  assert.deepEqual(
    mixed.map((row) => row.profile_id),
    [player.profileId, player2.profileId],
    'lower() puts beta before Zeta',
  );
  // Case-fold ties use UUID, independent of insertion order and spelling case.
  await db.query(
    "update public.profiles set nickname=case when id=$1 then 'CaseTie' else 'casetie' end where id=any($2::uuid[])",
    [player.profileId, [player.profileId, player2.profileId]],
  );
  const tied = ok(await read(owner), 'case-fold tie').filter((row) =>
    [player.profileId, player2.profileId].includes(row.profile_id),
  );
  const foldedOrder = [player.profileId, player2.profileId];
  const rawOrder = (
    await db.query('select id from public.profiles where id=any($1::uuid[]) order by nickname,id', [
      foldedOrder,
    ])
  ).rows.map((row) => row.id);
  assert.notDeepEqual(rawOrder, foldedOrder, 'fixture distinguishes raw order from lower()');
  assert.deepEqual(
    tied.map((row) => row.profile_id),
    foldedOrder,
    'case-fold order is deterministic with fixed profile UUIDs',
  );
  await db.query('update public.profiles set nickname=$2 where id=$1', [
    player.profileId,
    ' Alias-player ',
  ]);
  await db.query('update public.profiles set nickname=null where id=$1', [player2.profileId]);
  // A deidentified target remains excluded even if a fixture retains its membership.
  await db.query(
    "update public.profiles set account_status='deleted',auth_user_id=null,deidentified_at=now() where id=$1",
    [deleting.profileId],
  );
  try {
    assertProjection(ok(await read(owner), 'deleted target'), all, forbidden);
    denied(await read(deleting), 404, 'NOT_FOUND', 'deidentified actor has no Auth link');
  } finally {
    await db.query(
      "update public.profiles set account_status='deletion_pending',auth_user_id=$2,deidentified_at=null where id=$1",
      [deleting.profileId, deleting.authId],
    );
  }
  await proveActorRevalidation(status, db, owner, groupId);
  // Counterproof: an actual defective SQL projection leaks the full name as display_name.
  const original = (
    await db.query(
      "select pg_get_functiondef('public.get_group_members(uuid,uuid,uuid)'::regprocedure) as definition",
    )
  ).rows[0].definition;
  const probeMutant = async (definition, check) => {
    assert.notEqual(definition, original);
    await db.query(definition);
    try {
      await check();
    } finally {
      await db.query(original);
    }
  };
  await probeMutant(
    original.replace("v_member.status is distinct from 'active'", 'false'),
    async () => {
      for (const actor of [pending, removed, outsider]) {
        const response = await read(actor);
        assert.throws(() => denied(response, 403, 'NOT_MEMBER', 'authority mutant'));
      }
    },
  );
  await probeMutant(
    original.replace(
      "and (m.status='active' or (m.status='pending' and\n      (v_actor=v_group.owner_id or v_member.role='organizer')))",
      "and m.status in ('active','pending','removed')",
    ),
    async () => {
      for (const [actor, ids] of [
        [owner, all],
        [organizer, all],
        [player, active],
      ]) {
        const rows = ok(await read(actor), 'membership filter mutant');
        assert.throws(() => assertProjection(rows, ids, forbidden));
      }
    },
  );
  await probeMutant(
    original.replace("p.account_status not in ('deletion_pending','deleted')", 'true'),
    async () => {
      const rows = ok(await read(owner), 'deletion filter mutant');
      assert.throws(() => assertProjection(rows, all, forbidden));
    },
  );
  await probeMutant(
    original.replace('m.group_id=p_group_id and p.account_status', 'p.account_status'),
    async () => {
      const rows = ok(await read(owner), 'cross-group mutant');
      assert.throws(() => assertProjection(rows, all, forbidden));
    },
  );
  await probeMutant(
    original.replace(
      "case when m.status='pending' then m.last_requested_at end,",
      "case when m.status='pending' then m.last_requested_at end desc,",
    ),
    async () => {
      const rows = ok(await read(owner), 'pending order mutant');
      assert.throws(() => assertProjection(rows, all, forbidden));
    },
  );
  console.log(
    'ok - authorization, pending/removed, cross-group, ordering and case-fold tie counterproofs',
  );
  const mutant = original.replace("coalesce(nullif(btrim(p.nickname),''),p.name)", 'p.name');
  assert.notEqual(mutant, original);
  await db.query(mutant);
  try {
    assert.throws(() =>
      assertProjection(
        expectedRows.map((row) => ({ ...row, account_status: 'active' })),
        all,
        forbidden,
      ),
    );
    const bad = ok(await read(owner), 'mutant');
    assert.throws(() => assertProjection(bad, all, forbidden));
  } finally {
    await db.query(original);
  }
  const valueMutant = expectedRows.map((row) => ({ ...row, phone: forbidden[3] }));
  assert.throws(() => assertProjection(valueMutant, all, forbidden));
  const extra = original
    .replace('status text)', 'status text, account_status text)')
    .replace('else m.role end, m.status', 'else m.role end, m.status, p.account_status');
  assert.notEqual(extra, original);
  const replaceProjection = async (definition) => {
    await db.query('begin');
    try {
      await db.query('drop function public.get_group_members(uuid,uuid,uuid)');
      await db.query(definition);
      await db.query(
        'revoke all on function public.get_group_members(uuid,uuid,uuid) from public,anon,authenticated,service_role',
      );
      await db.query(
        'grant execute on function public.get_group_members(uuid,uuid,uuid) to service_role',
      );
      await db.query("notify pgrst, 'reload schema'");
      await db.query('commit');
    } catch (error) {
      await db.query('rollback');
      throw error;
    }
  };
  // Execute via SQL because PostgREST schema-cache reload is asynchronous; no sleeps or retries.
  await replaceProjection(extra);
  try {
    const bad = (
      await db.query('select * from public.get_group_members($1,$2,$3)', [
        owner.authId,
        owner.sessionId,
        groupId,
      ])
    ).rows;
    assert.throws(() => assertProjection(bad, all, forbidden));
  } finally {
    await replaceProjection(original);
  }
  // Profile then group locks: both waits are observed; removing either lock
  // causes the competitor to finish before the barrier and rejects the proof.
  const holder = client(status.dbUrl, 'holder');
  const reader = client(status.dbUrl, 'reader');
  const connections = [holder, reader];
  const started = await Promise.allSettled(connections.map((connection) => connection.connect()));
  assert.ok(started.every((result) => result.status === 'fulfilled'));
  try {
    const pids = await assertDistinctConnections({ observer: db, holder, reader }, 'members-read');
    for (const resource of ['profile', 'group']) {
      const run = async () => {
        await holder.query('begin');
        await holder.query(
          resource === 'profile'
            ? 'select id from public.profiles where id=$1 for no key update'
            : 'select id from public.groups where id=$1 for no key update',
          [resource === 'profile' ? owner.profileId : groupId],
        );
        const contender = track(
          (async () => {
            await reader.query('begin');
            try {
              await reader.query('set local role service_role');
              const rows = (
                await reader.query('select * from public.get_group_members($1,$2,$3)', [
                  owner.authId,
                  owner.sessionId,
                  groupId,
                ])
              ).rows;
              await reader.query('commit');
              return rows;
            } catch (error) {
              await reader.query('rollback');
              throw error;
            }
          })(),
        );
        let failure;
        try {
          await awaitLockWait(db, contender, pids.reader, pids.holder, resource, APP_PREFIX);
        } catch (error) {
          failure = error;
        } finally {
          await holder.query('rollback');
        }
        const result = await contender.settled;
        assert.equal(result.status, 'fulfilled');
        assertProjection(result.value, all, forbidden);
        if (failure) throw failure;
      };
      await run();
      const withoutLock = original.replace(
        resource === 'profile'
          ? 'where p.id=v_actor for no key update;'
          : 'where g.id=p_group_id for no key update;',
        resource === 'profile' ? 'where p.id=v_actor;' : 'where g.id=p_group_id;',
      );
      assert.notEqual(withoutLock, original);
      await db.query(withoutLock);
      try {
        await assert.rejects(run, /finished before its lock wait was observed/);
      } finally {
        await db.query(original);
      }
    }
  } finally {
    const closed = await Promise.allSettled(connections.map((connection) => connection.end()));
    assert.ok(closed.every((result) => result.status === 'fulfilled'));
  }
  console.log(
    'ok - profile/group lock waits observed with distinct PIDs; each removed-lock mutant rejects',
  );
  await db.query(
    `insert into private.revoked_auth_sessions(session_id,profile_id,expires_at) values($1,$2,now()+interval '1 day')`,
    [owner.sessionId, owner.profileId],
  );
  denied(await read(owner), 401, 'UNAUTHENTICATED', 'revoked session');
  console.log('ok - wrong display name and extra profile fields counterproofs reject');
}
async function main() {
  const status = localStatus();
  const db = client(status.dbUrl, 'admin');
  guard.useDatabase(status.dbUrl);
  guard.onCleanup(cleanup);
  guard.onCensus(async (census) => {
    for (const table of [
      'auth.users',
      'public.profiles',
      'public.groups',
      'private.idempotency_records',
      'private.invite_rate_limits',
    ]) {
      assert.equal(
        (await census.query(`select count(*)::integer as n from ${table}`)).rows[0].n,
        0,
        table,
      );
    }
    console.log('ok - residue census: auth.users/profiles/groups/idempotency/invite_rate_limits=0');
  });
  await db.connect();
  try {
    assert.equal((await db.query('select count(*)::integer as n from auth.users')).rows[0].n, 0);
    await prove(status, db);
  } finally {
    await db.end();
  }
}
if (await guard.run(main)) console.log('Group members read harness passed.');
