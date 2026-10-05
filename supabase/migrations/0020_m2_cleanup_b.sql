-- M2-D15: change only the mode of the eight remaining M1-B locks.
-- CREATE OR REPLACE preserves owners and ACLs; no grant is added.
begin;

CREATE OR REPLACE FUNCTION public.worker_acquire_external_effect(p_supported_kinds text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  if cardinality(p_supported_kinds) = 0 then return null; end if;

  v_now := clock_timestamp();
  select effect.*
  into v_effect
  from private.external_effects as effect
  where effect.kind = any (p_supported_kinds)
    and (
      effect.status = 'pending'
      or (effect.status = 'failed_retryable' and effect.next_attempt_at <= v_now)
    )
    and (
      effect.kind <> 'delete_auth_user'
      or effect.resource_type <> 'deletion_request'
      or private.deletion_auth_effect_is_ready(effect.resource_id)
    )
  order by effect.next_attempt_at asc nulls first, effect.created_at, effect.id
  for no key update skip locked
  limit 1;

  if not found then return null; end if;

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
$function$
;

CREATE OR REPLACE FUNCTION public.worker_complete_external_effect(p_effect_id uuid, p_lease_token uuid, p_result text, p_error_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  for no key update;

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
$function$
;

CREATE OR REPLACE FUNCTION public.worker_finish_job(p_run_id bigint, p_status text, p_summary jsonb, p_error_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  for no key update;

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
$function$
;

CREATE OR REPLACE FUNCTION private.reconcile_deletion_request(p_request_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_request private.deletion_requests%rowtype;
  v_has_storage boolean;
begin
  select request.* into v_request
  from private.deletion_requests as request
  where request.id = p_request_id
  for no key update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_request.status = 'completed' then return 'completed'; end if;

  v_has_storage := private.deletion_has_pending_storage(p_request_id);

  if v_has_storage then
    update private.deletion_requests
    set status = 'cleaning_storage',
        next_attempt_at = null,
        last_error_code = null
    where id = p_request_id;
    return 'cleaning_storage';
  end if;

  update private.deletion_requests
  set status = 'deleting_auth',
      next_attempt_at = null,
      last_error_code = null
  where id = p_request_id;
  insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
  values ('delete_auth_user', 'deletion_request', p_request_id,
          'delete_auth_user:' || p_request_id::text)
  on conflict (dedupe_key) do nothing;
  return 'deleting_auth';
end;
$function$
;

CREATE OR REPLACE FUNCTION public.enqueue_data_export_purge(p_export_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_export private.data_exports%rowtype;
begin
  select export.* into v_export from private.data_exports export where export.id=p_export_id for no key update;
  if not found then raise exception using errcode='P0002',message='NOT_FOUND'; end if;
  if v_export.status='ready' then update private.data_exports set status='cleanup_pending' where id=p_export_id; end if;
  insert into private.external_effects(kind,resource_type,resource_id,dedupe_key)
  values('delete_data_export','data_export',p_export_id,'delete_data_export:'||p_export_id::text)
  on conflict(dedupe_key) do nothing;
  return jsonb_build_object('export_id',p_export_id,'queued',true);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.worker_publish_data_export(p_effect_id uuid, p_lease_token uuid, p_storage_path text, p_content_digest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_effect private.external_effects%rowtype; v_export private.data_exports%rowtype;
begin
  select effect.* into v_effect from private.external_effects effect where effect.id=p_effect_id for no key update;
  if not found or v_effect.kind<>'build_data_export' or v_effect.status<>'leased'
     or v_effect.lease_token<>p_lease_token or v_effect.lease_until<=clock_timestamp()
     or p_content_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  select export.* into v_export from private.data_exports export where export.id=v_effect.resource_id for update;
  if not found or v_export.status<>'building'
     or p_storage_path<>'exports/'||v_export.profile_id::text||'/'||v_export.id::text||'.zip'
     or exists(select 1 from public.profiles p where p.id=v_export.profile_id
               and p.account_status in ('deletion_pending','deleted')) then
    raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  update private.data_exports set status='ready',storage_path=p_storage_path,
    content_digest=p_content_digest,ready_at=now(),expires_at=now()+interval '24 hours'
  where id=v_export.id;
  return jsonb_build_object('export_id',v_export.id,'status','ready');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.finalize_deletion(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile_id uuid;
  v_request private.deletion_requests%rowtype;
begin
  select profile_id into v_profile_id from private.deletion_requests
  where id = p_request_id;
  if v_profile_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;

  perform 1 from public.profiles where id = v_profile_id for update;
  select request.* into v_request from private.deletion_requests as request
  where request.id = p_request_id for no key update;
  if v_request.status = 'completed' then
    return jsonb_build_object('deletion_request_id', p_request_id, 'status', 'completed');
  end if;
  if v_request.status <> 'finalizing'
     or exists (select 1 from auth.users where id = v_request.auth_user_id)
     or private.deletion_has_pending_storage(p_request_id) then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;

  update public.profiles
  set auth_user_id = null,
      name = 'Deleted ' || encode(extensions.gen_random_bytes(16), 'hex'),
      nickname = null,
      photo_url = null,
      position = null,
      dominant_foot = null,
      shirt_number = null,
      account_status = 'deleted',
      status_changed_at = now(),
      deidentified_at = now()
  where id = v_profile_id;

  update private.deletion_requests
  set auth_user_id = null,
      status = 'completed',
      next_attempt_at = null,
      last_error_code = null,
      completed_at = now()
  where id = p_request_id;

  return jsonb_build_object('deletion_request_id', p_request_id, 'status', 'completed');
end;
$function$
;

CREATE OR REPLACE FUNCTION public.consume_data_export(p_actor_auth_user_id uuid, p_actor_session_id uuid, p_export_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_profile public.profiles%rowtype; v_export private.data_exports%rowtype;
begin
  if p_actor_auth_user_id is null or p_actor_session_id is null or p_export_id is null then
    raise exception using errcode='28000',message='UNAUTHENTICATED'; end if;
  select profile.* into v_profile from public.profiles profile
  where profile.auth_user_id=p_actor_auth_user_id;
  if not found then raise exception using errcode='28000',message='UNAUTHENTICATED'; end if;
  -- Denylist and account authority are checked before the export row is read or
  -- locked. Logout therefore cannot consume or purge a ready artifact.
  if private.is_actor_session_revoked(p_actor_session_id) then
    raise exception using errcode='28000',message='UNAUTHENTICATED'; end if;
  if v_profile.account_status not in ('active','suspended','banned') then
    raise exception using errcode='42501',message='FORBIDDEN'; end if;
  select export.* into v_export from private.data_exports export
  where export.id=p_export_id for no key update;
  if not found or v_export.profile_id<>v_profile.id or v_export.status<>'ready'
     or v_export.expires_at<=now() then
    raise exception using errcode='P0001',message='EXPORT_EXPIRED'; end if;
  update private.data_exports set status='downloaded',downloaded_at=now()
  where id=p_export_id and status='ready';
  if not found then raise exception using errcode='P0001',message='EXPORT_EXPIRED'; end if;
  return jsonb_build_object('export_id',v_export.id,'storage_path',v_export.storage_path,
                            'content_digest',v_export.content_digest);
end;
$function$
;

-- M2-D21: revalidate the actor before replay; preserve the new-call guard.
create or replace function public.request_data_export(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_profile public.profiles%rowtype;
  v_actor_key text;
  v_acquired record;
  v_privacy_request_id uuid;
  v_export_id uuid;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(p_request_id,p_input_hmac,p_canonical_version,p_hash_key_version);
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode='28000',message='UNAUTHENTICATED';
  end if;
  select profile.* into v_profile from public.profiles profile
  where profile.auth_user_id=p_actor_auth_user_id;
  if not found then raise exception using errcode='P0002',message='NOT_FOUND'; end if;
  v_actor_key := 'profile:' || v_profile.id::text;
  select * into v_acquired from private.acquire_request_data_export_idempotency(
    v_actor_key,p_request_id,p_input_hmac,p_canonical_version,p_hash_key_version);
  -- M2-D14: FOR NO KEY UPDATE. A idempotência acima já segura FOR KEY SHARE
  -- neste perfil pela FK actor_id; FOR UPDATE faria dois pedidos do mesmo
  -- titular esperarem um pelo FOR KEY SHARE do outro. A transação não altera o
  -- perfil, e o lock continua serializando os pedidos: o segundo encontra o
  -- export do primeiro e recebe EXPORT_ALREADY_PENDING.
  select profile.* into v_profile from public.profiles profile
  where profile.id=v_profile.id and profile.auth_user_id=p_actor_auth_user_id for no key update;
  if not found then raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  if private.is_actor_session_revoked(p_actor_session_id) then
    raise exception using errcode='28000',message='UNAUTHENTICATED';
  end if;
  if v_profile.account_status not in ('active','suspended','banned') then
    raise exception using errcode='42501',message='FORBIDDEN';
  end if;
  -- M2-D21: replay uses exactly the actor guard of a new privacy request.
  if not v_acquired.acquired then
    return jsonb_build_object('outcome',v_acquired.outcome,
      'current',private.data_export_projection(v_profile.id));
  end if;
  if exists(select 1 from private.data_exports export where export.profile_id=v_profile.id
    and (export.status in ('queued','building','ready','cleanup_pending')
      or (export.status='downloaded' and export.storage_path is not null))) then
    raise exception using errcode='P0001',message='EXPORT_ALREADY_PENDING';
  end if;
  insert into public.privacy_requests(profile_id,kind)
  values(v_profile.id,'access') returning id into v_privacy_request_id;
  insert into private.data_exports(privacy_request_id,profile_id)
  values(v_privacy_request_id,v_profile.id) returning id into v_export_id;
  insert into private.external_effects(kind,resource_type,resource_id,dedupe_key)
  values('build_data_export','data_export',v_export_id,'build_data_export:'||v_export_id::text);
  v_outcome := jsonb_build_object('export_id',v_export_id::text,
                                  'logical_result','data_export_requested');
  perform private.complete_request_data_export_idempotency(v_actor_key,p_request_id,p_input_hmac,
    p_canonical_version,p_hash_key_version,v_outcome);
  return jsonb_build_object('outcome',v_outcome,'current',private.data_export_projection(v_profile.id));
end;
$function$;

commit;
