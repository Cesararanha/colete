-- Fatia 0031: notas dos jogadores, M6 do piloto (decisão humana de César de
-- 19/10/2026, docs/25 §8.1; contrato da nota simples em docs/13 §4.1.2 e
-- docs/27). Corte de docs/01 §5.6, docs/10 §7 e docs/13 §§4.1 e 4.1.1.
--
-- O dono ou um organizador ativo dá a cada membro ativo do grupo uma nota
-- inteira de 1 a 5, que vale para todos os rachas do grupo até ser alterada;
-- pode dar a si mesmo. Não há goleiro: sem a lista de goleiros do racha (D8),
-- todo membro conta como jogador de linha. Repetir a nota atual não muda nada
-- e não grava histórico; não existe apagar nota, só alterar. Cada alteração
-- grava, no histórico, de quanto para quanto, quem e quando.
--
-- Quem vê: a organização vê a nota atual de cada membro ativo, com quem mudou
-- por último e quando; o titular vê sempre a própria, inclusive depois de sair
-- do grupo, durante a retenção; os demais membros ativos veem as notas atuais
-- só quando o dono escolheu "membros" (ratings_visibility da 0016). O
-- histórico nunca sai para o app: fica para a contestação, que é pós-piloto
-- (D63-D), assim como a trilha pública e as notificações N20 e N24 (D63-B).
--
-- Retenção (docs/17 §2): a nota de quem continua membro ativo fica; o job
-- diário purge_ratings apaga nota e histórico 12 meses depois de a pessoa
-- sair do grupo (removed_at, inclusive pela exclusão de conta) ou de o grupo
-- ser encerrado (archived_at, inclusive apagado pela 0029), e também quando a
-- membership já foi expurgada.
--
-- Travas, no padrão da 0029: o grupo apagado é decidido antes de travar
-- qualquer linha dele, pelo mesmo caminho de um grupo inexistente; depois das
-- travas, autoridade, grupo e membership do alvo são relidos, inclusive no
-- replay. A D63.5 continua adiada: o padrão idempotente é o da 0021 a 0030.
begin;

-- ---------------------------------------------------------------------------
-- Nota atual e histórico
-- ---------------------------------------------------------------------------
-- Nomes e colunas de docs/10 §7, em private, sem RLS e sem privilégio
-- (docs/14 §5.2): a leitura é só por projeção das RPCs abaixo, como as
-- inscrições (0022). Os defaults da 0004 já as fazem nascer sem privilégio.
-- O histórico é a autoridade: cada versão é uma linha, nunca reescrita; a
-- nota atual aponta para a sua versão, e o trigger abaixo prova que as
-- estrelas são as daquela versão. A FK é imediata (docs/10 a admite
-- diferida): set_rating grava o histórico antes da nota atual.
create table private.rating_history (
  id         bigint generated always as identity primary key,
  group_id   uuid not null references public.groups (id),
  profile_id uuid not null references public.profiles (id),
  old_stars  smallint check (old_stars between 1 and 5),
  new_stars  smallint not null check (new_stars between 1 and 5),
  changed_by uuid not null references public.profiles (id),
  changed_at timestamptz not null default now(),
  unique (id, group_id, profile_id),
  check (old_stars is distinct from new_stars)
);

create table private.ratings (
  group_id           uuid not null references public.groups (id),
  profile_id         uuid not null references public.profiles (id),
  current_history_id bigint not null,
  stars              smallint not null check (stars between 1 and 5),
  updated_by         uuid not null references public.profiles (id),
  updated_at         timestamptz not null default now(),
  primary key (group_id, profile_id),
  constraint ratings_current_history_belongs_to_rating
    foreign key (current_history_id, group_id, profile_id)
    references private.rating_history (id, group_id, profile_id)
);

comment on table private.ratings is
  'Nota atual de um membro no grupo (0031). Escrita somente por set_rating e purge_ratings; leitura somente por get_group_ratings e get_my_rating.';
