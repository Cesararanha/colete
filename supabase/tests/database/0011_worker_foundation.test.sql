begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ---------------------------------------------------------------------------
-- Extensions, calibrations and private-table boundary
-- ---------------------------------------------------------------------------

select has_extension('pg_cron', 'pg_cron is installed by the worker migration');
select has_extension('pg_net', 'pg_net is installed by the worker migration');
select is(
  (select extnamespace::regnamespace::text from pg_extension where extname = 'pg_cron'),
  'pg_catalog',
  'pg_cron uses the platform schema expected by the local and hosted stacks'
);
select is(
  (select extnamespace::regnamespace::text from pg_extension where extname = 'pg_net'),
  'extensions',
  'pg_net uses the existing extensions schema'
);

select set_eq(
  $$select limit_key || ':' || limit_value || ':' || unit
      from private.app_limits
     where limit_key in (
       'external_effect_lease_seconds', 'worker_soft_deadline_seconds',
       'external_effect_max_attempts', 'external_effect_backoff_base_seconds',
       'external_effect_backoff_cap_seconds', 'worker_max_effects_per_invocation')$$,
  $$select * from (values
      ('external_effect_lease_seconds:180:seconds'::text),
      ('worker_soft_deadline_seconds:120:seconds'),
      ('external_effect_max_attempts:8:attempts'),
      ('external_effect_backoff_base_seconds:60:seconds'),
      ('external_effect_backoff_cap_seconds:3600:seconds'),
      ('worker_max_effects_per_invocation:10:effects')) as expected(value)$$,
  'all six worker calibrations and their units are exact'
);
select lives_ok(
  $$insert into private.app_limits (limit_key, limit_value, unit, notes)
    values ('effect_unit_probe', 1, 'effects', 'rolled back with pgTAP')$$,
  'effects extends the closed app-limit unit vocabulary'
);

select has_column('private', 'external_effects', 'lease_token', 'effects carry a fencing token');
select col_type_is('private', 'external_effects', 'lease_token', 'uuid', 'the fencing token is a UUID');
select ok(
  not (select relrowsecurity from pg_class where oid = 'private.external_effects'::regclass),
  'the private service table still deliberately has no RLS'
);
select is(
  (select count(*) from pg_policies
   where schemaname = 'private' and tablename in ('external_effects', 'job_runs')),
  0::bigint,
  'no policy pretends to protect the worker service tables'
);
select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'private'
     and table_name in ('external_effects', 'job_runs', 'retention_runs')
     and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')),
  0::bigint,
  'the existing private tables stay grant-free after the worker RPCs are added'
);

-- ---------------------------------------------------------------------------
-- Closed state machine and deterministic backoff
-- ---------------------------------------------------------------------------

select throws_ok(
  $$insert into private.external_effects
      (kind, resource_type, resource_id, dedupe_key, status, attempts, lease_until)
    values ('delete_auth_user', 'profile', gen_random_uuid(), 'invalid:lease-without-token',
            'leased', 1, now() + interval '3 minutes')$$,
  '23514', null, 'a lease cannot exist without its fencing token'
);
select throws_ok(
  $$insert into private.external_effects
      (kind, resource_type, resource_id, dedupe_key, status, attempts,
       lease_token, lease_until, completed_at)
    values ('delete_auth_user', 'profile', gen_random_uuid(), 'invalid:leased-completed',
            'leased', 1, gen_random_uuid(), now() + interval '3 minutes', now())$$,
  '23514', null, 'a leased attempt cannot claim terminal completion'
);
select throws_ok(
  $$insert into private.external_effects
      (kind, resource_type, resource_id, dedupe_key, status, attempts,
       next_attempt_at, last_error_code)
    values ('delete_auth_user', 'profile', gen_random_uuid(), 'invalid:eighth-retry',
            'failed_retryable', 8, now(), 'TEMPORARY')$$,
  '23514', null, 'an eighth failed attempt cannot remain retryable'
);
select throws_ok(
  $$insert into private.external_effects
      (kind, resource_type, resource_id, dedupe_key, status, attempts,
       last_error_code, completed_at)
    values ('delete_auth_user', 'profile', gen_random_uuid(), 'invalid:success-error',
            'succeeded', 1, 'STALE_ERROR', now())$$,
  '23514', null, 'success cannot carry stale retry metadata'
);

select has_function(
  'private', 'external_effect_backoff_seconds', array['uuid', 'integer']::name[],
  'the deterministic equal-jitter helper exists'
);
select is(
  private.external_effect_backoff_seconds(
    '10000000-0000-4000-8000-000000000001', 1),
  private.external_effect_backoff_seconds(
    '10000000-0000-4000-8000-000000000001', 1),
  'the same effect and attempt always produce the same jitter'
);
select ok(
  private.external_effect_backoff_seconds(
    '10000000-0000-4000-8000-000000000001', 1) between 30 and 60,
  'attempt one stays in the inclusive 50%-100% equal-jitter window'
);
select ok(
  private.external_effect_backoff_seconds(
    '10000000-0000-4000-8000-000000000001', 7) between 1800 and 3600,
  'attempt seven applies the 3600-second raw cap before jitter'
);

