begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000003');

insert into public.profiles (id, auth_user_id, name) values
  ('aaaaaaaa-0000-4000-8000-00000000000a',
   '00000000-0000-4000-8000-000000000001', 'Ana'),
  ('bbbbbbbb-0000-4000-8000-00000000000b',
   '00000000-0000-4000-8000-000000000002', 'Bruno');

-- ---------------------------------------------------------------------------
-- Structure, lifecycle and retention
-- ---------------------------------------------------------------------------

select has_table('private', 'idempotency_records', 'the server-only idempotency table exists');
select hasnt_table('public', 'idempotency_records', 'idempotency state is not exposed in public');
select col_is_pk(
  'private',
  'idempotency_records',
  array['actor_key', 'operation', 'request_id'],
  'actor, operation and request id form the idempotency key'
);
select fk_ok(
  'private', 'idempotency_records', 'actor_id',
  'public', 'profiles', 'id',
  'a resolved actor points at a profile'
);
select is(
  (select unique_constraint_schema || '.' || unique_constraint_name
   from information_schema.referential_constraints
   where constraint_schema = 'private'
     and constraint_name = 'idempotency_records_actor_id_fkey'),
  'public.profiles_pkey',
  'the actor foreign key targets the profile primary key'
);
select is(
  (select c.confdeltype
   from pg_constraint as c
   where c.conname = 'idempotency_records_actor_id_fkey'
     and c.conrelid = 'private.idempotency_records'::regclass),
  'r'::"char",
  'deleting a profile never cascades into its idempotency tombstones'
);
select col_not_null(
  'private', 'idempotency_records', 'request_hash', 'the request HMAC is mandatory'
);
select col_not_null(
  'private', 'idempotency_records', 'canonical_version', 'the canonical version is mandatory'
);
select col_not_null(
  'private', 'idempotency_records', 'hash_key_version', 'the HMAC key version is mandatory'
);
select col_default_is(
  'private', 'idempotency_records', 'canonical_version', '1', 'canonical input starts at v1'
);
select col_default_is(
  'private', 'idempotency_records', 'state', 'executing_uncommitted',
  'a winner starts executing without exposing a committed intermediate state'
);
select ok(
  not (select relrowsecurity from pg_class where oid = 'private.idempotency_records'::regclass),
  'the private service table deliberately has no RLS'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'private.idempotency_records'::regclass),
  'the service table does not force RLS on a future RPC owner'
);
select is(
  (select count(*) from pg_policies
   where schemaname = 'private' and tablename = 'idempotency_records'),
  0::bigint,
  'the private service table has no policies'
);
select has_trigger(
  'private', 'idempotency_records', 'idempotency_records_must_conclude',
  'the transaction-boundary constraint trigger exists'
);
select ok(
  (select trigger.tgdeferrable and trigger.tginitdeferred
   from pg_trigger as trigger
   where trigger.tgrelid = 'private.idempotency_records'::regclass
     and trigger.tgname = 'idempotency_records_must_conclude'),
  'the conclusion trigger is DEFERRABLE INITIALLY DEFERRED'
);
select is(
  (select limit_value from private.app_limits
   where limit_key = 'idempotency_wait_timeout_ms'),
  3000::bigint,
  'the transactional wait timeout is three seconds'
);
select is(
  (select unit from private.app_limits
   where limit_key = 'idempotency_wait_timeout_ms'),
  'milliseconds',
  'the timeout unit is explicit'
);
select lives_ok(
  $$insert into private.app_limits (limit_key, limit_value, unit, notes)
    values ('millisecond_probe', 1, 'milliseconds', 'rolled back with this test')$$,
  'milliseconds belongs to the closed app-limit unit vocabulary'
);

