begin;

-- M2, fatia 2: membership, papéis e titularidade sobre grupos de fixture.
-- Fontes: docs/25-plano-m2.md §2 (ordem global de locks, M2-D13, M2-D14) e §4
-- (normativo desta fatia, decisões M2-D16 a M2-D18 do §8.1); docs/10-schema-db.md
-- §3 e §10; docs/13-contratos-funcoes.md §0, §0.1, §5 e §8; docs/17-mapa-dados-lgpd.md
-- §2 e §4.
--
-- Sem create_group: a função mora na 0017 (docs/25 §2). Os grupos desta fatia
-- nascem por fixture. Nenhuma função que a 0015 fixou é redefinida aqui.
--
-- Modo das travas (M2-D13): toda trava de domínio desta migration é
-- FOR NO KEY UPDATE. Cada RPC grava primeiro a idempotência, cuja FK
-- actor_id → profiles toma FOR KEY SHARE no perfil do ator até o commit; FOR
-- NO KEY UPDATE é compatível com esse FOR KEY SHARE e conflita consigo mesmo,
-- então a serialização entre transações de domínio continua. Nenhuma função
-- desta migration apaga perfil, grupo ou membership nem altera coluna de chave
-- delas. A única exceção é o expurgo de retenção, que apaga a membership
-- removida e por isso a trava FOR UPDATE, sem esperar (SKIP LOCKED).

-- ---------------------------------------------------------------------------
-- Envelope idempotente: extensão append-only das allowlists
-- ---------------------------------------------------------------------------
-- docs/25 §4.1: operação, outcome e resource crescem sem retirar nada. O
-- resource de toda operação desta fatia é o grupo: a membership tem chave
-- composta, e o outcome carrega os IDs estáveis que a identificam.

alter table private.idempotency_records
  drop constraint idempotency_records_operation_check,
  drop constraint idempotency_records_outcome_code_check,
  drop constraint idempotency_records_resource_type_check;

alter table private.idempotency_records
  add constraint idempotency_records_operation_check check (operation in (
    'complete_profile', 'update_profile', 'accept_policies',
    'revoke_current_session', 'delete_account', 'request_data_export',
    'approve_member', 'remove_member', 'set_role', 'set_monthly',
    'set_ratings_visibility', 'transfer_ownership', 'leave_group'
  )),
  add constraint idempotency_records_outcome_code_check check (
    outcome_code is null or outcome_code in (
      'profile_created', 'profile_updated', 'policies_accepted',
      'session_revoked', 'deletion_requested', 'data_export_requested',
      'member_approved', 'member_refused', 'member_removed', 'role_set',
      'monthly_set', 'ratings_visibility_set', 'ownership_transferred',
      'group_left'
    )
  ),
  add constraint idempotency_records_resource_type_check check (
    resource_type is null or resource_type in (
      'profile', 'auth_session', 'deletion_request', 'data_export', 'group'
    )
  );

-- O validador vivo passa a delegado privado, e o nome público ganha as sete
-- formas desta fatia, no mesmo padrão da 0012 e da 0013.
alter function private.validate_idempotency_outcome(text, jsonb)
  rename to validate_through_data_export_outcome;

create function private.validate_idempotency_outcome(
  p_operation text,
  p_outcome jsonb
)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_keys text[];
  v_results text[];
  v_id_key text;
  v_id uuid;
begin
  if p_operation not in ('approve_member', 'remove_member', 'set_role', 'set_monthly',
                         'set_ratings_visibility', 'transfer_ownership', 'leave_group') then
    perform private.validate_through_data_export_outcome(p_operation, p_outcome);
    return;
  end if;

  -- Somente IDs estáveis e logical_result (docs/25 §4.1). Papel, status,
  -- visibilidade e titularidade atuais vêm de projeção fresca, nunca daqui;
  -- motivo livre nunca entra (M2-D18).
  if p_operation in ('approve_member', 'remove_member', 'set_role', 'set_monthly') then
    v_keys := array['group_id', 'logical_result', 'profile_id'];
  elsif p_operation = 'transfer_ownership' then
    v_keys := array['group_id', 'logical_result', 'new_owner_id'];
  else
    v_keys := array['group_id', 'logical_result'];
  end if;
  v_results := case p_operation
    when 'approve_member' then array['member_approved', 'member_refused']
    when 'remove_member' then array['member_removed']
    when 'set_role' then array['role_set']
    when 'set_monthly' then array['monthly_set']
    when 'set_ratings_visibility' then array['ratings_visibility_set']
    when 'transfer_ownership' then array['ownership_transferred']
    else array['group_left']
  end;

  if p_outcome is null
     or jsonb_typeof(p_outcome) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
          is distinct from v_keys
     or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
     or not (p_outcome ->> 'logical_result' = any(v_results)) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  foreach v_id_key in array v_keys loop
    continue when v_id_key = 'logical_result';
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