comment on table private.rating_history is
  'Versões da nota (0031): de quanto para quanto, quem e quando. Append-only; apagada somente por purge_ratings.';

create index rating_history_rating_idx on private.rating_history (group_id, profile_id, id);
create index ratings_profile_idx on private.ratings (profile_id);

-- As estrelas, o autor e o instante da nota atual são os da versão apontada.
create function private.require_rating_matches_history()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if not exists (
    select 1 from private.rating_history as version
    where version.id = new.current_history_id
      and version.group_id = new.group_id and version.profile_id = new.profile_id
      and version.new_stars = new.stars and version.changed_by = new.updated_by
      and version.changed_at = new.updated_at
  ) then
    raise exception using errcode = '23514', message = 'RATING_HISTORY_MISMATCH';
  end if;
  return new;
end;
$function$;

create trigger ratings_match_history
  before insert or update on private.ratings
  for each row execute function private.require_rating_matches_history();

-- Nenhuma versão é reescrita; só o expurgo da retenção apaga.
create function private.forbid_rating_history_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception using errcode = '23514', message = 'RATING_HISTORY_APPEND_ONLY';
end;
$function$;

create trigger rating_history_append_only
  before update on private.rating_history
  for each row execute function private.forbid_rating_history_update();

revoke all on function private.require_rating_matches_history()
  from public, anon, authenticated, service_role;
revoke all on function private.forbid_rating_history_update()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Livro de idempotência: lista fechada de operações e desfechos
-- ---------------------------------------------------------------------------
-- Todas as operações e todos os desfechos que já existem continuam, inclusive
-- set_group_appearance (0027), update_match e cancel_match (0028),
-- delete_group (0029) e as cinco operações de foto (0030).
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
    'delete_group', 'begin_photo_upload', 'set_profile_photo',
    'remove_profile_photo', 'set_group_photo', 'remove_group_photo',
    'set_rating'
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
      'match_cancel_unchanged', 'group_deleted', 'photo_upload_started',
      'profile_photo_set', 'profile_photo_removed', 'profile_photo_unchanged',
      'group_photo_set', 'group_photo_removed', 'group_photo_unchanged',
      'rating_set', 'rating_unchanged'
    )
  );

alter function private.validate_idempotency_outcome(text, jsonb)
  rename to validate_through_photos_outcome;

-- O desfecho guarda só os IDs e o resultado lógico, como set_role: nenhuma
-- estrela, antiga ou nova (docs/17 §3). A nota corrente é projeção fresca.
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
  if p_operation <> 'set_rating' then
    perform private.validate_through_photos_outcome(p_operation, p_outcome);
    return;
  end if;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
        is distinct from array['group_id', 'logical_result', 'profile_id']::text[]
     or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
     or not (p_outcome ->> 'logical_result' = any (array['rating_set', 'rating_unchanged'])) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  foreach v_id_key in array array['group_id', 'profile_id'] loop
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

revoke all on function private.validate_through_photos_outcome(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_idempotency_outcome(text, jsonb)
  from public, anon, authenticated, service_role;

-- Corpos idênticos aos da 0030; somente as listas de operações ganham
-- set_rating. O recurso é o grupo, como nas demais operações de grupo.
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
                            'delete_group', 'begin_photo_upload', 'set_profile_photo',
                            'remove_profile_photo', 'set_group_photo', 'remove_group_photo',
                            'set_rating')
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
  v_resource_type text;
  v_resource_key text;