select throws_ok(
  $$insert into private.idempotency_records
      (actor_key, operation, request_id, request_hash, hash_key_version)
    values ('system:retention_probe', 'update_profile',
            '10000000-0000-4000-8000-000000000001', repeat('a', 63), 1)$$,
  '23514',
  null,
  'a raw or malformed digest cannot be stored as the request HMAC'
);
select throws_ok(
  $$insert into private.idempotency_records
      (actor_key, operation, request_id, request_hash, canonical_version, hash_key_version)
    values ('system:retention_probe', 'update_profile',
            '10000000-0000-4000-8000-000000000002', repeat('a', 64), 2, 1)$$,
  '23514',
  null,
  'an unknown canonical input version cannot enter the table'
);
select throws_ok(
  $$insert into private.idempotency_records
      (actor_key, operation, request_id, request_hash, hash_key_version)
    values ('system:retention_probe', 'unknown_operation',
            '10000000-0000-4000-8000-000000000003', repeat('a', 64), 1)$$,
  '23514',
  null,
  'an operation needs an explicit migration before it can use idempotency'
);
select throws_ok(
  $$insert into private.idempotency_records
      (actor_key, operation, request_id, request_hash, hash_key_version,
       outcome_expires_at)
    values ('system:retention_probe', 'update_profile',
            '10000000-0000-4000-8000-000000000004', repeat('a', 64), 1,
            now() + interval '29 days')$$,
  '23514',
  null,
  'the replay payload retention cannot be shortened ad hoc'
);
select throws_ok(
  $$insert into private.idempotency_records
      (actor_key, operation, request_id, request_hash, hash_key_version,
       record_expires_at)
    values ('system:retention_probe', 'update_profile',
            '10000000-0000-4000-8000-000000000005', repeat('a', 64), 1,
            now() + interval '23 months')$$,
  '23514',
  null,
  'the conflict tombstone retention cannot be shortened ad hoc'
);
select throws_ok(
  $$insert into private.idempotency_records
      (actor_key, operation, request_id, request_hash, hash_key_version, state)
    values ('system:retention_probe', 'update_profile',
            '10000000-0000-4000-8000-000000000006', repeat('a', 64), 1,
            'leased')$$,
  '23514', null, 'no lease or takeover state exists'
);
select throws_ok(
  $$insert into private.idempotency_records
      (actor_key, operation, request_id, request_hash, hash_key_version,
       state, outcome_code, outcome, completed_at)
    values ('bootstrap:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            'complete_profile', '10000000-0000-4000-8000-000000000007',
            repeat('a', 64), 1, 'completed', 'profile_created',
            '{"logical_result":"profile_created","profile_id":"aaaaaaaa-0000-4000-8000-00000000000a"}',
            now())$$,
  '23514', null, 'a completed bootstrap can never keep actor_id null'
);

-- ---------------------------------------------------------------------------
-- Closed actor namespace and bootstrap exception
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select * from private.acquire_idempotency(
      'profile:AAAAAAAA-0000-4000-8000-00000000000A', 'update_profile',
      '20000000-0000-4000-8000-000000000001', repeat('a', 64), 1, 1)$$,
  '22023', 'VALIDATION', 'profile actor keys use a canonical lowercase UUID'
);
-- Canonical lowercase is the whole rule, and nothing in this file used to say
-- so: until migration 0009 the check here also pinned the UUID version nibble
-- to 1 through 5, and no assertion covered that, which is how it survived. The
-- version a UUID carries is not an invariant of any contract in this project,
-- so the assertion above is paired with its complement rather than left to
-- imply a narrower rule than the one enforced.
insert into auth.users (id) values ('00000000-0000-4000-8000-000000000004');
insert into public.profiles (id, auth_user_id, name) values
  ('aaaaaaaa-0000-7000-8000-00000000000a',
   '00000000-0000-4000-8000-000000000004', 'Vera');
