begin;

create extension if not exists pgtap with schema extensions;

select plan(100);

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000003');

insert into public.profiles (id, auth_user_id, name, account_status) values
  ('aaaaaaaa-0000-4000-8000-00000000000a',
   '00000000-0000-4000-8000-000000000001', 'Ana', 'active'),
  ('bbbbbbbb-0000-4000-8000-00000000000b',
   '00000000-0000-4000-8000-000000000002', 'Bruno', 'active'),
  ('cccccccc-0000-4000-8000-00000000000c',
   '00000000-0000-4000-8000-000000000003', 'Caio', 'deletion_pending');

insert into public.privacy_requests (id, profile_id, kind) values
  ('11111111-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000a', 'access'),
  ('22222222-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-00000000000b', 'access');

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------

select has_table('public', 'policy_acceptances', 'policy_acceptances exists');
select has_table('public', 'privacy_requests', 'privacy_requests exists');
select has_table('public', 'revoked_auth_sessions', 'revoked_auth_sessions exists');
select has_table('public', 'deletion_requests', 'deletion_requests exists');
select has_table('public', 'data_exports', 'data_exports exists');

select col_is_pk(
  'public', 'revoked_auth_sessions', 'session_id', 'the revoked session id is the key'
);
select col_is_unique(
  'public', 'deletion_requests', 'profile_id', 'a profile has at most one deletion saga'
);
select col_is_unique(
  'public', 'data_exports', 'privacy_request_id', 'an export belongs to one request'
);
select col_is_unique(
  'public', 'data_exports', 'storage_path', 'two exports never share a storage path'
);
select col_is_unique(
  'public', 'policy_acceptances',
  array['profile_id', 'document_type', 'version'],
  'a document version is accepted once per person'
);
select fk_ok(
  'public', 'data_exports', 'privacy_request_id',
  'public', 'privacy_requests', 'id',
  'an export hangs off the privacy request that asked for it'
);
select is(
  (select count(*)
   from pg_constraint c
   where c.conrelid = 'public.deletion_requests'::regclass
     and c.contype = 'f'
     and c.conkey @> array[(select a.attnum from pg_attribute a
                            where a.attrelid = 'public.deletion_requests'::regclass
                              and a.attname = 'auth_user_id')]),
  0::bigint,
  'deletion_requests.auth_user_id has no foreign key, so the saga outlives Auth'
);
select col_not_null(
  'public', 'revoked_auth_sessions', 'expires_at', 'a revocation has to expire'
);
select col_type_is(
  'public', 'deletion_requests', 'attempts', 'integer', 'the saga counts its attempts'
);

-- ---------------------------------------------------------------------------
-- Acceptance
-- ---------------------------------------------------------------------------

insert into public.policy_acceptances (profile_id, document_type, version, source)
values ('aaaaaaaa-0000-4000-8000-00000000000a', 'terms', '2026-08-01', 'signup');

select throws_ok(
  $$insert into public.policy_acceptances (profile_id, document_type, version, source)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', 'terms', '2026-08-01', 'reauth')$$,
  '23505',
  null,
  'accepting the same document version twice records one acceptance'
);
select lives_ok(
  $$insert into public.policy_acceptances (profile_id, document_type, version, source)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', 'terms', '2026-09-01', 'reauth')$$,
  'a new mandatory version is a new acceptance'
);
select throws_ok(
  $$insert into public.policy_acceptances (profile_id, document_type, version, source)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', 'cookies', '1', 'signup')$$,
  '23514',
  null,
  'only terms and privacy are acceptable documents'
);
select throws_ok(
  $$insert into public.policy_acceptances (profile_id, document_type, version, source)
    values ('bbbbbbbb-0000-4000-8000-00000000000b', 'terms', '1', 'import')$$,
  '23514',
  null,
  'an acceptance has to come from signup or reauth'
);

-- ---------------------------------------------------------------------------
-- Session revocation
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.revoked_auth_sessions (session_id, profile_id, revoked_at, expires_at)
    values ('99999999-0000-4000-8000-00000000000f',
            'aaaaaaaa-0000-4000-8000-00000000000a', now(), now() - interval '1 hour')$$,
  '23514',
  null,
  'a revocation cannot expire before it starts'
);