revoke all on function private.validate_through_data_export_outcome(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_idempotency_outcome(text, jsonb)
  from public, anon, authenticated, service_role;

-- Aquisição INSERT-first das sete operações, no padrão de
-- acquire_delete_account_idempotency (0012). A allowlist fechada é a desta
-- fatia; nenhuma operação anterior passa por aqui.
create function private.acquire_group_idempotency(
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
                            'set_ratings_visibility', 'transfer_ownership', 'leave_group')
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

create function private.complete_group_idempotency(
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
                            'set_ratings_visibility', 'transfer_ownership', 'leave_group') then
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

revoke all on function private.acquire_group_idempotency(text, text, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function private.complete_group_idempotency(text, text, uuid, text, integer, integer, jsonb)
  from public, anon, authenticated, service_role;

-- O trigger diferido passa a exigir, para as sete operações, resource 'group'
-- igual ao group_id do outcome. O corpo parte do texto vivo da 0013; a única
-- mudança é o ramo novo.
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
                                  'set_ratings_visibility','transfer_ownership','leave_group')
           and (v_record.resource_type is distinct from 'group'
                or v_record.resource_id is distinct from (v_record.outcome->>'group_id')::uuid)) then
      raise exception using errcode='23514',message='IDEMPOTENCY_OUTCOME_INVALID';
    end if;
  end if;
  return null;
end;
$function$;

revoke all on function private.enforce_idempotency_conclusion()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Revalidação depois dos locks (docs/25 §4.1)
-- ---------------------------------------------------------------------------
-- As RPCs resolvem somente a identidade antes da idempotência e
-- validam, depois de todos os locks, estado da conta, sessão revogada, aceite
-- pendente e, para o grupo, existência, arquivamento, membership do ator e
-- papel. A autenticação fica fora do sub-bloco que conserva o desfecho no
-- replay sem autoridade de grupo: conta, sessão ou aceite negados propagam
-- o mesmo erro da chamada nova, sem desfecho (M2-D20, ajuste de 28/09).
-- As mutações de domínio desta fatia e da 0015 travam antes o grupo;
-- o expurgo de retenção é exceção: trava só memberships removed com
-- FOR UPDATE SKIP LOCKED, sem esperar e sem alterar autoridade ativa.
-- Com o grupo travado, a leitura do papel e da membership ativa já é a decisão.

create function private.require_group_actor_after_locks(
  p_actor_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid
)
returns void
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_status text;
begin
  select profile.account_status into v_status
  from public.profiles as profile
  where profile.id = p_actor_id and profile.auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;
  if v_status in ('deletion_pending', 'deleted') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_status in ('suspended', 'banned') then
    raise exception using errcode = '42501', message = 'PROFILE_SUSPENDED';
  end if;
  if private.is_actor_session_revoked(p_actor_session_id) then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  perform private.require_policies_accepted(p_actor_id);
end;
$function$;

-- Autoridade do ator no grupo já travado: 'owner', 'organizer' ou 'player'.
-- O dono deriva de groups.owner_id (docs/10 §3); o papel só vale com
-- membership active. Grupo arquivado responde GROUP_ARCHIVED antes da
-- membership, porque o arquivamento passa todas a removed.
create function private.group_actor_authority(p_group_id uuid, p_actor_id uuid)
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