select is(
  (select acquired from private.acquire_idempotency(
    'profile:aaaaaaaa-0000-7000-8000-00000000000a', 'update_profile',
    '20000000-0000-4000-8000-00000000000c', repeat('a', 64), 1, 1)),
  true,
  'and a lowercase key is accepted whatever version nibble its UUID carries'
);
select private.complete_idempotency(
  'profile:aaaaaaaa-0000-7000-8000-00000000000a', 'update_profile',
  '20000000-0000-4000-8000-00000000000c', repeat('a', 64), 1, 1,
  '{"logical_result":"profile_updated"}'::jsonb
);
select throws_ok(
  $$select * from private.acquire_idempotency(
      'system:bad-name', 'update_profile',
      '20000000-0000-4000-8000-000000000002', repeat('a', 64), 1, 1)$$,
  '22023', 'VALIDATION', 'system actor keys use the closed lower_snake_case grammar'
);
select throws_ok(
  $$select * from private.acquire_idempotency(
      'device:aaaaaaaa-0000-4000-8000-00000000000a', 'update_profile',
      '20000000-0000-4000-8000-000000000003', repeat('a', 64), 1, 1)$$,
  '22023', 'VALIDATION', 'unknown actor namespaces are rejected'
);
select throws_ok(
  $$select * from private.acquire_idempotency(
      'profile:dddddddd-0000-4000-8000-00000000000d', 'update_profile',
      '20000000-0000-4000-8000-000000000004', repeat('a', 64), 1, 1)$$,
  '22023', 'VALIDATION', 'a normal profile actor has to exist'
);
select throws_ok(
  $$select * from private.acquire_idempotency(
      'system:version_test', 'update_profile',
      '20000000-0000-4000-8000-000000000008', repeat('a', 64), 1, 0)$$,
  '22023', 'VALIDATION', 'an HMAC key version must be positive'
);
select throws_ok(
  $$select * from private.acquire_idempotency(
      'system:version_test', 'update_profile',
      '20000000-0000-4000-8000-000000000009', repeat('a', 64), 1, 32768)$$,
  '22023', 'VALIDATION', 'an HMAC key version must fit its persisted representation'
);
select throws_ok(
  $$select * from private.acquire_idempotency(
      'bootstrap:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'update_profile', '20000000-0000-4000-8000-000000000007',
      repeat('a', 64), 1, 1)$$,
  '22023', 'VALIDATION', 'only complete_profile accepts the bootstrap namespace'
);
select throws_ok(
  $$select * from private.acquire_idempotency(
      'profile:aaaaaaaa-0000-4000-8000-00000000000a', 'complete_profile',
      '20000000-0000-4000-8000-00000000000a', repeat('a', 64), 1, 1)$$,
  '22023', 'VALIDATION',
  'complete_profile cannot skip the bootstrap derivation with a known profile actor'
);
select throws_ok(
  $$select * from private.acquire_idempotency(
      'system:profile_creator', 'complete_profile',
      '20000000-0000-4000-8000-00000000000b', repeat('a', 64), 1, 1)$$,
  '22023', 'VALIDATION', 'complete_profile is not reachable from a system actor'
);
select throws_ok(
  $$insert into private.idempotency_records
      (actor_key, actor_id, operation, request_id, request_hash, hash_key_version)
    values ('profile:aaaaaaaa-0000-4000-8000-00000000000a',
            'aaaaaaaa-0000-4000-8000-00000000000a', 'complete_profile',
            '10000000-0000-4000-8000-000000000008', repeat('a', 64), 1)$$,
  '23514', null,
  'the table itself keeps complete_profile exclusive to the bootstrap namespace'
);
select is(
  (select acquired from private.acquire_idempotency(
    'system:idempotency_test', 'update_profile',
    '20000000-0000-4000-8000-000000000005', repeat('a', 64), 1, 1)),
  true,
  'a valid system actor can acquire a key'
);
select private.complete_idempotency(
  'system:idempotency_test', 'update_profile',
  '20000000-0000-4000-8000-000000000005', repeat('a', 64), 1, 1,
  '{"logical_result":"profile_updated"}'::jsonb
);
select is(
  (select actor_id from private.idempotency_records
   where request_id = '20000000-0000-4000-8000-000000000005'),
  null::uuid,
  'a system actor never gains a profile id'
);

select is(
  (select acquired from private.acquire_idempotency(
    'bootstrap:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'complete_profile',
    '20000000-0000-4000-8000-000000000006', repeat('b', 64), 1, 1)),
  true,
  'complete_profile can acquire before the profile exists'
);
select is(
  (select actor_id from private.idempotency_records
   where request_id = '20000000-0000-4000-8000-000000000006'),
  null::uuid,
  'the bootstrap record starts with no actor link'
);
insert into public.profiles (id, auth_user_id, name) values
  ('cccccccc-0000-4000-8000-00000000000c',
   '00000000-0000-4000-8000-000000000003', 'Caio');
