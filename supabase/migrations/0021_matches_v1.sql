-- Fatia 0021: Rachas v1, modo apresentação (docs/25 §8.1 e docs/27, decisões
-- humanas de 12/10, 14/10 e 15/10/2026). Corte de docs/10 §4 e docs/13 §3.1:
-- racha de grupo com início/fim, fuso, local, endereço, coordenadas opcionais,
-- vagas de linha e valor por jogador. TP/T0/T1/T2, fase, goleiros, Pix,
-- recorrência e cancelamento ficam para o M3 integral, em migrations próprias.
-- A D63.5 foi adiada (docs/25 §8.1): esta fatia usa o padrão idempotente atual,
-- o mesmo de create_group e rename_group.
begin;

-- ---------------------------------------------------------------------------
-- Tabela
-- ---------------------------------------------------------------------------
-- Nomes de docs/10 §4. latitude/longitude não existem em docs/10: guardam o
-- local do racha arredondado a 4 casas (~11 m), somente depois que a pessoa
-- confirma a posição (decisão humana de 15/10/2026). Nunca aparecem em log,
-- outcome ou mensagem de erro.
create table private.matches (
  id               uuid primary key default gen_random_uuid(),
  group_id         uuid not null references public.groups (id),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  timezone         text not null,
  location_name    text not null,
  location_address text,
  latitude         numeric(6, 4) check (latitude between -90 and 90),
  longitude        numeric(7, 4) check (longitude between -180 and 180),
  field_slots      int not null check (field_slots > 0),
  field_price      numeric(10, 2) not null check (field_price > 0),
  created_by       uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  unique (id, group_id),
  check (starts_at < ends_at),
  check ((latitude is null) = (longitude is null))
);

comment on table private.matches is
  'Racha v1 (modo apresentação). Escrita somente por create_match; created_by é histórico, não autoridade.';

create index matches_group_starts_idx on private.matches (group_id, starts_at);

