begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------
-- Both UUIDs below are version 7, the version migration 0004 rejected. The
-- profile one is the value docs/10-schema-db.md section 9.1 and
-- docs/13-contratos-funcoes.md section 5.7 use as their own worked example, so
-- the checks under test are confronted with the documents' own data.

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000901');

insert into public.profiles (id, auth_user_id, name) values
  ('01890f7e-e948-7c53-b13a-4a36e4b7d21e',
   '00000000-0000-4000-8000-000000000901', 'Vera');

select is(
  substring('01890f7e-e948-7c53-b13a-4a36e4b7d21e' from 15 for 1),
  '7',
  'the profile fixture really is a version 7 UUID, not a v4 in disguise'
);
select is(
  substring('0192a5c1-4f2b-7d8e-9abc-1a2b3c4d5e6f' from 15 for 1),
  '7',
  'and so is the session fixture'
);

-- ---------------------------------------------------------------------------
-- actor_key
-- ---------------------------------------------------------------------------

select is(
  (select acquired from private.acquire_idempotency(
    'profile:01890f7e-e948-7c53-b13a-4a36e4b7d21e', 'update_profile',
    '90000000-0000-4000-8000-000000000001', repeat('a', 64), 1, 1)),
  true,
  'a version 7 profile actor key is accepted'
);
select private.complete_idempotency(
  'profile:01890f7e-e948-7c53-b13a-4a36e4b7d21e', 'update_profile',
  '90000000-0000-4000-8000-000000000001', repeat('a', 64), 1, 1,
  '{"logical_result":"profile_updated"}'::jsonb
);
select is(
  (select actor_id from private.idempotency_records
   where request_id = '90000000-0000-4000-8000-000000000001'),
  '01890f7e-e948-7c53-b13a-4a36e4b7d21e'::uuid,
  'and it resolves to the profile it names'
);

-- The rule that survives is canonical lowercase, and it is still enforced.
select throws_ok(
  $$select * from private.acquire_idempotency(
      'profile:01890F7E-E948-7C53-B13A-4A36E4B7D21E', 'update_profile',
      '90000000-0000-4000-8000-000000000002', repeat('a', 64), 1, 1)$$,
  '22023', 'VALIDATION', 'an uppercase profile actor key is still rejected'
);
select throws_ok(
  $$select * from private.acquire_idempotency(
      'profile:01890f7e-e948-7c53-b13a-4a36e4b7d21', 'update_profile',
      '90000000-0000-4000-8000-000000000003', repeat('a', 64), 1, 1)$$,
  '22023', 'VALIDATION', 'a truncated profile actor key is still rejected'
);
select throws_ok(
  $$select * from private.acquire_idempotency(
      'profile:01890f7ee9487c53b13a4a36e4b7d21e', 'update_profile',
      '90000000-0000-4000-8000-000000000004', repeat('a', 64), 1, 1)$$,
  '22023', 'VALIDATION', 'an unhyphenated profile actor key is still rejected'
);

-- The table constraint, not only the helper that writes through it.
select has_index(
  'private', 'idempotency_records', 'idempotency_records_record_expiry_idx',
  'the table this constraint guards is otherwise untouched'
);
select is(
  (select count(*) from pg_constraint
   where conrelid = 'private.idempotency_records'::regclass
     and conname = 'idempotency_records_actor_key_namespace_check'),
  1::bigint,
  'the recreated namespace constraint is named instead of anonymous'
);
select throws_ok(
  $$insert into private.idempotency_records
      (actor_key, actor_id, operation, request_id, request_hash, hash_key_version)
    values ('profile:01890F7E-E948-7C53-B13A-4A36E4B7D21E',
            '01890f7e-e948-7c53-b13a-4a36e4b7d21e', 'update_profile',
            '90000000-0000-4000-8000-000000000005', repeat('a', 64), 1)$$,
  '23514', null, 'the table itself still refuses an uppercase actor key'
);
select throws_ok(
  $$insert into private.idempotency_records
      (actor_key, operation, request_id, request_hash, hash_key_version)
    values ('device:01890f7e-e948-7c53-b13a-4a36e4b7d21e', 'update_profile',
            '90000000-0000-4000-8000-000000000006', repeat('a', 64), 1)$$,
  '23514', null, 'and the namespace stays closed, which the relaxation must not widen'
);
select throws_ok(
  $$insert into private.idempotency_records
      (actor_key, operation, request_id, request_hash, hash_key_version)
    values ('system:profile_creator', 'complete_profile',
            '90000000-0000-4000-8000-000000000007', repeat('a', 64), 1)$$,
  '23514', null, 'complete_profile is still exclusive to the bootstrap namespace'
);

-- ---------------------------------------------------------------------------
-- profile_id in a complete_profile outcome
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select private.validate_idempotency_outcome(
      'complete_profile',
      '{"logical_result":"profile_created",
        "profile_id":"01890f7e-e948-7c53-b13a-4a36e4b7d21e"}'::jsonb)$$,
  'a version 7 profile_id is accepted in a complete_profile outcome'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'complete_profile',
      '{"logical_result":"profile_created",
        "profile_id":"01890F7E-E948-7C53-B13A-4A36E4B7D21E"}'::jsonb)$$,
  '22023', 'VALIDATION', 'an uppercase profile_id is still rejected'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'complete_profile',
      '{"logical_result":"profile_created","profile_id":"not-a-uuid"}'::jsonb)$$,
  '22023', 'VALIDATION', 'a malformed profile_id is still rejected'
);
-- Truncated and unhyphenated are the two shapes a mis-edited length quantifier
-- would let through, and this migration edited exactly that part of the regex.
-- Asserting them only on actor_key would leave the edit unproven here.
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'complete_profile',
      '{"logical_result":"profile_created",
        "profile_id":"01890f7e-e948-7c53-b13a-4a36e4b7d21"}'::jsonb)$$,
  '22023', 'VALIDATION', 'a truncated profile_id is still rejected'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'complete_profile',
      '{"logical_result":"profile_created",
        "profile_id":"01890f7ee9487c53b13a4a36e4b7d21e"}'::jsonb)$$,
  '22023', 'VALIDATION', 'an unhyphenated profile_id is still rejected'
);

