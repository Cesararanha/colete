begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000101');

insert into public.profiles (id, auth_user_id, name) values
  ('aaaaaaaa-0000-4000-8000-0000000001aa',
   '00000000-0000-4000-8000-000000000101', 'Ana');

-- ---------------------------------------------------------------------------
-- Where the operational tables live
-- ---------------------------------------------------------------------------

select has_table('private', 'external_effects', 'the external effect outbox exists');
select has_table('private', 'job_runs', 'the job run log exists');
select has_table('private', 'retention_runs', 'the retention run log exists');
select hasnt_table('public', 'external_effects', 'the outbox is not exposed in public');
select hasnt_table('public', 'job_runs', 'job runs are not exposed in public');
select hasnt_table('public', 'retention_runs', 'retention runs are not exposed in public');

-- docs/14-convencoes-app.md section 5.2. These are service tables: no client
-- role reads them, so the boundary is schema privilege, not RLS. force RLS with
-- zero policies would make a future owner without BYPASSRLS read zero rows.
select ok(
  not (select relrowsecurity from pg_class where oid = 'private.external_effects'::regclass),
  'the outbox deliberately has no RLS'
);
select ok(
  not (select relrowsecurity from pg_class where oid = 'private.job_runs'::regclass),
  'the job run log deliberately has no RLS'
);
select ok(
  not (select relrowsecurity from pg_class where oid = 'private.retention_runs'::regclass),
  'the retention run log deliberately has no RLS'
);
select is(
  (select count(*) from pg_policies
   where schemaname = 'private'
     and tablename in ('external_effects', 'job_runs', 'retention_runs')),
  0::bigint,
  'no policy pretends to protect a table no client can reach'
);

-- ---------------------------------------------------------------------------
-- The new tables are born without privilege
-- ---------------------------------------------------------------------------
-- This slice does not repeat the revocations of 0004. It proves that the
-- ALTER DEFAULT PRIVILEGES of 0001 and 0004 already covered tables that did not
-- exist when they ran.

