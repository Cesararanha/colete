begin;

-- M1-B, slice 2: governed account deletion from the first transactional
-- request through Storage/Auth reconciliation and irreversible deidentification.
-- Sources: docs/22-plano-m1-b.md section 4; docs/10-schema-db.md sections 2,
-- 11 and 12; docs/13-contratos-funcoes.md sections 0 and 5.3; and
-- docs/14-convencoes-app.md sections 5.2 and 5.3.

-- ---------------------------------------------------------------------------
-- The deletion saga is a service table; clients receive only a typed projection.
-- ---------------------------------------------------------------------------

revoke select on table public.deletion_requests from authenticated;
drop policy deletion_requests_select_own on public.deletion_requests;
alter table public.deletion_requests no force row level security;
alter table public.deletion_requests disable row level security;
alter table public.deletion_requests set schema private;

revoke all on table private.deletion_requests
  from public, anon, authenticated, service_role;

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
      request.status = 'failed_retryable' or request.last_error_code is not null
  )
  from private.deletion_requests as request
  where request.profile_id = p_profile_id;
$function$;

create type public.deletion_request_projection as (
  id uuid,
  status text,
  requested_at timestamptz,
  completed_at timestamptz,
  has_operational_failure boolean
);

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
    request.status = 'failed_retryable' or request.last_error_code is not null
  )::public.deletion_request_projection
  from private.deletion_requests as request
  join public.profiles as profile on profile.id = request.profile_id
  where profile.auth_user_id = auth.uid();
$function$;

comment on function public.get_own_deletion_request() is
  'Typed own-row projection for the deletion-pending shell. It deliberately ignores the session denylist and exposes no Auth identifier, attempt, retry instant or internal error code.';

revoke all on function public.get_own_deletion_request()
  from public, anon, authenticated, service_role;
grant execute on function public.get_own_deletion_request() to authenticated;
revoke all on type public.deletion_request_projection
  from public, anon, authenticated, service_role;

create or replace function private.current_privacy_profile_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select profile.id
  from public.profiles as profile
  where profile.auth_user_id = auth.uid();
$function$;

revoke all on function private.current_privacy_profile_id()
  from public, anon, authenticated, service_role;
grant execute on function private.current_privacy_profile_id() to authenticated;

-- Once deletion_pending commits, an old JWT may use only the deletion
-- projection above and the privacy channel. Direct profile, policy-acceptance
-- and export reads lose their rows immediately. privacy_requests_select_own is
-- intentionally unchanged.
drop policy profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select to authenticated
  using (
    auth_user_id = (select auth.uid())
    and account_status not in ('deletion_pending', 'deleted')
  );

drop policy policy_acceptances_select_own on public.policy_acceptances;
create policy policy_acceptances_select_own
  on public.policy_acceptances for select to authenticated
  using (
    profile_id = (
      select profile.id from public.profiles as profile
      where profile.auth_user_id = (select auth.uid())
        and profile.account_status not in ('deletion_pending', 'deleted')
    )
  );

drop policy data_exports_select_own on public.data_exports;
create policy data_exports_select_own
  on public.data_exports for select to authenticated
  using (
    profile_id = (
      select profile.id from public.profiles as profile
      where profile.auth_user_id = (select auth.uid())
        and profile.account_status not in ('deletion_pending', 'deleted')
    )
  );

drop policy privacy_requests_select_own on public.privacy_requests;
create policy privacy_requests_select_own
  on public.privacy_requests for select to authenticated
  using (profile_id = (select private.current_privacy_profile_id()));

-- ---------------------------------------------------------------------------
-- Append-only extension of the transactional idempotency envelope.
-- ---------------------------------------------------------------------------

alter table private.idempotency_records
  drop constraint idempotency_records_operation_check,
  drop constraint idempotency_records_outcome_code_check,
  drop constraint idempotency_records_resource_type_check;

