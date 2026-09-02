begin;

create extension if not exists pgtap with schema extensions;

select plan(94);

-- ---------------------------------------------------------------------------
-- Extension and the idempotency golden vector
-- ---------------------------------------------------------------------------

select has_extension('extensions', 'pgcrypto', 'pgcrypto is installed by migration');

-- docs/13-contratos-funcoes.md section 0.1: test key 00..1f, operation join_match.
-- If the SQL and the TypeScript implementations ever disagree, this fails here
-- instead of failing later with the outbox on top of it.
select is(
  encode(
    extensions.hmac(
      convert_to('colete/idempotency/v1', 'UTF8')
        || '\x00'::bytea
        || convert_to('join_match', 'UTF8')
        || '\x00'::bytea
        || convert_to(
             '{"list_kind":"field","match_id":"01890f7e-e948-7c53-b13a-4a36e4b7d21e"}',
             'UTF8'),
      decode('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex'),
      'sha256'),
    'hex'),
  '5974c4e8c2434e4d150f2f2199180b3228c869f80e72dabc0f25218132595ee4',
  'pgcrypto reproduces the canonical idempotency golden vector'
);

-- The 0x00 separators are load-bearing: without them the same bytes would let a
-- different domain, operation and payload split collide on one digest.
select isnt(
  encode(
    extensions.hmac(
      convert_to(
        'colete/idempotency/v1join_match'
          || '{"list_kind":"field","match_id":"01890f7e-e948-7c53-b13a-4a36e4b7d21e"}',
        'UTF8'),
      decode('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex'),
      'sha256'),
    'hex'),
  '5974c4e8c2434e4d150f2f2199180b3228c869f80e72dabc0f25218132595ee4',
  'dropping the domain separators changes the digest'
);

-- ---------------------------------------------------------------------------
-- Operational limits
-- ---------------------------------------------------------------------------

select has_table('private', 'app_limits', 'app_limits exists');
select has_table('private', 'allowed_proof_mime_types', 'allowed_proof_mime_types exists');

select is(
  (select limit_value from private.app_limits where limit_key = 'proof_max_bytes'),
  10485760::bigint,
  'proof_max_bytes is seeded at 10 MiB'
);
select is(
  (select limit_value from private.app_limits where limit_key = 'claim_cooldown_seconds'),
  300::bigint,
  'claim_cooldown_seconds is seeded at five minutes'
);
select is(
  (select limit_value from private.app_limits
   where limit_key = 'auth_session_max_lifetime_seconds'),
  7776000::bigint,
  'the Auth session maximum lifetime is seeded at ninety days'
);
select is(
  (select limit_value from private.app_limits
   where limit_key = 'notification_dispatch_max_attempts'),
  6::bigint,
  'the dispatcher gives up after six attempts'
);
select is(
  (select limit_value from private.app_limits
   where limit_key = 'notification_dispatch_backoff_base_seconds'),
  60::bigint,
  'the dispatcher backoff starts at one minute'
);
select is(
  (select limit_value from private.app_limits
   where limit_key = 'notification_dispatch_backoff_cap_seconds'),
  3600::bigint,
  'the dispatcher backoff is capped at one hour'
);

select is(
  (select array_agg(mime_type order by mime_type) from private.allowed_proof_mime_types),
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
  'the proof media type allowlist matches the contract'
);

select throws_ok(
  $$insert into private.app_limits (limit_key, limit_value, unit, notes)
    values ('negative_probe', -1, 'seconds', 'probe')$$,
  '23514',
  null,
  'a negative limit is rejected'
);
select throws_ok(
  $$insert into private.app_limits (limit_key, limit_value, unit, notes)
    values ('unit_probe', 1, 'furlongs', 'probe')$$,
  '23514',
  null,
  'an unknown unit is rejected'
);

-- ---------------------------------------------------------------------------
-- profiles structure
-- ---------------------------------------------------------------------------

select has_table('public', 'profiles', 'profiles exists');
select col_is_pk('public', 'profiles', 'id', 'profiles.id is the primary key');
select col_is_unique('public', 'profiles', 'auth_user_id', 'auth_user_id is unique');
select is(
  (select c.confdeltype
   from pg_constraint c
   where c.conrelid = 'public.profiles'::regclass and c.contype = 'f'),
  'n'::"char",
  'deleting the Auth user nullifies the link instead of deleting the profile'
);
select col_not_null('public', 'profiles', 'name', 'name is mandatory');
select col_not_null('public', 'profiles', 'account_status', 'account_status is mandatory');
select col_default_is(
  'public', 'profiles', 'account_status', 'active', 'a new profile starts active'
);

-- ---------------------------------------------------------------------------
-- profiles lifecycle
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000003'),
  ('00000000-0000-4000-8000-000000000004');