begin
  if p_operation is null
     or p_operation not in ('approve_member', 'remove_member', 'set_role', 'set_monthly',
                            'set_ratings_visibility', 'transfer_ownership', 'leave_group',
                            'create_group', 'join_by_code', 'join_by_invite',
                            'revoke_group_invite', 'regenerate_group_invite', 'issue_group_invite',
                            'rename_group', 'create_match', 'join_match',
                            'leave_match', 'set_match_payment',
                            'set_group_appearance', 'update_match', 'cancel_match',
                            'delete_group', 'begin_photo_upload', 'set_profile_photo',
                            'remove_profile_photo', 'set_group_photo', 'remove_group_photo',
                            'set_rating') then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  perform private.validate_idempotency_outcome(p_operation, p_outcome);
  begin
    v_actor_id := substring(p_actor_key from 9)::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end;
  if p_operation = 'begin_photo_upload' then
    v_resource_type := 'photo_upload';
    v_resource_key := 'upload_id';
  elsif p_operation in ('set_profile_photo', 'remove_profile_photo') then
    v_resource_type := 'profile';
    v_resource_key := 'profile_id';
    if (p_outcome ->> 'profile_id')::uuid is distinct from v_actor_id then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  else
    v_resource_type := 'group';
    v_resource_key := 'group_id';
  end if;

  update private.idempotency_records as records
  set state = 'completed',
      outcome_code = p_outcome ->> 'logical_result',
      resource_type = v_resource_type,
      resource_id = (p_outcome ->> v_resource_key)::uuid,
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
                                  'cancel_match','delete_group','set_group_photo',
                                  'remove_group_photo','set_rating')
           and (v_record.resource_type is distinct from 'group'
                or v_record.resource_id is distinct from (v_record.outcome->>'group_id')::uuid))
       or (v_record.operation='begin_photo_upload'
           and (v_record.resource_type is distinct from 'photo_upload'
                or v_record.resource_id is distinct from (v_record.outcome->>'upload_id')::uuid))
       or (v_record.operation in ('set_profile_photo','remove_profile_photo')
           and (v_record.resource_type is distinct from 'profile'
                or v_record.resource_id is distinct from v_record.actor_id
                or v_record.resource_id is distinct from (v_record.outcome->>'profile_id')::uuid)) then
      raise exception using errcode='23514',message='IDEMPOTENCY_OUTCOME_INVALID';
    end if;
  end if;
  return null;
end;
$function$;