alter table private.idempotency_records
  add constraint idempotency_records_operation_check check (operation in (
    'complete_profile', 'update_profile', 'accept_policies',
    'revoke_current_session', 'delete_account'
  )),
  add constraint idempotency_records_outcome_code_check check (
    outcome_code is null or outcome_code in (
      'profile_created', 'profile_updated', 'policies_accepted',
      'session_revoked', 'deletion_requested'
    )
  ),
  add constraint idempotency_records_resource_type_check check (
    resource_type is null or resource_type in (
      'profile', 'auth_session', 'deletion_request'
    )
  );

-- Preserve the four exact M1-A shapes behind a private delegate and extend the
-- public validator name with exactly one new shape. The delegate remains
-- unreachable to every client and administrative role.
alter function private.validate_idempotency_outcome(text, jsonb)
  rename to validate_m1a_idempotency_outcome;

create or replace function private.validate_idempotency_outcome(
  p_operation text,
  p_outcome jsonb
)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_request_id uuid;
begin
  if p_operation <> 'delete_account' then
    perform private.validate_m1a_idempotency_outcome(p_operation, p_outcome);
    return;
  end if;

  if p_outcome is null
     or jsonb_typeof(p_outcome) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
          is distinct from array['deletion_request_id', 'logical_result']::text[]
     or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
     or p_outcome ->> 'logical_result' <> 'deletion_requested'
     or jsonb_typeof(p_outcome -> 'deletion_request_id') <> 'string'
     or p_outcome ->> 'deletion_request_id'
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  begin
    v_request_id := (p_outcome ->> 'deletion_request_id')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end;

  if p_outcome ->> 'deletion_request_id' <> v_request_id::text then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
end;
$function$;