select lives_ok(
  $$select private.complete_idempotency(
      'bootstrap:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'complete_profile',
      '20000000-0000-4000-8000-000000000006', repeat('b', 64), 1, 1,
      '{"logical_result":"profile_created","profile_id":"cccccccc-0000-4000-8000-00000000000c"}'::jsonb)$$,
  'complete_profile links the idempotency row after creating the profile'
);
select is(
  (select actor_id from private.idempotency_records
   where request_id = '20000000-0000-4000-8000-000000000006'),
  'cccccccc-0000-4000-8000-00000000000c'::uuid,
  'the bootstrap exception ends at completion'
);

-- ---------------------------------------------------------------------------
-- Exact replay-safe outcome vocabulary
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select private.validate_idempotency_outcome(
      'complete_profile',
      '{"logical_result":"profile_created","profile_id":"aaaaaaaa-0000-4000-8000-00000000000a"}'::jsonb)$$,
  'complete_profile accepts its exact safe outcome'
);
select lives_ok(
  $$select private.validate_idempotency_outcome(
      'update_profile', '{"logical_result":"profile_updated"}'::jsonb)$$,
  'update_profile accepts its exact safe outcome'
);
select lives_ok(
  $$select private.validate_idempotency_outcome(
      'accept_policies',
      '{"logical_result":"policies_accepted","accepted":[{"document_type":"privacy","version":"2026-08-01"},{"document_type":"terms","version":"2026-08-01"}]}'::jsonb)$$,
  'accept_policies accepts a canonically ordered bounded list'
);
select lives_ok(
  $$select private.validate_idempotency_outcome(
      'revoke_current_session',
      '{"logical_result":"session_revoked","session_id":"30000000-0000-4000-8000-000000000001","revoked_at":"2026-08-31T12:34:56.123456Z"}'::jsonb)$$,
  'revoke_current_session accepts the strict UTC timestamp shape'
);

select throws_ok(
  $$select private.validate_idempotency_outcome(
      'unknown_operation', '{"logical_result":"profile_updated"}'::jsonb)$$,
  '22023', 'VALIDATION', 'unknown operations have no replay outcome vocabulary'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'update_profile', '{"logical_result":"profile_updated","access_token":"redacted"}'::jsonb)$$,
  '22023', 'VALIDATION', 'top-level sensitive extras are rejected'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'complete_profile',
      '{"logical_result":"profile_created","profile_id":"aaaaaaaa-0000-4000-8000-00000000000a","refresh_token":"redacted"}'::jsonb)$$,
  '22023', 'VALIDATION', 'complete_profile rejects every unknown key'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'accept_policies',
      '{"logical_result":"policies_accepted","accepted":[{"document_type":"privacy","version":"1","access_token":"redacted"}]}'::jsonb)$$,
  '22023', 'VALIDATION', 'nested sensitive extras are rejected'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'revoke_current_session',
      '{"logical_result":"session_revoked","session_id":"30000000-0000-4000-8000-000000000001","revoked_at":"2026-08-31T12:34:56.123456Z","authorization":"redacted"}'::jsonb)$$,
  '22023', 'VALIDATION', 'session revocation rejects every unknown key'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'update_profile', '{"logical_result":"profile_created"}'::jsonb)$$,
  '22023', 'VALIDATION', 'logical results cannot cross operations'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'complete_profile', '{"logical_result":"profile_created"}'::jsonb)$$,
  '22023', 'VALIDATION', 'a required outcome key cannot be omitted'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'update_profile', '{"logical_result":7}'::jsonb)$$,
  '22023', 'VALIDATION', 'outcome fields have exact JSON types'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'accept_policies',
      '{"logical_result":"policies_accepted","accepted":[{"document_type":"cookies","version":"1"}]}'::jsonb)$$,
  '22023', 'VALIDATION', 'outcome enums remain closed'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'accept_policies',
      '{"logical_result":"policies_accepted","accepted":[]}'::jsonb)$$,
  '22023', 'VALIDATION', 'an acceptance replay cannot contain an empty list'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'accept_policies',
      '{"logical_result":"policies_accepted","accepted":[{"document_type":"terms","version":"1"},{"document_type":"privacy","version":"1"}]}'::jsonb)$$,
  '22023', 'VALIDATION', 'acceptances have canonical byte ordering'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'accept_policies',
      '{"logical_result":"policies_accepted","accepted":[{"document_type":"privacy","version":"1"},{"document_type":"privacy","version":"1"}]}'::jsonb)$$,
  '22023', 'VALIDATION', 'duplicate acceptances are rejected'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'accept_policies',
      '{"logical_result":"policies_accepted","accepted":[{"document_type":"privacy","version":"1"},{"document_type":"terms","version":"1"},{"document_type":"terms","version":"2"}]}'::jsonb)$$,
  '22023', 'VALIDATION', 'the acceptance replay list has an explicit maximum size'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'revoke_current_session',
      '{"logical_result":"session_revoked","session_id":"30000000-0000-4000-8000-000000000001","revoked_at":"2026-08-31T12:34:56Z"}'::jsonb)$$,
  '22023', 'VALIDATION', 'revocation timestamps require six fractional digits'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'revoke_current_session',
      '{"logical_result":"session_revoked","session_id":"30000000-0000-4000-8000-000000000001","revoked_at":"2026-99-31T12:34:56.123456Z"}'::jsonb)$$,
  '22023', 'VALIDATION', 'a shape-correct but impossible timestamp is rejected'
);