revoke all on function private.enforce_idempotency_conclusion() from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- set_rating(group_id, profile_id, stars, request_id)
-- ---------------------------------------------------------------------------
-- Dono ou organizador ativo; jogador recebe NOT_ORGANIZER; ex-membro,
-- pendente e estranho NOT_MEMBER; grupo inexistente NOT_FOUND; grupo apagado
-- GROUP_DELETED (a Edge responde NOT_FOUND), também no replay; grupo
-- arquivado GROUP_ARCHIVED; suspenso GROUP_SUSPENDED. O alvo precisa ser
-- membro ativo com conta ativa (NOT_ACTIVE_MEMBER). Estrelas fora de 1–5,
-- STARS_RANGE. Travas na ordem global (docs/09 D37): os dois perfis em UUID
-- crescente, o grupo, as duas memberships em UUID crescente e a nota atual. O
-- grupo apagado não trava grupo nem memberships, pelo predicado da 0029.
create function public.set_rating(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_group_id uuid, p_profile_id uuid, p_stars integer
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
  v_target_status text;
  v_target_account text;
  v_rating private.ratings%rowtype;
  v_history_id bigint;
  v_result text;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_group_id is null or p_profile_id is null or p_stars is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  if p_stars not between 1 and 5 then
    raise exception using errcode = '22023', message = 'STARS_RANGE';
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
    v_actor_key, 'set_rating', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  perform 1 from public.profiles
  where id in (v_actor_id, p_profile_id)
  order by id
  for no key update;
  perform 1 from public.groups
  where id = p_group_id and not private.is_group_deleted(id)
  for no key update;
  perform 1 from public.group_members as membership
  where membership.group_id = p_group_id
    and membership.profile_id in (v_actor_id, p_profile_id)
    and not private.is_group_deleted(membership.group_id)
  order by membership.profile_id
  for no key update;
  select * into v_rating from private.ratings
  where group_id = p_group_id and profile_id = p_profile_id
    and not private.is_group_deleted(group_id)
  for update;

  -- M2-D20: perda de autenticação devolve o erro normal, inclusive no replay.
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  -- Só a perda de autoridade no grupo conserva o desfecho, sem projeção. O
  -- grupo apagado (GROUP_DELETED) fica fora da lista e recusa também o replay.
  begin
    v_authority := private.group_actor_authority(p_group_id, v_actor_id);
    if v_authority not in ('owner', 'organizer') then
      raise exception using errcode = '42501', message = 'NOT_ORGANIZER';
    end if;
    perform private.require_group_not_suspended(p_group_id);
  exception
    when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
      if not v_acquired.acquired and sqlerrm in (
        'NOT_FOUND', 'GROUP_ARCHIVED', 'NOT_MEMBER', 'NOT_ORGANIZER', 'GROUP_SUSPENDED'
      ) then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
  end;

  -- current só depois da autoridade atual autorizada, relido sob as travas.
  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome, 'current', jsonb_build_object(
      'stars', (select stars from private.ratings
                where group_id = p_group_id and profile_id = p_profile_id)));
  end if;

  select membership.status, profile.account_status into v_target_status, v_target_account
  from public.group_members as membership
  join public.profiles as profile on profile.id = membership.profile_id
  where membership.group_id = p_group_id and membership.profile_id = p_profile_id;
  if v_target_status is distinct from 'active'
     or v_target_account in ('deletion_pending', 'deleted') then
    raise exception using errcode = 'P0001', message = 'NOT_ACTIVE_MEMBER';
  end if;

  if v_rating.stars = p_stars then
    v_result := 'rating_unchanged';
  else
    insert into private.rating_history
      (group_id, profile_id, old_stars, new_stars, changed_by, changed_at)
    values (p_group_id, p_profile_id, v_rating.stars, p_stars, v_actor_id, now())
    returning id into v_history_id;
    insert into private.ratings
      (group_id, profile_id, current_history_id, stars, updated_by, updated_at)
    values (p_group_id, p_profile_id, v_history_id, p_stars, v_actor_id, now())
    on conflict (group_id, profile_id) do update
    set current_history_id = excluded.current_history_id, stars = excluded.stars,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at;
    v_result := 'rating_set';
  end if;

  v_outcome := jsonb_build_object('group_id', p_group_id::text,
    'logical_result', v_result, 'profile_id', p_profile_id::text);
  perform private.complete_group_idempotency(
    v_actor_key, 'set_rating', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome,
    'current', jsonb_build_object('stars', p_stars));
end;
$function$;