insert into public.revoked_auth_sessions (session_id, profile_id, expires_at)
values ('dddddddd-0000-4000-8000-00000000000d',
        'aaaaaaaa-0000-4000-8000-00000000000a', now() + interval '1 hour');

select throws_ok(
  $$insert into public.revoked_auth_sessions (session_id, profile_id, expires_at)
    values ('dddddddd-0000-4000-8000-00000000000d',
            'aaaaaaaa-0000-4000-8000-00000000000a', now() + interval '2 hours')$$,
  '23505',
  null,
  'the same session is revoked once'
);

set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000001",
    "session_id":"eeeeeeee-0000-4000-8000-00000000000e"}';

select ok(
  not private.is_session_revoked(), 'a session that was never revoked is accepted'
);

set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000001",
    "session_id":"dddddddd-0000-4000-8000-00000000000d"}';

select ok(private.is_session_revoked(), 'a revoked session is rejected');

set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000002",
    "session_id":"eeeeeeee-0000-4000-8000-00000000000e"}';

select ok(
  not private.is_session_revoked(),
  'revoking one session does not revoke a different one'
);

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001"}';

select ok(
  private.is_session_revoked(),
  'a token with no session_id claim fails closed and counts as revoked'
);

-- ---------------------------------------------------------------------------
-- The common guard
-- ---------------------------------------------------------------------------

select throws_ok(
  'select private.require_domain_authority()',
  '28000',
  'UNAUTHENTICATED',
  'a token with no session_id claim cannot reach domain authority'
);

reset request.jwt.claims;

select throws_ok(
  'select private.require_domain_authority()',
  '28000',
  'UNAUTHENTICATED',
  'an unauthenticated context has no domain authority'
);

set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000001",
    "session_id":"dddddddd-0000-4000-8000-00000000000d"}';

select throws_ok(
  'select private.require_domain_authority()',
  '28000',
  'UNAUTHENTICATED',
  'a revoked session loses domain authority while its JWT is still valid'
);

set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000001",
    "session_id":"eeeeeeee-0000-4000-8000-00000000000e"}';

select is(
  private.require_domain_authority(),
  'aaaaaaaa-0000-4000-8000-00000000000a'::uuid,
  'an active account on a live session gets its internal identity'
);

set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000003",
    "session_id":"ffffffff-0000-4000-8000-00000000000f"}';

select throws_ok(
  'select private.require_domain_authority()',
  '42501',
  'FORBIDDEN',
  'an account awaiting deletion has no domain authority on any session'
);

reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- Deletion saga
-- ---------------------------------------------------------------------------

insert into public.deletion_requests (profile_id, auth_user_id)
values ('cccccccc-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-000000000003');

select throws_ok(
  $$insert into public.deletion_requests (profile_id, auth_user_id)
    values ('cccccccc-0000-4000-8000-00000000000c',
            '00000000-0000-4000-8000-000000000003')$$,
  '23505',
  null,
  'a second deletion request for the same profile is refused'
);
select throws_ok(
  $$insert into public.deletion_requests (profile_id, auth_user_id, status, completed_at)
    values ('aaaaaaaa-0000-4000-8000-00000000000a',
            '00000000-0000-4000-8000-000000000001', 'completed', now())$$,
  '23514',
  null,
  'a completed saga cannot still be holding an Auth identifier'
);
select throws_ok(
  $$insert into public.deletion_requests (profile_id, status)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', 'completed')$$,
  '23514',
  null,
  'a completed saga has to record when it completed'
);
select throws_ok(
  $$insert into public.deletion_requests (profile_id, status)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', 'requested')$$,
  '23514',
  null,
  'an unfinished saga must keep the Auth identifier it still has to delete'
);
select throws_ok(
  $$insert into public.deletion_requests (profile_id, auth_user_id, status, completed_at)
    values ('aaaaaaaa-0000-4000-8000-00000000000a',
            '00000000-0000-4000-8000-000000000001', 'requested', now())$$,
  '23514',
  null,
  'an unfinished saga is not completed'
);
select lives_ok(
  $$insert into public.deletion_requests (profile_id, status, completed_at, auth_deleted_at)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', 'completed', now(), now())$$,
  'a finished saga keeps its record without the Auth identifier'
);
select throws_ok(
  $$insert into public.deletion_requests (profile_id, auth_user_id, status)
    values ('bbbbbbbb-0000-4000-8000-00000000000b',
            '00000000-0000-4000-8000-000000000002', 'abandoned')$$,
  '23514',
  null,
  'an unknown saga status is rejected'
);
select throws_ok(
  $$insert into public.deletion_requests (profile_id, auth_user_id, attempts)
    values ('bbbbbbbb-0000-4000-8000-00000000000b',
            '00000000-0000-4000-8000-000000000002', -1)$$,
  '23514',
  null,
  'the attempt counter never goes negative'
);

