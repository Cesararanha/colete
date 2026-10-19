-- Fatia 0028: editar e cancelar racha, modo apresentação (item 10 do feedback
-- do teste; decisão humana de César de 18/10/2026, docs/25 §8.1). Corte de
-- docs/13 §§3.2 e 3.3 sobre os Rachas v1 e o Racha completo: quem cria racha
-- no grupo (dono ou organizador ativo) edita data, início, fim, local,
-- endereço, vagas, preço e descrição, e cancela de vez. Sem motivo, nota,
-- notificação, revisão, matriz de recomputação, estorno ou ciclo de
-- pagamento: as marcações de pago ficam como estão. A D63.5 continua adiada:
-- o padrão idempotente é o mesmo da 0021, 0022 e 0027.
begin;

-- ---------------------------------------------------------------------------
-- Estado de cancelamento
-- ---------------------------------------------------------------------------
-- Nomes de docs/10 §4, sem phase, motivo e nota, que ficam para o M3
-- integral. O cancelamento é definitivo: nenhuma RPC limpa as duas colunas.
alter table private.matches
  add column canceled_at timestamptz,
  add column canceled_by uuid references public.profiles (id),
  add constraint matches_canceled_pair_check
    check ((canceled_at is null) = (canceled_by is null));

comment on table private.matches is
  'Racha v1 (modo apresentação). Escrita somente por create_match, update_match e cancel_match; created_by e canceled_by são histórico, não autoridade.';

-- ---------------------------------------------------------------------------
-- Livro de idempotência: lista fechada de operações e desfechos
-- ---------------------------------------------------------------------------
-- Todas as operações e todos os desfechos que já existem continuam, inclusive
-- set_group_appearance (0027).
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
    'rename_group', 'create_match', 'join_match', 'leave_match',
    'set_match_payment', 'set_group_appearance', 'update_match', 'cancel_match'
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
      'group_renamed', 'match_created', 'match_joined', 'match_waitlisted',
      'match_join_unchanged', 'match_left', 'match_leave_unchanged',
      'payment_marked_paid', 'payment_marked_unpaid', 'payment_unchanged',
      'group_appearance_set', 'match_updated', 'match_canceled',
      'match_cancel_unchanged'
    )
  );

alter function private.validate_idempotency_outcome(text, jsonb)
  rename to validate_through_group_appearance_outcome;