-- ---------------------------------------------------------------------------
-- Acquisition remains idle without a published handler
-- ---------------------------------------------------------------------------

insert into private.external_effects
  (id, kind, resource_type, resource_id, dedupe_key)
values
  ('11000000-0000-4000-8000-000000000001', 'delete_auth_user', 'profile',
   '12000000-0000-4000-8000-000000000001', 'worker-test:idle');

select is(
  public.worker_acquire_external_effect(array[]::text[]),
  null::jsonb,
  '0011 acquires no effect while the runtime publishes no handler'
);
select is(
  (select status from private.external_effects where dedupe_key = 'worker-test:idle'),
  'pending',
  'the unhandled effect remains pending rather than being falsely consumed'
);
select throws_ok(
  $$select public.worker_acquire_external_effect(array['delete_auth_user','delete_auth_user'])$$,
  '22023', 'VALIDATION', 'the supported-handler list rejects duplicates'
);
select throws_ok(
  $$select public.worker_acquire_external_effect(array['send_email'])$$,
  '22023', 'VALIDATION', 'the supported-handler list rejects an unknown kind'
);

select ok(
  (public.worker_acquire_external_effect(array['delete_auth_user']) ->> 'lease_token')::uuid
    is not null,
  'a published test handler acquires the pending effect with a token'
);
select is(
  (select status || ':' || attempts from private.external_effects
   where dedupe_key = 'worker-test:idle'),
  'leased:1',
  'acquisition changes state and increments the attempt atomically'
);
select throws_ok(
  $$select public.worker_complete_external_effect(
      '11000000-0000-4000-8000-000000000001',
      '13000000-0000-4000-8000-000000000001',
      'succeeded', null)$$,
  'P0001', 'CONCURRENT_CHANGE', 'a token other than the active fencing token cannot complete'
);
select lives_ok(
  $$select public.worker_complete_external_effect(
      '11000000-0000-4000-8000-000000000001',
      (select lease_token from private.external_effects where dedupe_key = 'worker-test:idle'),
      'succeeded', null)$$,
  'the live fencing token completes its own lease'
);
select is(
  (select status from private.external_effects where dedupe_key = 'worker-test:idle'),
  'succeeded',
  'successful completion reaches the exact terminal state'
);

-- ---------------------------------------------------------------------------
-- Job lifecycle, wrappers and server-derived slots
-- ---------------------------------------------------------------------------

select has_function('public', 'worker_begin_job', array['text']::name[], 'the job-begin RPC exists');
select has_function(
  'public', 'worker_execute_database_job', array['bigint']::name[],
  'the identity-retention wrapper exists'
);
select has_function(
  'public', 'worker_finish_job', array['bigint','text','jsonb','text']::name[],
  'the job completion RPC exists'
);
select is(
  private.worker_job_slot('health_check_jobs', '2026-09-07 12:14:59+00'),
  '2026-09-07 12:10:00+00'::timestamptz,
  'the database derives the five-minute UTC slot'
);
select is(
  private.worker_job_slot('purge_expired_revoked_sessions', '2026-09-07 12:16:59+00'),
  '2026-09-07 11:17:00+00'::timestamptz,
  'the hourly slot is the latest scheduled minute 17, never a caller instant'
);
select is(
  private.worker_job_slot('purge_expired_idempotency_outcomes', '2026-09-07 02:00:00+00'),
  '2026-09-06 03:23:00+00'::timestamptz,
  'the daily slot is the latest 03:23 UTC occurrence'
);
select ok(
  (public.worker_begin_job('expire_data_exports') ->> 'acquired')::boolean,
  'the export slice publishes its hourly job'
);

create temporary table worker_run_ids (kind text primary key, id bigint not null);
insert into worker_run_ids
select 'retention', (public.worker_begin_job('purge_expired_revoked_sessions') ->> 'run_id')::bigint;
select ok(
  (select id is not null from worker_run_ids where kind = 'retention'),
  'the first call owns the server-derived cron slot'
);
select lives_ok(
  $$select public.worker_finish_job(
      (select id from worker_run_ids where kind = 'retention'),
      'succeeded',
      public.worker_execute_database_job(
        (select id from worker_run_ids where kind = 'retention')),
      null)$$,
  'the database retention wrapper and worker completion close one run'
);
select is(
  (select status from private.job_runs
   where id = (select id from worker_run_ids where kind = 'retention')),
  'succeeded',
  'a completed run is observably terminal'
);
select is(
  public.worker_begin_job('purge_expired_revoked_sessions') ->> 'acquired',
  'false',
  'a duplicate wake-up in the same slot is a no-op'
);