-- ---------------------------------------------------------------------------
-- Titular requests
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.privacy_requests (profile_id, kind)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', 'portability')$$,
  '23514',
  null,
  'only the enumerated request kinds are accepted'
);
select throws_ok(
  $$insert into public.privacy_requests (profile_id, kind, status)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', 'access', 'archived')$$,
  '23514',
  null,
  'an unknown request status is rejected'
);
select lives_ok(
  $$insert into public.privacy_requests (profile_id, kind)
    values ('aaaaaaaa-0000-4000-8000-00000000000a', 'correction')$$,
  'a correction request opens normally'
);

-- ---------------------------------------------------------------------------
-- Export artifacts
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into public.data_exports
      (privacy_request_id, profile_id, status, storage_path)
    values ('11111111-0000-4000-8000-00000000000a',
            'aaaaaaaa-0000-4000-8000-00000000000a', 'queued', 'exports/a.zip')$$,
  '23514',
  null,
  'a queued export has no artifact yet'
);
select throws_ok(
  $$insert into public.data_exports
      (privacy_request_id, profile_id, status, storage_path, ready_at, expires_at)
    values ('11111111-0000-4000-8000-00000000000a',
            'aaaaaaaa-0000-4000-8000-00000000000a', 'ready', 'exports/a.zip',
            now(), now() + interval '1 hour')$$,
  '23514',
  null,
  'a ready export cannot exist without its content digest'
);
select throws_ok(
  $$insert into public.data_exports
      (privacy_request_id, profile_id, status, storage_path, content_digest,
       ready_at, expires_at)
    values ('11111111-0000-4000-8000-00000000000a',
            'aaaaaaaa-0000-4000-8000-00000000000a', 'ready', 'exports/a.zip', 'sha256:x',
            now(), now() + interval '25 hours')$$,
  '23514',
  null,
  'an export cannot outlive its 24 hour window'
);
select lives_ok(
  $$insert into public.data_exports
      (privacy_request_id, profile_id, status, storage_path, content_digest,
       ready_at, expires_at)
    values ('11111111-0000-4000-8000-00000000000a',
            'aaaaaaaa-0000-4000-8000-00000000000a', 'ready', 'exports/a.zip', 'sha256:x',
            '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z')$$,
  'an export may live exactly 24 hours'
);
select throws_ok(
  $$insert into public.data_exports
      (privacy_request_id, profile_id, status, storage_path, content_digest,
       ready_at, expires_at, downloaded_at, purged_at)
    values ('22222222-0000-4000-8000-00000000000b',
            'bbbbbbbb-0000-4000-8000-00000000000b', 'downloaded', 'exports/b.zip',
            'sha256:y', now(), now() + interval '1 hour', now(), now())$$,
  '23514',
  null,
  'a downloaded export is either still stored or purged, never both'
);
select lives_ok(
  $$insert into public.data_exports
      (privacy_request_id, profile_id, status, ready_at, expires_at,
       downloaded_at, purged_at)
    values ('22222222-0000-4000-8000-00000000000b',
            'bbbbbbbb-0000-4000-8000-00000000000b', 'downloaded',
            now(), now() + interval '1 hour', now(), now())$$,
  'a downloaded export survives as a record after its artifact is purged'
);
select throws_ok(
  $$insert into public.data_exports
      (privacy_request_id, profile_id, status, storage_path, purged_at)
    values ('11111111-0000-4000-8000-00000000000a',
            'aaaaaaaa-0000-4000-8000-00000000000a', 'expired', 'exports/c.zip', now())$$,
  '23514',
  null,
  'an expired export keeps no path to its artifact'
);
select throws_ok(
  $$insert into public.data_exports (privacy_request_id, profile_id, status)
    values ('11111111-0000-4000-8000-00000000000a',
            'aaaaaaaa-0000-4000-8000-00000000000a', 'archived')$$,
  '23514',
  null,
  'an unknown export status is rejected'
);

