-- Fatia 0022: Racha completo, modo apresentação (docs/25 §8.1, decisão humana
-- de 15/10/2026). Corte de docs/10 §5 e docs/13 §§1.1, 1.2 e 2.6: presença
-- ("Vou jogar"), lista de espera com promoção atômica, desistência e marcação
-- manual de pagamento, sem Pix, comprovante, valor digitado, claim, T1/T2,
-- goleiro, convidado, sorteio ou notificação. A D63.5 continua adiada: o
-- padrão idempotente é o mesmo da 0021.
begin;

-- ---------------------------------------------------------------------------
-- Tabela
-- ---------------------------------------------------------------------------
-- Nome e estados de docs/10 §5. Fora do corte: list_kind (só linha),
-- queue_tier (fila única), ciclo de pagamento, convidado e added_by. A fila
-- usa uma sequência própria: ir ao fim é sempre nextval, como em docs/10 §5.
-- paid é a marcação manual da organização (13 §2.6 recortado); o valor nunca
-- é gravado, porque o total é calculado de matches.field_price.
create sequence private.match_queue_seq;

create table private.match_players (
  id                uuid primary key default gen_random_uuid(),
  match_id          uuid not null references private.matches (id),
  profile_id        uuid not null references public.profiles (id),
  status            text not null check (status in ('starter', 'waitlist', 'left', 'removed')),
  queue_seq         bigint not null,
  joined_at         timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  paid              boolean not null default false,
  payment_marked_by uuid references public.profiles (id),
  payment_marked_at timestamptz,
  unique (match_id, profile_id),
  unique (match_id, queue_seq),
  check ((payment_marked_by is null) = (payment_marked_at is null)),
  check (not paid or payment_marked_by is not null),
  -- Quem pagou não desiste (13 §1.2, PAYMENT_ALREADY_REAL). removed guarda a
  -- marcação de quem saiu do grupo depois de pagar: o fato não é apagado.
  check (not (paid and status = 'left'))
);

comment on table private.match_players is
  'Inscrição no racha v1 (modo apresentação). Escrita somente por join_match, leave_match, set_match_payment e pela saída do grupo; leitura somente por get_match_roster e get_matches_occupancy.';

create index match_players_match_status_idx on private.match_players (match_id, status, queue_seq);
create index match_players_profile_idx on private.match_players (profile_id);

-- Nenhum papel cliente lê a tabela: toda leitura é projeção das RPCs abaixo
-- (docs/10 §11, "participantes só por projeção; própria posição por RPC").
-- Por isso mora em private, sem RLS e sem grant (docs/14 §5.2; decisão humana
-- de 15/10/2026). A capacidade é contada sobre ela: com RLS forçada e zero
-- policies, um dono sem BYPASSRLS contaria zero confirmados e falharia aberto.
-- Os privilégios padrão de private (0004) já nascem revogados; a 0022 só prova.

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
    'set_match_payment'
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
      'payment_marked_paid', 'payment_marked_unpaid', 'payment_unchanged'
    )
  );

alter function private.validate_idempotency_outcome(text, jsonb)
  rename to validate_through_create_match_outcome;

-- O desfecho guarda somente IDs e o resultado lógico: nenhum nome, posição na
-- fila, estado de pagamento ou valor. O estado atual é recalculado no retry.
create function private.validate_idempotency_outcome(p_operation text, p_outcome jsonb)
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
  if p_operation = 'join_match' then
    v_keys := array['group_id', 'logical_result', 'match_id'];
    v_results := array['match_joined', 'match_waitlisted', 'match_join_unchanged'];
  elsif p_operation = 'leave_match' then
    v_keys := array['group_id', 'logical_result', 'match_id'];
    v_results := array['match_left', 'match_leave_unchanged'];
  elsif p_operation = 'set_match_payment' then
    v_keys := array['group_id', 'logical_result', 'match_id', 'profile_id'];
    v_results := array['payment_marked_paid', 'payment_marked_unpaid', 'payment_unchanged'];
  else
    perform private.validate_through_create_match_outcome(p_operation, p_outcome);
    return;
  end if;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
        is distinct from v_keys
     or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
     or not (p_outcome ->> 'logical_result' = any(v_results)) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  foreach v_id_key in array array_remove(v_keys, 'logical_result') loop
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

revoke all on function private.validate_through_create_match_outcome(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_idempotency_outcome(text, jsonb)
  from public, anon, authenticated, service_role;

-- Corpo idêntico ao da 0021; somente a lista de operações ganha join_match,
-- leave_match e set_match_payment.
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
                            'leave_match', 'set_match_payment')
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

