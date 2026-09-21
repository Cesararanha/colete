begin;

-- M1-B, slice 3: governed data-export production, one-shot delivery and purge.
-- Sources: docs/22-plano-m1-b.md section 5; docs/13-contratos-funcoes.md
-- sections 0 and 5.3; docs/14-convencoes-app.md sections 5.1-5.3; and
-- docs/17-mapa-dados-lgpd.md sections 3-5.

-- The export row is operational state. Clients receive only the typed
-- projection below; paths and digests never cross this boundary.
revoke select on table public.data_exports from authenticated;
drop policy data_exports_select_own on public.data_exports;
alter table public.data_exports no force row level security;
alter table public.data_exports disable row level security;
alter table public.data_exports set schema private;
revoke all on table private.data_exports from public, anon, authenticated, service_role;

-- The first build attempt fixes the logical snapshot instant. Retries reuse it
-- so a crash can reconstruct the exact same artifact when source rows did not
-- change between attempts.
alter table private.data_exports
  add column snapshot_at timestamptz;

-- A normalized provider code is redacted by finalization as required by
-- docs/22 section 4. This non-identifying boolean records only that terminal
-- Storage failure happened, so the titular projection remains truthful after
-- the text code is gone.
alter table private.deletion_requests
  add column has_operational_failure boolean not null default false;

-- A terminal build is a truthful failure before Storage absence is known. The
-- original state check equated every failed build with a confirmed purge and
-- therefore forced a false purged_at. Preserve the old confirmed-purge shape
-- and add only the two honest terminal-failure shapes: unpublished metadata or
-- a known artifact whose purge ultimately failed.
alter table private.data_exports
  drop constraint data_exports_state_check,
  add constraint data_exports_state_check check (
       (status in ('queued', 'building') and storage_path is null and content_digest is null
        and ready_at is null and expires_at is null and downloaded_at is null
        and purged_at is null)
    or (status = 'ready' and storage_path is not null and content_digest is not null
        and ready_at is not null and expires_at is not null and downloaded_at is null
        and purged_at is null)
    or (status = 'downloaded' and ready_at is not null and expires_at is not null
        and downloaded_at is not null
        and ((storage_path is not null and content_digest is not null and purged_at is null)
          or (storage_path is null and content_digest is null and purged_at is not null)))
    or (status = 'cleanup_pending' and storage_path is not null
        and content_digest is not null and ready_at is not null and expires_at is not null
        and purged_at is null)
    or (status in ('expired', 'failed') and storage_path is null and content_digest is null
        and purged_at is not null)
    or (status = 'failed' and purged_at is null
        and ((storage_path is null and content_digest is null)
          or (storage_path is not null and content_digest is not null)))
  );

-- PL/pgSQL bodies retain explicitly qualified names as source text. Rewrite
-- only the six functions shipped by 0012 that depend on the moved table. This
-- is append-only: the old migration remains byte-for-byte immutable.
do $migration$
declare
  v_signature text;
  v_definition text;
begin
  foreach v_signature in array array[
    'private.reconcile_deletion_request(uuid)',
    'public.delete_account(uuid,uuid,uuid,text,integer,integer)',
    'public.worker_get_deletion_effect_target(uuid,uuid)',
    'public.worker_confirm_deletion_effect(uuid,uuid)',
    'public.finalize_deletion(uuid)',
    'private.sync_deletion_failure_from_effect()'
  ] loop
    select pg_get_functiondef(v_signature::regprocedure) into v_definition;
    v_definition := replace(v_definition, 'public.data_exports', 'private.data_exports');
    if v_signature = 'public.delete_account(uuid,uuid,uuid,text,integer,integer)' then
      if strpos(v_definition, 'set status = ''failed'', purged_at = now()') = 0 then
        raise exception 'delete_account cancellation shape changed';
      end if;
      v_definition := replace(
        v_definition,
        'set status = ''failed'', purged_at = now()',
        'set status = ''failed'''
      );
    end if;
    execute v_definition;
  end loop;
end;
$migration$;