-- Grupo suspenso bloqueia aprovação, papel, mensalista, visibilidade,
-- transferência comum e qualquer edição (docs/25 §4.1). leave_group de
-- não-owner fica fora do bloqueio e não chama esta função.
create function private.require_group_not_suspended(p_group_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $function$
begin
  if exists (select 1 from public.groups where id = p_group_id and suspended_at is not null) then
    raise exception using errcode = 'P0001', message = 'GROUP_SUSPENDED';
  end if;
end;
$function$;

revoke all on function private.require_group_actor_after_locks(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.group_actor_authority(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.require_group_not_suspended(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- approve_member(group_id, profile_id, approve, request_id)
-- ---------------------------------------------------------------------------
-- Locks: perfil alvo → grupo → membership (docs/25 §4.1). O perfil alvo é o
-- lock-pai da cota pessoal: duas aprovações do mesmo perfil em grupos
-- diferentes serializam nele, e a segunda reconta. O grupo é o lock-pai da
-- capacidade, recontada como defesa: o próprio pendente já ocupa a vaga.
-- Recusa (M2-D16): pending → removed, removed_at = now(), removal_count
-- inalterado; nenhuma linha nova.
create function public.approve_member(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer,
  p_group_id uuid,
  p_profile_id uuid,
  p_approve boolean
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
  v_status text;
  v_active bigint;
  v_open bigint;
  v_max_groups bigint;
  v_capacity bigint;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  -- Resolver identidade não concede autoridade: conta e sessão são checadas
  -- sob os locks abaixo, inclusive no replay de um desfecho já concluído.
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if p_group_id is null or p_profile_id is null or p_approve is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;

  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'approve_member', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);
  perform 1 from public.profiles where id = p_profile_id for no key update;
  perform 1 from public.groups where id = p_group_id for no key update;
  select membership.status into v_status
  from public.group_members as membership
  where membership.group_id = p_group_id and membership.profile_id = p_profile_id
  for no key update;

  -- M2-D20, ajuste de 28/09: perda de autenticação devolve o erro normal,
  -- inclusive no replay, sem desfecho. Fica fora do tratamento de autoridade.
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  -- Só a perda de autoridade no grupo conserva o desfecho sem projeção.
  -- O sub-bloco cobre só essa checagem: locks e projeções ficam fora dele.
  begin
    v_authority := private.group_actor_authority(p_group_id, v_actor_id);
    if v_authority not in ('owner', 'organizer') then
      raise exception using errcode = '42501', message = 'NOT_ORGANIZER';
    end if;
    perform private.require_group_not_suspended(p_group_id);
  exception
    when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
      if not v_acquired.acquired and sqlerrm in (
        'NOT_FOUND', 'GROUP_ARCHIVED', 'NOT_MEMBER',
        'NOT_ORGANIZER', 'OWNER_ONLY', 'GROUP_SUSPENDED', 'OWNER_MUST_TRANSFER'
      ) then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
  end;

  -- M2-D20 emendada: current só depois da autoridade atual autorizada.
  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome, 'current', jsonb_build_object(
      'status', (select status from public.group_members
                 where group_id = p_group_id and profile_id = p_profile_id)));
  end if;

  if v_status is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'MEMBERSHIP_ALREADY_DECIDED';
  end if;

  if p_approve then
    select max(limit_value) filter (where limit_key = 'max_active_groups_per_profile'),
           max(limit_value) filter (where limit_key = 'max_group_capacity')
    into v_max_groups, v_capacity
    from private.app_limits
    where limit_key in ('max_active_groups_per_profile', 'max_group_capacity');
    if v_max_groups is null or v_max_groups <= 0 or v_capacity is null or v_capacity <= 0 then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;

    -- Cota pessoal (docs/10 §3): memberships active em grupos não
    -- arquivados, grupo próprio incluído; pedido pending não conta.
    select count(*) into v_active
    from public.group_members as membership
    join public.groups as grp on grp.id = membership.group_id
    where membership.profile_id = p_profile_id
      and membership.status = 'active'
      and grp.archived_at is null;
    if v_active >= v_max_groups then
      raise exception using errcode = 'P0001', message = 'GROUP_LIMIT';
    end if;

    -- Capacidade pending + active. O pendente aprovado já está na conta, então
    -- a aprovação não muda o total: é defesa contra estado já inválido.
    select count(*) into v_open
    from public.group_members
    where group_id = p_group_id and status in ('pending', 'active');
    if v_open > v_capacity then
      raise exception using errcode = 'P0001', message = 'GROUP_FULL';
    end if;

    update public.group_members
    set status = 'active'
    where group_id = p_group_id and profile_id = p_profile_id;
    v_outcome := jsonb_build_object('group_id', p_group_id::text,
      'profile_id', p_profile_id::text, 'logical_result', 'member_approved');
  else
    update public.group_members
    set status = 'removed', removed_at = now()
    where group_id = p_group_id and profile_id = p_profile_id;
    v_outcome := jsonb_build_object('group_id', p_group_id::text,
      'profile_id', p_profile_id::text, 'logical_result', 'member_refused');
  end if;

  perform private.complete_group_idempotency(
    v_actor_key, 'approve_member', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);

  return jsonb_build_object('outcome', v_outcome, 'current', jsonb_build_object(
    'status', (select status from public.group_members
               where group_id = p_group_id and profile_id = p_profile_id)));
end;
$function$;

-- ---------------------------------------------------------------------------
-- remove_member(group_id, profile_id, reason, request_id)
-- ---------------------------------------------------------------------------
-- Locks: perfis afetados em ordem → grupo → memberships. No M2 o único perfil
-- afetado é o alvo, e o conjunto de rachas e provas é vazio: PROOFS_PENDING,
-- remoção dos rachas futuros, refunds e invalidações entram no M3/M5 nesta
-- mesma transação, antes da linha de membership, que muda por último.
--
-- M2-D18: reason é obrigatório, não vazio depois de trim e com no máximo 500
-- caracteres, pelo precedente de docs/13 §3.3; fora disso, VALIDATION. O
-- motivo não é persistido no M2: não vai para tabela, log, erro nem outcome, e
-- esta função não o lê depois da validação.
create function public.remove_member(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer,
  p_group_id uuid,
  p_profile_id uuid,
  p_reason text
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
  v_status text;
  v_reason_length integer;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  -- Resolver identidade não concede autoridade: conta e sessão são checadas
  -- sob os locks abaixo, inclusive no replay de um desfecho já concluído.
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_reason_length := char_length(regexp_replace(p_reason, '^\s+|\s+$', '', 'g'));
  if p_group_id is null or p_profile_id is null
     or v_reason_length is null or v_reason_length not between 1 and 500 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;

  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'remove_member', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);
  perform 1 from public.profiles where id = p_profile_id for no key update;
  perform 1 from public.groups where id = p_group_id for no key update;
  select membership.status into v_status
  from public.group_members as membership
  where membership.group_id = p_group_id and membership.profile_id = p_profile_id
  for no key update;

  -- M2-D20, ajuste de 28/09: perda de autenticação devolve o erro normal,
  -- inclusive no replay, sem desfecho. Fica fora do tratamento de autoridade.
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  -- Só a perda de autoridade no grupo conserva o desfecho sem projeção.
  -- O sub-bloco cobre só essa checagem: locks e projeções ficam fora dele.
  begin
    v_authority := private.group_actor_authority(p_group_id, v_actor_id);
    if v_authority not in ('owner', 'organizer') then
      raise exception using errcode = '42501', message = 'NOT_ORGANIZER';
    end if;
    perform private.require_group_not_suspended(p_group_id);
  exception
    when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
      if not v_acquired.acquired and sqlerrm in (
        'NOT_FOUND', 'GROUP_ARCHIVED', 'NOT_MEMBER',
        'NOT_ORGANIZER', 'OWNER_ONLY', 'GROUP_SUSPENDED', 'OWNER_MUST_TRANSFER'
      ) then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
  end;

  -- M2-D20 emendada: current só depois da autoridade atual autorizada.
  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome, 'current', jsonb_build_object(
      'ok', true, 'refunds', '[]'::jsonb, 'invalidated_matches', '[]'::jsonb));
  end if;

  if exists (select 1 from public.groups where id = p_group_id and owner_id = p_profile_id) then
    raise exception using errcode = 'P0001', message = 'IS_OWNER';
  end if;
  if v_status is distinct from 'active' then
    raise exception using errcode = 'P0001', message = 'NOT_ACTIVE_MEMBER';
  end if;

  -- docs/25 §4.2: active → removed grava removed_at, desliga is_monthly e
  -- retira autoridade; a linha nunca é apagada nem substituída.
  update public.group_members
  set status = 'removed', removed_at = now(), is_monthly = false
  where group_id = p_group_id and profile_id = p_profile_id;

  v_outcome := jsonb_build_object('group_id', p_group_id::text,
    'profile_id', p_profile_id::text, 'logical_result', 'member_removed');
  perform private.complete_group_idempotency(
    v_actor_key, 'remove_member', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);

  return jsonb_build_object('outcome', v_outcome, 'current', jsonb_build_object(
    'ok', true, 'refunds', '[]'::jsonb, 'invalidated_matches', '[]'::jsonb));
end;
$function$;

-- ---------------------------------------------------------------------------
-- set_role(group_id, profile_id, role, request_id)
-- ---------------------------------------------------------------------------
-- Locks: perfil alvo → grupo → membership. Somente o dono. O papel do dono
-- continua derivado de groups.owner_id. Alvo sem membership active:
-- NOT_ACTIVE_MEMBER (M2-D17).
create function public.set_role(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer,
  p_group_id uuid,
  p_profile_id uuid,
  p_role text
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
  v_status text;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  -- Resolver identidade não concede autoridade: conta e sessão são checadas
  -- sob os locks abaixo, inclusive no replay de um desfecho já concluído.
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if p_group_id is null or p_profile_id is null
     or p_role is null or p_role not in ('organizer', 'player') then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;

  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'set_role', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);
  perform 1 from public.profiles where id = p_profile_id for no key update;
  perform 1 from public.groups where id = p_group_id for no key update;
  select membership.status into v_status
  from public.group_members as membership
  where membership.group_id = p_group_id and membership.profile_id = p_profile_id
  for no key update;

  -- M2-D20, ajuste de 28/09: perda de autenticação devolve o erro normal,
  -- inclusive no replay, sem desfecho. Fica fora do tratamento de autoridade.
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  -- Só a perda de autoridade no grupo conserva o desfecho sem projeção.
  -- O sub-bloco cobre só essa checagem: locks e projeções ficam fora dele.
  begin
    if private.group_actor_authority(p_group_id, v_actor_id) <> 'owner' then
      raise exception using errcode = '42501', message = 'OWNER_ONLY';
    end if;
    perform private.require_group_not_suspended(p_group_id);
  exception
    when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
      if not v_acquired.acquired and sqlerrm in (
        'NOT_FOUND', 'GROUP_ARCHIVED', 'NOT_MEMBER',
        'NOT_ORGANIZER', 'OWNER_ONLY', 'GROUP_SUSPENDED', 'OWNER_MUST_TRANSFER'
      ) then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
  end;

  -- M2-D20 emendada: current só depois da autoridade atual autorizada.
  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome, 'current', jsonb_build_object(
      'role', (select role from public.group_members
               where group_id = p_group_id and profile_id = p_profile_id)));
  end if;
  if v_status is distinct from 'active' then
    raise exception using errcode = 'P0001', message = 'NOT_ACTIVE_MEMBER';
  end if;

  update public.group_members
  set role = p_role
  where group_id = p_group_id and profile_id = p_profile_id;

  v_outcome := jsonb_build_object('group_id', p_group_id::text,
    'profile_id', p_profile_id::text, 'logical_result', 'role_set');
  perform private.complete_group_idempotency(
    v_actor_key, 'set_role', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);

  return jsonb_build_object('outcome', v_outcome, 'current', jsonb_build_object(
    'role', (select role from public.group_members
             where group_id = p_group_id and profile_id = p_profile_id)));
end;
$function$;

-- ---------------------------------------------------------------------------
-- set_monthly(group_id, profile_id, enabled, request_id)
-- ---------------------------------------------------------------------------
-- Locks: perfil alvo → grupo → membership. Dono ou organizador (docs/01 §5:
-- dono ou organizador liga o selo). is_monthly=true exige monthly_enabled,
-- que no M2 só nasce ligado por fixture (M2-D6). Alvo sem membership active:
-- NOT_ACTIVE_MEMBER (M2-D17).
create function public.set_monthly(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer,
  p_group_id uuid,
  p_profile_id uuid,
  p_enabled boolean
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
  v_status text;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  -- Resolver identidade não concede autoridade: conta e sessão são checadas
  -- sob os locks abaixo, inclusive no replay de um desfecho já concluído.
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if p_group_id is null or p_profile_id is null or p_enabled is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;

  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'set_monthly', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);
  perform 1 from public.profiles where id = p_profile_id for no key update;
  perform 1 from public.groups where id = p_group_id for no key update;
  select membership.status into v_status
  from public.group_members as membership
  where membership.group_id = p_group_id and membership.profile_id = p_profile_id
  for no key update;

  -- M2-D20, ajuste de 28/09: perda de autenticação devolve o erro normal,
  -- inclusive no replay, sem desfecho. Fica fora do tratamento de autoridade.
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  -- Só a perda de autoridade no grupo conserva o desfecho sem projeção.
  -- O sub-bloco cobre só essa checagem: locks e projeções ficam fora dele.
  begin
    if private.group_actor_authority(p_group_id, v_actor_id) not in ('owner', 'organizer') then
      raise exception using errcode = '42501', message = 'NOT_ORGANIZER';
    end if;
    perform private.require_group_not_suspended(p_group_id);
  exception
    when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
      if not v_acquired.acquired and sqlerrm in (
        'NOT_FOUND', 'GROUP_ARCHIVED', 'NOT_MEMBER',
        'NOT_ORGANIZER', 'OWNER_ONLY', 'GROUP_SUSPENDED', 'OWNER_MUST_TRANSFER'
      ) then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
  end;

  -- M2-D20 emendada: current só depois da autoridade atual autorizada.
  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome, 'current', jsonb_build_object(
      'enabled', (select is_monthly from public.group_members
                  where group_id = p_group_id and profile_id = p_profile_id)));
  end if;
  if v_status is distinct from 'active' then
    raise exception using errcode = 'P0001', message = 'NOT_ACTIVE_MEMBER';
  end if;
  if p_enabled and not exists (
    select 1 from public.groups where id = p_group_id and monthly_enabled
  ) then
    raise exception using errcode = 'P0001', message = 'MONTHLY_DISABLED';
  end if;

  -- docs/13 §5: não altera inscrição já materializada; no M2 não há racha.
  update public.group_members
  set is_monthly = p_enabled
  where group_id = p_group_id and profile_id = p_profile_id;

  v_outcome := jsonb_build_object('group_id', p_group_id::text,
    'profile_id', p_profile_id::text, 'logical_result', 'monthly_set');
  perform private.complete_group_idempotency(
    v_actor_key, 'set_monthly', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);

  return jsonb_build_object('outcome', v_outcome, 'current', jsonb_build_object(
    'enabled', (select is_monthly from public.group_members
                where group_id = p_group_id and profile_id = p_profile_id)));
