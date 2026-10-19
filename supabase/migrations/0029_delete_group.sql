-- Fatia 0029: apagar grupo (PR J, item 1 do feedback do César; decisão humana
-- de 19/10/2026, docs/25 §8.1). Só o dono ativo apaga, e é definitivo: não há
-- reativar. O grupo não é apagado fisicamente. Fica encerrado, com o estado e
-- a data em private.group_deletions e archived_at no mesmo instante, e os
-- dados preservados para a exportação e a retenção. Ninguém, nem o dono,
-- acessa mais.
--
-- archived_at é o que já tira um grupo de toda leitura (policy
-- groups_select_active_member, helpers de leitura, Agenda, get_match,
-- ocupação, pedidos próprios), do limite de 5 grupos ativos (D6, 0015) e da
-- saga de exclusão de conta (grupos próprios não arquivados). A linha de
-- private.group_deletions distingue o grupo apagado do arquivado pela
-- exclusão de conta (M2-D9), que conserva o contrato de docs/25 §5.0.1:
-- GROUP_ARCHIVED (410) na chamada nova e o desfecho gravado no replay.
--
-- O grupo apagado não conserva nada disso. Toda escrita recusa com
-- GROUP_DELETED, inclusive o replay de um pedido feito antes do encerramento,
-- e a Edge responde NOT_FOUND (404), o mesmo de um grupo que nunca existiu.
-- A recusa sai dos dois helpers de autoridade, chamados depois das travas,
-- com uma mensagem que nenhum tratador da M2-D20 conserva: o replay não
-- devolve desfecho. create_match e o resgate de convite devolvem o desfecho
-- do replay sem passar pelo helper e ganham a mesma checagem.
--
-- Ao apagar, na mesma transação: os rachas que não terminaram nem foram
-- cancelados passam a cancelados (o estado da 0028); todos os convites são
-- revogados, e a prévia da 0026/0027, STABLE e sem trava, cai no CODE_INVALID
-- genérico pela linha do convite, antes de tocar no grupo; os pedidos
-- pendentes passam a removed sem incrementar removal_count (M2-D9); as
-- memberships ativas ficam como histórico e deixam de contar no limite.
-- A D63.5 continua adiada: o padrão idempotente é o da 0021 a 0028.
begin;

-- ---------------------------------------------------------------------------
-- Estado do encerramento
-- ---------------------------------------------------------------------------
-- Tabela privada de serviço, sem RLS (docs/14 §5.2): a proteção vem dos
-- privilégios de schema, e os defaults da 0004 a fazem nascer sem privilégio.
-- Uma linha por grupo, escrita somente por delete_group e nunca apagada.
-- deleted_by é histórico, não autoridade, como canceled_by (0028).
create table private.group_deletions (
  group_id   uuid primary key references public.groups (id),
  deleted_by uuid not null references public.profiles (id),
  deleted_at timestamptz not null default now()
);

comment on table private.group_deletions is
  'Grupo apagado pelo dono (0029): definitivo. Escrita somente por delete_group; deleted_by é histórico, não autoridade.';

-- Sem trava: quem pergunta já segura a linha do grupo, e delete_group grava
-- esta linha sob essa mesma trava.
create function private.is_group_deleted(p_group_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select exists (select 1 from private.group_deletions where group_id = p_group_id);
$function$;

revoke all on function private.is_group_deleted(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Livro de idempotência: lista fechada de operações e desfechos
-- ---------------------------------------------------------------------------
-- Todas as operações e todos os desfechos que já existem continuam, inclusive
-- set_group_appearance (0027), update_match e cancel_match (0028).
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
    'set_match_payment', 'set_group_appearance', 'update_match', 'cancel_match',
    'delete_group'
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
      'match_cancel_unchanged', 'group_deleted'
    )
  );

alter function private.validate_idempotency_outcome(text, jsonb)
  rename to validate_through_edit_cancel_match_outcome;