revoke all on function private.validate_m1a_idempotency_outcome(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_idempotency_outcome(text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.acquire_delete_account_idempotency(
  p_actor_key text,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer
)
returns table (
  acquired boolean,
  record_state text,
  outcome_code text,
  resource_type text,
  resource_id uuid,
  outcome jsonb
)
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
     or p_canonical_version <> 1
     or p_hash_key_version not between 1 and 32767
     or p_input_hmac !~ '^[0-9a-f]{64}$'
     or p_actor_key
        !~ '^profile:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  begin
    v_actor_id := substring(p_actor_key from 9)::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end;

  if p_actor_key <> 'profile:' || v_actor_id::text
     or not exists (select 1 from public.profiles where id = v_actor_id) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  select limit_value into v_wait_timeout_ms
  from private.app_limits where limit_key = 'idempotency_wait_timeout_ms';
  if v_wait_timeout_ms is null or v_wait_timeout_ms <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  v_previous_lock_timeout := current_setting('lock_timeout');
  begin
    perform set_config('lock_timeout', v_wait_timeout_ms::text || 'ms', true);
    insert into private.idempotency_records (
      actor_key, actor_id, operation, request_id, request_hash,
      canonical_version, hash_key_version
    ) values (
      p_actor_key, v_actor_id, 'delete_account', p_request_id, p_input_hmac,
      p_canonical_version::smallint, p_hash_key_version::smallint
    )
    on conflict (actor_key, operation, request_id) do nothing
    returning true into v_inserted;
    perform set_config('lock_timeout', v_previous_lock_timeout, true);
  exception when lock_not_available then
    perform set_config('lock_timeout', v_previous_lock_timeout, true);
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_WAIT_TIMEOUT';
  end;

  if v_inserted then
    return query select true, 'executing_uncommitted'::text, null::text,
      null::text, null::uuid, null::jsonb;
    return;
  end if;

  select records.* into strict v_record
  from private.idempotency_records as records
  where records.actor_key = p_actor_key
    and records.operation = 'delete_account'
    and records.request_id = p_request_id;

  if v_record.request_hash <> p_input_hmac
     or v_record.canonical_version <> p_canonical_version
     or v_record.hash_key_version <> p_hash_key_version then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
  end if;
  if v_record.state = 'payload_expired' then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_EXPIRED';
  elsif v_record.state = 'executing_uncommitted' then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_WAIT_TIMEOUT';
  end if;

  return query select false, v_record.state, v_record.outcome_code,
    v_record.resource_type, v_record.resource_id, v_record.outcome;
end;
$function$;

create or replace function private.complete_delete_account_idempotency(
  p_actor_key text,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer,
  p_outcome jsonb
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_request_id uuid;
begin
  perform private.validate_idempotency_outcome('delete_account', p_outcome);
  begin
    v_actor_id := substring(p_actor_key from 9)::uuid;
    v_request_id := (p_outcome ->> 'deletion_request_id')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end;

  update private.idempotency_records as records
  set state = 'completed',
      outcome_code = 'deletion_requested',
      resource_type = 'deletion_request',
      resource_id = v_request_id,
      outcome = p_outcome,
      updated_at = now(),
      completed_at = now()
  where records.actor_key = p_actor_key
    and records.actor_id = v_actor_id
    and records.operation = 'delete_account'
    and records.request_id = p_request_id
    and records.request_hash = p_input_hmac
    and records.canonical_version = p_canonical_version
    and records.hash_key_version = p_hash_key_version
    and records.state = 'executing_uncommitted';

  if not found then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
  end if;
end;
$function$;

revoke all on function private.acquire_delete_account_idempotency(text, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function private.complete_delete_account_idempotency(text, uuid, text, integer, integer, jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.enforce_idempotency_conclusion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_record private.idempotency_records%rowtype;
begin
  if tg_op = 'DELETE' then
    if old.state = 'executing_uncommitted' then
      raise exception using errcode = '23514', message = 'IDEMPOTENCY_INCOMPLETE';
    end if;
    return null;
  end if;
  if tg_op = 'INSERT' and new.state <> 'executing_uncommitted' then
    raise exception using errcode = '23514', message = 'IDEMPOTENCY_TRANSITION_INVALID';
  end if;
  if tg_op = 'UPDATE' and not (
    (old.state = 'executing_uncommitted' and new.state = 'completed')
    or (old.state = 'completed' and new.state = 'payload_expired')
  ) then
    raise exception using errcode = '23514', message = 'IDEMPOTENCY_TRANSITION_INVALID';
  end if;

  select records.* into v_record
  from private.idempotency_records as records
  where records.actor_key = new.actor_key
    and records.operation = new.operation
    and records.request_id = new.request_id;

  if found and v_record.state = 'executing_uncommitted' then
    raise exception using errcode = '23514', message = 'IDEMPOTENCY_INCOMPLETE';
  end if;
  if found and v_record.state = 'completed' then
    perform private.validate_idempotency_outcome(v_record.operation, v_record.outcome);
    if v_record.outcome_code <> v_record.outcome ->> 'logical_result'
       or (v_record.operation = 'complete_profile' and (
         v_record.resource_type <> 'profile'
         or v_record.resource_id <> v_record.actor_id
         or v_record.resource_id <> (v_record.outcome ->> 'profile_id')::uuid
       ))
       or (v_record.operation in ('update_profile', 'accept_policies')
           and (v_record.resource_type is not null or v_record.resource_id is not null))
       or (v_record.operation = 'revoke_current_session' and (
         v_record.resource_type <> 'auth_session'
         or v_record.resource_id <> (v_record.outcome ->> 'session_id')::uuid
       ))
       or (v_record.operation = 'delete_account' and (
         v_record.resource_type <> 'deletion_request'
         or v_record.resource_id <> (v_record.outcome ->> 'deletion_request_id')::uuid
       )) then
      raise exception using errcode = '23514', message = 'IDEMPOTENCY_OUTCOME_INVALID';
    end if;
  end if;
  return null;
end;
$function$;

revoke all on function private.enforce_idempotency_conclusion()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Initial account-deletion transaction and saga reconciliation.
-- ---------------------------------------------------------------------------

create or replace function private.require_financial_deletion_substitute(p_profile_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $function$
begin
  if p_profile_id is null
     or not exists (select 1 from public.profiles where id = p_profile_id) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  -- Groups, disputes and financial cases do not exist in M1-B. This is the
  -- mandatory extension point: their migrations replace this primitive and
  -- keep delete_account calling it before any domain authority is removed.
end;
$function$;

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

  select exists (
    select 1 from public.profiles where id = v_request.profile_id and photo_url is not null
  ) or exists (
    select 1 from public.data_exports
    where profile_id = v_request.profile_id and storage_path is not null
  ) into v_has_storage;

  if v_has_storage then
    update private.deletion_requests
    set status = 'cleaning_storage', next_attempt_at = null, last_error_code = null
    where id = p_request_id;
    return 'cleaning_storage';
  end if;

  update private.deletion_requests
  set status = 'deleting_auth', next_attempt_at = null, last_error_code = null
  where id = p_request_id;
  insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
  values ('delete_auth_user', 'deletion_request', p_request_id,
          'delete_auth_user:' || p_request_id::text)
  on conflict (dedupe_key) do nothing;
  return 'deleting_auth';
end;
$function$;

create or replace function public.delete_account(
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
  v_profile_id uuid;
  v_profile public.profiles%rowtype;
  v_actor_key text;
  v_acquired record;
  v_request_id uuid;
  v_lifetime_seconds bigint;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;

  select id into v_profile_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if v_profile_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_profile_id::text;

  select * into v_acquired
  from private.acquire_delete_account_idempotency(
    v_actor_key, p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);
  if not v_acquired.acquired then
    return jsonb_build_object(
      'outcome', v_acquired.outcome,
      'current', private.deletion_request_projection(v_profile_id)
    );
  end if;

  -- Lock order: idempotency first, then profile. Previous-saga detection is the
  -- first decision under that lock, before the financial extension point.
  select profile.* into v_profile
  from public.profiles as profile
  where profile.id = v_profile_id and profile.auth_user_id = p_actor_auth_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;
  if exists (select 1 from private.deletion_requests where profile_id = v_profile_id) then
    raise exception using errcode = 'P0001', message = 'DELETION_ALREADY_PENDING';
  end if;
  if private.is_actor_session_revoked(p_actor_session_id) then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  if v_profile.account_status not in ('active', 'suspended', 'banned') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  perform private.require_financial_deletion_substitute(v_profile_id);

  -- No object may later become ready. Rows without an object terminate as
  -- failed/cancelled; every existing object becomes cleanup_pending and gets a
  -- deduplicated purge intent.
  update public.data_exports
  set status = 'failed', purged_at = now()
  where profile_id = v_profile_id and status in ('queued', 'building');

  update public.data_exports
  set status = 'cleanup_pending'
  where profile_id = v_profile_id and storage_path is not null
    and status in ('ready', 'downloaded', 'cleanup_pending');

  insert into private.deletion_requests (profile_id, auth_user_id)
  values (v_profile_id, p_actor_auth_user_id)
  returning id into v_request_id;

  insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
  select 'delete_data_export', 'data_export', export.id,
         'delete_data_export:' || export.id::text || ':' || v_request_id::text
  from public.data_exports as export
  where export.profile_id = v_profile_id and export.storage_path is not null
  on conflict (dedupe_key) do nothing;

  if v_profile.photo_url is not null then
    insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
    values ('delete_storage_object', 'profile_avatar', v_profile_id,
            'delete_storage_object:profile_avatar:' || v_profile_id::text)
    on conflict (dedupe_key) do nothing;
  end if;

  -- Enqueueing is not advancing the saga. If there is no known Storage work,
  -- create the Auth intent now so the worker has something to acquire, while
  -- the request itself remains in the contractual initial state.
  if v_profile.photo_url is null and not exists (
    select 1 from public.data_exports
    where profile_id = v_profile_id and storage_path is not null
  ) then
    insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
    values ('delete_auth_user', 'deletion_request', v_request_id,
            'delete_auth_user:' || v_request_id::text)
    on conflict (dedupe_key) do nothing;
  end if;

  select limit_value into v_lifetime_seconds
  from private.app_limits where limit_key = 'auth_session_max_lifetime_seconds';
  if v_lifetime_seconds is null or v_lifetime_seconds <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  insert into private.revoked_auth_sessions (session_id, profile_id, expires_at)
  values (p_actor_session_id, v_profile_id,
          now() + make_interval(secs => v_lifetime_seconds::integer))
  on conflict (session_id) do nothing;

  update public.profiles
  set account_status = 'deletion_pending', status_changed_at = now()
  where id = v_profile_id;

  v_outcome := jsonb_build_object(
    'deletion_request_id', v_request_id::text,
    'logical_result', 'deletion_requested');
  perform private.complete_delete_account_idempotency(
    v_actor_key, p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);

  return jsonb_build_object(
    'outcome', v_outcome,
    'current', jsonb_build_object(
      'id', v_request_id,
      'status', 'requested',
      'requested_at', (select requested_at from private.deletion_requests where id = v_request_id),
      'completed_at', null,
      'has_operational_failure', false
    )
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Fenced worker projections and confirmations for Storage/Auth handlers.
-- ---------------------------------------------------------------------------

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
    select storage_path, profile_id into v_path, v_profile_id
    from public.data_exports where id = v_effect.resource_id;
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

create or replace function public.worker_confirm_deletion_effect(
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
  v_profile_id uuid;
  v_request_id uuid;
  v_status text;
begin
  select effect.* into v_effect from private.external_effects as effect
  where effect.id = p_effect_id for update;
  if not found or v_effect.status <> 'leased'
     or v_effect.lease_token <> p_lease_token
     or v_effect.lease_until <= clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;

  if v_effect.kind = 'delete_data_export' then
    select profile_id into v_profile_id from public.data_exports
    where id = v_effect.resource_id;
    update public.data_exports
    set status = 'failed', storage_path = null, content_digest = null, purged_at = now()
    where id = v_effect.resource_id and storage_path is not null;
    select id into v_request_id from private.deletion_requests
    where profile_id = v_profile_id;
  elsif v_effect.kind = 'delete_storage_object'
        and v_effect.resource_type = 'profile_avatar' then
    v_profile_id := v_effect.resource_id;
    update public.profiles set photo_url = null where id = v_profile_id;
    select id into v_request_id from private.deletion_requests
    where profile_id = v_profile_id;
  elsif v_effect.kind = 'delete_auth_user'
        and v_effect.resource_type = 'deletion_request' then
    v_request_id := v_effect.resource_id;
    if exists (
      select 1 from auth.users as auth_user
      join private.deletion_requests as request
        on request.auth_user_id = auth_user.id
      where request.id = v_request_id
    ) then
      raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
    end if;
    update private.deletion_requests
    set status = 'finalizing', auth_deleted_at = coalesce(auth_deleted_at, now()),
        next_attempt_at = null, last_error_code = null
    where id = v_request_id and status <> 'completed';
    return jsonb_build_object('deletion_request_id', v_request_id, 'status', 'finalizing');
  else
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  if v_request_id is null then
    return jsonb_build_object('status', 'orphan_reconciled');
  end if;
  v_status := private.reconcile_deletion_request(v_request_id);
  return jsonb_build_object('deletion_request_id', v_request_id, 'status', v_status);
end;
$function$;

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
     or exists (select 1 from public.profiles where id = v_profile_id and photo_url is not null)
     or exists (select 1 from public.data_exports
                where profile_id = v_profile_id and storage_path is not null) then
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

-- Keep saga diagnostics aligned with the fenced external-effect attempt. Only
-- normalized codes and server-derived instants cross this trigger.
create or replace function private.sync_deletion_failure_from_effect()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_request_id uuid;
begin
  if new.kind not in ('delete_data_export', 'delete_storage_object', 'delete_auth_user')
     or new.status not in ('failed_retryable', 'dead') then
    return new;
  end if;
  if new.kind = 'delete_auth_user' then
    v_request_id := new.resource_id;
  elsif new.kind = 'delete_data_export' then
    select request.id into v_request_id
    from public.data_exports as export
    join private.deletion_requests as request on request.profile_id = export.profile_id
    where export.id = new.resource_id;
  elsif new.resource_type = 'profile_avatar' then
    select id into v_request_id from private.deletion_requests
    where profile_id = new.resource_id;
  end if;
  if v_request_id is not null then
    update private.deletion_requests
    set status = 'failed_retryable',
        attempts = greatest(attempts, new.attempts),
        next_attempt_at = new.next_attempt_at,
        last_error_code = new.last_error_code
    where id = v_request_id and status <> 'completed';
  end if;
  return new;
end;
$function$;

create trigger external_effects_sync_deletion_failure
after update of status, next_attempt_at, last_error_code on private.external_effects
for each row execute function private.sync_deletion_failure_from_effect();

-- ---------------------------------------------------------------------------
-- Daily retention of completed, still-identifiable saga rows.
-- ---------------------------------------------------------------------------

create or replace function private.purge_completed_deletion_requests()
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
  select count(*) into v_scanned from private.deletion_requests
  where status = 'completed' and completed_at <= v_now - interval '90 days';
  delete from private.deletion_requests
  where status = 'completed' and completed_at <= v_now - interval '90 days';
  get diagnostics v_purged = row_count;
  insert into private.retention_runs
    (policy, window_start, window_end, scanned, purged, failed, started_at, finished_at)
  values ('purge_completed_deletion_requests', v_now - interval '90 days', v_now,
          v_scanned::integer, v_purged::integer, 0, v_started_at, clock_timestamp());
  return jsonb_build_object('scanned', v_scanned, 'purged', v_purged);
end;
$function$;

create or replace function private.account_deletion_job_slot(
  p_job_name text,
  p_now timestamptz
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_slot timestamptz;
begin
  if p_job_name <> 'purge_completed_deletion_requests' then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_slot := date_trunc('day', p_now at time zone 'UTC') at time zone 'UTC'
            + interval '3 hours 43 minutes';
  return case when v_slot <= p_now then v_slot else v_slot - interval '1 day' end;
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
  v_slot := case when p_job_name = 'purge_completed_deletion_requests'
    then private.account_deletion_job_slot(p_job_name, v_now)
    else private.worker_job_slot(p_job_name, v_now) end;
  select max(limit_value) filter (where limit_key = 'worker_soft_deadline_seconds'),
         max(limit_value) filter (where limit_key = 'worker_max_effects_per_invocation')
  into v_deadline, v_max_effects from private.app_limits
  where limit_key in ('worker_soft_deadline_seconds', 'worker_max_effects_per_invocation');
  if v_deadline is null or v_deadline <= 0 or v_max_effects is null or v_max_effects <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  update private.job_runs as run
  set status = 'failed', finished_at = v_now, error_code = 'RUN_ABANDONED',
      summary = jsonb_build_object('scanned',0,'changed',0,'skipped',0,'failed',1,
        'stale',1,'duration_ms',greatest(0, floor(extract(epoch from (v_now-run.started_at))*1000)::bigint))
  where run.job_name = p_job_name and run.status = 'running' and run.scheduled_for < v_slot;
  insert into private.job_runs (run_key, job_name, triggered_by, scheduled_for, status)
  values ('cron:' || p_job_name || ':' || to_char(v_slot at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          p_job_name, 'cron', v_slot, 'running')
  on conflict (run_key) do nothing returning id into v_run_id;
  if v_run_id is null then
    return jsonb_build_object('acquired',false,'job_name',p_job_name,'scheduled_for',v_slot);
  end if;
  return jsonb_build_object('acquired',true,'run_id',v_run_id,'job_name',p_job_name,
    'scheduled_for',v_slot,'soft_deadline_seconds',v_deadline,'max_effects',v_max_effects);
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
  if p_run_id is null then raise exception using errcode='22023',message='VALIDATION'; end if;
  select run.* into v_run from private.job_runs as run where run.id=p_run_id for update;
  if not found or v_run.status <> 'running' then
    raise exception using errcode='P0001',message='CONCURRENT_CHANGE';
  end if;
  if v_run.job_name = 'purge_expired_revoked_sessions' then
    v_result := private.purge_expired_revoked_sessions();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,
      'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name = 'purge_expired_idempotency_outcomes' then
    v_result := private.purge_expired_idempotency_outcomes();
    v_scanned := (v_result->>'payload_expired')::bigint+(v_result->>'tombstones_deleted')::bigint;
    return jsonb_build_object('scanned',v_scanned,'changed',v_scanned,'skipped',0,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name = 'purge_completed_deletion_requests' then
    v_result := private.purge_completed_deletion_requests();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,
      'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name = 'health_check_jobs' then
    select count(*),count(*) filter(where run.status='failed'),count(*) filter(where run.error_code='RUN_ABANDONED')
    into v_scanned,v_failed,v_stale from private.job_runs as run
    where run.id<>p_run_id and run.started_at>=now()-interval '24 hours';
    return jsonb_build_object('scanned',v_scanned,'changed',0,'skipped',v_scanned-v_failed,
      'failed',v_failed,'stale',v_stale,'duration_ms',0);
  end if;
  raise exception using errcode='22023',message='VALIDATION';
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
  v_project_url text; v_publishable_key text; v_cron_secret text; v_request_id bigint;
begin
  if p_job_name = 'purge_completed_deletion_requests' then
    perform private.account_deletion_job_slot(p_job_name, clock_timestamp());
  else
    perform private.worker_job_slot(p_job_name, clock_timestamp());
  end if;
  begin
    select decrypted_secret into strict v_project_url from vault.decrypted_secrets where name='worker_project_url';
    select decrypted_secret into strict v_publishable_key from vault.decrypted_secrets where name='worker_publishable_key';
    select decrypted_secret into strict v_cron_secret from vault.decrypted_secrets where name='worker_cron_secret';
  exception when no_data_found or too_many_rows then
    raise exception using errcode='P0001',message='WORKER_CONFIGURATION_MISSING';
  end;
  if v_project_url is null or length(v_project_url)=0 or v_publishable_key is null
     or length(v_publishable_key)=0 or v_cron_secret is null or length(v_cron_secret)=0 then
    raise exception using errcode='P0001',message='WORKER_CONFIGURATION_MISSING';
  end if;
  select net.http_post(url:=rtrim(v_project_url,'/')||'/functions/v1/worker/'||p_job_name,
    body:='{}'::jsonb,headers:=jsonb_build_object('Content-Type','application/json','apikey',v_publishable_key,
      'Authorization','Bearer '||v_cron_secret),timeout_milliseconds:=5000) into v_request_id;
  return v_request_id;
end;
$function$;

select cron.schedule('colete_v1_purge_completed_deletion_requests','43 3 * * *',
  $$select private.invoke_worker_cron('purge_completed_deletion_requests');$$);

revoke all on function private.require_financial_deletion_substitute(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.reconcile_deletion_request(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.sync_deletion_failure_from_effect()
  from public, anon, authenticated, service_role;
revoke all on function private.purge_completed_deletion_requests()
  from public, anon, authenticated, service_role;
revoke all on function private.account_deletion_job_slot(text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.deletion_request_projection(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_account(uuid,uuid,uuid,text,integer,integer)
  from public, anon, authenticated;
revoke all on function public.worker_get_deletion_effect_target(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.worker_confirm_deletion_effect(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.finalize_deletion(uuid)
  from public, anon, authenticated;

grant execute on function public.delete_account(uuid,uuid,uuid,text,integer,integer)
  to service_role;
grant execute on function public.worker_get_deletion_effect_target(uuid,uuid)
  to service_role;
grant execute on function public.worker_confirm_deletion_effect(uuid,uuid)
  to service_role;
grant execute on function public.finalize_deletion(uuid) to service_role;

commit;