select throws_ok(
  $$insert into public.profiles (name, account_status) values ('No Auth', 'active')$$,
  '23514',
  null,
  'an active profile cannot exist without an Auth link'
);
select throws_ok(
  $$insert into public.profiles (auth_user_id, name, account_status, deidentified_at)
    values ('00000000-0000-4000-8000-000000000004', 'Ghost', 'deleted', now())$$,
  '23514',
  null,
  'a deleted profile cannot keep its Auth link'
);
select throws_ok(
  $$insert into public.profiles (name, account_status) values ('Ghost', 'deleted')$$,
  '23514',
  null,
  'a deleted profile must record when it was deidentified'
);
select throws_ok(
  $$insert into public.profiles (auth_user_id, name, account_status, deidentified_at)
    values ('00000000-0000-4000-8000-000000000004', 'Leaving', 'deletion_pending', now())$$,
  '23514',
  null,
  'a profile awaiting deletion is not deidentified yet'
);
select lives_ok(
  $$insert into public.profiles (auth_user_id, name, account_status)
    values ('00000000-0000-4000-8000-000000000004', 'Leaving', 'deletion_pending')$$,
  'a profile awaiting deletion may still hold its Auth link'
);
select lives_ok(
  $$insert into public.profiles (name, account_status, deidentified_at)
    values ('redacted', 'deleted', now())$$,
  'a deidentified profile survives its Auth user'
);
select throws_ok(
  $$insert into public.profiles (auth_user_id, name, account_status)
    values ('00000000-0000-4000-8000-000000000003', 'Bad', 'archived')$$,
  '23514',
  null,
  'an unknown account status is rejected'
);
select throws_ok(
  $$insert into public.profiles (auth_user_id, name, dominant_foot)
    values ('00000000-0000-4000-8000-000000000003', 'Bad', 'middle')$$,
  '23514',
  null,
  'an unknown dominant foot is rejected'
);
select throws_ok(
  $$insert into public.profiles (auth_user_id, name, position)
    values ('00000000-0000-4000-8000-000000000003', 'Bad', 'sweeper')$$,
  '23514',
  null,
  'an unknown position is rejected'
);
select lives_ok(
  $$insert into public.profiles (auth_user_id, name, position)
    values ('00000000-0000-4000-8000-000000000003', 'Flexible', 'goalkeeper')$$,
  'goalkeeper is an accepted profile position'
);
select lives_ok(
  $$update public.profiles set position = 'defender'
    where auth_user_id = '00000000-0000-4000-8000-000000000003'$$,
  'defender is an accepted profile position'
);
select lives_ok(
  $$update public.profiles set position = 'midfielder'
    where auth_user_id = '00000000-0000-4000-8000-000000000003'$$,
  'midfielder is an accepted profile position'
);
select lives_ok(
  $$update public.profiles set position = 'forward'
    where auth_user_id = '00000000-0000-4000-8000-000000000003'$$,
  'forward is an accepted profile position'
);
select lives_ok(
  $$update public.profiles set position = null
    where auth_user_id = '00000000-0000-4000-8000-000000000003'$$,
  'a profile position may be null'
);

-- ---------------------------------------------------------------------------
-- Helper shape: nothing runs with elevated rights, everything pins search_path
-- ---------------------------------------------------------------------------

select has_function('private', 'current_session_id', array[]::name[], 'current_session_id exists');
select has_function('private', 'current_profile_id', array[]::name[], 'current_profile_id exists');
select has_function('private', 'require_profile_id', array[]::name[], 'require_profile_id exists');
select has_function(
  'private', 'require_active_profile', array[]::name[], 'require_active_profile exists'
);

select is(
  (select p.prosecdef from pg_proc p
   where p.oid = 'private.current_session_id()'::regprocedure),
  false,
  'current_session_id runs as its caller'
);
select is(
  (select p.prosecdef from pg_proc p
   where p.oid = 'private.current_profile_id()'::regprocedure),
  false,
  'current_profile_id runs as its caller'
);
select is(
  (select p.prosecdef from pg_proc p
   where p.oid = 'private.require_profile_id()'::regprocedure),
  false,
  'require_profile_id runs as its caller'
);
select is(
  (select p.prosecdef from pg_proc p
   where p.oid = 'private.require_active_profile()'::regprocedure),
  false,
  'require_active_profile runs as its caller'
);

select ok(
  (select p.proconfig from pg_proc p
   where p.oid = 'private.current_session_id()'::regprocedure) @> array['search_path=""'],
  'current_session_id pins an empty search_path'
);
select ok(
  (select p.proconfig from pg_proc p
   where p.oid = 'private.current_profile_id()'::regprocedure) @> array['search_path=""'],
  'current_profile_id pins an empty search_path'
);
select ok(
  (select p.proconfig from pg_proc p
   where p.oid = 'private.require_profile_id()'::regprocedure) @> array['search_path=""'],
  'require_profile_id pins an empty search_path'
);
select ok(
  (select p.proconfig from pg_proc p
   where p.oid = 'private.require_active_profile()'::regprocedure) @> array['search_path=""'],
  'require_active_profile pins an empty search_path'
);