end;
$function$;

-- ---------------------------------------------------------------------------
-- set_ratings_visibility(group_id, visibility, confirm_members_visibility, request_id)
-- ---------------------------------------------------------------------------
-- Locks: perfil do ator → grupo. Somente o dono; 'members' exige a
-- confirmação explícita que viaja no contrato.
create function public.set_ratings_visibility(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer,
  p_group_id uuid,
  p_visibility text,
  p_confirm_members_visibility boolean
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
  -- Resolver identidade não concede autoridade: conta e sessão são checadas
  -- sob os locks abaixo, inclusive no replay de um desfecho já concluído.
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if p_group_id is null or p_confirm_members_visibility is null
     or p_visibility is null or p_visibility not in ('private', 'members') then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;

  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'set_ratings_visibility', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);
  -- M2-D14: o perfil do próprio ator em FOR NO KEY UPDATE, compatível com o
  -- FOR KEY SHARE que a idempotência acima já segura nele.
  perform 1 from public.profiles where id = v_actor_id for no key update;
  perform 1 from public.groups where id = p_group_id for no key update;

  -- M2-D20, ajuste de 28/09: perda de autenticação devolve o erro normal,
  -- inclusive no replay, sem desfecho. Fica fora do tratamento de autoridade.
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  -- Só a perda de autoridade no grupo conserva o desfecho sem projeção.
  -- O sub-bloco cobre só essa checagem: locks e projeções ficam fora dele.
  begin
    if private.group_actor_authority(p_group_id, v_actor_id) <> 'owner' then
      raise exception using errcode = '42501', message = 'OWNER_ONLY';
    end if;
    perform private.require_group_not_suspended(p_group_id);
  exception
    when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
      if not v_acquired.acquired and sqlerrm in (
        'NOT_FOUND', 'GROUP_ARCHIVED', 'NOT_MEMBER',
        'NOT_ORGANIZER', 'OWNER_ONLY', 'GROUP_SUSPENDED', 'OWNER_MUST_TRANSFER'
      ) then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
  end;

  -- M2-D20 emendada: current só depois da autoridade atual autorizada.
  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome, 'current', jsonb_build_object(
      'visibility', (select ratings_visibility from public.groups where id = p_group_id)));
  end if;
  if p_visibility = 'members' and not p_confirm_members_visibility then
    raise exception using errcode = 'P0001', message = 'VISIBILITY_CONFIRMATION_REQUIRED';
  end if;

  update public.groups
  set ratings_visibility = p_visibility
  where id = p_group_id;

  v_outcome := jsonb_build_object('group_id', p_group_id::text,
    'logical_result', 'ratings_visibility_set');
  perform private.complete_group_idempotency(
    v_actor_key, 'set_ratings_visibility', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);

  return jsonb_build_object('outcome', v_outcome, 'current', jsonb_build_object(
    'visibility', (select ratings_visibility from public.groups where id = p_group_id)));