-- The same value through the real bootstrap path, not only the validator.
select is(
  (select acquired from private.acquire_idempotency(
    'bootstrap:' || repeat('c', 64), 'complete_profile',
    '90000000-0000-4000-8000-000000000008', repeat('b', 64), 1, 1)),
  true,
  'the bootstrap key is acquired before the profile is known'
);
select lives_ok(
  $$select private.complete_idempotency(
      'bootstrap:' || repeat('c', 64), 'complete_profile',
      '90000000-0000-4000-8000-000000000008', repeat('b', 64), 1, 1,
      '{"logical_result":"profile_created",
        "profile_id":"01890f7e-e948-7c53-b13a-4a36e4b7d21e"}'::jsonb)$$,
  'and completion links it to a version 7 profile'
);
select is(
  (select resource_id from private.idempotency_records
   where request_id = '90000000-0000-4000-8000-000000000008'),
  '01890f7e-e948-7c53-b13a-4a36e4b7d21e'::uuid,
  'the tombstone records that profile as the resource it created'
);

-- ---------------------------------------------------------------------------
-- session_id in a revoke_current_session outcome
-- ---------------------------------------------------------------------------

select lives_ok(
  $$select private.validate_idempotency_outcome(
      'revoke_current_session',
      '{"logical_result":"session_revoked",
        "session_id":"0192a5c1-4f2b-7d8e-9abc-1a2b3c4d5e6f",
        "revoked_at":"2026-09-02T12:34:56.123456Z"}'::jsonb)$$,
  'a version 7 session_id is accepted in a revocation outcome'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'revoke_current_session',
      '{"logical_result":"session_revoked",
        "session_id":"0192A5C1-4F2B-7D8E-9ABC-1A2B3C4D5E6F",
        "revoked_at":"2026-09-02T12:34:56.123456Z"}'::jsonb)$$,
  '22023', 'VALIDATION', 'an uppercase session_id is still rejected'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'revoke_current_session',
      '{"logical_result":"session_revoked",
        "session_id":"0192a5c1-4f2b-7d8e-9abc-1a2b3c4d5e6",
        "revoked_at":"2026-09-02T12:34:56.123456Z"}'::jsonb)$$,
  '22023', 'VALIDATION', 'a truncated session_id is still rejected'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'revoke_current_session',
      '{"logical_result":"session_revoked",
        "session_id":"0192a5c14f2b7d8e9abc1a2b3c4d5e6f",
        "revoked_at":"2026-09-02T12:34:56.123456Z"}'::jsonb)$$,
  '22023', 'VALIDATION', 'an unhyphenated session_id is still rejected'
);
select throws_ok(
  $$select private.validate_idempotency_outcome(
      'revoke_current_session',
      '{"logical_result":"session_revoked",
        "session_id":"not-a-uuid",
        "revoked_at":"2026-09-02T12:34:56.123456Z"}'::jsonb)$$,
  '22023', 'VALIDATION', 'a malformed session_id is still rejected'
);

-- End to end, through the RPC. This is the call that failed before 0009: no
-- document declares which UUID version GoTrue mints, so a v7 session_id was a
-- perfectly ordinary token that could not log itself out.
select is(
  public.revoke_current_session(
    '00000000-0000-4000-8000-000000000901', '0192a5c1-4f2b-7d8e-9abc-1a2b3c4d5e6f',
    '90000000-0000-4000-8000-000000000009', repeat('d', 64), 1, 1)
    -> 'outcome' ->> 'logical_result',
  'session_revoked',
  'a session whose id is a version 7 UUID can revoke itself'
);
select is(
  (select count(*) from private.revoked_auth_sessions
   where session_id = '0192a5c1-4f2b-7d8e-9abc-1a2b3c4d5e6f'),
  1::bigint,
  'and the denylist really holds it'
);

-- ---------------------------------------------------------------------------
-- Replacing the functions changed nothing else
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE preserves the ACL, but preserving it is the claim, so it is
-- asserted rather than assumed.

select ok(
  not has_function_privilege(
    'service_role', 'private.validate_idempotency_outcome(text,jsonb)', 'execute'),
  'the replaced validator is still unreachable by the administrative role'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'private.acquire_idempotency(text,text,uuid,text,integer,integer)', 'execute'),
  'the replaced acquire helper is still unreachable by a client role'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.complete_idempotency(text,text,uuid,text,integer,integer,jsonb)', 'execute'),
  'the replaced completion helper is still unreachable by the administrative role'
);
select is(
  (select count(*) from pg_proc as p
   where p.oid in (
     'private.validate_idempotency_outcome(text,jsonb)'::regprocedure,
     'private.acquire_idempotency(text,text,uuid,text,integer,integer)'::regprocedure,
     'private.complete_idempotency(text,text,uuid,text,integer,integer,jsonb)'::regprocedure)
     and p.proconfig @> array['search_path=""']
     and not p.prosecdef),
  3::bigint,
  'all three stay SECURITY INVOKER with an empty search_path'
);

select * from finish();

rollback;
