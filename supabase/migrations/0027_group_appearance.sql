-- Fatia 0027: ícone e cor do grupo (PR H, decisão humana de César de
-- 18/10/2026). O dono escolhe um de oito ícones e uma de seis cores; lista,
-- detalhe, Agenda, Criar racha e a página do convite (0026) mostram a escolha.
-- O padrão idempotente é o de rename_group (0018): lista fechada de
-- operações, validador encadeado, RPC chamada só pela Edge groups com o actor
-- context. A D63.5 continua adiada (docs/25 §8.1).
begin;

-- ---------------------------------------------------------------------------
-- Colunas
-- ---------------------------------------------------------------------------
-- Valores fechados, em inglês como os demais enums do banco. O rótulo
-- ("Bola", "Azul") e o desenho moram no app; o banco guarda só a chave. O
-- padrão vale para os grupos existentes e para os novos: create_group não
-- muda.
alter table public.groups
  add column icon text not null default 'ball'
    constraint groups_icon_check check (icon in (
      'ball', 'goal', 'field', 'whistle', 'shirt', 'trophy', 'bolt', 'flame')),
  add column color text not null default 'blue'
    constraint groups_color_check check (color in (
      'blue', 'green', 'orange', 'pink', 'lilac', 'sand'));

-- Lista e detalhe leem groups pela policy groups_select_active_member (0015),
-- coluna a coluna: o membro ativo de grupo não arquivado passa a ler as duas.
-- Nenhum papel cliente ganha escrita; service_role continua sem DML (0004).
grant select (icon, color) on public.groups to authenticated;

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
    'rename_group', 'create_match', 'join_match', 'leave_match',
    'set_match_payment', 'set_group_appearance'
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
      'group_appearance_set'
    )
  );

alter function private.validate_idempotency_outcome(text, jsonb)
  rename to validate_through_match_players_outcome;

-- O desfecho guarda somente o ID do grupo e o resultado lógico, como o de
-- rename_group: nenhum ícone ou cor. A escolha corrente é projeção fresca.
create function private.validate_idempotency_outcome(p_operation text, p_outcome jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_id uuid;
begin
  if p_operation <> 'set_group_appearance' then
    perform private.validate_through_match_players_outcome(p_operation, p_outcome);
    return;
  end if;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
        is distinct from array['group_id', 'logical_result']::text[]
     or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
     or p_outcome ->> 'logical_result' <> 'group_appearance_set'
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

revoke all on function private.validate_through_match_players_outcome(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_idempotency_outcome(text, jsonb)
  from public, anon, authenticated, service_role;

-- Corpo idêntico ao da 0022; somente a lista de operações ganha
-- set_group_appearance.
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
                            'set_group_appearance')
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

-- O recurso de set_group_appearance é o próprio grupo, como em rename_group.
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
                            'set_group_appearance') then
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
                                  'set_match_payment','set_group_appearance')
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
-- set_group_appearance(group_id, icon, color, request_id)
-- ---------------------------------------------------------------------------
-- Somente o dono com membership active (groups.owner_id, como em
-- transfer_ownership): organizador e jogador recebem OWNER_ONLY, quem não é
-- mais membro recebe NOT_MEMBER. Ícone e cor fora da lista recusam
-- VALIDATION antes de qualquer ator ou chave idempotente; a Edge recusa o
-- mesmo antes de gastar a chave. Os dois campos chegam sempre juntos: a tela
-- salva a escolha inteira. Locks perfil → grupo → membership própria, todos
-- FOR NO KEY UPDATE (M2-D13). Altera somente groups.icon e groups.color.
create function public.set_group_appearance(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_group_id uuid, p_icon text, p_color text
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
  if p_group_id is null
     or p_icon is null
     or p_icon not in ('ball', 'goal', 'field', 'whistle', 'shirt', 'trophy', 'bolt', 'flame')
     or p_color is null
     or p_color not in ('blue', 'green', 'orange', 'pink', 'lilac', 'sand') then
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
    v_actor_key, 'set_group_appearance', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  -- A FK da idempotência já segura FOR KEY SHARE no perfil próprio.
  perform 1 from public.profiles where id = v_actor_id for no key update;
  perform 1 from public.groups where id = p_group_id for no key update;
  perform 1 from public.group_members
    where group_id = p_group_id and profile_id = v_actor_id for no key update;
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  -- Só a perda de autoridade no grupo conserva o desfecho sem projeção.
  begin
    if private.group_actor_authority(p_group_id, v_actor_id) <> 'owner' then
      raise exception using errcode = '42501', message = 'OWNER_ONLY';
    end if;
    perform private.require_group_not_suspended(p_group_id);
  exception when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
    if not v_acquired.acquired and sqlerrm in
      ('NOT_FOUND', 'GROUP_ARCHIVED', 'NOT_MEMBER', 'OWNER_ONLY', 'GROUP_SUSPENDED') then
      return jsonb_build_object('outcome', v_acquired.outcome);
    end if;
    raise;
  end;

  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome,
      'current', (select jsonb_build_object('group_id', grp.id, 'icon', grp.icon,
        'color', grp.color) from public.groups as grp where grp.id = p_group_id));
  end if;

  update public.groups set icon = p_icon, color = p_color where id = p_group_id;
  v_outcome := jsonb_build_object('group_id', p_group_id::text,
    'logical_result', 'group_appearance_set');
  perform private.complete_group_idempotency(
    v_actor_key, 'set_group_appearance', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome,
    'current', jsonb_build_object('group_id', p_group_id, 'icon', p_icon, 'color', p_color));