-- ---------------------------------------------------------------------------
-- Acquire, complete, replay, conflict and payload expiry
-- ---------------------------------------------------------------------------

select is(
  (select acquired from private.acquire_idempotency(
    'profile:aaaaaaaa-0000-4000-8000-00000000000a', 'update_profile',
    '40000000-0000-4000-8000-000000000001', repeat('c', 64), 1, 7)),
  true,
  'the first valid caller wins the key'
);
select lives_ok(
  $$select private.complete_idempotency(
      'profile:aaaaaaaa-0000-4000-8000-00000000000a', 'update_profile',
      '40000000-0000-4000-8000-000000000001', repeat('c', 64), 1, 7,
      '{"logical_result":"profile_updated"}'::jsonb)$$,
  'the winner completes the exact executing row'
);
select is(
  (select acquired from private.acquire_idempotency(
    'profile:aaaaaaaa-0000-4000-8000-00000000000a', 'update_profile',
    '40000000-0000-4000-8000-000000000001', repeat('c', 64), 1, 7)),
  false,
  'a matching retry replays rather than executing again'
);
select is(
  (select outcome from private.acquire_idempotency(
    'profile:aaaaaaaa-0000-4000-8000-00000000000a', 'update_profile',
    '40000000-0000-4000-8000-000000000001', repeat('c', 64), 1, 7)),
  '{"logical_result":"profile_updated"}'::jsonb,
  'a matching retry receives the same safe outcome'
);
select throws_ok(
  $$select * from private.acquire_idempotency(
      'profile:aaaaaaaa-0000-4000-8000-00000000000a', 'update_profile',
      '40000000-0000-4000-8000-000000000001', repeat('d', 64), 1, 7)$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'the same key with different input conflicts'
);
select throws_ok(
  $$select * from private.acquire_idempotency(
      'profile:aaaaaaaa-0000-4000-8000-00000000000a', 'update_profile',
      '40000000-0000-4000-8000-000000000001', repeat('c', 64), 1, 8)$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'the same key with another HMAC key version conflicts'
);
select throws_ok(
  $$select private.complete_idempotency(
      'profile:aaaaaaaa-0000-4000-8000-00000000000a', 'update_profile',
      '40000000-0000-4000-8000-000000000001', repeat('c', 64), 1, 7,
      '{"logical_result":"profile_updated"}'::jsonb)$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'a completed row cannot be completed twice'
);