-- O recurso das operações de racha é o grupo, como em create_group: o racha
-- viaja no outcome, e a restrição de resource_type da 0004 não muda.
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
                            'leave_match', 'set_match_payment') then
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
                                  'set_match_payment')
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
-- Auxiliares de domínio
-- ---------------------------------------------------------------------------
-- Locks de docs/10 §10, sempre FOR NO KEY UPDATE (M2-D13): perfil → grupo →
-- membership → racha; a linha de inscrição vem depois, na RPC. O grupo do
-- racha é resolvido sem lock e nunca muda: não existe edição de racha nesta
-- fatia. A FK da idempotência já segura FOR KEY SHARE no perfil próprio.
-- Autenticação antes de existência (revisão do #71, P1-2): conta, sessão e
-- aceite são conferidos sob o lock do perfil mesmo quando o racha não existe,
-- e então o helper devolve null; quem chama responde o mesmo NOT_FOUND de
-- quem não é membro, sem revelar se o ID existe.
create function private.lock_match_context(
  p_actor_id uuid, p_actor_auth_user_id uuid, p_actor_session_id uuid, p_match_id uuid
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_group_id uuid;
begin
  select match.group_id into v_group_id from private.matches as match where match.id = p_match_id;
  perform 1 from public.profiles where id = p_actor_id for no key update;
  if v_group_id is null then
    perform private.require_group_actor_after_locks(
      p_actor_id, p_actor_auth_user_id, p_actor_session_id);
    return null;
  end if;
  perform 1 from public.groups where id = v_group_id for no key update;
  perform 1 from public.group_members
    where group_id = v_group_id and profile_id = p_actor_id for no key update;
  perform 1 from private.matches where id = p_match_id for no key update;
  perform private.require_group_actor_after_locks(
    p_actor_id, p_actor_auth_user_id, p_actor_session_id);
  return v_group_id;
end;
$function$;

-- Papel do ator no grupo do racha já travado, ou NOT_FOUND: racha
-- inexistente, grupo arquivado e membership não active respondem igual, para
-- que ninguém de fora aprenda se o ID existe (revisão do #71, P1-2). O dono
-- deriva de groups.owner_id, como em group_actor_authority (0016).
create function private.match_actor_authority(p_group_id uuid, p_actor_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_owner_id uuid;
  v_role text;
begin
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

-- Estado atual de uma pessoa no racha, recalculado a cada resposta e a cada
-- retry. 'out' cobre left, removed e ausência de linha.
create function private.match_player_current(p_match_id uuid, p_profile_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with player as (
    select status, queue_seq from private.match_players
    where match_id = p_match_id and profile_id = p_profile_id
      and status in ('starter', 'waitlist')
  )
  select jsonb_build_object(
    'status', coalesce((select status from player), 'out'),
    'waitlist_position', case when (select status from player) = 'waitlist' then (
      select count(*)::integer + 1 from private.match_players as other
      where other.match_id = p_match_id and other.status = 'waitlist'
        and other.queue_seq < (select queue_seq from player)) end,
    'confirmed_count', (select count(*)::integer from private.match_players
      where match_id = p_match_id and status = 'starter'),
    'waitlist_count', (select count(*)::integer from private.match_players
      where match_id = p_match_id and status = 'waitlist'),
    'field_slots', (select field_slots from private.matches where id = p_match_id));
$function$;

-- Resumo financeiro da organização: pagos × field_price, sem valor digitado.
create function private.match_payment_summary(p_match_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select jsonb_build_object(
    'paid_count', (count(*) filter (where player.paid))::integer,
    'confirmed_count', count(player.id)::integer,
    'total', to_char(count(*) filter (where player.paid) * match.field_price, 'FM9999999990.00'))
  from private.matches as match
  left join private.match_players as player
    on player.match_id = match.id and player.status = 'starter'
  where match.id = p_match_id
  group by match.field_price;
$function$;

-- Promove a espera para as vagas livres, em ordem de queue_seq, e prova
-- starter <= field_slots. Quem chama já segura o lock do racha, que serializa
-- toda mutação de inscrição dele: não há janela para duas promoções.
create function private.promote_match_waitlist(p_match_id uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_slots integer;
  v_starters integer;
  v_next uuid;
begin
  select field_slots into strict v_slots from private.matches where id = p_match_id;
  loop
    select count(*) into v_starters from private.match_players
    where match_id = p_match_id and status = 'starter';
    exit when v_starters >= v_slots;
    select id into v_next from private.match_players
    where match_id = p_match_id and status = 'waitlist'
    order by queue_seq
    limit 1
    for no key update;
    exit when not found;
    update private.match_players
    set status = 'starter', status_changed_at = now()
    where id = v_next;
  end loop;
  if v_starters > v_slots then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;
end;
$function$;

revoke all on function private.lock_match_context(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.match_actor_authority(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.match_player_current(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.match_payment_summary(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.promote_match_waitlist(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Saída do grupo libera a inscrição
-- ---------------------------------------------------------------------------
-- docs/10 §10: nenhum estado final tem participante ativo sem membership
-- ativa. Toda saída (leave_group, remove_member, delete_account, arquivamento
-- e transferência na exclusão) passa a membership de active a outro estado
-- por UPDATE, já sob os locks de grupo e membership; o trigger completa a
-- ordem travando os rachas futuros, em ordem de UUID, e promove a espera.
-- Racha já iniciado guarda a lista como histórico. paid fica na linha
-- removed: o fato do pagamento não é apagado.
create function private.release_match_players_on_membership_exit()
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
      if v_status = 'starter' then
        perform private.promote_match_waitlist(v_match_id);
      end if;
    end if;
  end loop;
  return null;
end;
$function$;

revoke all on function private.release_match_players_on_membership_exit()
  from public, anon, authenticated, service_role;

create trigger group_members_release_match_players
  after update of status on public.group_members
  for each row
  when (old.status = 'active' and new.status <> 'active')
  execute function private.release_match_players_on_membership_exit();

-- ---------------------------------------------------------------------------
-- join_match(match_id, request_id) — docs/13 §1.1, recortado
-- ---------------------------------------------------------------------------
-- Membro ativo, antes de starts_at. Com vaga (starter < field_slots) entra
-- confirmado; senão, no fim da espera. Já estar na lista com chave nova é
-- sucesso sem efeito (match_join_unchanged). Voltar depois de desistir é
-- nova intenção e recebe nova queue_seq: vai ao fim.
create function public.join_match(
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

  -- current só depois da autoridade atual autorizada.
  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome,
      'current', private.match_player_current(p_match_id, v_actor_id));
  end if;

  select * into strict v_match from private.matches where id = p_match_id;
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

-- ---------------------------------------------------------------------------
-- leave_match(match_id, request_id) — docs/13 §1.2, recortado
-- ---------------------------------------------------------------------------
-- Confirmado ou na espera, até starts_at. Já estar fora é sucesso sem efeito.
-- Quem está marcado como pago não desiste (PAYMENT_ALREADY_REAL): a
-- organização desmarca antes. A saída de um confirmado promove o primeiro da
-- espera na mesma transação, sob o lock do racha.
create function public.leave_match(
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

  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome,
      'current', private.match_player_current(p_match_id, v_actor_id));
  end if;

  select starts_at into strict v_starts_at from private.matches where id = p_match_id;
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

-- ---------------------------------------------------------------------------
-- set_match_payment(match_id, profile_id, paid, request_id) — 13 §2.6 recortado
-- ---------------------------------------------------------------------------
-- Dono ou organizador ativo marca "pago" ou "não pago", só para confirmado,
-- em qualquer momento do racha. Grava quem marcou e quando; marcar o estado
-- que já vale é sucesso sem efeito e não reescreve o registro.
create function public.set_match_payment(
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

-- ---------------------------------------------------------------------------
-- Leituras: get_match_roster(match_id) e get_matches_occupancy()
-- ---------------------------------------------------------------------------
-- Projeção de docs/10 §11 (match_players_public recortada): nome, apelido e
-- posição de quem está na lista, para membro ativo do grupo. Conta em
-- exclusão ou excluída aparece só como vaga ocupada, sem ID, nome, apelido
-- ou posição. Pagamento: a organização vê o de cada confirmado e o resumo; o
-- jogador vê somente o próprio. stable: uma única fotografia do banco.
create function public.get_match_roster(
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

-- Ocupação de cada racha ainda não encerrado dos grupos ativos do ator: o
-- mesmo conjunto que a policy de matches entrega à lista.
create function public.get_matches_occupancy(
  p_actor_auth_user_id uuid, p_actor_session_id uuid
)
returns table (match_id uuid, confirmed_count integer, waitlist_count integer, viewer_status text)
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
        and player.status in ('starter', 'waitlist')), 'out')
  from private.matches as match
  join public.groups as grp on grp.id = match.group_id and grp.archived_at is null
  join public.group_members as membership
    on membership.group_id = match.group_id and membership.profile_id = v_actor_id
   and membership.status = 'active'
  where match.ends_at > now()
  order by match.starts_at, match.id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Descrição do racha (decisão humana de 16/10/2026)
-- ---------------------------------------------------------------------------
-- Texto simples opcional, até 500 pontos de código. Fica fora de outcome, log
-- e mensagem de erro, como o local. O detalhe o mostra como texto puro: nada
-- vira link nem marcação. list_my_matches não o projeta; só get_match.
alter table private.matches
  add column description text
    check (description is null or char_length(description) between 1 and 500);

-- Regra da descrição, repetida na Edge e no formulário
-- (supabase/functions/_shared/match-config.ts e
-- src/features/matches/match-description.ts): NFC; quebra de linha mantida
-- (CR, CRLF, U+2028 e U+2029 viram LF); demais controles e marcas bidi
-- recusados; espaços Zs colapsados em um; espaços ao redor de LF e mais de
-- uma linha em branco somem; pontas aparadas. "" vira null; o que sobrar
-- vazio é recusado, assim como mais de 500 pontos de código.
create function private.normalize_match_description(p_value text)
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
  if p_value is null or p_value = '' then
    return null;
  end if;
  v_value := normalize(p_value, NFC);
  v_value := replace(replace(v_value, E'\r\n', E'\n'), E'\r', E'\n');
  v_value := translate(v_value, U&'\2028\2029', E'\n\n');
  for v_index in 1..char_length(v_value) loop
    v_character := substr(v_value, v_index, 1);
    v_code := ascii(v_character);
    if (v_code between 0 and 31 and v_code <> 10) or v_code between 127 and 159
       or v_code in (1564, 8203, 8206, 8207, 8234, 8235, 8236, 8237, 8238,
                     8288, 8289, 8290, 8291, 8292, 8294, 8295, 8296, 8297, 65279) then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
    if v_code in (32, 160, 5760, 8239, 8287, 12288) or v_code between 8192 and 8202 then
      v_result := v_result || ' ';
    else
      v_result := v_result || v_character;
    end if;
  end loop;
  v_result := regexp_replace(v_result, ' +', ' ', 'g');
  v_result := regexp_replace(v_result, ' *\n *', E'\n', 'g');
  v_result := regexp_replace(v_result, '\n{3,}', E'\n\n', 'g');
  v_result := regexp_replace(v_result, '^[ \n]+|[ \n]+$', '', 'g');
  if char_length(v_result) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  return v_result;
end;
$function$;

revoke all on function private.normalize_match_description(text)
  from public, anon, authenticated, service_role;

-- create_match ganha a décima chave do config, description (string ou null
-- explícito). Corpo idêntico ao da 0021, exceto a lista de chaves, a forma, a
-- normalização e o insert da descrição. Os privilégios da 0021 continuam: o
-- replace preserva o ACL.
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

-- get_match passa a projetar a descrição. A forma de retorno muda, então a
-- função é recriada com o mesmo corpo da 0021 e os mesmos privilégios.
drop function public.get_match(uuid, uuid, uuid);
create function public.get_match(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_match_id uuid
) returns table (id uuid, group_id uuid, group_name text, starts_at timestamptz,
  ends_at timestamptz, timezone text, location_name text, location_address text,
  description text, latitude numeric, longitude numeric, field_slots integer, field_price numeric)
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
    m.location_address, m.description, m.latitude, m.longitude, m.field_slots, m.field_price
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

revoke all on function public.get_match(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_match(uuid, uuid, uuid) to service_role;

revoke all on function public.join_match(uuid, uuid, uuid, text, integer, integer, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.leave_match(uuid, uuid, uuid, text, integer, integer, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.set_match_payment(uuid, uuid, uuid, text, integer, integer, uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.get_match_roster(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_matches_occupancy(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.join_match(uuid, uuid, uuid, text, integer, integer, uuid)
  to service_role;
grant execute on function public.leave_match(uuid, uuid, uuid, text, integer, integer, uuid)
  to service_role;
grant execute on function public.set_match_payment(uuid, uuid, uuid, text, integer, integer, uuid, uuid, boolean)
  to service_role;
grant execute on function public.get_match_roster(uuid, uuid, uuid) to service_role;
grant execute on function public.get_matches_occupancy(uuid, uuid) to service_role;

commit;