end;
$function$;

revoke all on function public.set_group_appearance(uuid, uuid, uuid, text, integer, integer, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_group_appearance(uuid, uuid, uuid, text, integer, integer, uuid, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Agenda: get_match e list_my_matches projetam o ícone e a cor do grupo
-- ---------------------------------------------------------------------------
-- A forma de retorno muda, então as duas são recriadas com o corpo da 0022
-- (get_match) e da 0021 (list_my_matches), mais group_icon e group_color
-- depois de group_name, e os mesmos privilégios.
drop function public.get_match(uuid, uuid, uuid);
create function public.get_match(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_match_id uuid
) returns table (id uuid, group_id uuid, group_name text, group_icon text, group_color text,
  starts_at timestamptz, ends_at timestamptz, timezone text, location_name text,
  location_address text, description text, latitude numeric, longitude numeric,
  field_slots integer, field_price numeric)
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
    m.field_slots, m.field_price
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
  field_price numeric)
language plpgsql volatile security definer set search_path = '' as $function$
declare v_actor uuid;
begin
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  perform 1 from public.profiles p where p.id = v_actor for no key update;
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  return query
  select m.id, m.group_id, g.name, g.icon, g.color, m.starts_at, m.ends_at, m.timezone,
    m.location_name, m.location_address, m.latitude, m.longitude, m.field_slots,
    m.field_price
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

-- ---------------------------------------------------------------------------
-- Página do convite: a prévia da 0026 devolve também o ícone e a cor
-- ---------------------------------------------------------------------------
-- Corpo idêntico ao da 0026 corrigida (só leitura, STABLE e sem trava, P1 da
-- revisão do #76), mais group_icon e group_color no fim do objeto. Os dois vêm
-- da mesma linha do grupo que a prévia já lê para um convite vivo, sem trava;
-- convite inexistente ou terminal continua saindo em CODE_INVALID antes de
-- tocar no grupo. São do grupo, não de uma pessoa. As wrappers públicas, os
-- grants e o limitador não mudam.
create or replace function private.preview_group_invite(
  p_actor_auth_user_id uuid, p_actor_session_id uuid,
  p_invite_id uuid, p_token_version smallint, p_token_digest text,
  p_code_digest text
) returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  v_actor_id uuid;
  v_invite public.group_invites%rowtype;
  v_group public.groups%rowtype;
  v_membership public.group_members%rowtype;
  v_limit bigint;
  v_capacity bigint;
  v_count bigint;
  v_members bigint;
  v_owner_name text;
  v_refusal text;
begin
  -- O ator é conferido antes do lookup, igual para todo código.
  v_actor_id := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id);
  perform private.require_group_actor_after_locks(v_actor_id,p_actor_auth_user_id,p_actor_session_id);
  if p_code_digest is not null then
    if p_code_digest !~ '^[0-9a-f]{64}$' then
      raise exception using errcode='22023', message='CODE_INVALID';
    end if;
    select * into v_invite from public.group_invites
    where code_digest = p_code_digest and token_version = 1;
  else
    if p_invite_id is null or p_token_version is distinct from 1
       or p_token_digest is null or p_token_digest !~ '^[0-9a-f]{64}$' then
      raise exception using errcode='22023', message='CODE_INVALID';
    end if;
    select * into v_invite from public.group_invites where id=p_invite_id;
  end if;
  -- Inexistente, material divergente e convite terminal têm a mesma resposta,
  -- decidida só pela linha do convite e sem esperar trava: nenhuma causa,
  -- nenhum grupo. Só um convite vivo chega ao estado do grupo.
  if not found
     or (p_code_digest is not null and v_invite.code_digest is distinct from p_code_digest)
     or (p_code_digest is null and (v_invite.token_version is distinct from p_token_version
         or v_invite.token_digest is distinct from p_token_digest))
     or v_invite.revoked_at is not null
     or v_invite.expires_at <= now()
     or v_invite.used_count >= v_invite.max_uses then
    raise exception using errcode='22023', message='CODE_INVALID';
  end if;
  select * into v_group from public.groups where id=v_invite.group_id;
  select * into v_membership from public.group_members
    where group_id=v_invite.group_id and profile_id=v_actor_id;
  if v_group.archived_at is not null then
    raise exception using errcode='P0001', message='GROUP_ARCHIVED';
  elsif v_group.suspended_at is not null then
    raise exception using errcode='P0001', message='GROUP_SUSPENDED';
  end if;
  if v_membership.status is distinct from 'pending'
     and v_membership.status is distinct from 'active' then
    select count(*) into v_count from public.group_members
    where group_id=v_group.id and status in ('pending','active');
    select limit_value into v_capacity from private.app_limits
      where limit_key='max_group_capacity';
    if v_capacity is null or v_capacity<=0 then
      raise exception using errcode='22023',message='VALIDATION';
    end if;
    if v_count >= v_capacity then
      v_refusal := 'GROUP_FULL';
    else
      select limit_value into v_limit from private.app_limits
      where limit_key='max_active_groups_per_profile';
      select count(*) into v_count from public.group_members m
        join public.groups g on g.id=m.group_id
        where m.profile_id=v_actor_id and m.status='active' and g.archived_at is null;
      if v_limit is null or v_count >= v_limit then
        v_refusal := 'GROUP_LIMIT';
      end if;
    end if;
  end if;
  -- A mesma contagem e o mesmo nome de exibição de get_group_members (0019):
  -- conta em exclusão não aparece nem conta.
  select count(*) into v_members from public.group_members m
    join public.profiles p on p.id=m.profile_id
    where m.group_id=v_group.id and m.status='active'
      and p.account_status not in ('deletion_pending','deleted');
  select coalesce(nullif(btrim(p.nickname),''),p.name) into v_owner_name
    from public.profiles p
    where p.id=v_group.owner_id and p.account_status not in ('deletion_pending','deleted');
  return jsonb_build_object(
    'group_name', v_group.name,
    'member_count', v_members,
    'owner_name', v_owner_name,
    'viewer_status', case when v_membership.status in ('active','pending')
                          then v_membership.status end,
    'group_id', case when v_membership.status='active' then v_group.id end,
    'refusal', v_refusal,
    'group_icon', v_group.icon,
    'group_color', v_group.color);
end;
$function$;
revoke all on function private.preview_group_invite(uuid,uuid,uuid,smallint,text,text)
  from public, anon, authenticated, service_role;

commit;