select is(
  (select acquired from private.acquire_idempotency(
    'profile:bbbbbbbb-0000-4000-8000-00000000000b', 'update_profile',
    '40000000-0000-4000-8000-000000000002', repeat('e', 64), 1, 1)),
  true,
  'a second executing fixture is acquired'
);
select throws_ok(
  $$select private.complete_idempotency(
      'profile:bbbbbbbb-0000-4000-8000-00000000000b', 'update_profile',
      '40000000-0000-4000-8000-000000000002', repeat('f', 64), 1, 1,
      '{"logical_result":"profile_updated"}'::jsonb)$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'completion cannot switch to a different HMAC'
);
select private.complete_idempotency(
  'profile:bbbbbbbb-0000-4000-8000-00000000000b', 'update_profile',
  '40000000-0000-4000-8000-000000000002', repeat('e', 64), 1, 1,
  '{"logical_result":"profile_updated"}'::jsonb
);

update private.idempotency_records
set state = 'payload_expired',
    outcome = null,
    updated_at = outcome_expires_at,
    payload_expired_at = outcome_expires_at
where actor_key = 'profile:bbbbbbbb-0000-4000-8000-00000000000b'
  and operation = 'update_profile'
  and request_id = '40000000-0000-4000-8000-000000000002';
select throws_ok(
  $$select * from private.acquire_idempotency(
      'profile:bbbbbbbb-0000-4000-8000-00000000000b', 'update_profile',
      '40000000-0000-4000-8000-000000000002', repeat('e', 64), 1, 1)$$,
  'P0001', 'IDEMPOTENCY_EXPIRED', 'a payload-free tombstone rejects replay as expired'
);

-- ---------------------------------------------------------------------------
-- Deferred conclusion guard
-- ---------------------------------------------------------------------------

select private.acquire_idempotency(
  'system:incomplete_test', 'update_profile',
  '50000000-0000-4000-8000-000000000001', repeat('a', 64), 1, 1
);
select throws_ok(
  'set constraints private.idempotency_records_must_conclude immediate',
  '23514',
  'IDEMPOTENCY_INCOMPLETE',
  'an acquired key cannot cross the transaction boundary while executing'
);
select private.complete_idempotency(
  'system:incomplete_test', 'update_profile',
  '50000000-0000-4000-8000-000000000001', repeat('a', 64), 1, 1,
  '{"logical_result":"profile_updated"}'::jsonb
);
set constraints private.idempotency_records_must_conclude deferred;

select is(
  (select acquired from private.acquire_idempotency(
    'system:complete_test', 'update_profile',
    '50000000-0000-4000-8000-000000000002', repeat('b', 64), 1, 1)),
  true,
  'the conclusion-guard success fixture is acquired'
);
select private.complete_idempotency(
  'system:complete_test', 'update_profile',
  '50000000-0000-4000-8000-000000000002', repeat('b', 64), 1, 1,
  '{"logical_result":"profile_updated"}'::jsonb
);
select lives_ok(
  'set constraints private.idempotency_records_must_conclude immediate',
  'a completed key passes the deferred transaction-boundary guard'
);
set constraints private.idempotency_records_must_conclude deferred;

-- ---------------------------------------------------------------------------
-- Helper and privilege boundary
-- ---------------------------------------------------------------------------

select has_function(
  'private', 'validate_idempotency_outcome', array['text', 'jsonb']::name[],
  'the outcome validator exists'
);
select has_function(
  'private', 'acquire_idempotency',
  array['text', 'text', 'uuid', 'text', 'integer', 'integer']::name[],
  'the acquire helper exists'
);
select has_function(
  'private', 'complete_idempotency',
  array['text', 'text', 'uuid', 'text', 'integer', 'integer', 'jsonb']::name[],
  'the completion helper exists'
);
select is(
  (select p.prosecdef from pg_proc as p
   where p.oid = 'private.acquire_idempotency(text,text,uuid,text,integer,integer)'::regprocedure),
  false,
  'acquire is SECURITY INVOKER for composition inside a future RPC'
);
select is(
  (select p.prosecdef from pg_proc as p
   where p.oid = 'private.complete_idempotency(text,text,uuid,text,integer,integer,jsonb)'::regprocedure),
  false,
  'complete is SECURITY INVOKER for composition inside a future RPC'
);
select ok(
  (select p.proconfig from pg_proc as p
   where p.oid = 'private.acquire_idempotency(text,text,uuid,text,integer,integer)'::regprocedure)
    @> array['search_path=""'],
  'acquire pins an empty search_path'
);
select ok(
  (select p.proconfig from pg_proc as p
   where p.oid = 'private.complete_idempotency(text,text,uuid,text,integer,integer,jsonb)'::regprocedure)
    @> array['search_path=""'],
  'complete pins an empty search_path'
);
select ok(
  (select p.proconfig from pg_proc as p
   where p.oid = 'private.validate_idempotency_outcome(text,jsonb)'::regprocedure)
    @> array['search_path=""'],
  'the validator pins an empty search_path'
);

