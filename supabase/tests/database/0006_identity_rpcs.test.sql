begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------
-- The Auth ID below is the published vector of docs/13-contratos-funcoes.md
-- section 5.7, so the bootstrap actor key this suite observes is comparable
-- against the document without trusting the implementation.

insert into auth.users (id) values
  ('01890f7e-e948-7c53-b13a-4a36e4b7d21e'),
  ('00000000-0000-4000-8000-000000000201'),
  ('00000000-0000-4000-8000-000000000202'),
  ('00000000-0000-4000-8000-000000000203');

insert into public.profiles (id, auth_user_id, name, account_status, status_changed_at) values
  ('bbbbbbbb-0000-4000-8000-0000000002bb',
   '00000000-0000-4000-8000-000000000202', 'Bruno', 'suspended', now()),
  ('cccccccc-0000-4000-8000-0000000002cc',
   '00000000-0000-4000-8000-000000000203', 'Caio', 'deletion_pending', now());

-- ---------------------------------------------------------------------------
-- Policy catalogue
-- ---------------------------------------------------------------------------

select has_table('private', 'policy_documents', 'the technical policy catalogue exists');
select hasnt_table('public', 'policy_documents', 'the catalogue is not exposed in public');
select col_is_pk(
  'private', 'policy_documents', array['document_type', 'version'],
  'a policy version is identified by type and version'
);
select ok(
  not (select relrowsecurity from pg_class where oid = 'private.policy_documents'::regclass),
  'the catalogue is a private service table without RLS'
);
select is(
  (select count(*)
   from information_schema.role_table_grants
   where table_schema = 'private' and table_name = 'policy_documents'
     and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')),
  0::bigint,
  'no client or administrative role reaches the catalogue table'
);
select has_index(
  'private', 'policy_documents', 'one_mandatory_policy_per_type',
  'at most one mandatory version per type is an index, not a convention'
);
select is(
  (select count(*)
   from information_schema.columns
   where table_schema = 'private' and table_name = 'policy_documents'
     and column_name in ('content', 'body', 'text', 'html')),
  0::bigint,
  'the integral text of a policy never becomes a column'
);

-- docs/10-schema-db.md section 2 carries this composite foreign key. Migration
-- 0003 created policy_acceptances before the catalogue existed.
select is(
  (select count(*)
   from pg_constraint
   where conrelid = 'public.policy_acceptances'::regclass
     and contype = 'f'
     and confrelid = 'private.policy_documents'::regclass),
  1::bigint,
  'an acceptance points at a real catalogue version'
);

select throws_ok(
  $$insert into private.policy_documents
      (document_type, version, content_sha256, published_at)
    values ('terms', '2026-08-01', '\x00'::bytea, now())$$,
  '23514', null, 'the digest is exactly 32 raw bytes'
);
select throws_ok(
  $$insert into private.policy_documents
      (document_type, version, content_sha256, published_at)
    values ('cookies', '2026-08-01', extensions.digest('t', 'sha256'), now())$$,
  '23514', null, 'the document type vocabulary is closed'
);
select throws_ok(
  $$insert into private.policy_documents
      (document_type, version, content_sha256, published_at)
    values ('terms', 'versão com espaço', extensions.digest('t', 'sha256'), now())$$,
  '23514', null, 'a version identifier has a closed grammar'
);

select lives_ok(
  $$select private.publish_policy_document(
      'terms', '2026-07-01', extensions.digest('terms-v1', 'sha256'),
      now() - interval '60 days', true)$$,
  'the dispatcher publishes the first mandatory version of a type'
);
select lives_ok(
  $$select private.publish_policy_document(
      'terms', '2026-08-01', extensions.digest('terms-v2', 'sha256'),
      now() - interval '1 day', true)$$,
  'the dispatcher switches the mandatory version atomically'
);
select is(
  (select version from private.policy_documents
   where document_type = 'terms' and mandatory),
  '2026-08-01',
  'only the newest published version stays mandatory'
);
select is(
  (select count(*) from private.policy_documents where document_type = 'terms'),
  2::bigint,
  'the superseded version is kept, because an acceptance still references it'
);
select throws_ok(
  $$select private.publish_policy_document(
      'terms', '2026-08-01', extensions.digest('a-different-file', 'sha256'),
      now() - interval '1 day', true)$$,
  '22023', 'VALIDATION',
  'a published version cannot silently change the file it anchors'
);
select throws_ok(
  $$update private.policy_documents set mandatory = true
    where document_type = 'terms' and version = '2026-07-01'$$,
  '23505', null, 'two mandatory versions of one type cannot coexist'
);
select lives_ok(
  $$select private.publish_policy_document(
      'privacy', '2026-08-01', extensions.digest('privacy-v1', 'sha256'),
      now() - interval '1 day', true)$$,
  'the catalogue now holds one mandatory version of each type'
);

-- ---------------------------------------------------------------------------
-- Guards of the administrative path
-- ---------------------------------------------------------------------------

select ok(
  private.is_actor_session_revoked(null),
  'a context without a session identifier counts as revoked, not as trusted'
);
select ok(
  not private.is_actor_session_revoked('55555555-0000-4000-8000-000000000009'),
  'an unknown session identifier is not on the denylist'
);

select throws_ok(
  $$select private.require_actor_context(
      null, '55555555-0000-4000-8000-000000000001')$$,
  '28000', 'UNAUTHENTICATED', 'the administrative path needs an identified actor'
);
select throws_ok(
  $$select private.require_actor_context(
      '00000000-0000-4000-8000-000000000202', null)$$,
  '28000', 'UNAUTHENTICATED', 'a context without session_id cannot be checked for revocation'
);
select throws_ok(
  $$select private.require_actor_context(
      '00000000-0000-4000-8000-000000000201',
      '55555555-0000-4000-8000-000000000001')$$,
  'P0002', 'NOT_FOUND', 'an Auth identity without a profile is not an actor yet'
);
select throws_ok(
  $$select private.require_actor_context(
      '00000000-0000-4000-8000-000000000202',
      '55555555-0000-4000-8000-000000000001')$$,
  '42501', 'PROFILE_SUSPENDED', 'a suspended account cannot mutate the domain'
);
select is(
  (select private.require_actor_context(
     '00000000-0000-4000-8000-000000000202',
     '55555555-0000-4000-8000-000000000001', true)),
  'bbbbbbbb-0000-4000-8000-0000000002bb'::uuid,
  'a suspended account is still an actor for its own security action'
);
select throws_ok(
  $$select private.require_actor_context(
      '00000000-0000-4000-8000-000000000203',
      '55555555-0000-4000-8000-000000000001', true)$$,
  '42501', 'FORBIDDEN', 'a pending deletion loses every authority, suspension aside'
);

select throws_ok(
  $$select private.require_internal_transport(
      '60000000-0000-4000-8000-000000000001', repeat('a', 63), 1, 1)$$,
  '22023', 'VALIDATION', 'a malformed HMAC never reaches the idempotency helper'
);
select throws_ok(
  $$select private.require_internal_transport(
      '60000000-0000-4000-8000-000000000001', repeat('a', 64), 2, 1)$$,
  '22023', 'VALIDATION', 'an unknown canonicalisation version is refused at the door'
);
select throws_ok(
  $$select private.require_internal_transport(
      '60000000-0000-4000-8000-000000000001', repeat('a', 64), 1, 0)$$,
  '22023', 'VALIDATION', 'an HMAC key version has to be a real version'
);

-- ---------------------------------------------------------------------------
-- Execution boundary of the four RPCs
-- ---------------------------------------------------------------------------

select is(
  (select count(*) from pg_proc as p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('complete_profile', 'update_profile', 'accept_policies',
                       'revoke_current_session')
     and p.prosecdef),
  4::bigint,
  'the four gateway RPCs are SECURITY DEFINER'
);
select is(
  (select count(*) from pg_proc as p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('complete_profile', 'update_profile', 'accept_policies',
                       'revoke_current_session')
     and p.proconfig @> array['search_path=""']),
  4::bigint,
  'each gateway RPC pins an empty search_path and qualifies every object'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.complete_profile(uuid,uuid,uuid,text,integer,integer,jsonb)', 'execute'),
  'anon cannot call complete_profile'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.complete_profile(uuid,uuid,uuid,text,integer,integer,jsonb)', 'execute'),
  'authenticated cannot call complete_profile'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.update_profile(uuid,uuid,uuid,text,integer,integer,jsonb)', 'execute'),
  'authenticated cannot call update_profile'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.accept_policies(uuid,uuid,uuid,text,integer,integer,jsonb)', 'execute'),
  'authenticated cannot call accept_policies'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.revoke_current_session(uuid,uuid,uuid,text,integer,integer)', 'execute'),
  'authenticated cannot call revoke_current_session'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.complete_profile(uuid,uuid,uuid,text,integer,integer,jsonb)', 'execute'),
  'the administrative role holds the nominal grant on complete_profile'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.update_profile(uuid,uuid,uuid,text,integer,integer,jsonb)', 'execute'),
  'the administrative role holds the nominal grant on update_profile'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.accept_policies(uuid,uuid,uuid,text,integer,integer,jsonb)', 'execute'),
  'the administrative role holds the nominal grant on accept_policies'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.revoke_current_session(uuid,uuid,uuid,text,integer,integer)', 'execute'),
  'the administrative role holds the nominal grant on revoke_current_session'
);

-- The nominal grant is the whole allowlist: it buys the four functions and
-- nothing else. docs/13-contratos-funcoes.md section 0.1.
select ok(
  not has_function_privilege(
    'service_role', 'private.require_actor_context(uuid,uuid,boolean,boolean)', 'execute'),
  'the administrative role cannot call the guard directly'
);
select ok(
  not has_function_privilege(
    'service_role', 'private.publish_policy_document(text,text,bytea,timestamptz,boolean)',
    'execute'),
  'the administrative role cannot publish a policy version'
);
select ok(
  not has_function_privilege(
    'service_role', 'private.validate_profile_patch(jsonb,boolean)', 'execute'),
  'the administrative role cannot call the field validator directly'
);

set local role service_role;
select throws_ok(
  $$update public.profiles set name = 'Denied'
    where id = 'bbbbbbbb-0000-4000-8000-0000000002bb'$$,
  '42501', null, 'the nominal grants did not restore direct DML on profiles'
);
select throws_ok(
  $$insert into public.policy_acceptances (profile_id, document_type, version, source)
    values ('bbbbbbbb-0000-4000-8000-0000000002bb', 'terms', '2026-08-01', 'signup')$$,
  '42501', null, 'the administrative role cannot forge an acceptance directly'
);
select throws_ok(
  'select * from private.policy_documents',
  '42501', null, 'the administrative role cannot read the catalogue table'
);
reset role;

-- The four RPCs write to public.profiles, which carries force row level
-- security with no write policy. They work because their owner holds BYPASSRLS.
-- docs/14-convencoes-app.md section 5.2 warns that depending on this attribute
-- is depending on something no test covers by default, so this suite covers it.
select ok(
  (select rolbypassrls from pg_roles
   where rolname = (select pg_get_userbyid(proowner) from pg_proc
                    where oid = 'public.update_profile(uuid,uuid,uuid,text,integer,integer,jsonb)'::regprocedure)),
  'the gateway RPCs depend on their owner holding BYPASSRLS, and that is asserted'
);

-- ---------------------------------------------------------------------------
-- complete_profile
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.complete_profile(
      null, '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000101', repeat('a', 64), 1, 1,
      '{"name":"Ana"}'::jsonb)$$,
  '28000', 'UNAUTHENTICATED', 'complete_profile needs a verified Auth identity'
);
select throws_ok(
  $$select public.complete_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', null,
      '60000000-0000-4000-8000-000000000102', repeat('a', 64), 1, 1,
      '{"name":"Ana"}'::jsonb)$$,
  '28000', 'UNAUTHENTICATED', 'complete_profile needs an identifiable session'
);
select throws_ok(
  $$select public.complete_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000103', repeat('a', 64), 1, 1,
      '{"nickname":"Ana"}'::jsonb)$$,
  '22023', 'VALIDATION', 'a profile cannot be created without a name'
);
select throws_ok(
  $$select public.complete_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000104', repeat('a', 64), 1, 1,
      '{"name":"Ana","account_status":"active"}'::jsonb)$$,
  '22023', 'VALIDATION', 'the payload never chooses account_status'
);