select is(
  (select count(*)
   from information_schema.role_table_grants
   where table_schema = 'private'
     and table_name in ('external_effects', 'job_runs', 'retention_runs')
     and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')),
  0::bigint,
  'no client or administrative role holds any privilege on the new tables'
);
select ok(
  not has_table_privilege('anon', 'private.job_runs', 'select'),
  'anon cannot read job runs'
);
select ok(
  not has_table_privilege('authenticated', 'private.job_runs', 'select'),
  'authenticated cannot read job runs'
);
select ok(
  not has_table_privilege('service_role', 'private.job_runs', 'select'),
  'service_role cannot read job runs'
);
select ok(
  not has_table_privilege('service_role', 'private.external_effects', 'insert'),
  'service_role cannot queue an external effect directly'
);
select ok(
  not has_table_privilege('service_role', 'private.retention_runs', 'insert'),
  'service_role cannot fabricate retention evidence'
);
select ok(
  not has_function_privilege('service_role', 'private.validate_job_summary(jsonb)', 'execute'),
  'service_role cannot execute the summary validator'
);
select ok(
  not has_function_privilege('anon', 'private.validate_job_summary(jsonb)', 'execute'),
  'anon cannot execute the summary validator'
);

set local role service_role;
select throws_ok(
  'select * from private.job_runs',
  '42501', null, 'service_role cannot SELECT the job run log'
);
select throws_ok(
  'select * from private.external_effects',
  '42501', null, 'service_role cannot SELECT the external effect outbox'
);
select throws_ok(
  'select * from private.retention_runs',
  '42501', null, 'service_role cannot SELECT the retention run log'
);
reset role;

set local role authenticated;
select throws_ok(
  'select * from private.job_runs',
  '42501', null, 'an authenticated client cannot SELECT the job run log'
);
reset role;

-- ---------------------------------------------------------------------------
-- External effects
-- ---------------------------------------------------------------------------

select col_is_pk('private', 'external_effects', 'id', 'the effect has a surrogate key');
select col_is_unique(
  'private', 'external_effects', 'dedupe_key',
  'the dedupe key is what makes a retried saga idempotent'
);
select col_not_null(
  'private', 'external_effects', 'dedupe_key', 'an effect without a dedupe key cannot exist'
);
select col_default_is(
  'private', 'external_effects', 'status', 'pending', 'an effect starts pending'
);
select col_default_is(
  'private', 'external_effects', 'attempts', '0', 'an effect starts with no attempt'
);

select lives_ok(
  $$insert into private.external_effects
      (kind, resource_type, resource_id, dedupe_key)
    values ('delete_auth_user', 'profile',
            'aaaaaaaa-0000-4000-8000-0000000001aa',
            'delete_auth_user:aaaaaaaa-0000-4000-8000-0000000001aa')$$,
  'a pending effect is queued with its dedupe key'
);
select throws_ok(
  $$insert into private.external_effects
      (kind, resource_type, resource_id, dedupe_key)
    values ('delete_auth_user', 'profile',
            'aaaaaaaa-0000-4000-8000-0000000001aa',
            'delete_auth_user:aaaaaaaa-0000-4000-8000-0000000001aa')$$,
  '23505', null, 'the same intent cannot be queued twice'
);
select throws_ok(
  $$insert into private.external_effects
      (kind, resource_type, resource_id, dedupe_key)
    values ('send_email', 'profile',
            'aaaaaaaa-0000-4000-8000-0000000001aa', 'send_email:1')$$,
  '23514', null, 'the effect vocabulary is closed to the five sagas of section 9'
);
select throws_ok(
  $$insert into private.external_effects
      (kind, resource_type, resource_id, dedupe_key, status)
    values ('purge_proof_object', 'payment_proof',
            'aaaaaaaa-0000-4000-8000-0000000001aa', 'purge:1', 'succeeded')$$,
  '23514', null, 'a terminal effect cannot exist without a completion time'
);
select throws_ok(
  $$insert into private.external_effects
      (kind, resource_type, resource_id, dedupe_key, completed_at)
    values ('purge_proof_object', 'payment_proof',
            'aaaaaaaa-0000-4000-8000-0000000001aa', 'purge:2', now())$$,
  '23514', null, 'a pending effect cannot claim it already finished'
);
select throws_ok(
  $$insert into private.external_effects
      (kind, resource_type, resource_id, dedupe_key, attempts)
    values ('purge_proof_object', 'payment_proof',
            'aaaaaaaa-0000-4000-8000-0000000001aa', 'purge:3', -1)$$,
  '23514', null, 'an attempt counter never goes negative'
);
select throws_ok(
  $$insert into private.external_effects
      (kind, resource_type, resource_id, dedupe_key, status, completed_at, last_error_code)
    values ('purge_proof_object', 'payment_proof',
            'aaaaaaaa-0000-4000-8000-0000000001aa', 'purge:4', 'dead', now(),
            'https://storage.example/proofs/secret-path')$$,
  '23514', null, 'the error column takes a normalized code, never a URL or a path'
);
select lives_ok(
  $$insert into private.external_effects
      (kind, resource_type, resource_id, dedupe_key, status, attempts,
       last_error_code, completed_at)
    values ('delete_storage_object', 'payment_proof',
            'aaaaaaaa-0000-4000-8000-0000000001aa', 'delete_storage_object:1',
            'dead', 6, 'STORAGE_UNAVAILABLE', now())$$,
  'a dead-lettered effect keeps its normalized code and completion time'
);

-- ---------------------------------------------------------------------------
-- Job runs
-- ---------------------------------------------------------------------------

select col_is_unique(
  'private', 'job_runs', 'run_key',
  'a repeated cron slot or human request is a no-op, not a second run'
);
select is(
  (select count(*)
   from pg_constraint
   where conrelid = 'private.job_runs'::regclass
     and contype = 'f'
     and 'match_id' = any (
       select attname from pg_attribute
       where attrelid = 'private.job_runs'::regclass and attnum = any (conkey))),
  0::bigint,
  'match_id carries no foreign key yet, because public.matches does not exist'
);
select col_type_is(
  'private', 'job_runs', 'match_id', 'uuid',
  'match_id is already the right type for the future constraint'
);
select ok(
  (select attnotnull = false from pg_attribute
   where attrelid = 'private.job_runs'::regclass and attname = 'match_id'),
  'match_id is nullable while matches is missing'
);
select fk_ok(
  'private', 'job_runs', 'requested_by',
  'public', 'profiles', 'id',
  'a human-triggered run points at the profile that asked for it'
);
select is(
  (select c.confdeltype
   from pg_constraint as c
   where c.conname = 'job_runs_requested_by_fkey'
     and c.conrelid = 'private.job_runs'::regclass),
  'r'::"char",
  'deleting a profile never erases the record that it triggered a run'
);

select lives_ok(
  $$insert into private.job_runs
      (run_key, job_name, triggered_by, scheduled_for, status)
    values ('cron:purge_idempotency_outcomes:2026-08-31T03:00:00Z',
            'purge_idempotency_outcomes', 'cron', now(), 'running')$$,
  'a cron slot opens a running job'
);
select is(
  (select summary from private.job_runs
   where run_key = 'cron:purge_idempotency_outcomes:2026-08-31T03:00:00Z'),
  '{"scanned":0,"changed":0,"skipped":0,"failed":0,"stale":0,"duration_ms":0}'::jsonb,
  'a run starts from the closed zeroed counter shape'
);
select lives_ok(
  $$insert into private.job_runs
      (run_key, job_name, triggered_by, requested_by, scheduled_for, status,
       finished_at, summary)
    values ('request:11111111-0000-4000-8000-000000000001',
            'reconcile_match', 'organizer',
            'aaaaaaaa-0000-4000-8000-0000000001aa', now(), 'succeeded', now(),
            '{"scanned":3,"changed":1,"skipped":2,"failed":0,"stale":0,"duration_ms":42}')$$,
  'a human reconciliation records the profile that requested it'
);
select throws_ok(
  $$insert into private.job_runs
      (run_key, job_name, triggered_by, scheduled_for, status)
    values ('cron:purge_idempotency_outcomes:2026-08-31T03:00:00Z',
            'purge_idempotency_outcomes', 'cron', now(), 'running')$$,
  '23505', null, 'the same cron slot cannot run twice'
);
select throws_ok(
  $$insert into private.job_runs
      (run_key, job_name, triggered_by, scheduled_for, status)
    values ('purge_idempotency_outcomes', 'purge_idempotency_outcomes',
            'cron', now(), 'running')$$,
  '23514', null, 'a run key states whether it came from a cron slot or a request'
);
select throws_ok(
  $$insert into private.job_runs
      (run_key, job_name, triggered_by, scheduled_for, status)
    values ('request:not-a-uuid', 'reconcile_match', 'system', now(), 'running')$$,
  '23514', null, 'a request run key carries a canonical UUID'
);
select throws_ok(
  $$insert into private.job_runs
      (run_key, job_name, triggered_by, scheduled_for, status)
    values ('cron:health_check_jobs:1', 'health_check_jobs', 'organizer', now(), 'running')$$,
  '23514', null, 'an organizer-triggered run has to name who requested it'
);
select throws_ok(
  $$insert into private.job_runs
      (run_key, job_name, triggered_by, requested_by, scheduled_for, status)
    values ('cron:health_check_jobs:2', 'health_check_jobs', 'cron',
            'aaaaaaaa-0000-4000-8000-0000000001aa', now(), 'running')$$,
  '23514', null, 'a cron run has no human requester'
);
select throws_ok(
  $$insert into private.job_runs
      (run_key, job_name, triggered_by, scheduled_for, status, finished_at)
    values ('cron:health_check_jobs:3', 'health_check_jobs', 'cron', now(),
            'running', now())$$,
  '23514', null, 'a running job has not finished'
);
select throws_ok(
  $$insert into private.job_runs
      (run_key, job_name, triggered_by, scheduled_for, status)
    values ('cron:health_check_jobs:4', 'health_check_jobs', 'cron', now(), 'succeeded')$$,
  '23514', null, 'a finished job records when it finished'
);
select throws_ok(
  $$insert into private.job_runs
      (run_key, job_name, triggered_by, scheduled_for, status, finished_at, error_code)
    values ('cron:health_check_jobs:5', 'health_check_jobs', 'cron', now(),
            'succeeded', now(), 'TIMEOUT')$$,
  '23514', null, 'only a failed run carries an error code'
);
select throws_ok(
  $$insert into private.job_runs
      (run_key, job_name, triggered_by, scheduled_for, status)
    values ('cron:Health_Check:6', 'Health_Check', 'cron', now(), 'running')$$,
  '23514', null, 'job names use the closed lower_snake_case grammar'
);

-- ---------------------------------------------------------------------------
-- The closed summary shape
-- ---------------------------------------------------------------------------

select has_function(
  'private', 'validate_job_summary', array['jsonb']::name[],
  'the job summary validator exists'
);
select ok(
  (select p.proconfig from pg_proc as p
   where p.oid = 'private.validate_job_summary(jsonb)'::regprocedure)
    @> array['search_path=""'],
  'the summary validator pins an empty search_path'
);
select has_trigger(
  'private', 'job_runs', 'job_runs_validate_summary',
  'the summary validator is wired to the table, not left to callers'
);

select lives_ok(
  $$select private.validate_job_summary(
      '{"scanned":10,"changed":4,"skipped":6,"failed":0,"stale":0,"duration_ms":1200}'::jsonb)$$,
  'the six counters are the accepted shape'
);
select lives_ok(
  $$select private.validate_job_summary(
      '{"scanned":10,"changed":4,"skipped":6,"failed":0,"stale":0,"duration_ms":1200,
        "cursor":"opaque-page-token"}'::jsonb)$$,
  'an opaque cursor is the only optional key'
);
select throws_ok(
  $$select private.validate_job_summary(
      '{"scanned":1,"changed":0,"skipped":0,"failed":0,"stale":0,"duration_ms":0,
        "profile_ids":["aaaaaaaa-0000-4000-8000-0000000001aa"]}'::jsonb)$$,
  '22023', 'VALIDATION', 'a job summary never carries a list of personal identifiers'
);
select throws_ok(
  $$select private.validate_job_summary(
      '{"scanned":1,"changed":0,"skipped":0,"failed":0,"stale":0}'::jsonb)$$,
  '22023', 'VALIDATION', 'a counter cannot be omitted'
);
select throws_ok(
  $$select private.validate_job_summary(
      '{"scanned":-1,"changed":0,"skipped":0,"failed":0,"stale":0,"duration_ms":0}'::jsonb)$$,
  '22023', 'VALIDATION', 'counters are non-negative'
);
select throws_ok(
  $$select private.validate_job_summary(
      '{"scanned":1.5,"changed":0,"skipped":0,"failed":0,"stale":0,"duration_ms":0}'::jsonb)$$,
  '22023', 'VALIDATION', 'counters are integers, never floats'
);
select throws_ok(
  $$select private.validate_job_summary(
      '{"scanned":"1","changed":0,"skipped":0,"failed":0,"stale":0,"duration_ms":0}'::jsonb)$$,
  '22023', 'VALIDATION', 'a counter is a JSON number, not a string'
);
select throws_ok(
  $$select private.validate_job_summary(
      '{"scanned":1,"changed":0,"skipped":0,"failed":0,"stale":0,"duration_ms":0,"cursor":7}'::jsonb)$$,
  '22023', 'VALIDATION', 'the cursor is an opaque string'
);
select throws_ok(
  $$select private.validate_job_summary(
      ('{"scanned":1,"changed":0,"skipped":0,"failed":0,"stale":0,"duration_ms":0,"cursor":"'
       || repeat('x', 201) || '"}')::jsonb)$$,
  '22023', 'VALIDATION', 'the cursor has an explicit maximum size'
);
select throws_ok(
  $$select private.validate_job_summary('[]'::jsonb)$$,
  '22023', 'VALIDATION', 'a summary is an object'
);

select throws_ok(
  $$insert into private.job_runs
      (run_key, job_name, triggered_by, scheduled_for, status, summary)
    values ('cron:apply_retention:7', 'apply_retention', 'cron', now(), 'running',
            '{"scanned":1,"changed":0,"skipped":0,"failed":0,"stale":0,"duration_ms":0,
              "match_ids":["aaaaaaaa-0000-4000-8000-0000000001aa"]}')$$,
  '22023', 'VALIDATION', 'the trigger rejects an unknown summary key on insert'
);
select throws_ok(
  $$update private.job_runs
       set summary = '{"scanned":1,"changed":0,"skipped":0,"failed":0,"stale":0,
                       "duration_ms":0,"note":"free text"}'
     where run_key = 'cron:purge_idempotency_outcomes:2026-08-31T03:00:00Z'$$,
  '22023', 'VALIDATION', 'the trigger rejects an unknown summary key on update'
);