-- Nenhum papel cliente lê a tabela: detalhe e lista são projeções de
-- get_match e list_my_matches, chamadas pela Edge com actor context, que
-- conferem a sessão revogada (revisão do #70, P1-1). Sem leitor direto, a
-- tabela mora em private, sem RLS e sem grant (docs/14 §5.2): a proteção é a
-- ausência de usage no schema e de privilégio, já revogados por padrão (0004).

-- docs/10 §9: job_runs.match_id nasceu sem FK na 0005 porque matches não
-- existia; a migration que cria matches adiciona a FK.
alter table private.job_runs
  add constraint job_runs_match_id_fkey foreign key (match_id) references private.matches (id);

-- ---------------------------------------------------------------------------
-- Livro de idempotência: lista fechada de operações e desfechos
-- ---------------------------------------------------------------------------
alter table private.idempotency_records
  drop constraint idempotency_records_operation_check,
  drop constraint idempotency_records_outcome_code_check;
alter table private.idempotency_records
  add constraint idempotency_records_operation_check check (operation in (
    'complete_profile', 'update_profile', 'accept_policies',
    'revoke_current_session', 'delete_account', 'request_data_export',
    'approve_member', 'remove_member', 'set_role', 'set_monthly',
    'set_ratings_visibility', 'transfer_ownership', 'leave_group',
    'create_group', 'join_by_code', 'join_by_invite',
    'revoke_group_invite', 'regenerate_group_invite', 'issue_group_invite',
    'rename_group', 'create_match'
  )),
  add constraint idempotency_records_outcome_code_check check (
    outcome_code is null or outcome_code in (
      'profile_created', 'profile_updated', 'policies_accepted',
      'session_revoked', 'deletion_requested', 'data_export_requested',
      'member_approved', 'member_refused', 'member_removed', 'role_set',
      'monthly_set', 'ratings_visibility_set', 'ownership_transferred',
      'group_left', 'group_created', 'membership_requested',
      'membership_reentry_requested', 'membership_request_unchanged',
      'membership_already_active', 'invite_revoked',
      'invite_revocation_unchanged', 'invite_regenerated', 'invite_issued',
      'group_renamed', 'match_created'
    )
  );

alter function private.validate_idempotency_outcome(text, jsonb)
  rename to validate_through_rename_group_outcome;

-- O desfecho guarda somente IDs: nenhum horário, local, coordenada ou valor.
create function private.validate_idempotency_outcome(p_operation text, p_outcome jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_id_key text;
  v_id uuid;
begin
  if p_operation <> 'create_match' then
    perform private.validate_through_rename_group_outcome(p_operation, p_outcome);
    return;
  end if;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
        is distinct from array['group_id', 'logical_result', 'match_id']::text[]
     or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
     or p_outcome ->> 'logical_result' <> 'match_created' then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  foreach v_id_key in array array['group_id', 'match_id'] loop
    if jsonb_typeof(p_outcome -> v_id_key) <> 'string'
       or p_outcome ->> v_id_key
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
    begin
      v_id := (p_outcome ->> v_id_key)::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end;
    if p_outcome ->> v_id_key <> v_id::text then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  end loop;
end;
$function$;

revoke all on function private.validate_through_rename_group_outcome(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_idempotency_outcome(text, jsonb)
  from public, anon, authenticated, service_role;

-- Corpo idêntico ao da 0018; somente a lista de operações ganha create_match.
create or replace function private.acquire_group_idempotency(
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
  if current_setting('transaction_isolation') <> 'read committed'
     or p_actor_key is null or p_operation is null or p_request_id is null
     or p_input_hmac is null
     or p_operation not in ('approve_member', 'remove_member', 'set_role', 'set_monthly',
                            'set_ratings_visibility', 'transfer_ownership', 'leave_group',
                            'create_group', 'join_by_code', 'join_by_invite',
                            'revoke_group_invite', 'regenerate_group_invite', 'issue_group_invite',
                            'rename_group', 'create_match')
     or p_canonical_version is distinct from 1
     or p_hash_key_version is null or p_hash_key_version not between 1 and 32767
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
      p_actor_key, v_actor_id, p_operation, p_request_id, p_input_hmac,
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
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_WAIT_TIMEOUT';
  end if;

  return query select false, v_record.state, v_record.outcome_code,
    v_record.resource_type, v_record.resource_id, v_record.outcome;
end;
$function$;

-- O recurso de create_match é o grupo, como em create_group: o racha viaja
-- no outcome, e a restrição de resource_type da 0004 não muda.
create or replace function private.complete_group_idempotency(
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
begin
  if p_operation is null
     or p_operation not in ('approve_member', 'remove_member', 'set_role', 'set_monthly',
                            'set_ratings_visibility', 'transfer_ownership', 'leave_group',
                            'create_group', 'join_by_code', 'join_by_invite',
                            'revoke_group_invite', 'regenerate_group_invite', 'issue_group_invite',
                            'rename_group', 'create_match') then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  perform private.validate_idempotency_outcome(p_operation, p_outcome);
  begin
    v_actor_id := substring(p_actor_key from 9)::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end;

  update private.idempotency_records as records
  set state = 'completed',
      outcome_code = p_outcome ->> 'logical_result',
      resource_type = 'group',
      resource_id = (p_outcome ->> 'group_id')::uuid,
      outcome = p_outcome,
      updated_at = now(),
      completed_at = now()
  where records.actor_key = p_actor_key
    and records.actor_id = v_actor_id
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

revoke all on function private.acquire_group_idempotency(text, text, uuid, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.complete_group_idempotency(text, text, uuid, text, integer, integer, jsonb) from public, anon, authenticated, service_role;

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
       or (v_record.operation='request_data_export' and (v_record.resource_type<>'data_export' or v_record.resource_id<>(v_record.outcome->>'export_id')::uuid))
       or (v_record.operation in ('approve_member','remove_member','set_role','set_monthly',
                                  'set_ratings_visibility','transfer_ownership','leave_group',
                                  'create_group','join_by_code','join_by_invite',
                                  'revoke_group_invite','regenerate_group_invite','issue_group_invite',
                                  'rename_group','create_match')
           and (v_record.resource_type is distinct from 'group'
                or v_record.resource_id is distinct from (v_record.outcome->>'group_id')::uuid)) then
      raise exception using errcode='23514',message='IDEMPOTENCY_OUTCOME_INVALID';
    end if;
  end if;
  return null;
end;
$function$;

revoke all on function private.enforce_idempotency_conclusion() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Texto livre do racha
-- ---------------------------------------------------------------------------
-- Mesma regra de private.normalize_group_name (0017), com limites próprios:
-- NFC, controles e marcas bidi fechados, Zs/Zl/Zp reduzidos a espaço,
-- trim/colapso e comprimento em pontos de código.
create function private.normalize_match_text(p_value text, p_min integer, p_max integer)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_value text;
  v_result text := '';
  v_character text;
  v_code integer;
  v_index integer;
begin
  if p_value is null or p_min is null or p_max is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_value := normalize(p_value, NFC);
  for v_index in 1..char_length(v_value) loop
    v_character := substr(v_value, v_index, 1);
    v_code := ascii(v_character);
    if v_code between 0 and 31 or v_code between 127 and 159
       or v_code in (1564, 8203, 8206, 8207, 8234, 8235, 8236, 8237, 8238,
                     8288, 8289, 8290, 8291, 8292, 8294, 8295, 8296, 8297, 65279) then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
    if v_code in (32, 160, 5760, 8239, 8287, 12288, 8232, 8233)
       or v_code between 8192 and 8202 then
      v_result := v_result || ' ';
    else
      v_result := v_result || v_character;
    end if;
  end loop;
  v_result := btrim(regexp_replace(v_result, ' +', ' ', 'g'));
  if char_length(v_result) not between p_min and p_max then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  return v_result;
end;
$function$;

revoke all on function private.normalize_match_text(text, integer, integer)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- create_match(group_id, config, request_id) — docs/13 §3.1, recortado
-- ---------------------------------------------------------------------------
-- config tem exatamente nove chaves; as opcionais chegam como null explícito.
-- Horários em UTC com precisão de minuto, como a Edge os canoniza. O JSON
-- canônico v1 só tem inteiros (docs/13 §0.1): preço e coordenadas chegam como
-- string decimal de casas fixas (2 e 4). A Edge
-- valida e normaliza o mesmo contrato antes de gastar a chave idempotente;
-- esta função é a autoridade e valida de novo.
-- Locks: perfil → grupo → membership, todos FOR NO KEY UPDATE (M2-D13).
create function public.create_match(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_group_id uuid, p_config jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_actor_key text;
  v_acquired record;
  v_authority text;
  v_match_id uuid;
  v_outcome jsonb;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_timezone text;
  v_location_name text;
  v_location_address text;
  v_latitude numeric;
  v_longitude numeric;
  v_field_slots integer;
  v_field_price numeric;
  v_instant constant text :=
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00\.000Z$';
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_group_id is null or p_config is null or jsonb_typeof(p_config) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_config) as key)
        is distinct from array['ends_at', 'field_price', 'field_slots', 'latitude',
          'location_address', 'location_name', 'longitude', 'starts_at',
          'timezone']::text[] then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  -- Forma de cada campo. Erro de forma é VALIDATION; regra de domínio tem
  -- código próprio (TIME_ORDER, PRICE_INVALID).
  if jsonb_typeof(p_config -> 'starts_at') <> 'string'
     or jsonb_typeof(p_config -> 'ends_at') <> 'string'
     or p_config ->> 'starts_at' !~ v_instant
     or p_config ->> 'ends_at' !~ v_instant
     or jsonb_typeof(p_config -> 'timezone') <> 'string'
     or jsonb_typeof(p_config -> 'location_name') <> 'string'
     or jsonb_typeof(p_config -> 'location_address') not in ('string', 'null')
     or jsonb_typeof(p_config -> 'latitude') not in ('string', 'null')
     or jsonb_typeof(p_config -> 'latitude') <> jsonb_typeof(p_config -> 'longitude')
     or coalesce(p_config ->> 'latitude', '0.0000') !~ '^-?[0-9]{1,2}\.[0-9]{4}$'
     or coalesce(p_config ->> 'longitude', '0.0000') !~ '^-?[0-9]{1,3}\.[0-9]{4}$'
     or jsonb_typeof(p_config -> 'field_slots') <> 'number'
     or jsonb_typeof(p_config -> 'field_price') <> 'string'
     or p_config ->> 'field_price' !~ '^[0-9]{1,4}\.[0-9]{2}$' then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  begin
    v_starts_at := (p_config ->> 'starts_at')::timestamptz;
    v_ends_at := (p_config ->> 'ends_at')::timestamptz;
    v_field_slots := (p_config ->> 'field_slots')::integer;
  exception when others then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end;
  if to_char(v_starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"')
       <> p_config ->> 'starts_at'
     or to_char(v_ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"')
       <> p_config ->> 'ends_at'
     or (p_config ->> 'field_slots') !~ '^[0-9]{1,2}$'
     or v_field_slots not between 1 and 99 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_timezone := p_config ->> 'timezone';
  if char_length(v_timezone) > 64
     or not exists (select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_location_name := private.normalize_match_text(p_config ->> 'location_name', 2, 80);
  if p_config ->> 'location_address' is not null then
    v_location_address := private.normalize_match_text(p_config ->> 'location_address', 2, 160);
  end if;
  if jsonb_typeof(p_config -> 'latitude') = 'string' then
    v_latitude := (p_config ->> 'latitude')::numeric;
    v_longitude := (p_config ->> 'longitude')::numeric;
    -- Precisão máxima de 4 casas: a coordenada arredondada é a única gravável.
    if v_latitude <> round(v_latitude, 4) or v_longitude <> round(v_longitude, 4)
       or v_latitude not between -90 and 90 or v_longitude not between -180 and 180 then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  end if;
  v_field_price := (p_config ->> 'field_price')::numeric;
  if v_field_price <= 0 then
    raise exception using errcode = 'P0001', message = 'PRICE_INVALID';
  end if;

  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'create_match', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  -- A FK da idempotência já segura FOR KEY SHARE no perfil próprio.
  perform 1 from public.profiles where id = v_actor_id for no key update;
  perform 1 from public.groups where id = p_group_id for no key update;
  perform 1 from public.group_members
    where group_id = p_group_id and profile_id = v_actor_id for no key update;
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  -- Replay devolve o desfecho gravado, sem projeção: o racha já existe e a
  -- leitura dele passa por get_match, com a autoridade de quem lê.
  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome);
  end if;

  v_authority := private.group_actor_authority(p_group_id, v_actor_id);
  if v_authority not in ('owner', 'organizer') then
    raise exception using errcode = '42501', message = 'NOT_ORGANIZER';
  end if;
  perform private.require_group_not_suspended(p_group_id);

  -- Regra temporal pelo relógio do servidor, depois da autoridade, para que
  -- quem não pode criar não aprenda nada sobre o próprio pedido.
  if v_starts_at <= now() or v_ends_at <= v_starts_at
     or v_ends_at - v_starts_at > interval '12 hours'
     or v_starts_at > now() + interval '365 days' then
    raise exception using errcode = 'P0001', message = 'TIME_ORDER';
  end if;

  insert into private.matches (group_id, starts_at, ends_at, timezone, location_name,
    location_address, latitude, longitude, field_slots, field_price, created_by)
  values (p_group_id, v_starts_at, v_ends_at, v_timezone, v_location_name,
    v_location_address, v_latitude, v_longitude, v_field_slots, v_field_price, v_actor_id)
  returning id into v_match_id;

  v_outcome := jsonb_build_object('group_id', p_group_id::text,
    'logical_result', 'match_created', 'match_id', v_match_id::text);
  perform private.complete_group_idempotency(
    v_actor_key, 'create_match', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome);
end;
$function$;

revoke all on function public.create_match(uuid, uuid, uuid, text, integer, integer, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_match(uuid, uuid, uuid, text, integer, integer, uuid, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Leituras: get_match(match_id) e list_my_matches()
-- ---------------------------------------------------------------------------
-- Mesmo padrão de get_group_members (0019): actor context da Edge, sessão
-- revogada recusada (UNAUTHENTICATED), perfil travado e revalidado. Só membro
-- active de grupo não arquivado lê; para os demais, ID existente e
-- inexistente respondem o mesmo NOT_FOUND, sem enumeração. created_by fica
-- fora da projeção: nenhuma tela o exibe.
create function public.get_match(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_match_id uuid
) returns table (id uuid, group_id uuid, group_name text, starts_at timestamptz,
  ends_at timestamptz, timezone text, location_name text, location_address text,
  latitude numeric, longitude numeric, field_slots integer, field_price numeric)
language plpgsql volatile security definer set search_path = '' as $function$
declare v_actor uuid;
begin
  if p_match_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  perform 1 from public.profiles p where p.id = v_actor for no key update;
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  return query
  select m.id, m.group_id, g.name, m.starts_at, m.ends_at, m.timezone, m.location_name,
    m.location_address, m.latitude, m.longitude, m.field_slots, m.field_price
  from private.matches m
  join public.groups g on g.id = m.group_id and g.archived_at is null
  join public.group_members gm on gm.group_id = m.group_id and gm.profile_id = v_actor
   and gm.status = 'active'
  where m.id = p_match_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
end;
$function$;

-- Rachas ainda não encerrados dos grupos ativos do ator, por início e ID.
create function public.list_my_matches(
  p_actor_auth_user_id uuid, p_actor_session_id uuid
) returns table (id uuid, group_id uuid, group_name text, starts_at timestamptz,
  ends_at timestamptz, timezone text, location_name text, location_address text,
  latitude numeric, longitude numeric, field_slots integer, field_price numeric)
language plpgsql volatile security definer set search_path = '' as $function$
declare v_actor uuid;
begin
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  perform 1 from public.profiles p where p.id = v_actor for no key update;
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  return query
  select m.id, m.group_id, g.name, m.starts_at, m.ends_at, m.timezone, m.location_name,
    m.location_address, m.latitude, m.longitude, m.field_slots, m.field_price
  from private.matches m
  join public.groups g on g.id = m.group_id and g.archived_at is null
  join public.group_members gm on gm.group_id = m.group_id and gm.profile_id = v_actor
   and gm.status = 'active'
  where m.ends_at > now()
  order by m.starts_at, m.id;
end;
$function$;

revoke all on function public.get_match(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_my_matches(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_match(uuid, uuid, uuid) to service_role;
grant execute on function public.list_my_matches(uuid, uuid) to service_role;

commit;