revoke all on function public.set_rating(uuid, uuid, uuid, text, integer, integer, uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.set_rating(uuid, uuid, uuid, text, integer, integer, uuid, uuid, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- get_group_ratings(group_id): as notas que o membro ativo pode ver
-- ---------------------------------------------------------------------------
-- Mesmo caminho de get_group_members (0029): quem não é membro ativo, de
-- grupo apagado ou não, recebe NOT_MEMBER antes da trava do grupo; o membro
-- ativo trava o grupo e relê a própria membership sob a trava. A organização
-- recebe cada membro ativo com a nota atual (ou null), quem mudou por último
-- e quando; o jogador recebe a própria e, com visibilidade "members", as
-- notas atuais dos demais, sem autor nem instante; com "private", nada dos
-- demais. Conta em exclusão não aparece; autor com conta excluída vem como
-- changed_by_removed.
create function public.get_group_ratings(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_group_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_group public.groups%rowtype;
  v_member public.group_members%rowtype;
  v_manage boolean;
  v_members jsonb;
begin
  if p_group_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  perform 1 from public.profiles as profile where profile.id = v_actor for no key update;
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  select membership.* into v_member from public.group_members as membership
  where membership.group_id = p_group_id and membership.profile_id = v_actor;
  if v_member.status is distinct from 'active' or private.is_group_deleted(p_group_id) then
    raise exception using errcode = '42501', message = 'NOT_MEMBER';
  end if;
  select grp.* into v_group from public.groups as grp where grp.id = p_group_id for no key update;
  select membership.* into v_member from public.group_members as membership
  where membership.group_id = p_group_id and membership.profile_id = v_actor;
  if v_member.status is distinct from 'active' or private.is_group_deleted(p_group_id) then
    raise exception using errcode = '42501', message = 'NOT_MEMBER';
  end if;
  if v_group.archived_at is not null then
    raise exception using errcode = 'P0001', message = 'GROUP_ARCHIVED';
  end if;
  v_manage := v_group.owner_id = v_actor or v_member.role = 'organizer';

  if v_manage or v_group.ratings_visibility = 'members' then
    select coalesce(jsonb_agg(jsonb_build_object(
        'profile_id', membership.profile_id,
        'display_name', coalesce(nullif(btrim(profile.nickname), ''), profile.name),
        'stars', rating.stars)
        || case when v_manage then jsonb_build_object(
          'changed_by_name', case when author.account_status in ('deletion_pending', 'deleted')
            then null else coalesce(nullif(btrim(author.nickname), ''), author.name) end,
          'changed_by_removed', coalesce(author.account_status in ('deletion_pending', 'deleted'), false),
          'changed_at', rating.updated_at) else '{}'::jsonb end
        order by rating.stars is not null,
          lower(coalesce(nullif(btrim(profile.nickname), ''), profile.name)), membership.profile_id),
      '[]'::jsonb)
    into v_members
    from public.group_members as membership
    join public.profiles as profile on profile.id = membership.profile_id
    left join private.ratings as rating
      on rating.group_id = membership.group_id and rating.profile_id = membership.profile_id
    left join public.profiles as author on author.id = rating.updated_by
    where membership.group_id = p_group_id and membership.status = 'active'
      and profile.account_status not in ('deletion_pending', 'deleted');
  end if;

  return jsonb_build_object(
    'group_id', p_group_id,
    'visibility', v_group.ratings_visibility,
    'can_rate', v_manage,
    'own_stars', (select stars from private.ratings
                  where group_id = p_group_id and profile_id = v_actor),
    'members', v_members);
end;
$function$;

revoke all on function public.get_group_ratings(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_group_ratings(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- get_my_rating(group_id): a própria nota, em qualquer visibilidade
-- ---------------------------------------------------------------------------
-- docs/13 §4.1.1 e D58: o titular vê a própria nota atual e a versão dela,
-- inclusive depois de sair do grupo, enquanto a retenção a conserva. Só lê a
-- linha do próprio ator, sem trava: o grupo inexistente, o apagado, o de que
-- a pessoa nunca participou e o membro sem nota respondem igual, sem nota.
create function public.get_my_rating(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_group_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_rating private.ratings%rowtype;
begin
  if p_group_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  select rating.* into v_rating from private.ratings as rating
  where rating.group_id = p_group_id and rating.profile_id = v_actor
    and not private.is_group_deleted(rating.group_id);
  return jsonb_build_object(
    'group_id', p_group_id,
    'stars', v_rating.stars,
    'rating_history_id', v_rating.current_history_id,
    'updated_at', v_rating.updated_at);
end;
$function$;

revoke all on function public.get_my_rating(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_rating(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Retenção: purge_ratings (docs/17 §§2 e 4)
-- ---------------------------------------------------------------------------
-- Nota e histórico de um membro saem 12 meses depois do fim da aplicação:
-- saída do grupo (removed_at, também pela exclusão de conta) ou encerramento
-- do grupo (archived_at, também o apagado). Sem membership, já expurgada por
-- purge_removed_memberships (que conta os mesmos 12 meses), a nota também
-- sai. Pendente não conta prazo: removed_at é zerado na reentrada. Sem
-- contestação no piloto, não há versão suspensa. SKIP LOCKED: uma nota travada
-- por set_rating fica para a próxima execução.
create function private.purge_ratings()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_started_at timestamptz := clock_timestamp();
  v_now timestamptz := now();
  v_scanned bigint;
  v_groups uuid[];
  v_profiles uuid[];
begin
  select count(*) into v_scanned
  from private.ratings as rating
  join public.groups as grp on grp.id = rating.group_id
  left join public.group_members as membership
    on membership.group_id = rating.group_id and membership.profile_id = rating.profile_id
  where membership.profile_id is null
     or (membership.status = 'removed' and membership.removed_at <= v_now - interval '12 months')
     or grp.archived_at <= v_now - interval '12 months';

  with expired as (
    select rating.group_id, rating.profile_id
    from private.ratings as rating
    join public.groups as grp on grp.id = rating.group_id
    left join public.group_members as membership
      on membership.group_id = rating.group_id and membership.profile_id = rating.profile_id
    where membership.profile_id is null
       or (membership.status = 'removed' and membership.removed_at <= v_now - interval '12 months')
       or grp.archived_at <= v_now - interval '12 months'
    order by rating.group_id, rating.profile_id
    for update of rating skip locked
  ), removed as (
    delete from private.ratings as rating
    using expired
    where rating.group_id = expired.group_id and rating.profile_id = expired.profile_id
    returning rating.group_id, rating.profile_id
  )
  select array_agg(removed.group_id), array_agg(removed.profile_id)
  into v_groups, v_profiles
  from removed;

  delete from private.rating_history as version
  using unnest(coalesce(v_groups, '{}'), coalesce(v_profiles, '{}')) as purged(group_id, profile_id)
  where version.group_id = purged.group_id and version.profile_id = purged.profile_id;

  insert into private.retention_runs
    (policy, window_start, window_end, scanned, purged, failed, started_at, finished_at)
  values ('purge_ratings', v_now - interval '12 months', v_now,
          v_scanned::integer, coalesce(cardinality(v_groups), 0), 0, v_started_at,
          clock_timestamp());
  return jsonb_build_object('scanned', v_scanned, 'purged', coalesce(cardinality(v_groups), 0));
end;
$function$;

revoke all on function private.purge_ratings()
  from public, anon, authenticated, service_role;
-- Corpos da 0030; o slot diário de purge_ratings é o dos outros expurgos de
-- retenção do grupo, e o despacho ganha o ramo do job novo.
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
  if p_job_name in ('process_external_effects', 'purge_invite_rate_limits') then
    return date_trunc('minute', v_now_utc) at time zone 'UTC';
  elsif p_job_name in ('health_check_jobs', 'reclaim_photo_uploads') then
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
  elsif p_job_name in ('purge_removed_memberships', 'purge_terminal_group_invites',
                       'purge_ratings') then
    v_slot := (date_trunc('day', v_now_utc) at time zone 'UTC')
      + interval '3 hours 53 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 day' end;
  end if;

  raise exception using errcode = '22023', message = 'VALIDATION';
end;
$function$;

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
  elsif v_run.job_name='purge_invite_rate_limits' then
    v_result:=private.purge_invite_rate_limits();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_terminal_group_invites' then
    v_result:=private.purge_terminal_group_invites();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_removed_memberships' then
    v_result:=private.purge_removed_memberships();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_ratings' then
    v_result:=private.purge_ratings();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='reclaim_photo_uploads' then
    v_result:=private.reclaim_photo_uploads();
    v_scanned:=(v_result->>'reclaimed')::bigint+(v_result->>'purged')::bigint;
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',v_scanned,'skipped',(v_result->>'scanned')::bigint-v_scanned,'failed',0,'stale',0,'duration_ms',0);
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

select cron.schedule('colete_v1_purge_ratings', '53 3 * * *',
  $$select private.invoke_worker_cron('purge_ratings');$$);

commit;
