begin;

-- M1-B review fixes: one UTC slot implementation for every published job and
-- convergence of an Auth effect whose lease expires after the saga commits.

create or replace function private.worker_job_slot(
  p_job_name text,
  p_now timestamptz
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_now_utc timestamp := p_now at time zone 'UTC';
  v_slot timestamptz;
begin
  if p_job_name = 'process_external_effects' then
    return date_trunc('minute', v_now_utc) at time zone 'UTC';
  elsif p_job_name = 'health_check_jobs' then
    return (
      date_trunc('hour', v_now_utc)
      + make_interval(mins => (extract(minute from v_now_utc)::integer / 5) * 5)
    ) at time zone 'UTC';
  elsif p_job_name = 'purge_expired_revoked_sessions' then
    v_slot := (date_trunc('hour', v_now_utc) at time zone 'UTC')
      + interval '17 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 hour' end;
  elsif p_job_name = 'purge_expired_idempotency_outcomes' then
    v_slot := (date_trunc('day', v_now_utc) at time zone 'UTC')
      + interval '3 hours 23 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 day' end;
  elsif p_job_name = 'purge_completed_deletion_requests' then
    v_slot := (date_trunc('day', v_now_utc) at time zone 'UTC')
      + interval '3 hours 43 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 day' end;
  elsif p_job_name = 'expire_data_exports' then
    v_slot := (date_trunc('hour', v_now_utc) at time zone 'UTC')
      + interval '7 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 hour' end;
  end if;

  raise exception using errcode = '22023', message = 'VALIDATION';
end;
$function$;

comment on function private.worker_job_slot(text, timestamptz) is
  'Single stable UTC slot resolver for all six published worker jobs; independent of the caller TimeZone GUC.';

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

  if v_deadline is null or v_deadline <= 0
     or v_max_effects is null or v_max_effects <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

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
        'duration_ms', greatest(
          0,
          floor(extract(epoch from (v_now - run.started_at)) * 1000)::bigint
        )
      )
  where run.job_name = p_job_name
    and run.status = 'running'
    and run.scheduled_for < v_slot;

  insert into private.job_runs
    (run_key, job_name, triggered_by, scheduled_for, status)
  values (
    'cron:' || p_job_name || ':'
      || to_char(v_slot at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
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

-- These slice-local resolvers were temporary adapters. All callers now use
-- worker_job_slot, so removing them prevents a second UTC implementation from
-- drifting away from the canonical six-job resolver.
drop function private.account_deletion_job_slot(text, timestamptz);
drop function private.data_export_job_slot(text, timestamptz);

create or replace function private.deletion_auth_effect_is_ready(p_request_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select coalesce((
    select request.status = 'completed'
      or (
        request.status in ('requested', 'failed_retryable', 'deleting_auth')
        and not private.deletion_has_pending_storage(request.id)
      )
    from private.deletion_requests as request
    where request.id = p_request_id
  ), true);
$function$;

revoke all on function private.worker_job_slot(text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.invoke_worker_cron(text)
  from public, anon, authenticated, service_role;
revoke all on function private.deletion_auth_effect_is_ready(uuid)
  from public, anon, authenticated, service_role;

commit;