-- ---------------------------------------------------------------------------
-- Row level security is on and forced
-- ---------------------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'public.policy_acceptances'::regclass),
  'policy_acceptances has row level security enabled'
);
select ok(
  (select relforcerowsecurity from pg_class
   where oid = 'public.policy_acceptances'::regclass),
  'policy_acceptances forces row level security'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.privacy_requests'::regclass),
  'privacy_requests has row level security enabled'
);
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.privacy_requests'::regclass),
  'privacy_requests forces row level security'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.revoked_auth_sessions'::regclass),
  'revoked_auth_sessions has row level security enabled'
);
select ok(
  (select relforcerowsecurity from pg_class
   where oid = 'public.revoked_auth_sessions'::regclass),
  'revoked_auth_sessions forces row level security'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.deletion_requests'::regclass),
  'deletion_requests has row level security enabled'
);
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.deletion_requests'::regclass),
  'deletion_requests forces row level security'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.data_exports'::regclass),
  'data_exports has row level security enabled'
);
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.data_exports'::regclass),
  'data_exports forces row level security'
);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

select ok(
  not has_table_privilege('anon', 'public.policy_acceptances', 'select'),
  'anon cannot read acceptances'
);
select ok(
  not has_table_privilege('anon', 'public.privacy_requests', 'select'),
  'anon cannot read privacy requests'
);
select ok(
  not has_table_privilege('anon', 'public.revoked_auth_sessions', 'select'),
  'anon cannot read the session denylist'
);
select ok(
  not has_table_privilege('anon', 'public.deletion_requests', 'select'),
  'anon cannot read deletion sagas'
);
select ok(
  not has_table_privilege('anon', 'public.data_exports', 'select'),
  'anon cannot read exports'
);

select ok(
  has_table_privilege('authenticated', 'public.policy_acceptances', 'select'),
  'authenticated may read acceptances, narrowed to its own rows by RLS'
);
select ok(
  has_table_privilege('authenticated', 'public.privacy_requests', 'select'),
  'authenticated may read privacy requests, narrowed to its own rows by RLS'
);
select ok(
  not has_table_privilege('authenticated', 'public.revoked_auth_sessions', 'select'),
  'the session denylist is a service table with no client grant at all'
);
select ok(
  has_table_privilege('authenticated', 'public.deletion_requests', 'select'),
  'authenticated may read deletion sagas, narrowed to its own rows by RLS'
);
select ok(
  has_table_privilege('authenticated', 'public.data_exports', 'select'),
  'authenticated may read exports, narrowed to its own rows by RLS'
);

select ok(
  not has_table_privilege('authenticated', 'public.policy_acceptances', 'insert'),
  'authenticated cannot insert acceptances'
);
select ok(
  not has_table_privilege('authenticated', 'public.policy_acceptances', 'update'),
  'authenticated cannot update acceptances'
);
select ok(
  not has_table_privilege('authenticated', 'public.policy_acceptances', 'delete'),
  'authenticated cannot delete acceptances'
);
select ok(
  not has_table_privilege('authenticated', 'public.privacy_requests', 'insert'),
  'authenticated cannot insert privacy requests'
);
select ok(
  not has_table_privilege('authenticated', 'public.privacy_requests', 'update'),
  'authenticated cannot update privacy requests'
);
select ok(
  not has_table_privilege('authenticated', 'public.privacy_requests', 'delete'),
  'authenticated cannot delete privacy requests'
);
select ok(
  not has_table_privilege('authenticated', 'public.revoked_auth_sessions', 'insert'),
  'authenticated cannot insert revocations'
);
select ok(
  not has_table_privilege('authenticated', 'public.revoked_auth_sessions', 'update'),
  'authenticated cannot update revocations'
);
select ok(
  not has_table_privilege('authenticated', 'public.revoked_auth_sessions', 'delete'),
  'authenticated cannot delete revocations'
);
select ok(
  not has_table_privilege('authenticated', 'public.deletion_requests', 'insert'),
  'authenticated cannot insert deletion sagas'
);
select ok(
  not has_table_privilege('authenticated', 'public.deletion_requests', 'update'),
  'authenticated cannot update deletion sagas'
);
select ok(
  not has_table_privilege('authenticated', 'public.deletion_requests', 'delete'),
  'authenticated cannot delete deletion sagas'
);
select ok(
  not has_table_privilege('authenticated', 'public.data_exports', 'insert'),
  'authenticated cannot insert exports'
);
select ok(
  not has_table_privilege('authenticated', 'public.data_exports', 'update'),
  'authenticated cannot mark its own export downloaded'
);
select ok(
  not has_table_privilege('authenticated', 'public.data_exports', 'delete'),
  'authenticated cannot delete exports'
);