select is(
  public.complete_profile(
    '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000105', repeat('a', 64), 1, 1,
    '{"name":"  Ana Lucia  ","position":"midfielder","shirt_number":10}'::jsonb)
    -> 'outcome' ->> 'logical_result',
  'profile_created',
  'complete_profile creates the internal identity'
);
select is(
  (select name from public.profiles
   where auth_user_id = '01890f7e-e948-7c53-b13a-4a36e4b7d21e'),
  'Ana Lucia',
  'the name is trimmed and normalised before it is stored'
);

-- The bootstrap actor key must be the published vector of docs/13 section 5.7.
select is(
  (select actor_key from private.idempotency_records
   where request_id = '60000000-0000-4000-8000-000000000105'),
  'bootstrap:21409156bb1cbd9d8cadf3814edcf230153e3378c09dc03ebf5ed8940c9c4d3a',
  'the bootstrap actor key matches the published derivation vector'
);
select is(
  (select actor_id from private.idempotency_records
   where request_id = '60000000-0000-4000-8000-000000000105'),
  (select id from public.profiles
   where auth_user_id = '01890f7e-e948-7c53-b13a-4a36e4b7d21e'),
  'the bootstrap record is linked to the profile it created'
);
select is(
  public.complete_profile(
    '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000105', repeat('a', 64), 1, 1,
    '{"name":"  Ana Lucia  ","position":"midfielder","shirt_number":10}'::jsonb)
    -> 'outcome' ->> 'profile_id',
  (select id::text from public.profiles
   where auth_user_id = '01890f7e-e948-7c53-b13a-4a36e4b7d21e'),
  'a retry with the same request_id replays instead of creating a second profile'
);
select is(
  (select count(*) from public.profiles
   where auth_user_id = '01890f7e-e948-7c53-b13a-4a36e4b7d21e'),
  1::bigint,
  'the replay produced no second profile'
);
select throws_ok(
  $$select public.complete_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000106', repeat('b', 64), 1, 1,
      '{"name":"Outra"}'::jsonb)$$,
  '22023', 'VALIDATION',
  'a new request_id after the profile exists is a validation error, not a second profile'
);

