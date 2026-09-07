begin;

-- M1-B, slice 1: the first worker, its scheduled wake-ups and the database
-- half of lease/fencing, retry and job-run observability.
-- Sources: docs/22-plano-m1-b.md sections 1-3; docs/10-schema-db.md sections
-- 9 and 11; docs/13-contratos-funcoes.md sections 0, 5.3 and 5.4;
-- docs/14-convencoes-app.md sections 5.2 and 5.3; and
-- docs/17-mapa-dados-lgpd.md sections 3 and 4.
--
-- This migration publishes no external-effect handler. The worker therefore
-- calls acquire_external_effect with an empty kind list until 0012 ships the
-- first consumers. Tests pass an explicit test allowlist to exercise the
-- primitive without making an unhandled production kind eligible.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Extension entry points are infrastructure, not client APIs. Cron continues
-- to execute its commands as postgres, and only the private invoker below can
-- read the named Vault entries.
revoke all on schema cron, net from public, anon, authenticated, service_role;
revoke all on all functions in schema cron, net from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Pilot calibrations
-- ---------------------------------------------------------------------------

alter table private.app_limits
  drop constraint app_limits_unit_check;

alter table private.app_limits
  add constraint app_limits_unit_check
  check (unit in ('bytes', 'seconds', 'attempts', 'milliseconds', 'effects'));

insert into private.app_limits (limit_key, limit_value, unit, notes)
values
  ('external_effect_lease_seconds', 180, 'seconds',
   'Initial pilot calibration. The lease is sixty seconds longer than the worker soft deadline.'),
  ('worker_soft_deadline_seconds', 120, 'seconds',
   'Initial pilot calibration. A worker awaits its current unit and does not rely on background lifetime.'),
  ('external_effect_max_attempts', 8, 'attempts',
   'Initial pilot calibration. A permanent failure or the eighth retryable failure dead-letters the effect.'),
  ('external_effect_backoff_base_seconds', 60, 'seconds',
   'Initial pilot calibration for deterministic equal-jitter retry backoff.'),
  ('external_effect_backoff_cap_seconds', 3600, 'seconds',
   'Initial pilot calibration for the retry backoff ceiling.'),
  ('worker_max_effects_per_invocation', 10, 'effects',
   'Initial pilot calibration. Effects are acquired and awaited one at a time.');

-- ---------------------------------------------------------------------------
-- External-effect lease, fencing and coherent states
-- ---------------------------------------------------------------------------

alter table private.external_effects
  add column lease_token uuid;

alter table private.external_effects
  drop constraint external_effects_attempts_check,
  drop constraint external_effects_check,
  drop constraint external_effects_check1;

alter table private.external_effects
  add constraint external_effects_attempts_check
    check (attempts between 0 and 8),
  add constraint external_effects_state_check check (
       (status = 'pending'
        and attempts = 0
        and lease_token is null and lease_until is null
        and next_attempt_at is null and last_error_code is null
        and completed_at is null)
    or (status = 'leased'
        and attempts between 1 and 8
        and lease_token is not null and lease_until is not null
        and next_attempt_at is null and last_error_code is null
        and completed_at is null)
    or (status = 'failed_retryable'
        and attempts between 1 and 7
        and lease_token is null and lease_until is null
        and next_attempt_at is not null and last_error_code is not null
        and completed_at is null)
    or (status = 'succeeded'
        and attempts between 1 and 8
        and lease_token is null and lease_until is null
        and next_attempt_at is null and last_error_code is null
        and completed_at is not null)
    or (status = 'dead'
        and attempts between 1 and 8
        and lease_token is null and lease_until is null
        and next_attempt_at is null and last_error_code is not null
        and completed_at is not null)
  ),
  add constraint external_effects_completed_at_check
    check (completed_at is null or completed_at >= created_at);

comment on column private.external_effects.lease_token is
  'Fresh fencing token for one lease attempt. Completion requires id, token, leased status and an unexpired lease under the server clock.';

drop index private.external_effects_due_idx;
create index external_effects_due_idx
  on private.external_effects (next_attempt_at asc nulls first, created_at, id)
  where status in ('pending', 'failed_retryable');

create or replace function private.external_effect_backoff_seconds(
  p_effect_id uuid,
  p_attempts integer
)
returns bigint
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_base bigint;
  v_cap bigint;
  v_max_attempts bigint;
  v_raw bigint;
  v_half bigint;
  v_hash bytea;
  v_bucket bigint;
