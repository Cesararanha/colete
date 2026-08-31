begin;

-- M1-A, slice 1: transactional idempotency and the application privilege boundary.
--
-- There is intentionally no public RPC in this migration. These helpers are
-- SECURITY INVOKER building blocks for a later SECURITY DEFINER RPC. The RPC,
-- its domain mutation and complete_idempotency must share one transaction.

-- app_limits was born with a closed unit vocabulary. Extend it here instead of
-- rewriting migration 0002, so an already-applied database follows the same path.
alter table private.app_limits
  drop constraint app_limits_unit_check;

alter table private.app_limits
  add constraint app_limits_unit_check
  check (unit in ('bytes', 'seconds', 'attempts', 'milliseconds'));

insert into private.app_limits (limit_key, limit_value, unit, notes)
values (
  'idempotency_wait_timeout_ms',
  3000,
  'milliseconds',
  'Initial pilot calibration: maximum wait for an in-flight request with the same idempotency key. Keep retries short; never turn this into a lease.'
);

create table private.idempotency_records (
  actor_key text not null,
  actor_id uuid references public.profiles(id) on update restrict on delete restrict,
  operation text not null,
  request_id uuid not null,
  request_hash text not null,
  canonical_version smallint not null default 1,
  hash_key_version smallint not null,
  state text not null default 'executing_uncommitted',
  outcome_code text,
  resource_type text,
  resource_id uuid,
  outcome jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  outcome_expires_at timestamptz not null default (now() + interval '30 days'),
  payload_expired_at timestamptz,
  record_expires_at timestamptz not null default (now() + interval '24 months'),
  primary key (actor_key, operation, request_id),
  check (length(actor_key) between 1 and 128),
  check (operation in (
    'complete_profile',
    'update_profile',
    'accept_policies',
    'revoke_current_session'
  )),
  check (request_hash ~ '^[0-9a-f]{64}$'),
  check (canonical_version = 1),
  check (hash_key_version > 0),
  check (state in ('executing_uncommitted', 'completed', 'payload_expired')),
  check (outcome_code is null or outcome_code in (
    'profile_created',
    'profile_updated',
    'policies_accepted',
    'session_revoked'
  )),
  check (resource_type is null or resource_type in ('profile', 'auth_session')),
  check ((resource_type is null) = (resource_id is null)),
  check (
    (
      actor_key ~ '^profile:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and operation <> 'complete_profile'
      and actor_id is not null
      and actor_key = 'profile:' || actor_id::text
    )
    or (
      actor_key ~ '^system:[a-z][a-z0-9_]{0,62}$'
      and operation <> 'complete_profile'
      and actor_id is null
    )
    or (
      actor_key ~ '^bootstrap:[0-9a-f]{64}$'
      and operation = 'complete_profile'
      and (
        (state = 'executing_uncommitted' and actor_id is null)
        or (state in ('completed', 'payload_expired') and actor_id is not null)
      )
    )
  ),
  check (
    (
      state = 'executing_uncommitted'
      and outcome_code is null
      and resource_type is null
      and resource_id is null
      and outcome is null
      and completed_at is null
      and payload_expired_at is null
    )
    or (
      state = 'completed'
      and outcome_code is not null
      and outcome is not null
      and completed_at is not null
      and payload_expired_at is null
    )
    or (
      state = 'payload_expired'
      and outcome_code is not null
      and outcome is null
      and completed_at is not null
      and payload_expired_at is not null
    )
  ),
  check (updated_at >= created_at),
  check (completed_at is null or completed_at >= created_at),
  check (payload_expired_at is null or payload_expired_at >= outcome_expires_at),
  check (outcome_expires_at = created_at + interval '30 days'),
  check (record_expires_at = created_at + interval '24 months')
);

comment on table private.idempotency_records is
  'Server-only idempotency state. request_hash is the lowercase hex HMAC-SHA256 of the canonical input; it is not a raw payload digest.';
comment on column private.idempotency_records.actor_key is
  'Closed namespace: profile:<canonical UUID>, system:<lower_snake_case name>, or bootstrap:<lowercase SHA-256>. complete_profile belongs exclusively to the bootstrap namespace and no other operation may use it. Only an executing_uncommitted complete_profile bootstrap may have no actor_id.';
comment on column private.idempotency_records.outcome is
  'Small replay-safe response only. It must pass private.validate_idempotency_outcome and must never contain secrets or raw request payloads.';
