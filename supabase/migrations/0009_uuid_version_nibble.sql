begin;

-- Relaxes the UUID version nibble that migration 0004 pinned to [1-5].
-- Sources: docs/13-contratos-funcoes.md sections 0, 0.1, 5.5 and 5.7;
-- docs/10-schema-db.md sections 9 and 9.1.
--
-- 0004 required the version nibble of every UUID it validated to be 1 through
-- 5 and the variant nibble to be 8 through b. The variant is an RFC 4122
-- invariant; the version is not an invariant of anything this project states.
-- No normative document declares which UUID version GoTrue mints for
-- session_id, and the UUID that docs/10 and docs/13 use as their own worked
-- example, 01890f7e-e948-7c53-b13a-4a36e4b7d21e, is a v7 that those checks
-- reject. This is the same family as the run_key defect fixed in migration
-- 0005: a shape that looks stricter and is simply wrong about what the contract
-- allows.
--
-- The invariant that stays is the one the contract really has: a canonical,
-- lowercase UUID. Uppercase and malformed input keep failing, and every other
-- behaviour of the three functions below is byte-for-byte what 0004 defined.
--
-- Append-only: 0004 is not rewritten. The table constraint is dropped and
-- recreated because a CHECK cannot be altered in place; the new expression is
-- strictly more permissive, so no committed row can fail it.

alter table private.idempotency_records
  drop constraint idempotency_records_check1;

alter table private.idempotency_records
  add constraint idempotency_records_actor_key_namespace_check check (
  (
  actor_key ~ '^profile:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
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
);

comment on constraint idempotency_records_actor_key_namespace_check
  on private.idempotency_records is
  'Closed actor namespace of docs/10-schema-db.md section 9. The profile branch accepts any canonical lowercase UUID: the version nibble is not an invariant of this contract.';

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
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
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
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
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

  if p_actor_key ~ '^profile:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
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

  if p_actor_key ~ '^profile:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
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

commit;