-- ---------------------------------------------------------------------------
-- No client role may execute a helper
-- ---------------------------------------------------------------------------

select ok(
  not has_function_privilege('anon', 'private.current_session_id()', 'execute'),
  'anon cannot execute current_session_id'
);
select ok(
  not has_function_privilege('authenticated', 'private.current_session_id()', 'execute'),
  'authenticated cannot execute current_session_id'
);
select ok(
  not has_function_privilege('anon', 'private.current_profile_id()', 'execute'),
  'anon cannot execute current_profile_id'
);
select ok(
  not has_function_privilege('authenticated', 'private.current_profile_id()', 'execute'),
  'authenticated cannot execute current_profile_id'
);
select ok(
  not has_function_privilege('anon', 'private.require_profile_id()', 'execute'),
  'anon cannot execute require_profile_id'
);
select ok(
  not has_function_privilege('authenticated', 'private.require_profile_id()', 'execute'),
  'authenticated cannot execute require_profile_id'
);
select ok(
  not has_function_privilege('anon', 'private.require_active_profile()', 'execute'),
  'anon cannot execute require_active_profile'
);
select ok(
  not has_function_privilege('authenticated', 'private.require_active_profile()', 'execute'),
  'authenticated cannot execute require_active_profile'
);

-- ---------------------------------------------------------------------------
-- Table privileges: read own profile, write nothing
-- ---------------------------------------------------------------------------

select ok(
  not has_table_privilege('anon', 'public.profiles', 'select'), 'anon cannot read profiles'
);
select ok(
  not has_table_privilege('anon', 'public.profiles', 'insert'), 'anon cannot insert profiles'
);
select ok(
  not has_table_privilege('anon', 'public.profiles', 'update'), 'anon cannot update profiles'
);
select ok(
  not has_table_privilege('anon', 'public.profiles', 'delete'), 'anon cannot delete profiles'
);
select ok(
  has_table_privilege('authenticated', 'public.profiles', 'select'),
  'authenticated may read profiles, narrowed to its own row by RLS'
);
select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'insert'),
  'authenticated cannot insert profiles directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'update'),
  'authenticated cannot update profiles directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.profiles', 'delete'),
  'authenticated cannot delete profiles directly'
);
select ok(
  not has_table_privilege('anon', 'private.app_limits', 'select'),
  'anon cannot read the operational limits'
);
select ok(
  not has_table_privilege('authenticated', 'private.app_limits', 'select'),
  'authenticated cannot read the operational limits'
);
select ok(
  not has_table_privilege('anon', 'private.allowed_proof_mime_types', 'select'),
  'anon cannot read the media type allowlist'
);
select ok(
  not has_table_privilege('authenticated', 'private.allowed_proof_mime_types', 'select'),
  'authenticated cannot read the media type allowlist'
);

-- ---------------------------------------------------------------------------
-- RLS is on and forced from birth
-- ---------------------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass),
  'profiles has row level security enabled'
);
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.profiles'::regclass),
  'profiles forces row level security on its owner too'
);
-- These two tables were created here with enable + force row level security and
-- zero policies, before the M0-B finding produced the rule in
-- docs/14-convencoes-app.md section 5.2. Migration 0008 settles that debt, so
-- what this file pins is the corrected protection model: a private service
-- table is protected by schema and table privilege, never by RLS. The privilege
-- side is asserted below and, layer by layer, in the 0008 suite.
select ok(
  not (select relrowsecurity from pg_class where oid = 'private.app_limits'::regclass),
  'app_limits is a private service table, so RLS is not its barrier'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'private.app_limits'::regclass),
  'app_limits does not force RLS on a server-side reader that lacks BYPASSRLS'
);
select ok(
  not (select relrowsecurity from pg_class
       where oid = 'private.allowed_proof_mime_types'::regclass),
  'allowed_proof_mime_types is a private service table, so RLS is not its barrier'
);
select ok(
  not (select relforcerowsecurity from pg_class
       where oid = 'private.allowed_proof_mime_types'::regclass),
  'allowed_proof_mime_types does not force RLS on a server-side reader'
);
-- The four assertions above state an absence, and absence of RLS is the default
-- of any table nobody configured. They are a regression guard, not a proof. This
-- is the positive half in this file: what protects these two tables is that no
-- client role holds any privilege on them, for any privilege type, not just the
-- select checked further up. The 0008 suite isolates each barrier in turn.
select is(
  (select count(*)
   from information_schema.role_table_grants
   where table_schema = 'private'
     and table_name in ('app_limits', 'allowed_proof_mime_types')
     and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')),
  0::bigint,
  'no client or administrative role holds any privilege on either service table'
);

select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'profiles'),
  1::bigint,
  'profiles carries exactly one policy'
);
select is(
  (select count(*) from pg_policies
   where schemaname = 'public' and tablename = 'profiles'
     and cmd in ('INSERT', 'UPDATE', 'DELETE')),
  0::bigint,
  'no policy lets a client write profiles: writes go through RPC'
);