begin
  if p_effect_id is null or p_attempts is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  select max(limit_value) filter (where limit_key = 'external_effect_backoff_base_seconds'),
         max(limit_value) filter (where limit_key = 'external_effect_backoff_cap_seconds'),
         max(limit_value) filter (where limit_key = 'external_effect_max_attempts')
  into v_base, v_cap, v_max_attempts
  from private.app_limits
  where limit_key in (
    'external_effect_backoff_base_seconds',
    'external_effect_backoff_cap_seconds',
    'external_effect_max_attempts'
  );

  if v_base is null or v_cap is null or v_max_attempts is null
     or v_base <= 0 or v_cap < v_base
     or p_attempts not between 1 and v_max_attempts then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  v_raw := least(v_cap, v_base * (2::bigint ^ (p_attempts - 1))::bigint);
  v_half := v_raw / 2;
  v_hash := extensions.digest(p_effect_id::text || p_attempts::text, 'sha256');
  v_bucket := get_byte(v_hash, 0)::bigint * 16777216
            + get_byte(v_hash, 1)::bigint * 65536
            + get_byte(v_hash, 2)::bigint * 256
            + get_byte(v_hash, 3)::bigint;

  -- Equal jitter is inclusive at both boundaries: floor(raw/2)..raw.
  return v_half + mod(v_bucket, v_raw - v_half + 1);
end;
$function$;

comment on function private.external_effect_backoff_seconds(uuid, integer) is
  'Deterministic equal jitter over SHA-256(effect UUID text || attempts): 50%-100% of min(3600, 60*2^(attempts-1)).';