comment on column private.idempotency_records.outcome_expires_at is
  'The replay payload is retained for exactly 30 days from creation.';
comment on column private.idempotency_records.record_expires_at is
  'The payload-free conflict tombstone is retained for exactly 24 months from creation.';

create index idempotency_records_record_expiry_idx
  on private.idempotency_records (record_expires_at);

-- Service tables are intentionally protected by schema/table privileges, not
-- RLS. With no client DML grants, RLS would add no boundary and could make a
-- future SECURITY DEFINER helper fail open by hiding rows it has to enforce.
revoke all on table private.idempotency_records from public, anon, authenticated, service_role;

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
  v_item jsonb;
  v_document_type text;
  v_version text;
  v_sort_key bytea;
  v_previous_sort_key bytea;
  v_uuid uuid;
begin
  if p_operation not in (
    'complete_profile',
    'update_profile',
    'accept_policies',
    'revoke_current_session'
  ) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  if p_outcome is null
     or jsonb_typeof(p_outcome) <> 'object'
     or octet_length(p_outcome::text) > 4096 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  if p_operation = 'complete_profile' then
    if (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
         is distinct from array['logical_result', 'profile_id']::text[]
       or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
       or p_outcome ->> 'logical_result' <> 'profile_created'
       or jsonb_typeof(p_outcome -> 'profile_id') <> 'string'
       or p_outcome ->> 'profile_id'
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;

    begin
      v_uuid := (p_outcome ->> 'profile_id')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end;

    if p_outcome ->> 'profile_id' <> v_uuid::text then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  elsif p_operation = 'update_profile' then
    if (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
         is distinct from array['logical_result']::text[]
       or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
       or p_outcome ->> 'logical_result' <> 'profile_updated' then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  elsif p_operation = 'accept_policies' then
    if (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
         is distinct from array['accepted', 'logical_result']::text[]
       or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
       or p_outcome ->> 'logical_result' <> 'policies_accepted'
       or jsonb_typeof(p_outcome -> 'accepted') <> 'array'
       or jsonb_array_length(p_outcome -> 'accepted') not between 1 and 2 then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;

    for v_item in
      select value from jsonb_array_elements(p_outcome -> 'accepted') with ordinality
      order by ordinality
    loop
      if jsonb_typeof(v_item) <> 'object'
         or (select array_agg(key order by key) from jsonb_object_keys(v_item) as key)
              is distinct from array['document_type', 'version']::text[]
         or jsonb_typeof(v_item -> 'document_type') <> 'string'
         or jsonb_typeof(v_item -> 'version') <> 'string' then
        raise exception using errcode = '22023', message = 'VALIDATION';
      end if;

      v_document_type := v_item ->> 'document_type';
      v_version := v_item ->> 'version';

      if v_document_type not in ('privacy', 'terms')
         or v_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' then
        raise exception using errcode = '22023', message = 'VALIDATION';
      end if;

      v_sort_key := convert_to(v_document_type, 'UTF8')
        || '\x00'::bytea
        || convert_to(v_version, 'UTF8');
      if v_previous_sort_key is not null and v_sort_key <= v_previous_sort_key then
        raise exception using errcode = '22023', message = 'VALIDATION';
      end if;
      v_previous_sort_key := v_sort_key;
    end loop;
  else
    if (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
         is distinct from array['logical_result', 'revoked_at', 'session_id']::text[]
       or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
       or p_outcome ->> 'logical_result' <> 'session_revoked'
       or jsonb_typeof(p_outcome -> 'session_id') <> 'string'
       or p_outcome ->> 'session_id'
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or jsonb_typeof(p_outcome -> 'revoked_at') <> 'string'
       or p_outcome ->> 'revoked_at'
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;

    begin
      v_uuid := (p_outcome ->> 'session_id')::uuid;
      perform (p_outcome ->> 'revoked_at')::timestamptz;
    exception
      when invalid_text_representation or datetime_field_overflow then
        raise exception using errcode = '22023', message = 'VALIDATION';
    end;

    if p_outcome ->> 'session_id' <> v_uuid::text then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  end if;
end;
$function$;

comment on function private.validate_idempotency_outcome(text, jsonb) is
  'Rejects every replay payload outside the four exact M1-A identity shapes, including unknown keys, unordered/duplicate acceptances and sensitive-looking extras.';

create or replace function private.acquire_idempotency(
  p_actor_key text,
  p_operation text,
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
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  if p_actor_key is null or p_operation is null or p_request_id is null
     or p_input_hmac is null or p_canonical_version is null
     or p_hash_key_version is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  if p_operation not in (
    'complete_profile',
    'update_profile',
    'accept_policies',
    'revoke_current_session'
  )
     or p_input_hmac !~ '^[0-9a-f]{64}$'
     or p_canonical_version <> 1
     or p_hash_key_version not between 1 and 32767 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  if p_actor_key ~ '^profile:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     and p_operation <> 'complete_profile' then
    begin
      v_actor_id := substring(p_actor_key from 9)::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end;

    if p_actor_key <> 'profile:' || v_actor_id::text then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;

    if not exists (
      select 1 from public.profiles as profile where profile.id = v_actor_id
    ) then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  elsif p_actor_key ~ '^system:[a-z][a-z0-9_]{0,62}$'
        and p_operation <> 'complete_profile' then
    v_actor_id := null;
  elsif p_actor_key ~ '^bootstrap:[0-9a-f]{64}$'
        and p_operation = 'complete_profile' then
    v_actor_id := null;
  else
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  select limits.limit_value
  into v_wait_timeout_ms
  from private.app_limits as limits
  where limits.limit_key = 'idempotency_wait_timeout_ms';

  if v_wait_timeout_ms is null or v_wait_timeout_ms <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  v_previous_lock_timeout := current_setting('lock_timeout');

  begin
    perform set_config('lock_timeout', v_wait_timeout_ms::text || 'ms', true);

    insert into private.idempotency_records (
      actor_key,
      actor_id,
      operation,
      request_id,
      request_hash,
      canonical_version,
      hash_key_version
    )
    values (
      p_actor_key,
      v_actor_id,
      p_operation,
      p_request_id,
      p_input_hmac,
      p_canonical_version::smallint,
      p_hash_key_version::smallint
    )
    on conflict (actor_key, operation, request_id) do nothing
    returning true into v_inserted;

    perform set_config('lock_timeout', v_previous_lock_timeout, true);
  exception when lock_not_available then
    perform set_config('lock_timeout', v_previous_lock_timeout, true);
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_WAIT_TIMEOUT';
  end;

  if v_inserted then
    return query
    select true, 'executing_uncommitted'::text, null::text, null::text, null::uuid, null::jsonb;
    return;
  end if;

  select records.*
  into strict v_record
  from private.idempotency_records as records
  where records.actor_key = p_actor_key
    and records.operation = p_operation
    and records.request_id = p_request_id;

  if v_record.request_hash <> p_input_hmac
     or v_record.canonical_version <> p_canonical_version
     or v_record.hash_key_version <> p_hash_key_version then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
  end if;

  if v_record.state = 'payload_expired' then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_EXPIRED';
  elsif v_record.state = 'executing_uncommitted' then
    -- This can only be the caller's own uncommitted placeholder. It is never a
    -- lease and no second execution is allowed to take it over.
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_WAIT_TIMEOUT';
  end if;

  return query
  select
    false,
    v_record.state,
    v_record.outcome_code,
    v_record.resource_type,
    v_record.resource_id,
    v_record.outcome;
end;
$function$;

comment on function private.acquire_idempotency(text, text, uuid, text, integer, integer) is
  'INSERT-first acquire for READ COMMITTED transactions. A unique-key conflict waits at most app_limits.idempotency_wait_timeout_ms, then observes the committed row in a new statement.';

create or replace function private.complete_idempotency(
  p_actor_key text,
  p_operation text,
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
  v_outcome_code text;
  v_resource_type text;
  v_resource_id uuid;
begin
  if p_actor_key is null or p_operation is null or p_request_id is null
     or p_input_hmac is null or p_canonical_version is null
     or p_hash_key_version is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  if p_operation not in (
    'complete_profile',
    'update_profile',
    'accept_policies',
    'revoke_current_session'
  )
     or p_input_hmac !~ '^[0-9a-f]{64}$'
     or p_canonical_version <> 1
     or p_hash_key_version not between 1 and 32767 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  perform private.validate_idempotency_outcome(p_operation, p_outcome);

  if p_actor_key ~ '^profile:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     and p_operation <> 'complete_profile' then
    begin
      v_actor_id := substring(p_actor_key from 9)::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end;

    if p_actor_key <> 'profile:' || v_actor_id::text
       or not exists (
         select 1 from public.profiles as profile where profile.id = v_actor_id
       ) then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  elsif p_actor_key ~ '^system:[a-z][a-z0-9_]{0,62}$'
        and p_operation <> 'complete_profile' then
    v_actor_id := null;
  elsif p_actor_key ~ '^bootstrap:[0-9a-f]{64}$'
        and p_operation = 'complete_profile' then
    v_actor_id := (p_outcome ->> 'profile_id')::uuid;
    if not exists (
      select 1 from public.profiles as profile where profile.id = v_actor_id
    ) then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  else
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  v_outcome_code := p_outcome ->> 'logical_result';

  if p_operation = 'complete_profile' then
    if (p_outcome ->> 'profile_id')::uuid <> v_actor_id then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
    v_resource_type := 'profile';
    v_resource_id := v_actor_id;
  elsif p_operation = 'revoke_current_session' then
    v_resource_type := 'auth_session';
    v_resource_id := (p_outcome ->> 'session_id')::uuid;
  end if;

  update private.idempotency_records as records
  set actor_id = v_actor_id,
      state = 'completed',
      outcome_code = v_outcome_code,
      resource_type = v_resource_type,
      resource_id = v_resource_id,
      outcome = p_outcome,
      updated_at = now(),
      completed_at = now()
  where records.actor_key = p_actor_key
    and records.operation = p_operation
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

comment on function private.complete_idempotency(text, text, uuid, text, integer, integer, jsonb) is
  'Completes exactly the matching executing_uncommitted row. It derives safe references from the validated outcome and links bootstrap complete_profile to its newly-created actor.';

-- A deferred constraint trigger turns every transaction that acquired but did
-- not conclude into an error. Querying the final row is essential: both the
-- INSERT and UPDATE events are queued, but both must judge the state at commit.
create or replace function private.enforce_idempotency_conclusion()
returns trigger
language plpgsql
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

  if tg_op = 'UPDATE'
     and not (
       (old.state = 'executing_uncommitted' and new.state = 'completed')
       or (old.state = 'completed' and new.state = 'payload_expired')
     ) then
    raise exception using errcode = '23514', message = 'IDEMPOTENCY_TRANSITION_INVALID';
  end if;

  select records.*
  into v_record
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
       or (
         v_record.operation = 'complete_profile'
         and (
           v_record.resource_type <> 'profile'
           or v_record.resource_id <> v_record.actor_id
           or v_record.resource_id <> (v_record.outcome ->> 'profile_id')::uuid
         )
       )
       or (
         v_record.operation in ('update_profile', 'accept_policies')
         and (v_record.resource_type is not null or v_record.resource_id is not null)
       )
       or (
         v_record.operation = 'revoke_current_session'
         and (
           v_record.resource_type <> 'auth_session'
           or v_record.resource_id <> (v_record.outcome ->> 'session_id')::uuid
         )
       ) then
      raise exception using errcode = '23514', message = 'IDEMPOTENCY_OUTCOME_INVALID';
    end if;
  end if;

  return null;
end;
$function$;

create constraint trigger idempotency_records_must_conclude
after insert or update or delete on private.idempotency_records
deferrable initially deferred
for each row
execute function private.enforce_idempotency_conclusion();

-- Supabase grants service_role broad public-table DML through role-level
-- defaults. Application code must not possess that bypass. Keep the elevated
-- platform credential in secret infrastructure only; no app path uses it.
revoke all on schema private from service_role;
revoke all on all tables in schema public, private from service_role;
revoke all on all sequences in schema public, private from service_role;
revoke execute on all functions in schema public, private from service_role;

alter default privileges for role postgres in schema public
  revoke all on tables from service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from service_role;
alter default privileges for role postgres in schema private
  revoke all on tables from service_role;
alter default privileges for role postgres in schema private
  revoke all on sequences from service_role;
alter default privileges for role postgres in schema private
  revoke execute on functions from service_role;

revoke all on function private.validate_idempotency_outcome(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.acquire_idempotency(text, text, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function private.complete_idempotency(text, text, uuid, text, integer, integer, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_idempotency_conclusion()
  from public, anon, authenticated, service_role;

commit;