select is(
  (select count(*) from pg_policies
   where schemaname = 'public'
     and tablename in ('policy_acceptances', 'privacy_requests', 'revoked_auth_sessions',
                       'deletion_requests', 'data_exports')
     and cmd in ('INSERT', 'UPDATE', 'DELETE')),
  0::bigint,
  'this slice grants no client write path to any privacy table'
);
select is(
  (select count(*) from pg_policies
   where schemaname = 'public'
     and tablename in ('policy_acceptances', 'privacy_requests', 'revoked_auth_sessions',
                       'deletion_requests', 'data_exports')
     and cmd = 'SELECT'),
  4::bigint,
  'four own-row read policies, and none on the session denylist'
);

-- ---------------------------------------------------------------------------
-- Isolation between two authenticated people
-- ---------------------------------------------------------------------------

insert into public.policy_acceptances (profile_id, document_type, version, source)
values ('bbbbbbbb-0000-4000-8000-00000000000b', 'terms', '2026-08-01', 'signup');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001"}';
set local role authenticated;

select is(
  (select count(*) from public.policy_acceptances
   where profile_id <> 'aaaaaaaa-0000-4000-8000-00000000000a'),
  0::bigint,
  'acceptances of other people are invisible'
);
select is(
  (select count(*) from public.privacy_requests
   where profile_id <> 'aaaaaaaa-0000-4000-8000-00000000000a'),
  0::bigint,
  'privacy requests of other people are invisible'
);
select is(
  (select count(*) from public.data_exports
   where profile_id <> 'aaaaaaaa-0000-4000-8000-00000000000a'),
  0::bigint,
  'exports of other people are invisible'
);
select is(
  (select count(*) from public.deletion_requests),
  1::bigint,
  'only the caller own deletion saga is visible'
);
select throws_ok(
  'select count(*) from public.revoked_auth_sessions',
  '42501',
  null,
  'the session denylist is unreachable from a client role'
);

reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- Guard shape
-- ---------------------------------------------------------------------------

select has_function(
  'private', 'is_session_revoked', array[]::name[], 'is_session_revoked exists'
);
select is(
  (select p.prosecdef from pg_proc p
   where p.oid = 'private.is_session_revoked()'::regprocedure),
  false,
  'is_session_revoked runs as its caller'
);
select ok(
  (select p.proconfig from pg_proc p
   where p.oid = 'private.is_session_revoked()'::regprocedure) @> array['search_path=""'],
  'is_session_revoked pins an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'private.is_session_revoked()', 'execute'),
  'anon cannot execute is_session_revoked'
);
select ok(
  not has_function_privilege('authenticated', 'private.is_session_revoked()', 'execute'),
  'authenticated cannot execute is_session_revoked'
);

select has_function(
  'private', 'require_domain_authority', array[]::name[], 'require_domain_authority exists'
);
select is(
  (select p.prosecdef from pg_proc p
   where p.oid = 'private.require_domain_authority()'::regprocedure),
  false,
  'require_domain_authority runs as its caller'
);
select ok(
  (select p.proconfig from pg_proc p
   where p.oid = 'private.require_domain_authority()'::regprocedure)
    @> array['search_path=""'],
  'require_domain_authority pins an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'private.require_domain_authority()', 'execute'),
  'anon cannot execute require_domain_authority'
);
select ok(
  not has_function_privilege('authenticated', 'private.require_domain_authority()', 'execute'),
  'authenticated cannot execute require_domain_authority'
);

select * from finish();

rollback;