-- The worker supplies exactly the kinds for which its deployed runtime has a
-- handler. In 0011 that list is empty. Later slices add code and pass the new
-- closed list in the same commit as the producer and handler.
create or replace function public.worker_acquire_external_effect(
  p_supported_kinds text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz;
  v_lease_seconds bigint;
  v_max_attempts bigint;
  v_effect private.external_effects%rowtype;
begin
  if p_supported_kinds is null
     or cardinality(p_supported_kinds) <> (
       select count(distinct kind)::integer from unnest(p_supported_kinds) as kind
     )
     or exists (
       select 1 from unnest(p_supported_kinds) as kind
       where kind not in (
         'delete_auth_user', 'delete_storage_object', 'build_data_export',
         'delete_data_export', 'purge_proof_object'
       )
     ) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  select max(limit_value) filter (where limit_key = 'external_effect_lease_seconds'),
         max(limit_value) filter (where limit_key = 'external_effect_max_attempts')
  into v_lease_seconds, v_max_attempts
  from private.app_limits
  where limit_key in ('external_effect_lease_seconds', 'external_effect_max_attempts');

  if v_lease_seconds is null or v_lease_seconds <= 0
     or v_max_attempts is null or v_max_attempts <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  v_now := clock_timestamp();
  -- Expiry is not evidence that the external provider failed. It only makes a
  -- new reconciliating attempt eligible. The eighth expired attempt is still
  -- the eighth failure and therefore dead-letters instead of becoming attempt 9.
  update private.external_effects as effect
  set status = case when effect.attempts >= v_max_attempts then 'dead'
                    else 'failed_retryable' end,
      lease_token = null,
      lease_until = null,
      next_attempt_at = case when effect.attempts >= v_max_attempts then null else v_now end,
      last_error_code = 'LEASE_EXPIRED',
      completed_at = case when effect.attempts >= v_max_attempts then v_now else null end
  where effect.status = 'leased'
    and effect.lease_until <= v_now;

  if cardinality(p_supported_kinds) = 0 then
    return null;
  end if;

  -- The expiry sweep may have waited on another row. A newly granted lease is
  -- always measured from a fresh server clock, never function-entry time.
  v_now := clock_timestamp();
  select effect.*
  into v_effect
  from private.external_effects as effect
  where effect.kind = any (p_supported_kinds)
    and (
      effect.status = 'pending'
      or (effect.status = 'failed_retryable' and effect.next_attempt_at <= v_now)
    )
  order by effect.next_attempt_at asc nulls first, effect.created_at, effect.id
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  update private.external_effects as effect
  set status = 'leased',
      attempts = effect.attempts + 1,
      lease_token = gen_random_uuid(),
      lease_until = v_now + make_interval(secs => v_lease_seconds::integer),
      next_attempt_at = null,
      last_error_code = null,
      completed_at = null
  where effect.id = v_effect.id
  returning effect.* into v_effect;

  return jsonb_build_object(
    'id', v_effect.id,
    'kind', v_effect.kind,
    'resource_type', v_effect.resource_type,
    'resource_id', v_effect.resource_id,
    'dedupe_key', v_effect.dedupe_key,
    'attempts', v_effect.attempts,
    'lease_token', v_effect.lease_token,
    'lease_until', v_effect.lease_until
  );
end;
$function$;

comment on function public.worker_acquire_external_effect(text[]) is
  'Short READ COMMITTED lease acquisition. Reclassifies expired leases, then locks the first eligible published-handler kind with FOR UPDATE SKIP LOCKED and NULLS FIRST ordering.';

create or replace function public.worker_complete_external_effect(
  p_effect_id uuid,
  p_lease_token uuid,
  p_result text,
  p_error_code text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz;
  v_max_attempts bigint;
  v_effect private.external_effects%rowtype;
  v_next_attempt_at timestamptz;
begin
  if p_effect_id is null or p_lease_token is null
     or p_result not in ('succeeded', 'retryable_failure', 'permanent_failure')
     or (p_result = 'succeeded' and p_error_code is not null)
     or (p_result <> 'succeeded' and (
       p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,62}$'
     )) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  select effect.*
  into v_effect
  from private.external_effects as effect
  where effect.id = p_effect_id
  for update;

  if not found
     or v_effect.status <> 'leased'
     or v_effect.lease_token <> p_lease_token
     or v_effect.lease_until <= clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;

  -- The row lock may have waited. Backoff and completion start from the instant
  -- this attempt actually won the fenced transition.
  v_now := clock_timestamp();

  select limit_value into v_max_attempts
  from private.app_limits
  where limit_key = 'external_effect_max_attempts';

  if v_max_attempts is null or v_max_attempts <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  if p_result = 'succeeded' then
    update private.external_effects as effect
    set status = 'succeeded',
        lease_token = null,
        lease_until = null,
        next_attempt_at = null,
        last_error_code = null,
        completed_at = v_now
    where effect.id = p_effect_id
    returning effect.* into v_effect;
  elsif p_result = 'permanent_failure' or v_effect.attempts >= v_max_attempts then
    update private.external_effects as effect
    set status = 'dead',
        lease_token = null,
        lease_until = null,
        next_attempt_at = null,
        last_error_code = p_error_code,
        completed_at = v_now
    where effect.id = p_effect_id
    returning effect.* into v_effect;
  else
    v_next_attempt_at := v_now + make_interval(
      secs => private.external_effect_backoff_seconds(v_effect.id, v_effect.attempts)::integer
    );
    update private.external_effects as effect
    set status = 'failed_retryable',
        lease_token = null,
        lease_until = null,
        next_attempt_at = v_next_attempt_at,
        last_error_code = p_error_code,
        completed_at = null
    where effect.id = p_effect_id
    returning effect.* into v_effect;
  end if;

  return jsonb_build_object(
    'id', v_effect.id,
    'status', v_effect.status,
    'attempts', v_effect.attempts,
    'next_attempt_at', v_effect.next_attempt_at,
    'completed_at', v_effect.completed_at,
    'decided_at', v_now
  );
end;
$function$;

comment on function public.worker_complete_external_effect(uuid, uuid, text, text) is
  'Fenced completion. An old token, a non-leased row or a lease no longer strictly in the future returns CONCURRENT_CHANGE without changing state.';

-- ---------------------------------------------------------------------------
-- Identity retention wrappers and observable job lifecycle
-- ---------------------------------------------------------------------------

create or replace function private.purge_expired_revoked_sessions()
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_started_at timestamptz := clock_timestamp();
  v_now timestamptz := now();
  v_scanned bigint;
  v_purged bigint;
begin
  select count(*) into v_scanned
  from private.revoked_auth_sessions as session
  where session.expires_at <= v_now;

  delete from private.revoked_auth_sessions as session
  where session.expires_at <= v_now;
  get diagnostics v_purged = row_count;

  insert into private.retention_runs
    (policy, window_start, window_end, scanned, purged, failed, started_at, finished_at)
  values (
    'purge_expired_revoked_sessions',
    v_now - interval '90 days',
    v_now,
    v_scanned::integer,
    v_purged::integer,
    0,
    v_started_at,
    clock_timestamp()
  );

  return jsonb_build_object('scanned', v_scanned, 'purged', v_purged);
end;
$function$;

create or replace function private.worker_job_slot(
  p_job_name text,
  p_now timestamptz
)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_slot timestamptz;
begin
  if p_job_name = 'process_external_effects' then
    return date_trunc('minute', p_now);
  elsif p_job_name = 'health_check_jobs' then
    return date_trunc('hour', p_now)
      + make_interval(mins => (extract(minute from p_now)::integer / 5) * 5);
  elsif p_job_name = 'purge_expired_revoked_sessions' then
    v_slot := date_trunc('hour', p_now) + interval '17 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 hour' end;
  elsif p_job_name = 'purge_expired_idempotency_outcomes' then
    v_slot := date_trunc('day', p_now) + interval '3 hours 23 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 day' end;
  end if;

  raise exception using errcode = '22023', message = 'VALIDATION';
end;
$function$;

create or replace function public.worker_begin_job(p_job_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_slot timestamptz;
  v_run_id bigint;
  v_deadline bigint;
  v_max_effects bigint;
begin
  v_slot := private.worker_job_slot(p_job_name, v_now);

  select max(limit_value) filter (where limit_key = 'worker_soft_deadline_seconds'),
         max(limit_value) filter (where limit_key = 'worker_max_effects_per_invocation')
  into v_deadline, v_max_effects
  from private.app_limits
  where limit_key in ('worker_soft_deadline_seconds', 'worker_max_effects_per_invocation');

  if v_deadline is null or v_deadline <= 0 or v_max_effects is null or v_max_effects <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  -- A later scheduled slot is evidence that an older running isolate did not
  -- persist a conclusion. It becomes a failed run, never fabricated success.
  update private.job_runs as run
  set status = 'failed',
      finished_at = v_now,
      error_code = 'RUN_ABANDONED',
      summary = jsonb_build_object(
        'scanned', 0,
        'changed', 0,
        'skipped', 0,
        'failed', 1,
        'stale', 1,
        'duration_ms', greatest(0, floor(extract(epoch from (v_now - run.started_at)) * 1000)::bigint)
      )
  where run.job_name = p_job_name
    and run.status = 'running'
    and run.scheduled_for < v_slot;

  insert into private.job_runs
    (run_key, job_name, triggered_by, scheduled_for, status)
  values (
    'cron:' || p_job_name || ':' || to_char(v_slot at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    p_job_name,
    'cron',
    v_slot,
    'running'
  )
  on conflict (run_key) do nothing
  returning id into v_run_id;

  if v_run_id is null then
    return jsonb_build_object(
      'acquired', false,
      'job_name', p_job_name,
      'scheduled_for', v_slot
    );
  end if;

  return jsonb_build_object(
    'acquired', true,
    'run_id', v_run_id,
    'job_name', p_job_name,
    'scheduled_for', v_slot,
    'soft_deadline_seconds', v_deadline,
    'max_effects', v_max_effects
  );
end;
$function$;

create or replace function public.worker_execute_database_job(p_run_id bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_run private.job_runs%rowtype;
  v_result jsonb;
  v_scanned bigint;
  v_failed bigint;
  v_stale bigint;
begin
  if p_run_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  select run.* into v_run
  from private.job_runs as run
  where run.id = p_run_id
  for update;

  if not found or v_run.status <> 'running' then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;

  if v_run.job_name = 'purge_expired_revoked_sessions' then
    v_result := private.purge_expired_revoked_sessions();
    return jsonb_build_object(
      'scanned', (v_result ->> 'scanned')::bigint,
      'changed', (v_result ->> 'purged')::bigint,
      'skipped', (v_result ->> 'scanned')::bigint - (v_result ->> 'purged')::bigint,
      'failed', 0,
      'stale', 0,
      'duration_ms', 0
    );
  elsif v_run.job_name = 'purge_expired_idempotency_outcomes' then
    v_result := private.purge_expired_idempotency_outcomes();
    v_scanned := (v_result ->> 'payload_expired')::bigint
               + (v_result ->> 'tombstones_deleted')::bigint;
    return jsonb_build_object(
      'scanned', v_scanned,
      'changed', v_scanned,
      'skipped', 0,
      'failed', 0,
      'stale', 0,
      'duration_ms', 0
    );
  elsif v_run.job_name = 'health_check_jobs' then
    select count(*),
           count(*) filter (where run.status = 'failed'),
           count(*) filter (where run.error_code = 'RUN_ABANDONED')
    into v_scanned, v_failed, v_stale
    from private.job_runs as run
    where run.id <> p_run_id
      and run.started_at >= now() - interval '24 hours';

    return jsonb_build_object(
      'scanned', v_scanned,
      'changed', 0,
      'skipped', v_scanned - v_failed,
      'failed', v_failed,
      'stale', v_stale,
      'duration_ms', 0
    );
  end if;

  raise exception using errcode = '22023', message = 'VALIDATION';
end;
$function$;

create or replace function public.worker_finish_job(
  p_run_id bigint,
  p_status text,
  p_summary jsonb,
  p_error_code text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_finished_at timestamptz;
  v_run private.job_runs%rowtype;
begin
  if p_run_id is null or p_status not in ('succeeded', 'failed')
     or (p_status = 'succeeded' and p_error_code is not null)
     or (p_status = 'failed' and (
       p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,62}$'
     )) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  perform private.validate_job_summary(p_summary);

  select run.* into v_run
  from private.job_runs as run
  where run.id = p_run_id
  for update;

  if not found or v_run.status <> 'running' then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;

  v_finished_at := clock_timestamp();

  update private.job_runs as run
  set status = p_status,
      finished_at = v_finished_at,
      error_code = p_error_code,
      summary = p_summary || jsonb_build_object(
        'duration_ms', greatest(
          (p_summary ->> 'duration_ms')::bigint,
          floor(extract(epoch from (v_finished_at - run.started_at)) * 1000)::bigint
        )
      )
  where run.id = p_run_id
    and run.status = 'running'
  returning run.* into v_run;

  if not found then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;

  return jsonb_build_object(
    'run_id', v_run.id,
    'status', v_run.status,
    'finished_at', v_run.finished_at
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Cron -> pg_net -> Edge wake-up
-- ---------------------------------------------------------------------------

create or replace function private.invoke_worker_cron(p_job_name text)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_project_url text;
  v_publishable_key text;
  v_cron_secret text;
  v_request_id bigint;
begin
  perform private.worker_job_slot(p_job_name, clock_timestamp());

  begin
    select decrypted_secret into strict v_project_url
    from vault.decrypted_secrets where name = 'worker_project_url';
    select decrypted_secret into strict v_publishable_key
    from vault.decrypted_secrets where name = 'worker_publishable_key';
    select decrypted_secret into strict v_cron_secret
    from vault.decrypted_secrets where name = 'worker_cron_secret';
  exception when no_data_found or too_many_rows then
    raise exception using errcode = 'P0001', message = 'WORKER_CONFIGURATION_MISSING';
  end;

  if v_project_url is null or length(v_project_url) = 0
     or v_publishable_key is null or length(v_publishable_key) = 0
     or v_cron_secret is null or length(v_cron_secret) = 0 then
    raise exception using errcode = 'P0001', message = 'WORKER_CONFIGURATION_MISSING';
  end if;

  select net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/worker/' || p_job_name,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_publishable_key,
      'Authorization', 'Bearer ' || v_cron_secret
    ),
    timeout_milliseconds := 5000
  ) into v_request_id;

  return v_request_id;
end;
$function$;

select cron.schedule(
  'colete_v1_process_external_effects',
  '* * * * *',
  $$select private.invoke_worker_cron('process_external_effects');$$
);
select cron.schedule(
  'colete_v1_health_check_jobs',
  '*/5 * * * *',
  $$select private.invoke_worker_cron('health_check_jobs');$$
);
select cron.schedule(
  'colete_v1_purge_expired_revoked_sessions',
  '17 * * * *',
  $$select private.invoke_worker_cron('purge_expired_revoked_sessions');$$
);
select cron.schedule(
  'colete_v1_purge_expired_idempotency_outcomes',
  '23 3 * * *',
  $$select private.invoke_worker_cron('purge_expired_idempotency_outcomes');$$
);

revoke all on function private.external_effect_backoff_seconds(uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function private.purge_expired_revoked_sessions()
  from public, anon, authenticated, service_role;
revoke all on function private.worker_job_slot(text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.invoke_worker_cron(text)
  from public, anon, authenticated, service_role;

revoke all on function public.worker_acquire_external_effect(text[])
  from public, anon, authenticated, service_role;
revoke all on function public.worker_complete_external_effect(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.worker_begin_job(text)
  from public, anon, authenticated, service_role;
revoke all on function public.worker_execute_database_job(bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.worker_finish_job(bigint, text, jsonb, text)
  from public, anon, authenticated, service_role;

grant execute on function public.worker_acquire_external_effect(text[]) to service_role;
grant execute on function public.worker_complete_external_effect(uuid, uuid, text, text)
  to service_role;
grant execute on function public.worker_begin_job(text) to service_role;
grant execute on function public.worker_execute_database_job(bigint) to service_role;
grant execute on function public.worker_finish_job(bigint, text, jsonb, text) to service_role;

commit;