insert into private.revoked_auth_sessions (session_id, profile_id, expires_at)
values ('55555555-0000-4000-8000-00000000000e',
        'bbbbbbbb-0000-4000-8000-0000000002bb', now() + interval '90 days');
select throws_ok(
  $$select public.complete_profile(
      '00000000-0000-4000-8000-000000000201', '55555555-0000-4000-8000-00000000000e',
      '60000000-0000-4000-8000-000000000107', repeat('c', 64), 1, 1,
      '{"name":"Nova"}'::jsonb)$$,
  '28000', 'UNAUTHENTICATED', 'a revoked session cannot bootstrap a profile'
);

-- ---------------------------------------------------------------------------
-- The policy gate
-- ---------------------------------------------------------------------------
-- docs/13-contratos-funcoes.md section 5.2: an ordinary mutation is refused
-- while a mandatory version is pending, but accepting and revoking are not.

select throws_ok(
  $$select public.update_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000201', repeat('a', 64), 1, 1,
      '{"nickname":"Aninha"}'::jsonb)$$,
  '22023', 'VALIDATION', 'an ordinary mutation waits for the mandatory versions'
);

-- ---------------------------------------------------------------------------
-- accept_policies
-- ---------------------------------------------------------------------------

update private.policy_documents set mandatory = false where document_type = 'privacy';
select throws_ok(
  $$select public.accept_policies(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000202', repeat('a', 64), 1, 1,
      '[{"document_type":"terms","version":"2026-08-01"}]'::jsonb)$$,
  '22023', 'VALIDATION',
  'acceptance fails closed while the catalogue lacks a mandatory version of each type'
);
update private.policy_documents set mandatory = true
where document_type = 'privacy' and version = '2026-08-01';