-- Recreate the two 0012 projections so the durable marker is combined with
-- the live retry state, while their five-field public shape remains unchanged.
create or replace function private.deletion_request_projection(p_profile_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select jsonb_build_object(
    'id', request.id,
    'status', request.status,
    'requested_at', request.requested_at,
    'completed_at', request.completed_at,
    'has_operational_failure',
      request.has_operational_failure
      or request.status = 'failed_retryable'
      or request.last_error_code is not null
  )
  from private.deletion_requests as request
  where request.profile_id = p_profile_id;
$function$;

create or replace function public.get_own_deletion_request()
returns setof public.deletion_request_projection
language sql
stable
security definer
set search_path = ''
as $function$
  select row(
    request.id,
    request.status,
    request.requested_at,
    request.completed_at,
    request.has_operational_failure
      or request.status = 'failed_retryable'
      or request.last_error_code is not null
  )::public.deletion_request_projection
  from private.deletion_requests as request
  join public.profiles as profile on profile.id = request.profile_id
  where profile.auth_user_id = auth.uid();
$function$;

-- Storage completion is a single predicate shared by saga reconciliation and
-- Auth-effect acquisition. A deterministic object may exist after an upload
-- that crashed before storage_path was published, so build and purge work are
-- equally part of the fence. Keep the closed kind list in this function only.
create or replace function private.deletion_has_pending_storage(
  p_request_id uuid
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  with target_request as (
    select request.profile_id
    from private.deletion_requests as request
    where request.id = p_request_id
  ),
  storage_effects as (
    select effect.*
    from private.external_effects as effect
    cross join target_request as request
    where effect.kind in (
      'build_data_export', 'delete_data_export', 'delete_storage_object'
    )
      and (
        (effect.resource_type = 'data_export' and exists (
          select 1 from private.data_exports as export
          where export.id = effect.resource_id
            and export.profile_id = request.profile_id
        ))
        or (effect.resource_type = 'profile_avatar'
            and effect.resource_id = request.profile_id)
      )
  )
  select coalesce(
    exists (
      select 1 from storage_effects
      where status in ('pending', 'leased', 'failed_retryable')
    )
    or exists (
      select 1
      from public.profiles as profile
      cross join target_request as request
      where profile.id = request.profile_id
        and profile.photo_url is not null
        and not exists (
          select 1 from storage_effects
          where resource_type = 'profile_avatar' and status = 'dead'
        )
    )
    or exists (
      select 1
      from private.data_exports as export
      cross join target_request as request
      where export.profile_id = request.profile_id
        and export.storage_path is not null
        and not exists (
          select 1 from storage_effects
          where resource_type = 'data_export'
            and resource_id = export.id
            and status = 'dead'
        )
    ),
    false
  );
$function$;

revoke all on function private.deletion_has_pending_storage(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.reconcile_deletion_request(p_request_id uuid)
returns text
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_request private.deletion_requests%rowtype;
  v_has_storage boolean;
begin
  select request.* into v_request
  from private.deletion_requests as request
  where request.id = p_request_id
  for update;
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
$function$;

-- Acquisition is the last database fence before a provider call. Reuse the
-- exact same Storage predicate as reconciliation even after the request has
-- already reached deleting_auth: later work must retract Auth readiness.
create or replace function private.deletion_auth_effect_is_ready(p_request_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select coalesce((
    select request.status in ('requested', 'failed_retryable', 'deleting_auth')
      and not private.deletion_has_pending_storage(request.id)
    from private.deletion_requests as request
    where request.id = p_request_id
  ), true);
$function$;

revoke all on function private.deletion_auth_effect_is_ready(uuid)
  from public, anon, authenticated, service_role;

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
  for update skip locked
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
$function$;

-- Reconcile on publication and terminal transition of a Storage purge. This
-- makes the invariant independent of which worker call happened to observe the
-- object, and advances only after the effect row itself is terminal.
create or replace function private.sync_deletion_failure_from_effect()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_request_id uuid;
begin
  if new.kind = 'build_data_export' and new.status = 'dead' then
    -- Upload may have committed before the terminal database failure. The path
    -- is deterministic, so terminal build accounting always becomes a real
    -- absence-confirming purge attempt instead of dropping the object.
    update private.data_exports
    set status = 'failed'
    where id = new.resource_id and status in ('queued', 'building');
    insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
    values ('delete_data_export', 'data_export', new.resource_id,
            'delete_data_export:' || new.resource_id::text)
    on conflict (dedupe_key) do nothing;
  end if;

  if new.resource_type = 'deletion_request' and new.kind = 'delete_auth_user' then
    v_request_id := new.resource_id;
  elsif new.resource_type = 'data_export' then
    select request.id into v_request_id
    from private.data_exports as export
    join private.deletion_requests as request on request.profile_id = export.profile_id
    where export.id = new.resource_id;
  elsif new.resource_type = 'profile_avatar' then
    select id into v_request_id from private.deletion_requests
    where profile_id = new.resource_id;
  end if;

  if v_request_id is null then return new; end if;

  if new.status = 'failed_retryable' then
    update private.deletion_requests
    set status = 'failed_retryable',
        attempts = greatest(attempts, new.attempts),
        next_attempt_at = new.next_attempt_at,
        last_error_code = new.last_error_code
    where id = v_request_id and status <> 'completed';
  elsif new.status = 'dead' and new.resource_type in ('data_export', 'profile_avatar') then
    if new.kind = 'delete_data_export' then
      -- The provider never confirmed absence. Keep path/digest, keep purged_at
      -- null, and release the export state honestly as failed.
      update private.data_exports
      set status = 'failed'
      where id = new.resource_id;
    end if;
    update private.deletion_requests
    set status = 'failed_retryable',
        attempts = greatest(attempts, new.attempts),
        next_attempt_at = null,
        last_error_code = new.last_error_code,
        has_operational_failure = true
    where id = v_request_id and status <> 'completed';
  elsif new.status = 'dead' then
    -- Auth dead-letter remains an actionable stalled saga. This item changes
    -- only the human-approved terminal policy for Storage.
    update private.deletion_requests
    set status = 'failed_retryable',
        attempts = greatest(attempts, new.attempts),
        next_attempt_at = null,
        last_error_code = new.last_error_code
    where id = v_request_id and status <> 'completed';
  end if;

  if new.resource_type in ('data_export', 'profile_avatar')
     and new.status in ('pending', 'succeeded', 'dead') then
    perform private.reconcile_deletion_request(v_request_id);
  end if;
  return new;
end;
$function$;

create trigger external_effects_reconcile_deletion_storage_insert
after insert on private.external_effects
for each row execute function private.sync_deletion_failure_from_effect();

-- A build may have uploaded its deterministic object before crashing, leaving
-- no path in the database. Every export purge therefore probes the canonical
-- path even when storage_path was never published.
create or replace function public.worker_get_deletion_effect_target(
  p_effect_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_effect private.external_effects%rowtype;
  v_path text;
  v_profile_id uuid;
  v_request_id uuid;
  v_request private.deletion_requests%rowtype;
begin
  select effect.* into v_effect from private.external_effects as effect
  where effect.id = p_effect_id for update;
  if not found or v_effect.status <> 'leased'
     or v_effect.lease_token <> p_lease_token
     or v_effect.lease_until <= clock_timestamp()
     or v_effect.kind not in ('delete_data_export', 'delete_storage_object', 'delete_auth_user') then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;

  if v_effect.kind = 'delete_data_export' then
    select coalesce(export.storage_path,
                    'exports/' || export.profile_id::text || '/' || export.id::text || '.zip'),
           export.profile_id
    into v_path, v_profile_id
    from private.data_exports as export
    where export.id = v_effect.resource_id;
    select id into v_request_id from private.deletion_requests
    where profile_id = v_profile_id;
    if v_request_id is not null then
      perform private.reconcile_deletion_request(v_request_id);
    end if;
    return jsonb_build_object('action', case when v_path is null then 'none' else 'storage' end,
      'bucket', 'data-exports', 'path', v_path);
  elsif v_effect.kind = 'delete_storage_object' and v_effect.resource_type = 'profile_avatar' then
    select id into v_request_id from private.deletion_requests
    where profile_id = v_effect.resource_id;
    if v_request_id is not null then
      perform private.reconcile_deletion_request(v_request_id);
    end if;
    select photo_url into v_path from public.profiles where id = v_effect.resource_id;
    return jsonb_build_object('action', case when v_path is null then 'none' else 'storage' end,
      'bucket', 'avatars', 'path', v_path);
  elsif v_effect.kind = 'delete_auth_user' and v_effect.resource_type = 'deletion_request' then
    select request.* into v_request from private.deletion_requests as request
    where request.id = v_effect.resource_id;
    if found and v_request.status in ('requested', 'failed_retryable') then
      perform private.reconcile_deletion_request(v_effect.resource_id);
      select request.* into v_request from private.deletion_requests as request
      where request.id = v_effect.resource_id;
    end if;
    if not found or v_request.status = 'completed' or v_request.auth_user_id is null then
      return jsonb_build_object('action', 'none', 'deletion_request_id', v_effect.resource_id);
    end if;
    return jsonb_build_object('action', 'auth',
      'auth_user_id', v_request.auth_user_id,
      'deletion_request_id', v_request.id);
  end if;

  raise exception using errcode = '22023', message = 'VALIDATION';
end;
$function$;

create unique index data_exports_one_active_per_profile_idx
  on private.data_exports (profile_id)
  where status in ('queued', 'building', 'ready', 'cleanup_pending')
     or (status = 'downloaded' and storage_path is not null);

create type public.data_export_projection as (
  id uuid,
  status text,
  created_at timestamptz,
  ready_at timestamptz,
  expires_at timestamptz,
  downloaded_at timestamptz,
  purged_at timestamptz
);

create or replace function private.data_export_projection(p_profile_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', export.id,
    'status', export.status,
    'created_at', export.created_at,
    'ready_at', export.ready_at,
    'expires_at', export.expires_at,
    'downloaded_at', export.downloaded_at,
    'purged_at', export.purged_at
  ) order by export.created_at desc, export.id), '[]'::jsonb)
  from private.data_exports as export
  where export.profile_id = p_profile_id;
$function$;

create or replace function public.get_own_data_exports()
returns setof public.data_export_projection
language sql
stable
security definer
set search_path = ''
as $function$
  select row(export.id, export.status, export.created_at, export.ready_at,
             export.expires_at, export.downloaded_at, export.purged_at)
         ::public.data_export_projection
  from private.data_exports as export
  join public.profiles as profile on profile.id = export.profile_id
  where profile.auth_user_id = auth.uid()
    and profile.account_status not in ('deletion_pending', 'deleted')
  order by export.created_at desc, export.id;
$function$;

revoke all on function private.data_export_projection(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_own_data_exports()
  from public, anon, authenticated, service_role;
grant execute on function public.get_own_data_exports() to authenticated;
revoke all on type public.data_export_projection
  from public, anon, authenticated, service_role;

-- Append-only extension of the idempotency envelope.
alter table private.idempotency_records
  drop constraint idempotency_records_operation_check,
  drop constraint idempotency_records_outcome_code_check,
  drop constraint idempotency_records_resource_type_check;
alter table private.idempotency_records
  add constraint idempotency_records_operation_check check (operation in (
    'complete_profile', 'update_profile', 'accept_policies',
    'revoke_current_session', 'delete_account', 'request_data_export'
  )),
  add constraint idempotency_records_outcome_code_check check (
    outcome_code is null or outcome_code in (
      'profile_created', 'profile_updated', 'policies_accepted',
      'session_revoked', 'deletion_requested', 'data_export_requested'
    )
  ),
  add constraint idempotency_records_resource_type_check check (
    resource_type is null or resource_type in (
      'profile', 'auth_session', 'deletion_request', 'data_export'
    )
  );

alter function private.validate_idempotency_outcome(text, jsonb)
  rename to validate_through_account_deletion_outcome;

create or replace function private.validate_idempotency_outcome(
  p_operation text, p_outcome jsonb
)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
declare v_id uuid;
begin
  if p_operation <> 'request_data_export' then
    perform private.validate_through_account_deletion_outcome(p_operation, p_outcome);
    return;
  end if;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_outcome) key)
          is distinct from array['export_id','logical_result']::text[]
     or p_outcome ->> 'logical_result' <> 'data_export_requested'
     or jsonb_typeof(p_outcome -> 'export_id') <> 'string'
     or p_outcome ->> 'export_id'
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode='22023', message='VALIDATION';
  end if;
  begin v_id := (p_outcome ->> 'export_id')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode='22023', message='VALIDATION';
  end;
  if p_outcome ->> 'export_id' <> v_id::text then
    raise exception using errcode='22023', message='VALIDATION';
  end if;
end;
$function$;

revoke all on function private.validate_through_account_deletion_outcome(text,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_idempotency_outcome(text,jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.acquire_request_data_export_idempotency(
  p_actor_key text, p_request_id uuid, p_input_hmac text,
  p_canonical_version integer, p_hash_key_version integer
)
returns table(acquired boolean, record_state text, outcome_code text,
              resource_type text, resource_id uuid, outcome jsonb)
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_inserted boolean := false;
  v_wait_timeout_ms bigint;
  v_previous_lock_timeout text;
  v_record private.idempotency_records%rowtype;
begin
  if current_setting('transaction_isolation') <> 'read committed'
     or p_actor_key is null or p_request_id is null or p_input_hmac is null
     or p_canonical_version <> 1 or p_hash_key_version not between 1 and 32767
     or p_input_hmac !~ '^[0-9a-f]{64}$'
     or p_actor_key !~ '^profile:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode='22023', message='VALIDATION';
  end if;
  begin v_actor_id := substring(p_actor_key from 9)::uuid;
  exception when invalid_text_representation then
    raise exception using errcode='22023', message='VALIDATION';
  end;
  if p_actor_key <> 'profile:' || v_actor_id::text
     or not exists(select 1 from public.profiles where id=v_actor_id) then
    raise exception using errcode='22023', message='VALIDATION';
  end if;
  select limit_value into v_wait_timeout_ms from private.app_limits
  where limit_key='idempotency_wait_timeout_ms';
  if v_wait_timeout_ms is null or v_wait_timeout_ms <= 0 then
    raise exception using errcode='22023', message='VALIDATION';
  end if;
  v_previous_lock_timeout := current_setting('lock_timeout');
  begin
    perform set_config('lock_timeout', v_wait_timeout_ms::text || 'ms', true);
    insert into private.idempotency_records(
      actor_key,actor_id,operation,request_id,request_hash,canonical_version,hash_key_version)
    values(p_actor_key,v_actor_id,'request_data_export',p_request_id,p_input_hmac,
           p_canonical_version::smallint,p_hash_key_version::smallint)
    on conflict(actor_key,operation,request_id) do nothing
    returning true into v_inserted;
    perform set_config('lock_timeout',v_previous_lock_timeout,true);
  exception when lock_not_available then
    perform set_config('lock_timeout',v_previous_lock_timeout,true);
    raise exception using errcode='P0001', message='IDEMPOTENCY_WAIT_TIMEOUT';
  end;
  if v_inserted then
    return query select true,'executing_uncommitted'::text,null::text,null::text,null::uuid,null::jsonb;
    return;
  end if;
  select records.* into strict v_record from private.idempotency_records records
  where records.actor_key=p_actor_key and records.operation='request_data_export'
    and records.request_id=p_request_id;
  if v_record.request_hash <> p_input_hmac
     or v_record.canonical_version <> p_canonical_version
     or v_record.hash_key_version <> p_hash_key_version then
    raise exception using errcode='P0001', message='IDEMPOTENCY_CONFLICT';
  end if;
  if v_record.state='payload_expired' then
    raise exception using errcode='P0001', message='IDEMPOTENCY_EXPIRED';
  elsif v_record.state='executing_uncommitted' then
    raise exception using errcode='P0001', message='IDEMPOTENCY_WAIT_TIMEOUT';
  end if;
  return query select false,v_record.state,v_record.outcome_code,
    v_record.resource_type,v_record.resource_id,v_record.outcome;
end;
$function$;

create or replace function private.complete_request_data_export_idempotency(
  p_actor_key text, p_request_id uuid, p_input_hmac text,
  p_canonical_version integer, p_hash_key_version integer, p_outcome jsonb
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare v_actor_id uuid; v_export_id uuid;
begin
  perform private.validate_idempotency_outcome('request_data_export',p_outcome);
  v_actor_id := substring(p_actor_key from 9)::uuid;
  v_export_id := (p_outcome ->> 'export_id')::uuid;
  update private.idempotency_records records
  set state='completed', outcome_code='data_export_requested',
      resource_type='data_export', resource_id=v_export_id, outcome=p_outcome,
      updated_at=now(), completed_at=now()
  where records.actor_key=p_actor_key and records.actor_id=v_actor_id
    and records.operation='request_data_export' and records.request_id=p_request_id
    and records.request_hash=p_input_hmac
    and records.canonical_version=p_canonical_version
    and records.hash_key_version=p_hash_key_version
    and records.state='executing_uncommitted';
  if not found then raise exception using errcode='P0001',message='IDEMPOTENCY_CONFLICT'; end if;
end;
$function$;

revoke all on function private.acquire_request_data_export_idempotency(text,uuid,text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function private.complete_request_data_export_idempotency(text,uuid,text,integer,integer,jsonb)
  from public, anon, authenticated, service_role;

-- Extend the deferred conclusion checker with the new exact resource binding.
create or replace function private.enforce_idempotency_conclusion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare v_record private.idempotency_records%rowtype;
begin
  if tg_op='DELETE' then
    if old.state='executing_uncommitted' then raise exception using errcode='23514',message='IDEMPOTENCY_INCOMPLETE'; end if;
    return null;
  end if;
  if tg_op='INSERT' and new.state<>'executing_uncommitted' then
    raise exception using errcode='23514',message='IDEMPOTENCY_TRANSITION_INVALID';
  end if;
  if tg_op='UPDATE' and not ((old.state='executing_uncommitted' and new.state='completed')
      or (old.state='completed' and new.state='payload_expired')) then
    raise exception using errcode='23514',message='IDEMPOTENCY_TRANSITION_INVALID';
  end if;
  select records.* into v_record from private.idempotency_records records
  where records.actor_key=new.actor_key and records.operation=new.operation
    and records.request_id=new.request_id;
  if found and v_record.state='executing_uncommitted' then
    raise exception using errcode='23514',message='IDEMPOTENCY_INCOMPLETE';
  end if;
  if found and v_record.state='completed' then
    perform private.validate_idempotency_outcome(v_record.operation,v_record.outcome);
    if v_record.outcome_code <> v_record.outcome ->> 'logical_result'
       or (v_record.operation='complete_profile' and (v_record.resource_type<>'profile'
         or v_record.resource_id<>v_record.actor_id or v_record.resource_id<>(v_record.outcome->>'profile_id')::uuid))
       or (v_record.operation in ('update_profile','accept_policies') and (v_record.resource_type is not null or v_record.resource_id is not null))
       or (v_record.operation='revoke_current_session' and (v_record.resource_type<>'auth_session' or v_record.resource_id<>(v_record.outcome->>'session_id')::uuid))
       or (v_record.operation='delete_account' and (v_record.resource_type<>'deletion_request' or v_record.resource_id<>(v_record.outcome->>'deletion_request_id')::uuid))
       or (v_record.operation='request_data_export' and (v_record.resource_type<>'data_export' or v_record.resource_id<>(v_record.outcome->>'export_id')::uuid)) then
      raise exception using errcode='23514',message='IDEMPOTENCY_OUTCOME_INVALID';
    end if;
  end if;
  return null;
end;
$function$;

create or replace function public.request_data_export(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer
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
  if not v_acquired.acquired then
    return jsonb_build_object('outcome',v_acquired.outcome,
      'current',private.data_export_projection(v_profile.id));
  end if;
  select profile.* into v_profile from public.profiles profile
  where profile.id=v_profile.id and profile.auth_user_id=p_actor_auth_user_id for update;
  if not found then raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  if private.is_actor_session_revoked(p_actor_session_id) then
    raise exception using errcode='28000',message='UNAUTHENTICATED';
  end if;
  if v_profile.account_status not in ('active','suspended','banned') then
    raise exception using errcode='42501',message='FORBIDDEN';
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

revoke all on function public.request_data_export(uuid,uuid,uuid,text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.request_data_export(uuid,uuid,uuid,text,integer,integer)
  to service_role;

-- Hourly reconciliation: ready objects past expiry and every downloaded object
-- still carrying a path converge to the same stable delete intent.
create or replace function private.expire_data_exports()
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare v_started_at timestamptz:=clock_timestamp(); v_now timestamptz:=now();
        v_scanned bigint; v_changed bigint;
begin
  select count(*) into v_scanned from private.data_exports export
  where (export.status='ready' and export.expires_at<=v_now)
     or (export.status='downloaded' and export.storage_path is not null);
  update private.data_exports export set status='cleanup_pending'
  where export.status='ready' and export.expires_at<=v_now;
  get diagnostics v_changed=row_count;
  insert into private.external_effects(kind,resource_type,resource_id,dedupe_key)
  select 'delete_data_export','data_export',export.id,'delete_data_export:'||export.id::text
  from private.data_exports export
  where export.status in ('cleanup_pending','downloaded') and export.storage_path is not null
  on conflict(dedupe_key) do nothing;
  insert into private.retention_runs(policy,window_start,window_end,scanned,purged,failed,started_at,finished_at)
  values('expire_data_exports',v_now-interval '1 hour',v_now,v_scanned::integer,
         v_changed::integer,0,v_started_at,clock_timestamp());
  return jsonb_build_object('scanned',v_scanned,'changed',v_changed);
end;
$function$;

create or replace function private.data_export_job_slot(p_job_name text,p_now timestamptz)
returns timestamptz language plpgsql stable set search_path='' as $function$
declare v_slot timestamptz;
begin
  if p_job_name<>'expire_data_exports' then raise exception using errcode='22023',message='VALIDATION'; end if;
  v_slot:=date_trunc('hour',p_now at time zone 'UTC') at time zone 'UTC'+interval '7 minutes';
  return case when v_slot<=p_now then v_slot else v_slot-interval '1 hour' end;
end;
$function$;

-- Extend the three job dispatch functions without changing the earlier slots.
create or replace function public.worker_begin_job(p_job_name text)
returns jsonb language plpgsql volatile security definer set search_path='' as $function$
declare v_now timestamptz:=clock_timestamp(); v_slot timestamptz; v_run_id bigint;
        v_deadline bigint; v_max_effects bigint;
begin
  v_slot:=case when p_job_name='purge_completed_deletion_requests' then private.account_deletion_job_slot(p_job_name,v_now)
    when p_job_name='expire_data_exports' then private.data_export_job_slot(p_job_name,v_now)
    else private.worker_job_slot(p_job_name,v_now) end;
  select max(limit_value) filter(where limit_key='worker_soft_deadline_seconds'),
         max(limit_value) filter(where limit_key='worker_max_effects_per_invocation')
  into v_deadline,v_max_effects from private.app_limits
  where limit_key in ('worker_soft_deadline_seconds','worker_max_effects_per_invocation');
  if v_deadline is null or v_deadline<=0 or v_max_effects is null or v_max_effects<=0 then
    raise exception using errcode='22023',message='VALIDATION'; end if;
  update private.job_runs run set status='failed',finished_at=v_now,error_code='RUN_ABANDONED',
    summary=jsonb_build_object('scanned',0,'changed',0,'skipped',0,'failed',1,'stale',1,
      'duration_ms',greatest(0,floor(extract(epoch from(v_now-run.started_at))*1000)::bigint))
  where run.job_name=p_job_name and run.status='running' and run.scheduled_for<v_slot;
  insert into private.job_runs(run_key,job_name,triggered_by,scheduled_for,status)
  values('cron:'||p_job_name||':'||to_char(v_slot at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         p_job_name,'cron',v_slot,'running') on conflict(run_key) do nothing returning id into v_run_id;
  if v_run_id is null then return jsonb_build_object('acquired',false,'job_name',p_job_name,'scheduled_for',v_slot); end if;
  return jsonb_build_object('acquired',true,'run_id',v_run_id,'job_name',p_job_name,
    'scheduled_for',v_slot,'soft_deadline_seconds',v_deadline,'max_effects',v_max_effects);
end;
$function$;

create or replace function public.worker_execute_database_job(p_run_id bigint)
returns jsonb language plpgsql volatile security definer set search_path='' as $function$
declare v_run private.job_runs%rowtype; v_result jsonb; v_scanned bigint; v_failed bigint; v_stale bigint;
begin
  if p_run_id is null then raise exception using errcode='22023',message='VALIDATION'; end if;
  select run.* into v_run from private.job_runs run where run.id=p_run_id for update;
  if not found or v_run.status<>'running' then raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  if v_run.job_name='purge_expired_revoked_sessions' then
    v_result:=private.purge_expired_revoked_sessions();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_expired_idempotency_outcomes' then
    v_result:=private.purge_expired_idempotency_outcomes(); v_scanned:=(v_result->>'payload_expired')::bigint+(v_result->>'tombstones_deleted')::bigint;
    return jsonb_build_object('scanned',v_scanned,'changed',v_scanned,'skipped',0,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_completed_deletion_requests' then
    v_result:=private.purge_completed_deletion_requests();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='expire_data_exports' then
    v_result:=private.expire_data_exports();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'changed')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'changed')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='health_check_jobs' then
    select count(*),count(*) filter(where run.status='failed'),count(*) filter(where run.error_code='RUN_ABANDONED') into v_scanned,v_failed,v_stale
    from private.job_runs run where run.id<>p_run_id and run.started_at>=now()-interval '24 hours';
    return jsonb_build_object('scanned',v_scanned,'changed',0,'skipped',v_scanned-v_failed,'failed',v_failed,'stale',v_stale,'duration_ms',0);
  end if;
  raise exception using errcode='22023',message='VALIDATION';
end;
$function$;

create or replace function private.invoke_worker_cron(p_job_name text)
returns bigint language plpgsql volatile security definer set search_path='' as $function$
declare v_project_url text; v_publishable_key text; v_cron_secret text; v_request_id bigint;
begin
  if p_job_name='purge_completed_deletion_requests' then perform private.account_deletion_job_slot(p_job_name,clock_timestamp());
  elsif p_job_name='expire_data_exports' then perform private.data_export_job_slot(p_job_name,clock_timestamp());
  else perform private.worker_job_slot(p_job_name,clock_timestamp()); end if;
  begin
    select decrypted_secret into strict v_project_url from vault.decrypted_secrets where name='worker_project_url';
    select decrypted_secret into strict v_publishable_key from vault.decrypted_secrets where name='worker_publishable_key';
    select decrypted_secret into strict v_cron_secret from vault.decrypted_secrets where name='worker_cron_secret';
  exception when no_data_found or too_many_rows then raise exception using errcode='P0001',message='WORKER_CONFIGURATION_MISSING'; end;
  if v_project_url is null or length(v_project_url)=0 or v_publishable_key is null or length(v_publishable_key)=0 or v_cron_secret is null or length(v_cron_secret)=0 then
    raise exception using errcode='P0001',message='WORKER_CONFIGURATION_MISSING'; end if;
  select net.http_post(url:=rtrim(v_project_url,'/')||'/functions/v1/worker/'||p_job_name,body:='{}'::jsonb,
    headers:=jsonb_build_object('Content-Type','application/json','apikey',v_publishable_key,'Authorization','Bearer '||v_cron_secret),timeout_milliseconds:=5000)
  into v_request_id; return v_request_id;
end;
$function$;

select cron.schedule('colete_v1_expire_data_exports','7 * * * *',
  $$select private.invoke_worker_cron('expire_data_exports');$$);

revoke all on function private.expire_data_exports() from public,anon,authenticated,service_role;
revoke all on function private.data_export_job_slot(text,timestamptz) from public,anon,authenticated,service_role;

-- Private Storage bucket. No storage.objects policy is created: client roles
-- have zero access and service_role bypasses RLS by platform design.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('data-exports','data-exports',false,52428800,array['application/zip']::text[]);

create or replace function public.worker_get_data_export_build_target(
  p_effect_id uuid, p_lease_token uuid
)
returns jsonb language plpgsql volatile security definer set search_path='' as $function$
declare v_effect private.external_effects%rowtype; v_export private.data_exports%rowtype;
        v_profile public.profiles%rowtype; v_profile_id uuid;
begin
  select effect.* into v_effect from private.external_effects effect
  where effect.id=p_effect_id for update;
  if not found or v_effect.kind<>'build_data_export' or v_effect.status<>'leased'
     or v_effect.lease_token<>p_lease_token or v_effect.lease_until<=clock_timestamp() then
    raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  -- Read only the key needed to acquire the canonical profile -> export lock
  -- order. The export row is deliberately not locked until the profile is.
  select export.profile_id into v_profile_id from private.data_exports export
  where export.id=v_effect.resource_id;
  if not found then return jsonb_build_object('action','none'); end if;
  select profile.* into v_profile from public.profiles profile where profile.id=v_profile_id for update;
  if not found then return jsonb_build_object('action','purge'); end if;
  select export.* into v_export from private.data_exports export
  where export.id=v_effect.resource_id and export.profile_id=v_profile_id for update;
  if not found then return jsonb_build_object('action','none'); end if;
  if v_export.status in ('failed','expired') then return jsonb_build_object('action','purge'); end if;
  if v_profile.account_status in ('deletion_pending','deleted')
     or v_export.status='cleanup_pending' then return jsonb_build_object('action','purge'); end if;
  if v_export.status='ready' then return jsonb_build_object('action','none'); end if;
  if v_export.status not in ('queued','building') then
    raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  update private.data_exports
  set status=case when status='queued' then 'building' else status end,
      snapshot_at=coalesce(snapshot_at,clock_timestamp())
  where id=v_export.id
  returning * into v_export;
  return jsonb_build_object(
    'action','build','path','exports/'||v_profile.id::text||'/'||v_export.id::text||'.zip',
    'auth_user_id',v_profile.auth_user_id,
    'snapshot',jsonb_build_object(
      'snapshot_at',to_char(v_export.snapshot_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'profile',jsonb_build_object('id',v_profile.id,'name',v_profile.name,'nickname',v_profile.nickname,
        'position',v_profile.position,'dominant_foot',v_profile.dominant_foot,
        'shirt_number',v_profile.shirt_number,'account_status',v_profile.account_status,'created_at',v_profile.created_at),
      'policy_acceptances',coalesce((select jsonb_agg(jsonb_build_object(
        'document_type',a.document_type,'version',a.version,'source',a.source,'accepted_at',a.accepted_at)
        order by a.document_type,a.version) from public.policy_acceptances a where a.profile_id=v_profile.id),'[]'::jsonb),
      'privacy_requests',coalesce((select jsonb_agg(jsonb_build_object(
        'kind',r.kind,'status',r.status,'response',r.response,
        'opened_at',r.opened_at,'resolved_at',r.resolved_at) order by r.opened_at,r.id)
        from public.privacy_requests r where r.profile_id=v_profile.id),'[]'::jsonb),
      'data_exports',coalesce((select jsonb_agg(jsonb_build_object(
        'id',e.id,'status',e.status,'created_at',e.created_at,'ready_at',e.ready_at,
        'expires_at',e.expires_at,'downloaded_at',e.downloaded_at,'purged_at',e.purged_at)
        order by e.created_at,e.id) from private.data_exports e where e.profile_id=v_profile.id),'[]'::jsonb)
    ));
end;
$function$;

create or replace function public.worker_publish_data_export(
  p_effect_id uuid,p_lease_token uuid,p_storage_path text,p_content_digest text
)
returns jsonb language plpgsql volatile security definer set search_path='' as $function$
declare v_effect private.external_effects%rowtype; v_export private.data_exports%rowtype;
begin
  select effect.* into v_effect from private.external_effects effect where effect.id=p_effect_id for update;
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
$function$;

create or replace function public.enqueue_data_export_purge(p_export_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $function$
declare v_export private.data_exports%rowtype;
begin
  select export.* into v_export from private.data_exports export where export.id=p_export_id for update;
  if not found then raise exception using errcode='P0002',message='NOT_FOUND'; end if;
  if v_export.status='ready' then update private.data_exports set status='cleanup_pending' where id=p_export_id; end if;
  insert into private.external_effects(kind,resource_type,resource_id,dedupe_key)
  values('delete_data_export','data_export',p_export_id,'delete_data_export:'||p_export_id::text)
  on conflict(dedupe_key) do nothing;
  return jsonb_build_object('export_id',p_export_id,'queued',true);
end;
$function$;

revoke all on function public.worker_get_data_export_build_target(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.worker_publish_data_export(uuid,uuid,text,text) from public,anon,authenticated,service_role;
revoke all on function public.enqueue_data_export_purge(uuid) from public,anon,authenticated,service_role;
grant execute on function public.worker_get_data_export_build_target(uuid,uuid) to service_role;
grant execute on function public.worker_publish_data_export(uuid,uuid,text,text) to service_role;
grant execute on function public.enqueue_data_export_purge(uuid) to service_role;

create or replace function public.consume_data_export(
  p_actor_auth_user_id uuid,p_actor_session_id uuid,p_export_id uuid
)
returns jsonb language plpgsql volatile security definer set search_path='' as $function$
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
  where export.id=p_export_id for update;
  if not found or v_export.profile_id<>v_profile.id or v_export.status<>'ready'
     or v_export.expires_at<=now() then
    raise exception using errcode='P0001',message='EXPORT_EXPIRED'; end if;
  update private.data_exports set status='downloaded',downloaded_at=now()
  where id=p_export_id and status='ready';
  if not found then raise exception using errcode='P0001',message='EXPORT_EXPIRED'; end if;
  return jsonb_build_object('export_id',v_export.id,'storage_path',v_export.storage_path,
                            'content_digest',v_export.content_digest);
end;
$function$;

-- Finalization uses the same Storage predicate as reconciliation and Auth
-- acquisition. A dead purge is terminal by human decision, but its durable
-- marker survives while the normalized text code is still redacted.
create or replace function public.finalize_deletion(p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
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
  where request.id = p_request_id for update;
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
$function$;

-- 0012 published the generic Storage reconciliation before exports had their
-- final lifecycle. Keep its fencing and deletion-saga behavior, while making
-- normal one-shot and expiry purges preserve their contractual terminal state.
create or replace function public.worker_confirm_deletion_effect(
  p_effect_id uuid,p_lease_token uuid
)
returns jsonb language plpgsql volatile security definer set search_path='' as $function$
declare v_effect private.external_effects%rowtype; v_export private.data_exports%rowtype;
        v_profile_id uuid; v_request_id uuid; v_status text;
begin
  select effect.* into v_effect from private.external_effects effect where effect.id=p_effect_id for update;
  if not found or v_effect.status<>'leased' or v_effect.lease_token<>p_lease_token
     or v_effect.lease_until<=clock_timestamp() then
    raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  if v_effect.kind='delete_data_export' then
    select export.* into v_export from private.data_exports export where export.id=v_effect.resource_id for update;
    if not found then return jsonb_build_object('status','orphan_reconciled'); end if;
    v_profile_id:=v_export.profile_id;
    select id into v_request_id from private.deletion_requests where profile_id=v_profile_id;
    update private.data_exports set
      status=case when v_request_id is not null then 'failed'
                  when v_export.status='downloaded' then 'downloaded'
                  when v_export.status='failed' then 'failed' else 'expired' end,
      storage_path=null,content_digest=null,purged_at=coalesce(purged_at,now())
    where id=v_export.id;
  elsif v_effect.kind='delete_storage_object' and v_effect.resource_type='profile_avatar' then
    v_profile_id:=v_effect.resource_id;
    update public.profiles set photo_url=null where id=v_profile_id;
    select id into v_request_id from private.deletion_requests where profile_id=v_profile_id;
  elsif v_effect.kind='delete_auth_user' and v_effect.resource_type='deletion_request' then
    v_request_id:=v_effect.resource_id;
    if exists(select 1 from auth.users u join private.deletion_requests r on r.auth_user_id=u.id
      where r.id=v_request_id) then raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
    update private.deletion_requests set status='finalizing',auth_deleted_at=coalesce(auth_deleted_at,now()),
      next_attempt_at=null,last_error_code=null where id=v_request_id and status<>'completed';
    return jsonb_build_object('deletion_request_id',v_request_id,'status','finalizing');
  else raise exception using errcode='22023',message='VALIDATION'; end if;
  if v_request_id is null then return jsonb_build_object('status','orphan_reconciled'); end if;
  v_status:=private.reconcile_deletion_request(v_request_id);
  return jsonb_build_object('deletion_request_id',v_request_id,'status',v_status);
end;
$function$;

revoke all on function public.consume_data_export(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.consume_data_export(uuid,uuid,uuid) to service_role;

commit;