end;
$function$;

-- ---------------------------------------------------------------------------
-- transfer_ownership(group_id, new_owner_id, request_id)
-- ---------------------------------------------------------------------------
-- Locks: perfis antigo e novo em bytes crescentes → grupo → memberships dos
-- dois em bytes crescentes. Só o dono transfere, então o perfil antigo é o do
-- ator. O novo dono precisa de membership active e perfil active; a função
-- altera somente groups.owner_id, e o trigger diferido da 0015 confere no
-- commit. Grupo suspenso bloqueia a transferência comum; a transferência por
-- exclusão (M2-D10) é outra via, a de delete_account.
create function public.transfer_ownership(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer,
  p_group_id uuid,
  p_new_owner_id uuid
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
  -- Resolver identidade não concede autoridade: conta e sessão são checadas
  -- sob os locks abaixo, inclusive no replay de um desfecho já concluído.
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if p_group_id is null or p_new_owner_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;

  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'transfer_ownership', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);
  perform 1 from public.profiles
  where id = any(array[v_actor_id, p_new_owner_id])
  order by id
  for no key update;
  perform 1 from public.groups where id = p_group_id for no key update;
  perform 1 from public.group_members
  where group_id = p_group_id and profile_id = any(array[v_actor_id, p_new_owner_id])
  order by profile_id
  for no key update;

  -- M2-D20, ajuste de 28/09: perda de autenticação devolve o erro normal,
  -- inclusive no replay, sem desfecho. Fica fora do tratamento de autoridade.
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  -- Só a perda de autoridade no grupo conserva o desfecho sem projeção.
  -- O sub-bloco cobre só essa checagem: locks e projeções ficam fora dele.
  begin
    if private.group_actor_authority(p_group_id, v_actor_id) <> 'owner' then
      raise exception using errcode = '42501', message = 'OWNER_ONLY';
    end if;
    perform private.require_group_not_suspended(p_group_id);
  exception
    when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
      if not v_acquired.acquired and sqlerrm in (
        'NOT_FOUND', 'GROUP_ARCHIVED', 'NOT_MEMBER',
        'NOT_ORGANIZER', 'OWNER_ONLY', 'GROUP_SUSPENDED', 'OWNER_MUST_TRANSFER'
      ) then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
  end;

  -- M2-D20 emendada: current só depois da autoridade atual autorizada.
  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome, 'current', jsonb_build_object(
      'owner_id', (select owner_id from public.groups where id = p_group_id)));
  end if;
  if not exists (
    select 1
    from public.group_members as membership
    join public.profiles as candidate on candidate.id = membership.profile_id
    where membership.group_id = p_group_id
      and membership.profile_id = p_new_owner_id
      and membership.status = 'active'
      and candidate.account_status = 'active'
  ) then
    raise exception using errcode = 'P0001', message = 'NOT_ACTIVE_MEMBER';
  end if;

  -- M2-D19 (4): concluir sem efeito também exclui UPDATE e seus triggers.
  if p_new_owner_id <> v_actor_id then
    update public.groups
    set owner_id = p_new_owner_id
    where id = p_group_id;
  end if;

  v_outcome := jsonb_build_object('group_id', p_group_id::text,
    'new_owner_id', p_new_owner_id::text, 'logical_result', 'ownership_transferred');
  perform private.complete_group_idempotency(
    v_actor_key, 'transfer_ownership', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);

  return jsonb_build_object('outcome', v_outcome, 'current', jsonb_build_object(
    'owner_id', (select owner_id from public.groups where id = p_group_id)));