select throws_ok(
  $$select public.accept_policies(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000203', repeat('a', 64), 1, 1,
      '[{"document_type":"terms","version":"2026-07-01"}]'::jsonb)$$,
  '22023', 'VALIDATION', 'a superseded version is not acceptable'
);
select throws_ok(
  $$select public.accept_policies(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000204', repeat('a', 64), 1, 1,
      '[{"document_type":"terms","version":"2099-01-01"}]'::jsonb)$$,
  '22023', 'VALIDATION', 'an unknown version is refused exactly like a superseded one'
);
select throws_ok(
  $$select public.accept_policies(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000205', repeat('a', 64), 1, 1,
      '[]'::jsonb)$$,
  '22023', 'VALIDATION', 'an empty acceptance is not an acceptance'
);
select throws_ok(
  $$select public.accept_policies(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000206', repeat('a', 64), 1, 1,
      '[{"document_type":"terms","version":"2026-08-01"},
        {"document_type":"privacy","version":"2026-08-01"}]'::jsonb)$$,
  '22023', 'VALIDATION', 'the acceptance list travels in canonical byte order'
);
select throws_ok(
  $$select public.accept_policies(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000207', repeat('a', 64), 1, 1,
      '[{"document_type":"privacy","version":"2026-08-01"},
        {"document_type":"privacy","version":"2026-08-01"}]'::jsonb)$$,
  '22023', 'VALIDATION', 'a duplicated pair is rejected by the same ordering rule'
);
select throws_ok(
  $$select public.accept_policies(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000208', repeat('a', 64), 1, 1,
      '[{"document_type":"privacy","version":"2026-08-01","source":"signup"}]'::jsonb)$$,
  '22023', 'VALIDATION', 'the payload never chooses the acceptance source'
);

