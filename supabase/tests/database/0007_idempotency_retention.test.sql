begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------
-- created_at is backdated instead of faking the clock. The table ties
-- outcome_expires_at and record_expires_at to created_at by check constraint,
-- so a backdated row is exactly a row that aged, and the purge still reads the
-- real server clock.

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000301');

insert into public.profiles (id, auth_user_id, name) values
  ('dddddddd-0000-4000-8000-0000000003dd',
   '00000000-0000-4000-8000-000000000301', 'Duda');

insert into private.idempotency_records
  (actor_key, actor_id, operation, request_id, request_hash, hash_key_version,
   state, outcome_code, outcome, created_at, updated_at, completed_at,
   outcome_expires_at, record_expires_at, payload_expired_at)
values
  -- fresh: nothing is due
  ('profile:dddddddd-0000-4000-8000-0000000003dd',
   'dddddddd-0000-4000-8000-0000000003dd', 'update_profile',
   '70000000-0000-4000-8000-000000000001', repeat('a', 64), 1,
   'completed', 'profile_updated', '{"logical_result":"profile_updated"}',
   now(), now(), now(),
   now() + interval '30 days', now() + interval '24 months', null),
  -- one day short of the payload deadline
  ('profile:dddddddd-0000-4000-8000-0000000003dd',
   'dddddddd-0000-4000-8000-0000000003dd', 'update_profile',
   '70000000-0000-4000-8000-000000000002', repeat('b', 64), 1,
   'completed', 'profile_updated', '{"logical_result":"profile_updated"}',
   now() - interval '29 days', now() - interval '29 days', now() - interval '29 days',
   now() - interval '29 days' + interval '30 days',
   now() - interval '29 days' + interval '24 months', null),
  -- past the payload deadline, far from the tombstone deadline
  ('profile:dddddddd-0000-4000-8000-0000000003dd',
   'dddddddd-0000-4000-8000-0000000003dd', 'update_profile',
   '70000000-0000-4000-8000-000000000003', repeat('c', 64), 1,
   'completed', 'profile_updated', '{"logical_result":"profile_updated"}',
   now() - interval '31 days', now() - interval '31 days', now() - interval '31 days',
   now() - interval '31 days' + interval '30 days',
   now() - interval '31 days' + interval '24 months', null),
  -- already a tombstone, one day short of the record deadline
  ('profile:dddddddd-0000-4000-8000-0000000003dd',
   'dddddddd-0000-4000-8000-0000000003dd', 'accept_policies',
   '70000000-0000-4000-8000-000000000004', repeat('d', 64), 1,
   'payload_expired', 'policies_accepted', null,
   now() - interval '23 months', now() - interval '22 months',
   now() - interval '23 months',
   now() - interval '23 months' + interval '30 days',
   now() - interval '23 months' + interval '24 months',
   now() - interval '23 months' + interval '30 days'),
  -- past the record deadline: the tombstone itself is due
  ('profile:dddddddd-0000-4000-8000-0000000003dd',
   'dddddddd-0000-4000-8000-0000000003dd', 'revoke_current_session',
   '70000000-0000-4000-8000-000000000005', repeat('e', 64), 1,
   'payload_expired', 'session_revoked', null,
   now() - interval '25 months', now() - interval '24 months',
   now() - interval '25 months',
   now() - interval '25 months' + interval '30 days',
   now() - interval '25 months' + interval '24 months',
   now() - interval '25 months' + interval '30 days');

-- ---------------------------------------------------------------------------
-- Shape of the purge
-- ---------------------------------------------------------------------------

select has_function(
  'private', 'purge_expired_idempotency_outcomes', array[]::name[],
  'the idempotency retention policy exists as a function'
);
select ok(
  (select p.proconfig from pg_proc as p
   where p.oid = 'private.purge_expired_idempotency_outcomes()'::regprocedure)
    @> array['search_path=""'],
  'the purge pins an empty search_path'
);
select is(
  (select p.prosecdef from pg_proc as p
   where p.oid = 'private.purge_expired_idempotency_outcomes()'::regprocedure),
  false,
  'the purge is SECURITY INVOKER: it runs as whichever job is granted it'
);
select is(
  (select p.pronargs from pg_proc as p
   where p.oid = 'private.purge_expired_idempotency_outcomes()'::regprocedure),
  0::smallint,
  'the purge takes no clock argument, so no caller can erase a payload early'
);
select has_index(
  'private', 'idempotency_records', 'idempotency_records_outcome_expiry_idx',
  'the 30-day phase has its own access path'
);
select ok(
  not has_function_privilege(
    'anon', 'private.purge_expired_idempotency_outcomes()', 'execute'),
  'anon cannot run the purge'
);
select ok(
  not has_function_privilege(
    'authenticated', 'private.purge_expired_idempotency_outcomes()', 'execute'),
  'authenticated cannot run the purge'
);
select ok(
  not has_function_privilege(
    'service_role', 'private.purge_expired_idempotency_outcomes()', 'execute'),
  'the purge is not part of the nominal gateway allowlist'
);

-- ---------------------------------------------------------------------------
-- What one execution does
-- ---------------------------------------------------------------------------

select is(
  private.purge_expired_idempotency_outcomes(),
  '{"payload_expired":1,"tombstones_deleted":1}'::jsonb,
  'one execution expires exactly the due payload and drops exactly the due tombstone'
);