-- O desfecho guarda somente os IDs e o resultado lógico: nenhum horário,
-- local, vaga, preço ou descrição. O racha corrente é lido de novo por
-- get_match, com a autoridade de quem lê.
create function private.validate_idempotency_outcome(p_operation text, p_outcome jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_results text[];
  v_id_key text;
  v_id uuid;
begin
  if p_operation = 'update_match' then
    v_results := array['match_updated'];
  elsif p_operation = 'cancel_match' then
    v_results := array['match_canceled', 'match_cancel_unchanged'];
  else
    perform private.validate_through_group_appearance_outcome(p_operation, p_outcome);
    return;
  end if;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
        is distinct from array['group_id', 'logical_result', 'match_id']::text[]
     or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
     or not (p_outcome ->> 'logical_result' = any(v_results)) then
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

revoke all on function private.validate_through_group_appearance_outcome(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_idempotency_outcome(text, jsonb)
  from public, anon, authenticated, service_role;

-- Corpo idêntico ao da 0027; somente a lista de operações ganha update_match
-- e cancel_match.
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
                            'rename_group', 'create_match', 'join_match',
                            'leave_match', 'set_match_payment',
                            'set_group_appearance', 'update_match', 'cancel_match')
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

-- O recurso de update_match e cancel_match é o grupo, como em create_match:
-- o racha viaja no outcome, e a restrição de resource_type da 0004 não muda.
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
                            'rename_group', 'create_match', 'join_match',
                            'leave_match', 'set_match_payment',
                            'set_group_appearance', 'update_match', 'cancel_match') then
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
                                  'rename_group','create_match','join_match','leave_match',
                                  'set_match_payment','set_group_appearance','update_match',
                                  'cancel_match')
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
-- Config do racha, para a edição
-- ---------------------------------------------------------------------------
-- As mesmas dez chaves, a mesma forma e a mesma normalização do config de
-- create_match (0022), devolvidas numa linha de private.matches com somente
-- os campos editáveis preenchidos. create_match conserva a própria cópia e
-- não muda nesta fatia. Erro de forma é VALIDATION; preço zero é
-- PRICE_INVALID. A regra temporal depende do racha gravado e fica em
-- update_match.
create function private.match_config_from_json(p_config jsonb)
returns private.matches
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_match private.matches%rowtype;
  v_instant constant text :=
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00\.000Z$';
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_config) as key)
        is distinct from array['description', 'ends_at', 'field_price', 'field_slots', 'latitude',
          'location_address', 'location_name', 'longitude', 'starts_at',
          'timezone']::text[] then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  if jsonb_typeof(p_config -> 'starts_at') <> 'string'
     or jsonb_typeof(p_config -> 'ends_at') <> 'string'
     or p_config ->> 'starts_at' !~ v_instant
     or p_config ->> 'ends_at' !~ v_instant
     or jsonb_typeof(p_config -> 'timezone') <> 'string'
     or jsonb_typeof(p_config -> 'location_name') <> 'string'
     or jsonb_typeof(p_config -> 'location_address') not in ('string', 'null')
     or jsonb_typeof(p_config -> 'description') not in ('string', 'null')
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
    v_match.starts_at := (p_config ->> 'starts_at')::timestamptz;
    v_match.ends_at := (p_config ->> 'ends_at')::timestamptz;
    v_match.field_slots := (p_config ->> 'field_slots')::integer;
  exception when others then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end;
  if to_char(v_match.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"')
       <> p_config ->> 'starts_at'
     or to_char(v_match.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"')
       <> p_config ->> 'ends_at'
     or (p_config ->> 'field_slots') !~ '^[0-9]{1,2}$'
     or v_match.field_slots not between 1 and 99 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_match.timezone := p_config ->> 'timezone';
  if char_length(v_match.timezone) > 64
     or not exists (select 1 from pg_catalog.pg_timezone_names where name = v_match.timezone) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_match.location_name := private.normalize_match_text(p_config ->> 'location_name', 2, 80);
  if p_config ->> 'location_address' is not null then
    v_match.location_address :=
      private.normalize_match_text(p_config ->> 'location_address', 2, 160);
  end if;
  -- Como em create_match: null é a única grafia de "sem descrição".
  if p_config ->> 'description' is not null then
    v_match.description := private.normalize_match_description(p_config ->> 'description');
    if v_match.description is null then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  end if;
  if jsonb_typeof(p_config -> 'latitude') = 'string' then
    v_match.latitude := (p_config ->> 'latitude')::numeric;
    v_match.longitude := (p_config ->> 'longitude')::numeric;
    if v_match.latitude <> round(v_match.latitude, 4)
       or v_match.longitude <> round(v_match.longitude, 4)
       or v_match.latitude not between -90 and 90
       or v_match.longitude not between -180 and 180 then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  end if;
  v_match.field_price := (p_config ->> 'field_price')::numeric;
  if v_match.field_price <= 0 then
    raise exception using errcode = 'P0001', message = 'PRICE_INVALID';
  end if;
  return v_match;
end;
$function$;

revoke all on function private.match_config_from_json(jsonb)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- update_match(match_id, config, request_id) — docs/13 §3.2, recortado
-- ---------------------------------------------------------------------------
-- Dono ou organizador ativo, enquanto o racha não terminou nem foi cancelado.
-- O config é o inteiro, com as dez chaves de create_match: a tela salva o
-- formulário todo. O grupo nunca muda. Mudar início ou fim segue a regra de
-- create_match (início futuro, fim depois do início, até 12 h, até 365 dias);
-- manter os dois deixa editar o resto de um racha já em andamento. Vagas não
-- descem abaixo dos confirmados (SLOTS_BELOW_CONFIRMED); se sobem, a espera é
-- promovida em ordem por promote_match_waitlist, a mesma da desistência.
-- O preço muda sem tocar nas marcações de pago.
-- Locks: perfil → grupo → membership → racha (lock_match_context), os mesmos
-- de join_match e leave_match: editar e confirmar nunca correm juntos.
create function public.update_match(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_match_id uuid, p_config jsonb
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
  v_group_id uuid;
  v_authority text;
  v_config private.matches%rowtype;
  v_match private.matches%rowtype;
  v_starters integer;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_match_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_config := private.match_config_from_json(p_config);
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'update_match', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  v_group_id := private.lock_match_context(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id, p_match_id);

  -- M2-D20: quem deixou de organizar, saiu do grupo ou teve o grupo
  -- suspenso recebe o desfecho gravado, sem repetir o efeito. Fora do grupo,
  -- o mesmo NOT_FOUND de um ID inexistente; jogador, NOT_ORGANIZER.
  begin
    if v_group_id is null then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
    v_authority := private.match_actor_authority(v_group_id, v_actor_id);
    if v_authority not in ('owner', 'organizer') then
      raise exception using errcode = '42501', message = 'NOT_ORGANIZER';
    end if;
    perform private.require_group_not_suspended(v_group_id);
  exception
    when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
      if not v_acquired.acquired
         and sqlerrm in ('NOT_FOUND', 'NOT_ORGANIZER', 'GROUP_SUSPENDED') then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
  end;

  -- Replay devolve o desfecho gravado, sem projeção, como create_match.
  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome);
  end if;

  select * into strict v_match from private.matches where id = p_match_id;
  if v_match.canceled_at is not null then
    raise exception using errcode = 'P0001', message = 'MATCH_CANCELED';
  end if;
  if v_match.ends_at <= now() then
    raise exception using errcode = 'P0001', message = 'MATCH_DONE';
  end if;
  -- Regra temporal pelo relógio do servidor, depois da autoridade.
  if (v_config.starts_at, v_config.ends_at) is distinct from (v_match.starts_at, v_match.ends_at)
     and (v_config.starts_at <= now() or v_config.ends_at <= v_config.starts_at
          or v_config.ends_at - v_config.starts_at > interval '12 hours'
          or v_config.starts_at > now() + interval '365 days') then
    raise exception using errcode = 'P0001', message = 'TIME_ORDER';
  end if;
  select count(*) into v_starters from private.match_players
  where match_id = p_match_id and status = 'starter';
  if v_config.field_slots < v_starters then
    raise exception using errcode = 'P0001', message = 'SLOTS_BELOW_CONFIRMED';
  end if;

  update private.matches
  set starts_at = v_config.starts_at, ends_at = v_config.ends_at,
      timezone = v_config.timezone, location_name = v_config.location_name,
      location_address = v_config.location_address, description = v_config.description,
      latitude = v_config.latitude, longitude = v_config.longitude,
      field_slots = v_config.field_slots, field_price = v_config.field_price
  where id = p_match_id;
  if v_config.field_slots > v_match.field_slots then
    perform private.promote_match_waitlist(p_match_id);
  end if;

  if (select count(*) from private.match_players
      where match_id = p_match_id and status = 'starter') > v_config.field_slots then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;

  v_outcome := jsonb_build_object('group_id', v_group_id::text,
    'logical_result', 'match_updated', 'match_id', p_match_id::text);
  perform private.complete_group_idempotency(
    v_actor_key, 'update_match', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome);
end;
$function$;

-- ---------------------------------------------------------------------------
-- cancel_match(match_id, request_id) — docs/13 §3.3, recortado
-- ---------------------------------------------------------------------------
-- Dono ou organizador ativo, enquanto o racha não terminou. Definitivo: grava
-- canceled_at e canceled_by e não apaga ninguém da lista nem as marcações de
-- pago, que ficam como histórico. Cancelar o que já está cancelado é sucesso
-- sem efeito (match_cancel_unchanged). Sem motivo, nota ou notificação.
-- Mesmos locks de update_match.
create function public.cancel_match(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_match_id uuid
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
  v_group_id uuid;
  v_authority text;
  v_match private.matches%rowtype;
  v_result text;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_match_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'cancel_match', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  v_group_id := private.lock_match_context(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id, p_match_id);

  begin
    if v_group_id is null then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
    v_authority := private.match_actor_authority(v_group_id, v_actor_id);
    if v_authority not in ('owner', 'organizer') then
      raise exception using errcode = '42501', message = 'NOT_ORGANIZER';
    end if;
    perform private.require_group_not_suspended(v_group_id);
  exception
    when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
      if not v_acquired.acquired
         and sqlerrm in ('NOT_FOUND', 'NOT_ORGANIZER', 'GROUP_SUSPENDED') then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
  end;

  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome);
  end if;

  select * into strict v_match from private.matches where id = p_match_id;
  if v_match.canceled_at is not null then
    v_result := 'match_cancel_unchanged';
  elsif v_match.ends_at <= now() then
    raise exception using errcode = 'P0001', message = 'MATCH_DONE';
  else
    update private.matches set canceled_at = now(), canceled_by = v_actor_id
    where id = p_match_id;
    v_result := 'match_canceled';
  end if;

  v_outcome := jsonb_build_object('group_id', v_group_id::text,
    'logical_result', v_result, 'match_id', p_match_id::text);
  perform private.complete_group_idempotency(
    v_actor_key, 'cancel_match', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome);
end;
$function$;

revoke all on function public.update_match(uuid, uuid, uuid, text, integer, integer, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.cancel_match(uuid, uuid, uuid, text, integer, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.update_match(uuid, uuid, uuid, text, integer, integer, uuid, jsonb)
  to service_role;
grant execute on function public.cancel_match(uuid, uuid, uuid, text, integer, integer, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Racha cancelado: presença, espera e pagamento recusam
-- ---------------------------------------------------------------------------
-- join_match, leave_match e set_match_payment ganham MATCH_CANCELED depois da
-- autoridade e antes do replay, sob o mesmo lock do racha que cancel_match
-- segura: quem confirma e quem cancela nunca correm juntos. O replay de um
-- pedido feito antes do cancelamento recebe a mesma recusa de uma chamada nova
-- (P1 da revisão do #79), sem desfecho, current ou resumo, e o registro
-- idempotente concluído fica como está. Quem perdeu a autoridade continua na
-- M2-D20 (o desfecho, sem projeção), como no #71: a recusa do cancelamento só
-- vale para quem ainda lê o racha. O resto dos corpos é o da 0022, e o replace
-- preserva o ACL.
create or replace function public.join_match(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_match_id uuid
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
  v_group_id uuid;
  v_match private.matches%rowtype;
  v_player private.match_players%rowtype;
  v_starters integer;
  v_status text;
  v_result text;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_match_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'join_match', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  v_group_id := private.lock_match_context(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id, p_match_id);

  -- M2-D20: só a perda de autoridade no grupo conserva o desfecho, sem
  -- current; autenticação negada já saiu com o erro normal no helper.
  begin
    if v_group_id is null then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
    perform private.match_actor_authority(v_group_id, v_actor_id);
    perform private.require_group_not_suspended(v_group_id);
  exception
    when sqlstate 'P0001' or sqlstate 'P0002' then
      if not v_acquired.acquired and sqlerrm in ('NOT_FOUND', 'GROUP_SUSPENDED') then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
  end;

  -- Cancelado recusa a chamada nova e o replay, antes de qualquer projeção.
  select * into strict v_match from private.matches where id = p_match_id;
  if v_match.canceled_at is not null then
    raise exception using errcode = 'P0001', message = 'MATCH_CANCELED';
  end if;

  -- current só depois da autoridade atual autorizada.
  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome,
      'current', private.match_player_current(p_match_id, v_actor_id));
  end if;

  if v_match.starts_at <= now() then
    raise exception using errcode = 'P0001', message = 'MATCH_STARTED';
  end if;

  select * into v_player from private.match_players
  where match_id = p_match_id and profile_id = v_actor_id
  for no key update;

  if v_player.status in ('starter', 'waitlist') then
    v_result := 'match_join_unchanged';
  else
    select count(*) into v_starters from private.match_players
    where match_id = p_match_id and status = 'starter';
    v_status := case when v_starters < v_match.field_slots then 'starter' else 'waitlist' end;
    if v_player.id is null then
      insert into private.match_players (match_id, profile_id, status, queue_seq)
      values (p_match_id, v_actor_id, v_status, nextval('private.match_queue_seq'));
    else
      update private.match_players
      set status = v_status, queue_seq = nextval('private.match_queue_seq'),
          status_changed_at = now()
      where id = v_player.id;
    end if;
    v_result := case v_status when 'starter' then 'match_joined' else 'match_waitlisted' end;
  end if;

  if (select count(*) from private.match_players
      where match_id = p_match_id and status = 'starter') > v_match.field_slots then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;

  v_outcome := jsonb_build_object('group_id', v_group_id::text,
    'logical_result', v_result, 'match_id', p_match_id::text);
  perform private.complete_group_idempotency(
    v_actor_key, 'join_match', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome,
    'current', private.match_player_current(p_match_id, v_actor_id));
end;
$function$;

create or replace function public.leave_match(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_match_id uuid
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
  v_group_id uuid;
  v_starts_at timestamptz;
  v_canceled boolean;
  v_player private.match_players%rowtype;
  v_result text;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_match_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'leave_match', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  v_group_id := private.lock_match_context(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id, p_match_id);

  -- Grupo suspenso não bloqueia a saída (docs/10 §11). M2-D20: perda de
  -- autoridade conserva o desfecho, sem current.
  begin
    if v_group_id is null then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
    perform private.match_actor_authority(v_group_id, v_actor_id);
  exception
    when sqlstate 'P0002' then
      if not v_acquired.acquired and sqlerrm = 'NOT_FOUND' then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
  end;

  -- Cancelado recusa a chamada nova e o replay, antes de qualquer projeção.
  select starts_at, canceled_at is not null into strict v_starts_at, v_canceled
  from private.matches where id = p_match_id;
  if v_canceled then
    raise exception using errcode = 'P0001', message = 'MATCH_CANCELED';
  end if;

  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome,
      'current', private.match_player_current(p_match_id, v_actor_id));
  end if;

  if v_starts_at <= now() then
    raise exception using errcode = 'P0001', message = 'MATCH_STARTED';
  end if;

  select * into v_player from private.match_players
  where match_id = p_match_id and profile_id = v_actor_id
  for no key update;

  if v_player.id is null or v_player.status not in ('starter', 'waitlist') then
    v_result := 'match_leave_unchanged';
  elsif v_player.paid then
    raise exception using errcode = 'P0001', message = 'PAYMENT_ALREADY_REAL';
  else
    update private.match_players
    set status = 'left', status_changed_at = now()
    where id = v_player.id;
    if v_player.status = 'starter' then
      perform private.promote_match_waitlist(p_match_id);
    end if;
    v_result := 'match_left';
  end if;

  v_outcome := jsonb_build_object('group_id', v_group_id::text,
    'logical_result', v_result, 'match_id', p_match_id::text);
  perform private.complete_group_idempotency(
    v_actor_key, 'leave_match', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome,
    'current', private.match_player_current(p_match_id, v_actor_id));
end;
$function$;

create or replace function public.set_match_payment(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_match_id uuid, p_profile_id uuid, p_paid boolean
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
  v_group_id uuid;
  v_authority text;
  v_player private.match_players%rowtype;
  v_result text;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_match_id is null or p_profile_id is null or p_paid is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'set_match_payment', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  v_group_id := private.lock_match_context(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id, p_match_id);

  -- M2-D20: quem deixou de organizar, ou saiu do grupo, recebe o desfecho
  -- gravado sem o resumo de hoje (revisão do #71, P1-1).
  begin
    if v_group_id is null then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
    v_authority := private.match_actor_authority(v_group_id, v_actor_id);
    if v_authority not in ('owner', 'organizer') then
      raise exception using errcode = '42501', message = 'NOT_ORGANIZER';
    end if;
  exception
    when sqlstate '42501' or sqlstate 'P0002' then
      if not v_acquired.acquired and sqlerrm in ('NOT_FOUND', 'NOT_ORGANIZER') then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
  end;

  -- Cancelado recusa a chamada nova e o replay, antes do resumo financeiro.
  if exists (select 1 from private.matches where id = p_match_id and canceled_at is not null) then
    raise exception using errcode = 'P0001', message = 'MATCH_CANCELED';
  end if;

  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome,
      'current', private.match_payment_summary(p_match_id));
  end if;

  select * into v_player from private.match_players
  where match_id = p_match_id and profile_id = p_profile_id
  for no key update;
  if v_player.id is null or v_player.status <> 'starter' then
    raise exception using errcode = 'P0001', message = 'NOT_STARTER';
  end if;

  if v_player.paid = p_paid then
    v_result := 'payment_unchanged';
  else
    update private.match_players
    set paid = p_paid, payment_marked_by = v_actor_id, payment_marked_at = now()
    where id = v_player.id;
    v_result := case when p_paid then 'payment_marked_paid' else 'payment_marked_unpaid' end;
  end if;

  v_outcome := jsonb_build_object('group_id', v_group_id::text,
    'logical_result', v_result, 'match_id', p_match_id::text,
    'profile_id', p_profile_id::text);
  perform private.complete_group_idempotency(
    v_actor_key, 'set_match_payment', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome,
    'current', private.match_payment_summary(p_match_id));
end;
$function$;

-- A saída do grupo continua liberando a inscrição em racha futuro, mas não
-- promove a espera de racha cancelado: a lista dele fica como estava. Corpo
-- da 0022, exceto a condição da promoção; o trigger não muda.
create or replace function private.release_match_players_on_membership_exit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_match_id uuid;
  v_status text;
begin
  for v_match_id in
    select player.match_id
    from private.match_players as player
    join private.matches as match on match.id = player.match_id
    where match.group_id = new.group_id and player.profile_id = new.profile_id
      and player.status in ('starter', 'waitlist') and match.starts_at > now()
    order by player.match_id
  loop
    perform 1 from private.matches where id = v_match_id for no key update;
    v_status := null;
    select status into v_status from private.match_players
    where match_id = v_match_id and profile_id = new.profile_id
    for no key update;
    if v_status in ('starter', 'waitlist') then
      update private.match_players
      set status = 'removed', status_changed_at = now()
      where match_id = v_match_id and profile_id = new.profile_id;
      if v_status = 'starter' and not exists (
          select 1 from private.matches where id = v_match_id and canceled_at is not null) then
        perform private.promote_match_waitlist(v_match_id);
      end if;
    end if;
  end loop;
  return null;
end;
$function$;

revoke all on function private.release_match_players_on_membership_exit()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Leituras: o estado cancelado
-- ---------------------------------------------------------------------------
-- get_match, list_my_matches e get_matches_occupancy ganham a coluna canceled
-- no fim; a forma de retorno muda, então são recriadas com o corpo da 0027
-- (get_match, list_my_matches) e da 0022 (ocupação) e os mesmos privilégios.
-- O racha cancelado continua na lista até terminar, como os outros: os
-- membros o veem com o chip "Cancelado". get_match_roster devolve canceled
-- junto de started; o replace preserva o ACL. canceled_at e canceled_by não
-- são projetados: nenhuma tela mostra quem cancelou nem quando.
create or replace function public.get_match_roster(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_match_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_match private.matches%rowtype;
  v_manage boolean;
  v_entries jsonb;
  v_current jsonb;
  v_own private.match_players%rowtype;
begin
  if p_match_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor_id := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  select * into v_match from private.matches where id = p_match_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  -- Fora do grupo, o mesmo NOT_FOUND de um ID inexistente.
  v_manage := private.match_actor_authority(v_match.group_id, v_actor_id)
    in ('owner', 'organizer');

  select coalesce(jsonb_agg(jsonb_build_object(
      'status', player.status,
      'profile_id', case when flags.hidden then null else player.profile_id end,
      'name', case when flags.hidden then null else profile.name end,
      'nickname', case when flags.hidden then null else profile.nickname end,
      'position', case when flags.hidden then null else profile.position end,
      'account_removed', flags.hidden,
      'is_viewer', player.profile_id = v_actor_id,
      'paid', case when v_manage and player.status = 'starter' then player.paid end)
    order by player.queue_seq), '[]'::jsonb)
  into v_entries
  from private.match_players as player
  join public.profiles as profile on profile.id = player.profile_id
  cross join lateral (
    select profile.account_status in ('deletion_pending', 'deleted') as hidden) as flags
  where player.match_id = p_match_id and player.status in ('starter', 'waitlist');

  v_current := private.match_player_current(p_match_id, v_actor_id);
  select * into v_own from private.match_players
  where match_id = p_match_id and profile_id = v_actor_id and status = 'starter';

  return jsonb_build_object(
    'match_id', p_match_id,
    'field_slots', v_match.field_slots,
    'started', v_match.starts_at <= now(),
    'canceled', v_match.canceled_at is not null,
    'confirmed_count', v_current -> 'confirmed_count',
    'waitlist_count', v_current -> 'waitlist_count',
    'viewer', jsonb_build_object(
      'status', v_current -> 'status',
      'waitlist_position', v_current -> 'waitlist_position',
      'paid', case when v_own.id is null then null else v_own.paid end,
      'can_manage', v_manage),
    'confirmed', coalesce((select jsonb_agg(item.entry - 'status' order by item.ord)
      from jsonb_array_elements(v_entries) with ordinality as item(entry, ord)
      where item.entry ->> 'status' = 'starter'), '[]'::jsonb),
    'waitlist', coalesce((select jsonb_agg(item.entry - 'status' - 'paid' order by item.ord)
      from jsonb_array_elements(v_entries) with ordinality as item(entry, ord)
      where item.entry ->> 'status' = 'waitlist'), '[]'::jsonb),
    'payment_summary', case when v_manage then private.match_payment_summary(p_match_id) end);
end;
$function$;

drop function public.get_match(uuid, uuid, uuid);
create function public.get_match(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_match_id uuid
) returns table (id uuid, group_id uuid, group_name text, group_icon text, group_color text,
  starts_at timestamptz, ends_at timestamptz, timezone text, location_name text,
  location_address text, description text, latitude numeric, longitude numeric,
  field_slots integer, field_price numeric, canceled boolean)
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
  select m.id, m.group_id, g.name, g.icon, g.color, m.starts_at, m.ends_at, m.timezone,
    m.location_name, m.location_address, m.description, m.latitude, m.longitude,
    m.field_slots, m.field_price, m.canceled_at is not null
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

drop function public.list_my_matches(uuid, uuid);
create function public.list_my_matches(
  p_actor_auth_user_id uuid, p_actor_session_id uuid
) returns table (id uuid, group_id uuid, group_name text, group_icon text, group_color text,
  starts_at timestamptz, ends_at timestamptz, timezone text, location_name text,
  location_address text, latitude numeric, longitude numeric, field_slots integer,
  field_price numeric, canceled boolean)
language plpgsql volatile security definer set search_path = '' as $function$
declare v_actor uuid;
begin
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  perform 1 from public.profiles p where p.id = v_actor for no key update;
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  return query
  select m.id, m.group_id, g.name, g.icon, g.color, m.starts_at, m.ends_at, m.timezone,
    m.location_name, m.location_address, m.latitude, m.longitude, m.field_slots,
    m.field_price, m.canceled_at is not null
  from private.matches m
  join public.groups g on g.id = m.group_id and g.archived_at is null
  join public.group_members gm on gm.group_id = m.group_id and gm.profile_id = v_actor
   and gm.status = 'active'
  where m.ends_at > now()
  order by m.starts_at, m.id;
end;
$function$;

drop function public.get_matches_occupancy(uuid, uuid);
create function public.get_matches_occupancy(
  p_actor_auth_user_id uuid, p_actor_session_id uuid
)
returns table (match_id uuid, confirmed_count integer, waitlist_count integer, viewer_status text,
  canceled boolean)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
begin
  v_actor_id := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  return query
  select match.id,
    (select count(*)::integer from private.match_players as player
      where player.match_id = match.id and player.status = 'starter'),
    (select count(*)::integer from private.match_players as player
      where player.match_id = match.id and player.status = 'waitlist'),
    coalesce((select player.status from private.match_players as player
      where player.match_id = match.id and player.profile_id = v_actor_id
        and player.status in ('starter', 'waitlist')), 'out'),
    match.canceled_at is not null
  from private.matches as match
  join public.groups as grp on grp.id = match.group_id and grp.archived_at is null
  join public.group_members as membership
    on membership.group_id = match.group_id and membership.profile_id = v_actor_id
   and membership.status = 'active'
  where match.ends_at > now()
  order by match.starts_at, match.id;
end;
$function$;

revoke all on function public.get_match(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_my_matches(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_matches_occupancy(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_match(uuid, uuid, uuid) to service_role;
grant execute on function public.list_my_matches(uuid, uuid) to service_role;
grant execute on function public.get_matches_occupancy(uuid, uuid) to service_role;

commit;