select is(
  public.accept_policies(
    '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000209', repeat('b', 64), 1, 1,
    '[{"document_type":"privacy","version":"2026-08-01"},
      {"document_type":"terms","version":"2026-08-01"}]'::jsonb) -> 'outcome',
  '{"accepted":[{"document_type":"privacy","version":"2026-08-01"},
                {"document_type":"terms","version":"2026-08-01"}],
    "logical_result":"policies_accepted"}'::jsonb,
  'the outcome records exactly the versions accepted, in canonical order'
);
select is(
  public.accept_policies(
    '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000209', repeat('b', 64), 1, 1,
    '[{"document_type":"privacy","version":"2026-08-01"},
      {"document_type":"terms","version":"2026-08-01"}]'::jsonb) -> 'current' -> 'pending',
  '[]'::jsonb,
  'a replay rereads the fresh policy state and finds nothing pending'
);
select is(
  (select count(*) from public.policy_acceptances as acceptance
   join public.profiles as profile on profile.id = acceptance.profile_id
   where profile.auth_user_id = '01890f7e-e948-7c53-b13a-4a36e4b7d21e'),
  2::bigint,
  'the replay recorded no second acceptance'
);
select is(
  (select coalesce(string_agg(distinct acceptance.source, ','), 'none')
   from public.policy_acceptances as acceptance
   join public.profiles as profile on profile.id = acceptance.profile_id
   where profile.auth_user_id = '01890f7e-e948-7c53-b13a-4a36e4b7d21e'),
  'signup',
  'the first acceptance of each type is derived as signup by the server'
);

select lives_ok(
  $$select private.publish_policy_document(
      'terms', '2026-10-01', extensions.digest('terms-v3', 'sha256'), now(), true)$$,
  'a newer mandatory version of terms is published'
);
select is(
  public.accept_policies(
    '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-00000000020a', repeat('c', 64), 1, 1,
    '[{"document_type":"terms","version":"2026-10-01"}]'::jsonb)
    -> 'current' -> 'pending',
  '[]'::jsonb,
  'accepting the new mandatory version clears the pending list again'
);
select is(
  (select acceptance.source
   from public.policy_acceptances as acceptance
   join public.profiles as profile on profile.id = acceptance.profile_id
   where profile.auth_user_id = '01890f7e-e948-7c53-b13a-4a36e4b7d21e'
     and acceptance.version = '2026-10-01'),
  'reauth',
  'a later version of a type already accepted is derived as reauth'
);

-- ---------------------------------------------------------------------------
-- update_profile
-- ---------------------------------------------------------------------------