select ok(
  not has_schema_privilege('service_role', 'private', 'usage'),
  'service_role cannot enter the private application schema'
);
select is(
  (select count(*)
   from information_schema.role_table_grants
   where grantee = 'service_role'
     and table_schema in ('public', 'private')),
  0::bigint,
  'service_role has no table privilege anywhere in the application schemas'
);
select is(
  (select count(*)
   from information_schema.routine_privileges
   where grantee = 'service_role'
     and specific_schema = 'private'),
  0::bigint,
  'service_role cannot execute any private helper'
);
-- docs/10-schema-db.md section 11 allows exactly one exception to the blanket
-- revocation: a nominal grant on the narrow RPCs the Edge is allowed to call.
-- Naming them here is deliberate, so a future migration that widens the
-- administrative surface has to change this assertion on purpose.
select is(
  (select coalesce(string_agg(distinct routine_name, ', ' order by routine_name), 'none')
   from information_schema.routine_privileges
   where grantee = 'service_role'
     and specific_schema = 'public'),
  'accept_policies, approve_member, check_and_debit_invite_attempt, complete_profile, consume_data_export, create_group, delete_account, enqueue_data_export_purge, finalize_deletion, get_invite_share_link, get_my_pending_group_requests, issue_group_invite, join_by_code, join_by_invite, leave_group, mark_invite_attempt_success, preview_group_by_code, preview_group_by_invite, regenerate_group_invite, remove_member, rename_group, request_data_export, revoke_current_session, revoke_group_invite, set_monthly, set_ratings_visibility, set_role, transfer_ownership, update_profile, worker_acquire_external_effect, worker_begin_job, worker_complete_external_effect, worker_confirm_deletion_effect, worker_execute_database_job, worker_finish_job, worker_get_data_export_build_target, worker_get_deletion_effect_target, worker_publish_data_export',
  'service_role executes only the nominal gateway allowlist, and nothing else'
);
-- string_agg(distinct ...) collapses overloads, so a second signature of an
-- allowlisted name could be granted without changing the line above. The count
-- is what makes the allowlist exact.
select is(
  (select count(*)
   from information_schema.routine_privileges
   where grantee = 'service_role'
     and specific_schema = 'public'),
  38::bigint,
  'the allowlist is exactly thirty-eight routines, so no overload can hide inside a name'
);
select ok(
  not has_table_privilege('anon', 'private.idempotency_records', 'select'),
  'anon cannot read idempotency records'
);
select ok(
  not has_table_privilege('authenticated', 'private.idempotency_records', 'select'),
  'authenticated cannot read idempotency records'
);
select ok(
  not has_table_privilege('service_role', 'private.idempotency_records', 'select'),
  'service_role cannot read idempotency records'
);
select ok(
  not has_table_privilege('service_role', 'public.profiles', 'insert'),
  'service_role no longer gets application-table DML'
);
select ok(
  (select rolbypassrls from pg_roles where rolname = 'service_role'),
  'service_role still has BYPASSRLS, so grants rather than policies form this boundary'
);

select ok(
  not has_function_privilege(
    'anon',
    'private.acquire_idempotency(text,text,uuid,text,integer,integer)',
    'execute'),
  'anon cannot execute acquire'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'private.acquire_idempotency(text,text,uuid,text,integer,integer)',
    'execute'),
  'authenticated cannot execute acquire'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.acquire_idempotency(text,text,uuid,text,integer,integer)',
    'execute'),
  'service_role cannot execute acquire'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.complete_idempotency(text,text,uuid,text,integer,integer,jsonb)',
    'execute'),
  'service_role cannot execute complete'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.validate_idempotency_outcome(text,jsonb)',
    'execute'),
  'service_role cannot execute the validator'
);