-- O desfecho guarda somente o grupo e o resultado lógico: nenhum nome, contagem
-- de rachas cancelados, convite ou pedido encerrado.
create function private.validate_idempotency_outcome(p_operation text, p_outcome jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_id uuid;
begin
  if p_operation <> 'delete_group' then
    perform private.validate_through_edit_cancel_match_outcome(p_operation, p_outcome);
    return;
  end if;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
        is distinct from array['group_id', 'logical_result']::text[]
     or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
     or p_outcome ->> 'logical_result' <> 'group_deleted'
     or jsonb_typeof(p_outcome -> 'group_id') <> 'string'
     or p_outcome ->> 'group_id'
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  begin
    v_id := (p_outcome ->> 'group_id')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end;
  if p_outcome ->> 'group_id' <> v_id::text then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
end;
$function$;

revoke all on function private.validate_through_edit_cancel_match_outcome(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_idempotency_outcome(text, jsonb)
  from public, anon, authenticated, service_role;

-- Corpos idênticos aos da 0028; somente as listas de operações ganham
-- delete_group. O recurso é o grupo, como nas demais operações de grupo.
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
                            'set_group_appearance', 'update_match', 'cancel_match',
                            'delete_group')
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
                            'set_group_appearance', 'update_match', 'cancel_match',
                            'delete_group') then
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
                                  'cancel_match','delete_group')
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
-- Autoridade: o grupo apagado recusa antes de tudo
-- ---------------------------------------------------------------------------
-- Os dois helpers rodam depois das travas do grupo, que delete_group segura
-- ao gravar o encerramento. GROUP_DELETED vem antes do arquivamento, da
-- membership e do papel: ex-membro, membro e dono recebem a mesma recusa, e o
-- replay também, porque nenhum tratador da M2-D20 conserva esta mensagem.
-- Corpos da 0016 e da 0022, mais a checagem; o replace preserva o ACL.
create or replace function private.group_actor_authority(p_group_id uuid, p_actor_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_owner_id uuid;
  v_archived_at timestamptz;
  v_role text;
begin
  select grp.owner_id, grp.archived_at into v_owner_id, v_archived_at
  from public.groups as grp where grp.id = p_group_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if private.is_group_deleted(p_group_id) then
    raise exception using errcode = 'P0002', message = 'GROUP_DELETED';
  end if;
  if v_archived_at is not null then
    raise exception using errcode = 'P0001', message = 'GROUP_ARCHIVED';
  end if;
  select membership.role into v_role
  from public.group_members as membership
  where membership.group_id = p_group_id
    and membership.profile_id = p_actor_id
    and membership.status = 'active';
  if not found then
    raise exception using errcode = '42501', message = 'NOT_MEMBER';
  end if;
  if v_owner_id = p_actor_id then
    return 'owner';
  end if;
  return v_role;
end;
$function$;

create or replace function private.match_actor_authority(p_group_id uuid, p_actor_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_owner_id uuid;
  v_role text;
begin
  if private.is_group_deleted(p_group_id) then
    raise exception using errcode = 'P0002', message = 'GROUP_DELETED';
  end if;
  select grp.owner_id, membership.role into v_owner_id, v_role
  from public.groups as grp
  join public.group_members as membership
    on membership.group_id = grp.id and membership.profile_id = p_actor_id
   and membership.status = 'active'
  where grp.id = p_group_id and grp.archived_at is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  return case when v_owner_id = p_actor_id then 'owner' else v_role end;
end;
$function$;

revoke all on function private.group_actor_authority(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.match_actor_authority(uuid, uuid)
  from public, anon, authenticated, service_role;

-- create_match devolve o desfecho do replay antes de chamar o helper, e o
-- resgate de convite não o chama: os dois recusam o replay pelo encerramento
-- sob as mesmas travas. Corpos da 0022 e da 0017, mais a checagem. A chamada
-- nova de create_match já recusa pelo helper; a do resgate encontra o convite
-- revogado (INVITE_REVOKED, M2-D42), como qualquer convite revogado.
create or replace function public.create_match(
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
  v_description text;
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
        is distinct from array['description', 'ends_at', 'field_price', 'field_slots', 'latitude',
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
  -- A Edge já troca "" por null; aqui "" também é recusado, para que null
  -- seja a única grafia de "sem descrição" no livro de idempotência.
  if p_config ->> 'description' is not null then
    v_description := private.normalize_match_description(p_config ->> 'description');
    if v_description is null then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
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
    -- 0029: grupo apagado recusa também o replay de antes do encerramento.
    if private.is_group_deleted(p_group_id) then
      raise exception using errcode = 'P0002', message = 'GROUP_DELETED';
    end if;
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
    location_address, description, latitude, longitude, field_slots, field_price, created_by)
  values (p_group_id, v_starts_at, v_ends_at, v_timezone, v_location_name,
    v_location_address, v_description, v_latitude, v_longitude, v_field_slots, v_field_price,
    v_actor_id)
  returning id into v_match_id;

  v_outcome := jsonb_build_object('group_id', p_group_id::text,
    'logical_result', 'match_created', 'match_id', v_match_id::text);
  perform private.complete_group_idempotency(
    v_actor_key, 'create_match', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome);
end;
$function$;

create or replace function private.join_group_invite(
  p_operation text, p_actor_auth_user_id uuid, p_actor_session_id uuid,
  p_request_id uuid, p_input_hmac text, p_canonical_version integer,
  p_hash_key_version integer, p_invite_id uuid, p_token_version smallint,
  p_token_digest text, p_code_digest text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_actor_id uuid; v_actor_key text; v_acquired record;
  v_invite public.group_invites%rowtype; v_group public.groups%rowtype;
  v_member public.group_members%rowtype; v_group_id uuid; v_invite_id uuid;
  v_count bigint; v_limit bigint; v_capacity bigint; v_result text; v_outcome jsonb;
begin
  perform private.require_internal_transport(p_request_id,p_input_hmac,
    p_canonical_version,p_hash_key_version);
  v_actor_id:=private.require_actor_context(p_actor_auth_user_id,p_actor_session_id);
  v_actor_key:='profile:'||v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key,p_operation,p_request_id,p_input_hmac,p_canonical_version,p_hash_key_version);
  if v_acquired.acquired then
    if p_operation='join_by_code' then
      if p_code_digest is null or p_code_digest !~ '^[0-9a-f]{64}$' then
        raise exception using errcode='22023',message='CODE_INVALID';
      end if;
      select * into v_invite from public.group_invites
      where code_digest=p_code_digest and token_version=1;
    else
      if p_invite_id is null or p_token_version is distinct from 1
         or p_token_digest is null or p_token_digest !~ '^[0-9a-f]{64}$' then
        raise exception using errcode='22023',message='CODE_INVALID';
      end if;
      select * into v_invite from public.group_invites where id=p_invite_id;
    end if;
    if not found then raise exception using errcode='22023',message='CODE_INVALID'; end if;
    v_group_id:=v_invite.group_id; v_invite_id:=v_invite.id;
  else
    v_group_id:=(v_acquired.outcome->>'group_id')::uuid;
    v_invite_id:=(v_acquired.outcome->>'invite_id')::uuid;
  end if;
  perform 1 from public.profiles where id=v_actor_id for no key update;
  select * into v_group from public.groups where id=v_group_id for no key update;
  select * into v_member from public.group_members where group_id=v_group_id
    and profile_id=v_actor_id for no key update;
  select * into v_invite from public.group_invites where id=v_invite_id for no key update;
  perform private.require_group_actor_after_locks(v_actor_id,p_actor_auth_user_id,p_actor_session_id);
  if not v_acquired.acquired then
    -- 0029: grupo apagado recusa também o replay de antes do encerramento.
    if private.is_group_deleted(v_group_id) then
      raise exception using errcode='P0002',message='GROUP_DELETED';
    end if;
    if v_member.status in ('pending','active') and v_group.archived_at is null then
      return jsonb_build_object('outcome',v_acquired.outcome || jsonb_build_object(
        'reentry',(v_acquired.outcome->>'logical_result')='membership_reentry_requested'),
        'current',jsonb_build_object('group_id',v_group_id,'group_name',v_group.name,
          'status',v_member.status));
    end if;
    return jsonb_build_object('outcome',v_acquired.outcome || jsonb_build_object(
      'reentry',(v_acquired.outcome->>'logical_result')='membership_reentry_requested'));
  end if;
  if (p_operation='join_by_code' and (v_invite.code_digest is distinct from p_code_digest
      or v_invite.token_version<>1))
     or (p_operation='join_by_invite' and (v_invite.token_version is distinct from p_token_version
       or v_invite.token_digest is distinct from p_token_digest)) then
    raise exception using errcode='22023',message='CODE_INVALID';
  end if;
  perform private.require_live_group_invite(v_invite_id);
  if v_group.archived_at is not null then
    raise exception using errcode='P0001',message='GROUP_ARCHIVED';
  elsif v_group.suspended_at is not null then
    raise exception using errcode='P0001',message='GROUP_SUSPENDED';
  end if;
  if v_member.status='active' then
    v_result:='membership_already_active';
  elsif v_member.status='pending' then
    v_result:='membership_request_unchanged';
  else
    select count(*) into v_count from public.group_members
    where group_id=v_group_id and status in ('pending','active');
    select limit_value into v_capacity from private.app_limits
      where limit_key='max_group_capacity';
    if v_capacity is null or v_capacity<=0 then
      raise exception using errcode='22023',message='VALIDATION';
    end if;
    if v_count>=v_capacity then raise exception using errcode='P0001',message='GROUP_FULL'; end if;
    select limit_value into v_limit from private.app_limits
    where limit_key='max_active_groups_per_profile';
    select count(*) into v_count from public.group_members m
      join public.groups g on g.id=m.group_id
      where m.profile_id=v_actor_id and m.status='active' and g.archived_at is null;
    if v_limit is null or v_count>=v_limit then
      raise exception using errcode='P0001',message='GROUP_LIMIT';
    end if;
    update public.group_invites set used_count=used_count+1
      where id=v_invite_id and used_count<max_uses;
    if not found then raise exception using errcode='P0001',message='INVITE_USED'; end if;
    if v_member.group_id is null then
      insert into public.group_members(group_id,profile_id,role,status)
      values(v_group_id,v_actor_id,'player','pending');
      v_result:='membership_requested';
    else
      update public.group_members set status='pending',role='player',is_monthly=false,
        removed_at=null,removal_count=removal_count+1,last_requested_at=now()
      where group_id=v_group_id and profile_id=v_actor_id and status='removed';
      if not found then raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
      v_result:='membership_reentry_requested';
    end if;
  end if;
  v_outcome:=jsonb_build_object('group_id',v_group_id,'invite_id',v_invite_id,
    'logical_result',v_result);
  perform private.complete_group_idempotency(v_actor_key,p_operation,p_request_id,
    p_input_hmac,p_canonical_version,p_hash_key_version,v_outcome);
  return jsonb_build_object('outcome',v_outcome || jsonb_build_object(
    'reentry',v_result='membership_reentry_requested'),
    'current',jsonb_build_object('group_id',v_group_id,'group_name',v_group.name,
      'status',case when v_member.status='active' then 'active' else 'pending' end));
end;
$function$;

revoke all on function private.join_group_invite(text,uuid,uuid,uuid,text,integer,integer,uuid,smallint,text,text)
  from public,anon,authenticated,service_role;

-- A leitura de membros responde ao grupo apagado como a um grupo inexistente
-- (NOT_MEMBER, docs/13 §5): o ramo GROUP_ARCHIVED da 0019 continua para o
-- arquivamento pela exclusão de conta. Corpo da 0019, mais a condição.
create or replace function public.get_group_members(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_group_id uuid
) returns table (profile_id uuid, display_name text, role text, status text)
language plpgsql volatile security definer set search_path = '' as $function$
declare v_actor uuid; v_group public.groups%rowtype; v_member public.group_members%rowtype;
begin
  if p_group_id is null then
    raise exception using errcode='22023', message='VALIDATION';
  end if;
  v_actor := private.require_actor_context(p_actor_auth_user_id,p_actor_session_id,true);
  perform 1 from public.profiles p where p.id=v_actor for no key update;
  v_actor := private.require_actor_context(p_actor_auth_user_id,p_actor_session_id,true);
  select g.* into v_group from public.groups g where g.id=p_group_id for no key update;
  select m.* into v_member from public.group_members m
    where m.group_id=p_group_id and m.profile_id=v_actor;
  if v_member.status is distinct from 'active' or private.is_group_deleted(p_group_id) then
    raise exception using errcode='42501', message='NOT_MEMBER';
  end if;
  if v_group.archived_at is not null then
    raise exception using errcode='P0001', message='GROUP_ARCHIVED';
  end if;
  return query
  select m.profile_id, coalesce(nullif(btrim(p.nickname),''),p.name),
    case when m.profile_id=v_group.owner_id then 'owner' else m.role end, m.status
  from public.group_members m join public.profiles p on p.id=m.profile_id
  where m.group_id=p_group_id and p.account_status not in ('deletion_pending','deleted')
    and (m.status='active' or (m.status='pending' and
      (v_actor=v_group.owner_id or v_member.role='organizer')))
  order by case when m.status='pending' then 3
                when m.profile_id=v_group.owner_id then 0
                when m.role='organizer' then 1 else 2 end,
    case when m.status='active' then lower(coalesce(nullif(btrim(p.nickname),''),p.name)) end,
    case when m.status='pending' then m.last_requested_at end,
    m.profile_id;
end;
$function$;

revoke all on function public.create_match(uuid, uuid, uuid, text, integer, integer, uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.get_group_members(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.create_match(uuid, uuid, uuid, text, integer, integer, uuid, jsonb)
  to service_role;
grant execute on function public.get_group_members(uuid,uuid,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- delete_group(group_id, request_id)
-- ---------------------------------------------------------------------------
-- Somente o dono com membership active (groups.owner_id, como em
-- set_group_appearance): organizador e jogador recebem OWNER_ONLY, quem não é
-- mais membro recebe NOT_MEMBER, grupo inexistente NOT_FOUND. Grupo suspenso
-- recusa com GROUP_SUSPENDED, e o já apagado com GROUP_DELETED.
--
-- Locks, todos FOR NO KEY UPDATE (M2-D13): perfil próprio → grupo →
-- membership própria, a ordem de create_match, rename_group e do resgate;
-- depois, sob o grupo, os pedidos pendentes por perfil, os rachas a cancelar
-- e os convites, cada conjunto em ordem crescente. Quem entra, cria racha ou
-- confirma presença trava o grupo antes de qualquer linha dele: com o grupo
-- travado aqui, ou espera e encontra o encerramento, ou já commitou e o
-- efeito dele é encerrado junto. Os perfis dos membros não são travados: o
-- encerramento só libera vaga do limite de 5, nunca a ocupa.
--
-- O replay devolve o desfecho gravado, sem projeção, depois da autenticação
-- (M2-D20): o registro concluído só existe se o encerramento commitou.
create function public.delete_group(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_group_id uuid
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
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_group_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
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
    v_actor_key, 'delete_group', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  -- A FK da idempotência já segura FOR KEY SHARE no perfil próprio.
  perform 1 from public.profiles where id = v_actor_id for no key update;
  perform 1 from public.groups where id = p_group_id for no key update;
  perform 1 from public.group_members
    where group_id = p_group_id and profile_id = v_actor_id for no key update;
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome);
  end if;

  if private.group_actor_authority(p_group_id, v_actor_id) <> 'owner' then
    raise exception using errcode = '42501', message = 'OWNER_ONLY';
  end if;
  perform private.require_group_not_suspended(p_group_id);

  perform 1 from public.group_members
    where group_id = p_group_id and status = 'pending'
    order by profile_id for no key update;
  perform 1 from private.matches
    where group_id = p_group_id and canceled_at is null and ends_at > now()
    order by id for no key update;
  perform 1 from public.group_invites
    where group_id = p_group_id
    order by id for no key update;

  -- Racha em andamento também não terminou: cancela, como cancel_match faria.
  -- O terminado e o já cancelado ficam como estão.
  update private.matches
  set canceled_at = now(), canceled_by = v_actor_id
  where group_id = p_group_id and canceled_at is null and ends_at > now();
  -- Todos, inclusive expirados e esgotados; o já revogado conserva o instante.
  update public.group_invites
  set revoked_at = now()
  where group_id = p_group_id and revoked_at is null;
  -- M2-D9: pendente vira removed, sem incrementar removal_count.
  update public.group_members
  set status = 'removed', removed_at = now()
  where group_id = p_group_id and status = 'pending';
  update public.groups set archived_at = now() where id = p_group_id;
  insert into private.group_deletions (group_id, deleted_by, deleted_at)
  values (p_group_id, v_actor_id, now());

  v_outcome := jsonb_build_object('group_id', p_group_id::text,
    'logical_result', 'group_deleted');
  perform private.complete_group_idempotency(
    v_actor_key, 'delete_group', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome);
end;
$function$;

revoke all on function public.delete_group(uuid, uuid, uuid, text, integer, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_group(uuid, uuid, uuid, text, integer, integer, uuid)
  to service_role;

commit;