end;
$function$;

-- ---------------------------------------------------------------------------
-- leave_group(group_id, request_id)
-- ---------------------------------------------------------------------------
-- Locks: perfil do ator → grupo → própria membership. O dono recebe
-- OWNER_MUST_TRANSFER antes de qualquer efeito. Grupo suspenso não bloqueia a
-- saída de não-owner (docs/25 §4.1). A membership muda por último; no M2 o
-- conjunto de rachas e provas é vazio.
create function public.leave_group(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer,
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
  -- Resolver identidade não concede autoridade: conta e sessão são checadas
  -- sob os locks abaixo, inclusive no replay de um desfecho já concluído.
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if p_group_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;

  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'leave_group', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);
  -- M2-D14: o perfil do próprio ator em FOR NO KEY UPDATE.
  perform 1 from public.profiles where id = v_actor_id for no key update;
  perform 1 from public.groups where id = p_group_id for no key update;
  perform 1 from public.group_members
  where group_id = p_group_id and profile_id = v_actor_id
  for no key update;

  -- M2-D20, ajuste de 28/09: perda de autenticação devolve o erro normal,
  -- inclusive no replay, sem desfecho. Fica fora do tratamento de autoridade.
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  -- Só a perda de autoridade no grupo conserva o desfecho sem projeção.
  -- O sub-bloco cobre só essa checagem: locks e projeções ficam fora dele.
  begin
    if private.group_actor_authority(p_group_id, v_actor_id) = 'owner' then
      raise exception using errcode = 'P0001', message = 'OWNER_MUST_TRANSFER';
    end if;
  exception
    when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
      if not v_acquired.acquired and sqlerrm in (
        'NOT_FOUND', 'GROUP_ARCHIVED', 'NOT_MEMBER',
        'NOT_ORGANIZER', 'OWNER_ONLY', 'GROUP_SUSPENDED', 'OWNER_MUST_TRANSFER'
      ) then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
  end;

  -- M2-D20 emendada: current só depois da autoridade atual autorizada.
  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome, 'current', jsonb_build_object(
      'ok', true, 'refunds', '[]'::jsonb, 'invalidated_matches', '[]'::jsonb));
  end if;

  update public.group_members
  set status = 'removed', removed_at = now(), is_monthly = false
  where group_id = p_group_id and profile_id = v_actor_id;

  v_outcome := jsonb_build_object('group_id', p_group_id::text,
    'logical_result', 'group_left');
  perform private.complete_group_idempotency(
    v_actor_key, 'leave_group', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);

  return jsonb_build_object('outcome', v_outcome, 'current', jsonb_build_object(
    'ok', true, 'refunds', '[]'::jsonb, 'invalidated_matches', '[]'::jsonb));