-- ---------------------------------------------------------------------------
-- Retention runs
-- ---------------------------------------------------------------------------

select lives_ok(
  $$insert into private.retention_runs
      (policy, window_start, window_end, scanned, purged, failed, finished_at)
    values ('purge_expired_idempotency_outcomes',
            now() - interval '1 day', now(), 20, 18, 2, now())$$,
  'a retention run records policy, window, counts and duration'
);
select throws_ok(
  $$insert into private.retention_runs
      (policy, window_start, window_end, scanned, purged, failed)
    values ('purge_expired_idempotency_outcomes', now(), now() - interval '1 day', 0, 0, 0)$$,
  '23514', null, 'a retention window cannot end before it starts'
);
select throws_ok(
  $$insert into private.retention_runs
      (policy, window_start, window_end, scanned, purged, failed)
    values ('purge_expired_idempotency_outcomes',
            now() - interval '1 day', now(), 1, 2, 0)$$,
  '23514', null, 'a run cannot purge more than it scanned'
);
select throws_ok(
  $$insert into private.retention_runs
      (policy, window_start, window_end, scanned, purged, failed)
    values ('purge_expired_idempotency_outcomes',
            now() - interval '1 day', now(), 1, 0, -1)$$,
  '23514', null, 'a failure counter never goes negative'
);
select is(
  (select count(*)
   from information_schema.columns
   where table_schema = 'private'
     and table_name = 'retention_runs'
     and column_name in ('subject_id', 'profile_id', 'record_id', 'purged_ids')),
  0::bigint,
  'retention evidence never names the subjects it purged'
);

-- ---------------------------------------------------------------------------
-- Census of JSON columns, per docs/17-mapa-dados-lgpd.md section 3
-- ---------------------------------------------------------------------------
-- A new json or jsonb column anywhere in the application schemas fails here
-- until it is classified in the map and given a registered validator.

select set_eq(
  $$select c.table_schema || '.' || c.table_name || '.' || c.column_name
      from information_schema.columns as c
      join pg_class as t
        on t.relname = c.table_name
       and t.relnamespace = c.table_schema::regnamespace
     where c.table_schema in ('public', 'private')
       and c.data_type in ('json', 'jsonb')
       and t.relkind = 'r'$$,
  $$select * from (values
      ('private.idempotency_records.outcome'::text),
      ('private.job_runs.summary')) as classified(name)$$,
  'every JSON column of the application schemas is classified in docs/17 section 3'
);
select has_function(
  'private', 'validate_idempotency_outcome', array['text', 'jsonb']::name[],
  'idempotency_records.outcome has its registered validator'
);
select has_function(
  'private', 'validate_job_summary', array['jsonb']::name[],
  'job_runs.summary has its registered validator'
);

select * from finish();

rollback;