select is(
  (select state from private.idempotency_records
   where request_id = '70000000-0000-4000-8000-000000000003'),
  'payload_expired',
  'a record past 30 days becomes a payload-free tombstone'
);
select is(
  (select outcome from private.idempotency_records
   where request_id = '70000000-0000-4000-8000-000000000003'),
  null::jsonb,
  'the replay payload is physically erased, not blanked into an empty object'
);
select is(
  (select outcome_code from private.idempotency_records
   where request_id = '70000000-0000-4000-8000-000000000003'),
  'profile_updated',
  'the payload-free tombstone still records which effect happened'
);
select is(
  (select request_hash from private.idempotency_records
   where request_id = '70000000-0000-4000-8000-000000000003'),
  repeat('c', 64),
  'the HMAC survives the payload, because conflict detection outlives replay'
);
select ok(
  (select payload_expired_at is not null and payload_expired_at >= outcome_expires_at
   from private.idempotency_records
   where request_id = '70000000-0000-4000-8000-000000000003'),
  'the tombstone records when its payload was erased'
);

select is(
  (select state from private.idempotency_records
   where request_id = '70000000-0000-4000-8000-000000000002'),
  'completed',
  'a record one day short of 30 days keeps its payload'
);
select is(
  (select outcome from private.idempotency_records
   where request_id = '70000000-0000-4000-8000-000000000001'),
  '{"logical_result":"profile_updated"}'::jsonb,
  'a fresh record is untouched'
);
select is(
  (select count(*) from private.idempotency_records
   where request_id = '70000000-0000-4000-8000-000000000004'),
  1::bigint,
  'a tombstone one month short of 24 months is preserved'
);
select is(
  (select count(*) from private.idempotency_records
   where request_id = '70000000-0000-4000-8000-000000000005'),
  0::bigint,
  'a tombstone past 24 months is deleted'
);

-- ---------------------------------------------------------------------------
-- The evidence it leaves
-- ---------------------------------------------------------------------------

select is(
  (select policy from private.retention_runs order by id desc limit 1),
  'purge_expired_idempotency_outcomes',
  'the run is recorded under the policy name of docs/17 section 4'
);
select is(
  (select scanned from private.retention_runs order by id desc limit 1),
  2,
  'the run counts what it found due across both deadlines'
);
select is(
  (select purged from private.retention_runs order by id desc limit 1),
  2,
  'the run counts what it actually changed'
);
select is(
  (select failed from private.retention_runs order by id desc limit 1),
  0,
  'nothing failed'
);
select ok(
  (select finished_at is not null and finished_at >= started_at
   from private.retention_runs order by id desc limit 1),
  'the run records its duration'
);
select ok(
  (select window_start = window_end - interval '24 months'
   from private.retention_runs order by id desc limit 1),
  'the window spans the full horizon the policy governs'
);
select is(
  (select count(*)
   from private.retention_runs as run
   where run::text ~ '(dddddddd|70000000|profile_updated)'),
  0::bigint,
  'the retention evidence never names what it purged'
);

-- ---------------------------------------------------------------------------
-- Repeating the purge
-- ---------------------------------------------------------------------------

select is(
  private.purge_expired_idempotency_outcomes(),
  '{"payload_expired":0,"tombstones_deleted":0}'::jsonb,
  'running the purge again changes nothing'
);
select is(
  (select count(*) from private.retention_runs),
  2::bigint,
  'but it still leaves evidence that it ran'
);
select is(
  (select scanned from private.retention_runs order by id desc limit 1),
  0,
  'the second run found nothing due'
);

-- ---------------------------------------------------------------------------
-- What an expired key answers
-- ---------------------------------------------------------------------------
-- docs/13-contratos-funcoes.md section 0, rule 2: after the payload is gone the
-- retry gets IDEMPOTENCY_EXPIRED and never executes a second time.

select throws_ok(
  $$select * from private.acquire_idempotency(
      'profile:dddddddd-0000-4000-8000-0000000003dd', 'update_profile',
      '70000000-0000-4000-8000-000000000003', repeat('c', 64), 1, 1)$$,
  'P0001', 'IDEMPOTENCY_EXPIRED',
  'a retry against a payload-free tombstone is refused, not re-executed'
);
select throws_ok(
  $$select * from private.acquire_idempotency(
      'profile:dddddddd-0000-4000-8000-0000000003dd', 'update_profile',
      '70000000-0000-4000-8000-000000000003', repeat('9', 64), 1, 1)$$,
  'P0001', 'IDEMPOTENCY_CONFLICT',
  'the surviving HMAC still detects a divergent input after the payload is gone'
);
select is(
  (select acquired from private.acquire_idempotency(
    'profile:dddddddd-0000-4000-8000-0000000003dd', 'revoke_current_session',
    '70000000-0000-4000-8000-000000000005', repeat('e', 64), 1, 1)),
  true,
  'past 24 months the key is free again, which is why the tombstone lasts that long'
);
select private.complete_idempotency(
  'profile:dddddddd-0000-4000-8000-0000000003dd', 'revoke_current_session',
  '70000000-0000-4000-8000-000000000005', repeat('e', 64), 1, 1,
  ('{"logical_result":"session_revoked",'
   || '"session_id":"55555555-0000-4000-8000-000000000031",'
   || '"revoked_at":"2026-08-31T12:34:56.123456Z"}')::jsonb
);

select * from finish();

rollback;