select is(
  public.update_profile(
    '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000301', repeat('a', 64), 1, 1,
    '{"nickname":"Aninha","dominant_foot":"left"}'::jsonb) -> 'outcome',
  '{"logical_result":"profile_updated"}'::jsonb,
  'the outcome never echoes the fields that were written'
);
select is(
  public.update_profile(
    '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000302', repeat('b', 64), 1, 1,
    '{}'::jsonb) -> 'current',
  '{"name":"Ana Lucia","nickname":"Aninha","position":"midfielder",
    "dominant_foot":"left","shirt_number":10}'::jsonb,
  'an absent key leaves its field untouched and an empty patch is a no-op success'
);
select is(
  public.update_profile(
    '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000303', repeat('c', 64), 1, 1,
    '{"nickname":null}'::jsonb) -> 'current' -> 'nickname',
  'null'::jsonb,
  'an explicit null is the only way to clear an optional field'
);
select throws_ok(
  $$select public.update_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000304', repeat('d', 64), 1, 1,
      '{"nickname":"   "}'::jsonb)$$,
  '22023', 'VALIDATION', 'a blank optional string is an error, not a silent null'
);
select throws_ok(
  $$select public.update_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000305', repeat('e', 64), 1, 1,
      '{"name":null}'::jsonb)$$,
  '22023', 'VALIDATION', 'name has no null spelling'
);
select throws_ok(
  $$select public.update_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000306', repeat('f', 64), 1, 1,
      '{"photo_url":"https://example.test/a.png"}'::jsonb)$$,
  '22023', 'VALIDATION', 'photo_url stays outside the allowlist until the bucket exists'
);
select throws_ok(
  $$select public.update_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000307', repeat('1', 64), 1, 1,
      '{"auth_user_id":"00000000-0000-4000-8000-000000000201"}'::jsonb)$$,
  '22023', 'VALIDATION', 'the payload cannot reach identity columns'
);
select throws_ok(
  $$select public.update_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000308', repeat('2', 64), 1, 1,
      '{"shirt_number":100}'::jsonb)$$,
  '22023', 'VALIDATION', 'the shirt number stays inside its documented range'
);
select throws_ok(
  $$select public.update_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000309', repeat('3', 64), 1, 1,
      '{"position":"striker"}'::jsonb)$$,
  '22023', 'VALIDATION', 'the position enum is closed'
);
select throws_ok(
  $$select public.update_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-00000000030a', repeat('4', 64), 1, 1,
      '{"name":"A"}'::jsonb)$$,
  '22023', 'VALIDATION', 'a name shorter than the documented minimum is refused'
);

-- The replay path runs before the gate on purpose: a mandatory version
-- published after the original commit must not turn a committed mutation into
-- an error on retry.
select lives_ok(
  $$select private.publish_policy_document(
      'privacy', '2026-12-01', extensions.digest('privacy-v2', 'sha256'), now(), true)$$,
  'a new mandatory privacy version is published after the update committed'
);
select is(
  public.update_profile(
    '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000301', repeat('a', 64), 1, 1,
    '{"nickname":"Aninha","dominant_foot":"left"}'::jsonb) -> 'outcome',
  '{"logical_result":"profile_updated"}'::jsonb,
  'a committed mutation still replays after a new mandatory version appears'
);
select throws_ok(
  $$select public.update_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-00000000030b', repeat('5', 64), 1, 1,
      '{"nickname":"Nova"}'::jsonb)$$,
  '22023', 'VALIDATION', 'but a new mutation waits for the new mandatory version'
);
select throws_ok(
  $$select public.update_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000301', repeat('9', 64), 1, 1,
      '{"nickname":"Aninha","dominant_foot":"left"}'::jsonb)$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'the same request_id with a different input conflicts'
);
select throws_ok(
  $$select public.update_profile(
      '00000000-0000-4000-8000-000000000202', '55555555-0000-4000-8000-000000000031',
      '60000000-0000-4000-8000-00000000030c', repeat('6', 64), 1, 1,
      '{"nickname":"Bru"}'::jsonb)$$,
  '42501', 'PROFILE_SUSPENDED', 'a suspended account cannot edit its profile'
);
select throws_ok(
  $$select public.update_profile(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-00000000000e',
      '60000000-0000-4000-8000-00000000030d', repeat('7', 64), 1, 1,
      '{"nickname":"Nova"}'::jsonb)$$,
  '28000', 'UNAUTHENTICATED', 'a revoked session cannot mutate, even with a valid actor'
);