create temporary table abandoned_run_id (id bigint primary key);
with inserted as (
  insert into private.job_runs
    (run_key, job_name, triggered_by, scheduled_for, started_at, status)
  values
    ('cron:process_external_effects:2000-01-01T00:00:00Z',
     'process_external_effects', 'cron', '2000-01-01', '2000-01-01', 'running')
  returning id
)
insert into abandoned_run_id select id from inserted;
select ok(
  (public.worker_begin_job('process_external_effects') ->> 'acquired')::boolean,
  'the current slot starts after seeing the abandoned older run'
);
select is(
  (select status || ':' || error_code from private.job_runs
   where id = (select id from abandoned_run_id)),
  'failed:RUN_ABANDONED',
  'the next slot marks the old run failed rather than inventing success'
);
select throws_ok(
  $$select public.worker_finish_job(
      (select id from abandoned_run_id), 'succeeded',
      '{"scanned":0,"changed":0,"skipped":0,"failed":0,"stale":0,"duration_ms":0}',
      null)$$,
  'P0001', 'CONCURRENT_CHANGE', 'an abandoned run can never be rewritten as success'
);

-- ---------------------------------------------------------------------------
-- Versioned cron catalogue and secret boundary
-- ---------------------------------------------------------------------------

select set_eq(
  $$select jobname || ':' || schedule from cron.job where jobname like 'colete_v1_%'$$,
  $$select * from (values
      ('colete_v1_process_external_effects:* * * * *'::text),
      ('colete_v1_health_check_jobs:*/5 * * * *'),
      ('colete_v1_purge_expired_revoked_sessions:17 * * * *'),
      ('colete_v1_purge_expired_idempotency_outcomes:23 3 * * *'),
      ('colete_v1_purge_completed_deletion_requests:43 3 * * *'),
      ('colete_v1_expire_data_exports:7 * * * *'),
      ('colete_v1_purge_removed_memberships:53 3 * * *'),
      ('colete_v1_purge_invite_rate_limits:* * * * *'),
      ('colete_v1_purge_terminal_group_invites:53 3 * * *'),
      ('colete_v1_reclaim_photo_uploads:*/5 * * * *'),
      ('colete_v1_purge_ratings:53 3 * * *')) as expected(value)$$,
  'the eleven schedules are exact and versioned'
);
select is(
  (select count(*) from cron.job
   where jobname like 'colete_v1_%'
     and command !~ $$^select private[.]invoke_worker_cron[(]'[a-z_]+'[)];$$),
  0::bigint,
  'cron commands carry only the closed job name and no effect or subject identifier'
);
select is(
  (select count(*) from cron.job
   where jobname like 'colete_v1_%'
     and command ~* '(https?://|apikey|authorization|bearer|secret|token)'),
  0::bigint,
  'cron rows contain no URL, key, token or secret value'
);
select throws_ok(
  $$select private.invoke_worker_cron('process_external_effects')$$,
  'P0001', 'WORKER_CONFIGURATION_MISSING',
  'missing named Vault configuration fails closed before any HTTP request'
);

-- ---------------------------------------------------------------------------
-- Nominal grants only; service_role still cannot do direct DML
-- ---------------------------------------------------------------------------

select ok(
  not has_schema_privilege('service_role', 'private', 'usage'),
  'service_role still cannot enter private'
);
select is(
  (select count(*) from information_schema.routine_privileges
   where grantee = 'service_role' and specific_schema = 'public'
     and routine_name like 'worker_%'),
  9::bigint,
  'the worker receives exactly nine nominal public RPC grants'
);
select is(
  (select count(*) from information_schema.routine_privileges
   where grantee in ('PUBLIC', 'anon', 'authenticated')
     and specific_schema = 'public' and routine_name like 'worker_%'),
  0::bigint,
  'no client role can execute a worker RPC'
);
select ok(
  not has_function_privilege(
    'service_role', 'private.invoke_worker_cron(text)', 'execute'),
  'the administrative role cannot invoke the Vault-reading cron helper'
);

set local role service_role;
select throws_ok(
  $$update private.external_effects set status = 'dead' where false$$,
  '42501', null, 'service_role cannot update effect state directly'
);
select throws_ok(
  $$insert into private.job_runs
      (run_key, job_name, triggered_by, scheduled_for, status)
    values ('cron:health_check_jobs:forged', 'health_check_jobs', 'cron', now(), 'running')$$,
  '42501', null, 'service_role cannot fabricate a job run directly'
);
reset role;

select * from finish();

rollback;