end;
$function$;

-- Somente o caminho secreto da Edge chama as RPCs (docs/13 §0.1).
revoke all on function public.approve_member(uuid, uuid, uuid, text, integer, integer, uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.remove_member(uuid, uuid, uuid, text, integer, integer, uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.set_role(uuid, uuid, uuid, text, integer, integer, uuid, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.set_monthly(uuid, uuid, uuid, text, integer, integer, uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.set_ratings_visibility(uuid, uuid, uuid, text, integer, integer, uuid, text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.transfer_ownership(uuid, uuid, uuid, text, integer, integer, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.leave_group(uuid, uuid, uuid, text, integer, integer, uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.approve_member(uuid, uuid, uuid, text, integer, integer, uuid, uuid, boolean)
  to service_role;
grant execute on function public.remove_member(uuid, uuid, uuid, text, integer, integer, uuid, uuid, text)
  to service_role;
grant execute on function public.set_role(uuid, uuid, uuid, text, integer, integer, uuid, uuid, text)
  to service_role;
grant execute on function public.set_monthly(uuid, uuid, uuid, text, integer, integer, uuid, uuid, boolean)
  to service_role;
grant execute on function public.set_ratings_visibility(uuid, uuid, uuid, text, integer, integer, uuid, text, boolean)
  to service_role;
grant execute on function public.transfer_ownership(uuid, uuid, uuid, text, integer, integer, uuid, uuid)
  to service_role;
grant execute on function public.leave_group(uuid, uuid, uuid, text, integer, integer, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Retenção: purge_removed_memberships (docs/17 §2 e §4)
-- ---------------------------------------------------------------------------
-- Membership removed por 12 meses a partir de removed_at; depois a linha sai.
-- Membership active ou pending nunca é tocada, e o grupo, que nunca é apagado
-- pela API, fica. Exceção à M2-D13: a transação apaga a linha, caso em que a
-- regra manda FOR UPDATE. SKIP LOCKED faz o expurgo nunca esperar: uma linha
-- travada por delete_account ou por uma RPC desta fatia fica para a próxima
-- execução, e o expurgo não entra em ciclo com a ordem grupo → memberships.
create function private.purge_removed_memberships()
returns jsonb
language plpgsql
set search_path = ''
as $function$
declare
  v_started_at timestamptz := clock_timestamp();
  v_now timestamptz := now();
  v_scanned bigint;
  v_purged bigint;
begin
  select count(*) into v_scanned from public.group_members
  where status = 'removed' and removed_at <= v_now - interval '12 months';

  with expired as (
    select membership.group_id, membership.profile_id
    from public.group_members as membership
    where membership.status = 'removed'
      and membership.removed_at <= v_now - interval '12 months'
    order by membership.group_id, membership.profile_id
    for update skip locked
  )
  delete from public.group_members as membership
  using expired
  where membership.group_id = expired.group_id
    and membership.profile_id = expired.profile_id;
  get diagnostics v_purged = row_count;

  insert into private.retention_runs
    (policy, window_start, window_end, scanned, purged, failed, started_at, finished_at)
  values ('purge_removed_memberships', v_now - interval '12 months', v_now,
          v_scanned::integer, v_purged::integer, 0, v_started_at, clock_timestamp());
  return jsonb_build_object('scanned', v_scanned, 'purged', v_purged);
end;
$function$;

revoke all on function private.purge_removed_memberships()
  from public, anon, authenticated, service_role;

-- Slot diário do job novo; os demais ramos são o texto vivo da 0014.
create or replace function private.worker_job_slot(p_job_name text, p_now timestamptz)
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
  elsif p_job_name = 'purge_removed_memberships' then
    v_slot := (date_trunc('day', v_now_utc) at time zone 'UTC')
      + interval '3 hours 53 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 day' end;
  end if;

  raise exception using errcode = '22023', message = 'VALIDATION';
end;
$function$;

-- Despacho do job novo. O texto parte do vivo da 0013; além do ramo novo, a
-- trava de job_runs passa de FOR UPDATE a FOR NO KEY UPDATE, porque docs/25
-- §2 manda alinhar à M2-D13 a trava do M1-B que uma migration reescrever
-- (pendência da M2-D15): a transação não apaga a execução nem altera sua
-- chave, e nenhuma FK aponta para job_runs.
create or replace function public.worker_execute_database_job(p_run_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_run private.job_runs%rowtype; v_result jsonb; v_scanned bigint; v_failed bigint; v_stale bigint;
begin
  if p_run_id is null then raise exception using errcode='22023',message='VALIDATION'; end if;
  select run.* into v_run from private.job_runs run where run.id=p_run_id for no key update;
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
  elsif v_run.job_name='purge_removed_memberships' then
    v_result:=private.purge_removed_memberships();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='health_check_jobs' then
    select count(*),count(*) filter(where run.status='failed'),count(*) filter(where run.error_code='RUN_ABANDONED') into v_scanned,v_failed,v_stale
    from private.job_runs run where run.id<>p_run_id and run.started_at>=now()-interval '24 hours';
    return jsonb_build_object('scanned',v_scanned,'changed',0,'skipped',v_scanned-v_failed,'failed',v_failed,'stale',v_stale,'duration_ms',0);
  end if;
  raise exception using errcode='22023',message='VALIDATION';
end;
$function$;

revoke all on function private.worker_job_slot(text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.worker_execute_database_job(bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.worker_execute_database_job(bigint) to service_role;

-- O agendamento segue o dos demais jobs (docs/25 §4.1): cron → pg_net → Edge
-- worker, com o nome fechado do job e nada mais.
select cron.schedule('colete_v1_purge_removed_memberships', '53 3 * * *',
  $$select private.invoke_worker_cron('purge_removed_memberships');$$);

commit;