-- ---------------------------------------------------------------------------
-- revoke_current_session
-- ---------------------------------------------------------------------------

select matches(
  public.revoke_current_session(
    '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000021',
    '60000000-0000-4000-8000-000000000401', repeat('a', 64), 1, 1)
    -> 'outcome' ->> 'revoked_at',
  '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$',
  'the revocation instant is a strict UTC timestamp with six fractional digits'
);
select ok(
  not (public.revoke_current_session(
    '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000021',
    '60000000-0000-4000-8000-000000000401', repeat('a', 64), 1, 1)
    -> 'outcome' ? 'expires_at'),
  'the outcome never carries expires_at, because session lifetime is mutable state'
);
select is(
  public.revoke_current_session(
    '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000021',
    '60000000-0000-4000-8000-000000000401', repeat('a', 64), 1, 1) -> 'current',
  '{"session_active":false}'::jsonb,
  'the fresh projection reports the session as inactive'
);
select is(
  (select count(*) from private.revoked_auth_sessions as revoked
   where revoked.session_id = '55555555-0000-4000-8000-000000000021'),
  1::bigint,
  'the session is on the denylist exactly once'
);

-- A second call with a new request_id over an already revoked session is a
-- success that must not shorten the denial already in force.
insert into private.revoked_auth_sessions (session_id, profile_id, expires_at)
select '55555555-0000-4000-8000-000000000023', profile.id, now() + interval '900 days'
from public.profiles as profile
where profile.auth_user_id = '01890f7e-e948-7c53-b13a-4a36e4b7d21e';

select is(
  public.revoke_current_session(
    '01890f7e-e948-7c53-b13a-4a36e4b7d21e', '55555555-0000-4000-8000-000000000023',
    '60000000-0000-4000-8000-000000000402', repeat('b', 64), 1, 1)
    -> 'outcome' ->> 'logical_result',
  'session_revoked',
  'a new request_id over an already revoked session is still a success'
);
select is(
  (select revoked.expires_at from private.revoked_auth_sessions as revoked
   where revoked.session_id = '55555555-0000-4000-8000-000000000023'),
  now() + interval '900 days',
  'the second call preserved the original expiry instead of shortening it'
);

select is(
  public.revoke_current_session(
    '00000000-0000-4000-8000-000000000202', '55555555-0000-4000-8000-000000000022',
    '60000000-0000-4000-8000-000000000403', repeat('c', 64), 1, 1)
    -> 'outcome' ->> 'logical_result',
  'session_revoked',
  'a suspended account may still revoke its own session'
);
select throws_ok(
  $$select public.revoke_current_session(
      '00000000-0000-4000-8000-000000000203', '55555555-0000-4000-8000-000000000024',
      '60000000-0000-4000-8000-000000000404', repeat('d', 64), 1, 1)$$,
  '42501', 'FORBIDDEN', 'a pending deletion has already lost every authority'
);
select throws_ok(
  $$select public.revoke_current_session(
      '01890f7e-e948-7c53-b13a-4a36e4b7d21e', null,
      '60000000-0000-4000-8000-000000000405', repeat('e', 64), 1, 1)$$,
  '28000', 'UNAUTHENTICATED', 'a token without session_id cannot revoke anything'
);

-- ---------------------------------------------------------------------------
-- What the idempotency records may never contain
-- ---------------------------------------------------------------------------

select is(
  (select count(*) from private.idempotency_records as records
   where records.outcome::text ~* '(token|secret|pix|password|authorization|http)'),
  0::bigint,
  'no outcome written by these RPCs carries a secret-looking value'
);
select is(
  (select count(*) from private.idempotency_records
   where state <> 'completed'),
  0::bigint,
  'every RPC in this suite concluded its idempotency key in the same transaction'
);


select * from finish();

rollback;