-- ---------------------------------------------------------------------------
-- Unauthenticated context
-- ---------------------------------------------------------------------------

select throws_ok(
  'select private.require_profile_id()',
  '28000',
  'UNAUTHENTICATED',
  'require_profile_id refuses a request with no authentication'
);
select throws_ok(
  'select private.require_active_profile()',
  '28000',
  'UNAUTHENTICATED',
  'require_active_profile refuses a request with no authentication'
);
select is(
  private.current_profile_id(),
  null::uuid,
  'there is no internal identity without an authenticated caller'
);

-- ---------------------------------------------------------------------------
-- Session claim
-- ---------------------------------------------------------------------------

set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000001",
    "session_id":"11111111-1111-4111-8111-111111111111"}';

select is(
  private.current_session_id(),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'the helper reads the GoTrue session_id claim'
);

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001"}';

select is(
  private.current_session_id(),
  null::uuid,
  'a token without a session_id claim yields no session'
);

reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- Isolation between two authenticated people
-- ---------------------------------------------------------------------------

insert into public.profiles (id, auth_user_id, name) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000001', 'Ana'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-000000000002', 'Bruno');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001"}';
set local role authenticated;

select is(
  (select count(*) from public.profiles),
  1::bigint,
  'an authenticated person sees exactly one profile'
);
select is(
  (select id from public.profiles),
  'aaaaaaaa-0000-4000-8000-00000000000a'::uuid,
  'and that profile is their own'
);
select is(
  (select count(*) from public.profiles
   where id = 'bbbbbbbb-0000-4000-8000-00000000000b'),
  0::bigint,
  'another person profile is invisible even when addressed by id'
);
select throws_ok(
  $$insert into public.profiles (auth_user_id, name)
    values ('00000000-0000-4000-8000-000000000003', 'Injected')$$,
  '42501',
  null,
  'an authenticated person cannot create a profile directly'
);
select throws_ok(
  $$update public.profiles set name = 'Renamed'
    where id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$,
  '42501',
  null,
  'an authenticated person cannot update even their own profile directly'
);
select throws_ok(
  $$delete from public.profiles where id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$,
  '42501',
  null,
  'an authenticated person cannot delete their own profile directly'
);
select throws_ok(
  'select private.current_profile_id()',
  '42501',
  null,
  'an authenticated person cannot reach the private helpers'
);

reset role;

set local role anon;

select throws_ok(
  'select count(*) from public.profiles',
  '42501',
  null,
  'anon cannot read the profiles table at all'
);

reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- Account status guard
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001"}';

select is(
  private.require_active_profile(),
  'aaaaaaaa-0000-4000-8000-00000000000a'::uuid,
  'an active account keeps its domain authority'
);

update public.profiles set account_status = 'suspended'
where id = 'aaaaaaaa-0000-4000-8000-00000000000a';

select throws_ok(
  'select private.require_active_profile()',
  '42501',
  'PROFILE_SUSPENDED',
  'a suspended account loses its domain authority'
);

update public.profiles set account_status = 'banned'
where id = 'aaaaaaaa-0000-4000-8000-00000000000a';

select throws_ok(
  'select private.require_active_profile()',
  '42501',
  'PROFILE_SUSPENDED',
  'a banned account loses its domain authority'
);

update public.profiles set account_status = 'deletion_pending'
where id = 'aaaaaaaa-0000-4000-8000-00000000000a';

-- The JWT is still inside its validity window and still resolves to this profile.
-- Authority is denied anyway, which is the whole point of the tombstone.
select throws_ok(
  'select private.require_active_profile()',
  '42501',
  'FORBIDDEN',
  'a pending deletion denies authority to a JWT that has not expired yet'
);

update public.profiles
set account_status = 'deleted', auth_user_id = null, deidentified_at = now()
where id = 'aaaaaaaa-0000-4000-8000-00000000000a';

-- A finished deletion no longer has an Auth link, so the guard cannot even
-- resolve the caller. The denial is NOT_FOUND rather than FORBIDDEN, and the
-- profile row survives so history keeps its subject.
select throws_ok(
  'select private.require_active_profile()',
  'P0002',
  'NOT_FOUND',
  'a deleted account resolves to no internal identity at all'
);

reset request.jwt.claims;

select * from finish();

rollback;