set local role service_role;

select throws_ok(
  'select * from public.profiles',
  '42501', null, 'service_role cannot SELECT application tables directly'
);
select throws_ok(
  $$insert into public.profiles (auth_user_id, name)
    values ('00000000-0000-4000-8000-000000000099', 'Denied')$$,
  '42501', null, 'service_role cannot INSERT application tables directly'
);
select throws_ok(
  $$update public.profiles set name = 'Denied'
    where id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$,
  '42501', null, 'service_role cannot UPDATE application tables directly'
);
select throws_ok(
  $$delete from public.profiles
    where id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$,
  '42501', null, 'service_role cannot DELETE application tables directly'
);
select throws_ok(
  $$select nextval('public.policy_acceptances_id_seq')$$,
  '42501', null, 'service_role cannot use an application sequence directly'
);
select throws_ok(
  $$select * from private.acquire_idempotency(
      'system:denied', 'update_profile',
      '70000000-0000-4000-8000-000000000001', repeat('a', 64), 1, 1)$$,
  '42501', null, 'service_role cannot call a private idempotency helper'
);
select throws_ok(
  'alter table private.idempotency_records disable trigger idempotency_records_must_conclude',
  '42501', null, 'service_role cannot disable the deferred conclusion guarantee'
);

reset role;

set local role authenticated;
select throws_ok(
  'alter table private.idempotency_records disable trigger idempotency_records_must_conclude',
  '42501', null, 'an authenticated client cannot disable the deferred conclusion guarantee'
);
reset role;

create table public.m1a_service_default_table_probe (id bigint generated always as identity);
create table private.m1a_service_nominal_probe (id integer primary key);
create function public.m1a_service_default_function_probe()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $probe$
begin
  insert into private.m1a_service_nominal_probe (id) values (1);
  return 1;
end;
$probe$;

select ok(
  not has_table_privilege('service_role', 'public.m1a_service_default_table_probe', 'insert'),
  'future public tables do not restore service-role DML'
);
select ok(
  not has_sequence_privilege(
    'service_role', 'public.m1a_service_default_table_probe_id_seq', 'usage'),
  'future public sequences do not restore service-role usage'
);
select ok(
  not has_function_privilege(
    'service_role', 'public.m1a_service_default_function_probe()', 'execute'),
  'future public functions do not restore service-role execution'
);

grant execute on function public.m1a_service_default_function_probe() to service_role;

set local role service_role;
select is(
  public.m1a_service_default_function_probe(),
  1,
  'service_role can use a narrow SECURITY DEFINER function after a nominal grant'
);
select throws_ok(
  'insert into private.m1a_service_nominal_probe (id) values (2)',
  '42501', null, 'the nominal function grant does not grant direct table DML'
);
reset role;

select is(
  (select count(*)::integer from private.m1a_service_nominal_probe),
  1,
  'the nominal test-only function produced exactly its intended effect'
);

-- Keep this final: the deferred transition error is intentionally pending until
-- the surrounding pgTAP transaction rolls back.
select private.acquire_idempotency(
  'system:invalid_transition', 'update_profile',
  '80000000-0000-4000-8000-000000000001', repeat('a', 64), 1, 1
);
update private.idempotency_records
set state = 'payload_expired',
    outcome_code = 'profile_updated',
    completed_at = now(),
    payload_expired_at = outcome_expires_at,
    updated_at = outcome_expires_at
where actor_key = 'system:invalid_transition'
  and operation = 'update_profile'
  and request_id = '80000000-0000-4000-8000-000000000001';
select throws_ok(
  'set constraints private.idempotency_records_must_conclude immediate',
  '23514', 'IDEMPOTENCY_TRANSITION_INVALID',
  'executing_uncommitted cannot skip directly to payload_expired'
);

select * from finish();

rollback;
