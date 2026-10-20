-- Fatia 0032: sorteio de times do piloto (PR L; decisões humanas de César de
-- 19/10/2026, docs/25 §8.1). Corte de docs/13 §§4.2 e 4.3 sobre o Racha
-- completo e as notas da 0031, com o algoritmo simples da D63-A: a serpentina
-- por nota. O dono ou organizador ativo sorteia 2, 3 ou 4 times entre os
-- confirmados de um racha que não terminou nem foi cancelado, com pelo menos
-- 2 confirmados por time, e o sorteio já vale como publicado. Sem proposta,
-- ajuste manual, trilha pública ou notificação.
--
-- O algoritmo (versão snake-v1) segue docs/04 §§1, 2 e 6 (início 0) e a
-- D63-A, sem nada aleatório: os confirmados são ordenados por nota
-- decrescente e, no empate, por UUID crescente (os 16 bytes, como docs/04
-- §2); as capacidades são balanced_sizes(N, K), primeiro N % K times com
-- ceil(N/K) e depois os demais com floor(N/K); a sequência é distribuída nos
-- índices 0..K-1 e depois K-1..0, repetindo os extremos e pulando time cheio
-- (1º no Time A, 2º e 3º no B, 4º e 5º no A, com dois times). O mesmo
-- conjunto de notas dá sempre os mesmos times; por isso não há semente, e a
-- serpentina não consome PRNG (docs/04 §8). Quem sobra quando N % K não é
-- zero entra nos primeiros times, e o sorteio exige a confirmação de que a
-- média por jogador não compensa jogar com uma pessoa a menos (docs/01 §5.7,
-- UNEQUAL_TEAMS_CONFIRMATION_REQUIRED).
--
-- Goleiro, pelo D8 (docs/01 §5.6): o goleiro é quem está na lista de
-- goleiros do racha, que ainda não existe; até lá, todo confirmado é jogador
-- de linha e entra no sorteio. A posição do perfil é só informativa (D9).
-- Todo confirmado precisa de nota atual no grupo (0031): sem nota, o sorteio
-- recusa com RATINGS_MISSING, sem valor padrão (docs/01 §5.6).
--
-- O resultado é guardado e reproduzível (D63-A): cada membro de time guarda a
-- versão da nota usada (rating_history_id), nunca as estrelas, e o sorteio
-- guarda a versão do algoritmo. A versão da nota some com o histórico, pelo
-- expurgo da 0031; a composição fica, sem nota. Os times não revelam a ordem
-- das notas: dentro de cada time, a leitura ordena pelo nome.
--
-- Só o último sorteio vale: sortear de novo substitui o anterior. Quem
-- desiste, sai do grupo ou sobe da espera depois muda a lista, não o sorteio:
-- a leitura esconde quem deixou de estar confirmado, mostra em "sem time" quem
-- entrou e marca o sorteio como desatualizado. Para a organização, uma nota
-- alterada depois do sorteio também o marca (docs/01 §5.6: mudança posterior
-- exige refazer o sorteio); o jogador não fica sabendo que uma nota mudou.
-- Racha cancelado e grupo apagado não mostram times, e sortear é recusado.
--
-- Travas, como a 0029: a recusa do racha inexistente, do grupo apagado e do
-- racha cancelado sai antes de travar qualquer linha do grupo, pelo mesmo
-- caminho de um ID inexistente; os dois estados são definitivos. O racha vivo
-- é travado por lock_match_context, a mesma trava de join_match e
-- leave_match, e o estado é relido depois dela, antes de gravar ou de
-- devolver um replay. As notas são lidas sob a trava do grupo, que set_rating
-- também segura, então nenhuma muda no meio do sorteio.
-- A D63.5 continua adiada: o padrão idempotente é o da 0021 à 0031.
begin;

-- ---------------------------------------------------------------------------
-- Sorteio e membros de cada time
-- ---------------------------------------------------------------------------
-- Tabelas privadas de serviço, sem RLS (docs/14 §5.2): a proteção vem dos
-- privilégios de schema, e os defaults da 0004 as fazem nascer sem privilégio.
-- Lidas só pela projeção get_match_teams e escritas só por draw_teams.
-- Uma linha de sorteio por racha: sortear de novo apaga a anterior, e os
-- membros dela, sob a trava do racha. drawn_by é histórico, não autoridade,
-- como canceled_by (0028), e nenhuma leitura o devolve.
create table private.match_draws (
  id                uuid primary key default gen_random_uuid(),
  match_id          uuid not null unique references private.matches (id),
  team_count        smallint not null check (team_count between 2 and 4),
  algorithm_version text not null check (algorithm_version = 'snake-v1'),
  drawn_by          uuid not null references public.profiles (id),
  drawn_at          timestamptz not null default now()
);

comment on table private.match_draws is
  'Sorteio de times corrente do racha (0032, serpentina por nota da D63-A). Escrita somente por draw_teams; leitura somente por get_match_teams.';

-- pick é a posição na sequência da serpentina (privada: revela a ordem das
-- notas); rating_history_id é a versão da nota usada, para reproduzir o
-- sorteio enquanto a retenção a conserva, e vira null quando o expurgo da 0031
-- apaga a versão.
create table private.match_draw_members (
  draw_id           uuid not null references private.match_draws (id) on delete cascade,
  profile_id        uuid not null references public.profiles (id),
  team_number       smallint not null check (team_number between 1 and 4),
  pick              smallint not null check (pick >= 1),
  rating_history_id bigint references private.rating_history (id) on delete set null,
  primary key (draw_id, profile_id),
  unique (draw_id, pick)
);

comment on table private.match_draw_members is
  'Membros de cada time do sorteio corrente (0032), com a versão da nota usada. Escrita somente por draw_teams; leitura somente por get_match_teams.';

create index match_draw_members_profile_idx on private.match_draw_members (profile_id);
create index match_draw_members_rating_idx on private.match_draw_members (rating_history_id);

-- ---------------------------------------------------------------------------
-- Livro de idempotência: lista fechada de operações e desfechos
-- ---------------------------------------------------------------------------
-- Todas as operações e todos os desfechos que já existem continuam, inclusive
-- set_group_appearance (0027), update_match e cancel_match (0028),
-- delete_group (0029), as cinco operações de foto (0030) e set_rating (0031).
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
    'set_rating', 'draw_teams'
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
      'rating_set', 'rating_unchanged', 'teams_drawn'
    )
  );

alter function private.validate_idempotency_outcome(text, jsonb)
  rename to validate_through_ratings_outcome;

-- O desfecho guarda somente os IDs e o resultado lógico, como update_match e
-- cancel_match: nenhum time, jogador, nota ou número de times. Os times
-- correntes são lidos de novo por get_match_teams, com a autoridade de quem lê.
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
  if p_operation <> 'draw_teams' then
    perform private.validate_through_ratings_outcome(p_operation, p_outcome);
    return;
  end if;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
        is distinct from array['group_id', 'logical_result', 'match_id']::text[]
     or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
     or p_outcome ->> 'logical_result' <> 'teams_drawn' then
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

revoke all on function private.validate_through_ratings_outcome(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_idempotency_outcome(text, jsonb)
  from public, anon, authenticated, service_role;

-- Corpos idênticos aos da 0031; somente as listas de operações ganham
-- draw_teams. O recurso é o grupo, como nas demais operações de racha.
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
                            'set_rating', 'draw_teams')
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
                            'set_rating', 'draw_teams') then
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
                                  'remove_group_photo','set_rating','draw_teams')
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
-- O sorteio: serpentina por nota (snake-v1)
-- ---------------------------------------------------------------------------
-- Quem chama já segura a trava do racha (a lista) e a do grupo (as notas) e
-- já conferiu que todo confirmado tem nota. A sequência de casas é 0..K-1,
-- depois K-1..0, repetindo os extremos; casa cheia é pulada, e as capacidades
-- são as de balanced_sizes. Determinística: não consome aleatoriedade.
create function private.draw_match_teams(
  p_match_id uuid, p_group_id uuid, p_team_count integer, p_actor_id uuid
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_draw_id uuid := gen_random_uuid();
  v_count integer;
  v_capacity integer[];
  v_size integer[];
  v_position integer := 0;
  v_direction integer := 1;
  v_team integer;
  v_pick integer := 0;
  v_player record;
begin
  select count(*) into v_count from private.match_players
  where match_id = p_match_id and status = 'starter';
  -- balanced_sizes(N, K): os primeiros N % K times com ceil(N/K).
  select array_agg(case when slot <= v_count % p_team_count
                        then v_count / p_team_count + 1 else v_count / p_team_count end
                   order by slot)
  into v_capacity from generate_series(1, p_team_count) as slot;
  v_size := array_fill(0, array[p_team_count]);

  delete from private.match_draws where match_id = p_match_id;
  insert into private.match_draws (id, match_id, team_count, algorithm_version, drawn_by)
  values (v_draw_id, p_match_id, p_team_count, 'snake-v1', p_actor_id);

  for v_player in
    select player.profile_id, rating.current_history_id
    from private.match_players as player
    join private.ratings as rating
      on rating.group_id = p_group_id and rating.profile_id = player.profile_id
    where player.match_id = p_match_id and player.status = 'starter'
    order by rating.stars desc, player.profile_id
  loop
    loop
      v_team := v_position;
      if v_direction = 1 then
        if v_position = p_team_count - 1 then v_direction := -1;
        else v_position := v_position + 1; end if;
      else
        if v_position = 0 then v_direction := 1;
        else v_position := v_position - 1; end if;
      end if;
      exit when v_size[v_team + 1] < v_capacity[v_team + 1];
    end loop;
    v_size[v_team + 1] := v_size[v_team + 1] + 1;
    v_pick := v_pick + 1;
    insert into private.match_draw_members
      (draw_id, profile_id, team_number, pick, rating_history_id)
    values (v_draw_id, v_player.profile_id, v_team + 1, v_pick, v_player.current_history_id);
  end loop;
end;
$function$;

revoke all on function private.draw_match_teams(uuid, uuid, integer, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- draw_teams(match_id, team_count, confirm_unequal_sizes, request_id)
-- ---------------------------------------------------------------------------
-- Somente dono ou organizador ativo; jogador recebe NOT_ORGANIZER, ex-membro,
-- pendente e estranho o mesmo NOT_FOUND de um ID inexistente, grupo apagado
-- também (GROUP_DELETED, que a Edge responde como NOT_FOUND). Racha cancelado
-- recusa com MATCH_CANCELED e terminado com MATCH_DONE, a chamada nova e o
-- replay de um sorteio anterior. Menos de 2 confirmados por time recusa com
-- TEAM_SIZE_INVALID; confirmado sem nota, com RATINGS_MISSING; tamanhos
-- diferentes sem a confirmação, com UNEQUAL_TEAMS_CONFIRMATION_REQUIRED. Quem
-- perdeu a autoridade continua na M2-D20: o replay devolve o desfecho.
create function public.draw_teams(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_match_id uuid, p_team_count integer, p_confirm_unequal_sizes boolean
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
  v_canceled_at timestamptz;
  v_authority text;
  v_match private.matches%rowtype;
  v_starters integer;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_match_id is null or p_team_count is null or p_team_count not between 2 and 4
     or p_confirm_unequal_sizes is null then
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
    v_actor_key, 'draw_teams', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  -- Racha inexistente, cancelado ou de grupo apagado: decidido sem travar nada
  -- do grupo, pelo caminho de um ID inexistente (só o próprio perfil, para a
  -- sessão). Só o racha vivo passa pela trava de join_match e leave_match.
  select match.group_id, match.canceled_at into v_group_id, v_canceled_at
  from private.matches as match where match.id = p_match_id;
  if v_group_id is null or v_canceled_at is not null
     or private.is_group_deleted(v_group_id) then
    perform 1 from public.profiles where id = v_actor_id for no key update;
    perform private.require_group_actor_after_locks(
      v_actor_id, p_actor_auth_user_id, p_actor_session_id);
  else
    v_group_id := private.lock_match_context(
      v_actor_id, p_actor_auth_user_id, p_actor_session_id, p_match_id);
  end if;

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

  -- Relido depois da trava: o cancelamento e o fim do racha recusam a chamada
  -- nova e o replay, inclusive o que esperou a trava enquanto o racha era
  -- cancelado.
  select * into strict v_match from private.matches where id = p_match_id;
  if v_match.canceled_at is not null then
    raise exception using errcode = 'P0001', message = 'MATCH_CANCELED';
  end if;
  if v_match.ends_at <= now() then
    raise exception using errcode = 'P0001', message = 'MATCH_DONE';
  end if;

  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome);
  end if;

  select count(*) into v_starters from private.match_players
  where match_id = p_match_id and status = 'starter';
  if v_starters < 2 * p_team_count then
    raise exception using errcode = 'P0001', message = 'TEAM_SIZE_INVALID';
  end if;
  if exists (
    select 1 from private.match_players as player
    where player.match_id = p_match_id and player.status = 'starter'
      and not exists (select 1 from private.ratings as rating
                      where rating.group_id = v_group_id
                        and rating.profile_id = player.profile_id)
  ) then
    raise exception using errcode = 'P0001', message = 'RATINGS_MISSING';
  end if;
  if v_starters % p_team_count <> 0 and not p_confirm_unequal_sizes then
    raise exception using errcode = 'P0001', message = 'UNEQUAL_TEAMS_CONFIRMATION_REQUIRED';
  end if;

  perform private.draw_match_teams(p_match_id, v_group_id, p_team_count, v_actor_id);

  v_outcome := jsonb_build_object('group_id', v_group_id::text,
    'logical_result', 'teams_drawn', 'match_id', p_match_id::text);
  perform private.complete_group_idempotency(
    v_actor_key, 'draw_teams', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome);
end;
$function$;

revoke all on function public.draw_teams(uuid, uuid, uuid, text, integer, integer, uuid, integer, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.draw_teams(uuid, uuid, uuid, text, integer, integer, uuid, integer, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- get_match_teams(match_id): os times correntes, para todo membro ativo
-- ---------------------------------------------------------------------------
-- Fora do grupo, o mesmo NOT_FOUND de um ID inexistente; grupo apagado, o
-- GROUP_DELETED de match_actor_authority. Racha cancelado não mostra times.
-- Cada time traz só quem ainda está confirmado, por nome (nunca na ordem da
-- serpentina, que revelaria a ordem das notas); quem foi confirmado depois
-- fica em unassigned, na ordem da lista; stale diz que a lista mudou desde o
-- sorteio e, só para quem pode sortear, também que uma nota usada mudou. Conta
-- em exclusão aparece sem identidade, como em get_match_roster. Nenhuma nota,
-- autor ou instante sai daqui.
create function public.get_match_teams(
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
  v_authority text;
  v_manage boolean;
  v_draw private.match_draws%rowtype;
  v_teams jsonb := '[]'::jsonb;
  v_unassigned jsonb := '[]'::jsonb;
  v_stale boolean := false;
begin
  if p_match_id is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor_id := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id, true);
  select * into v_match from private.matches where id = p_match_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_authority := private.match_actor_authority(v_match.group_id, v_actor_id);
  v_manage := v_authority in ('owner', 'organizer');

  if v_match.canceled_at is null then
    select * into v_draw from private.match_draws where match_id = p_match_id;
  end if;

  if v_draw.id is not null then
    with starter as (
      select player.profile_id, player.queue_seq from private.match_players as player
      where player.match_id = p_match_id and player.status = 'starter'
    ),
    entry as (
      select starter.profile_id, starter.queue_seq, member.team_number,
        lower(coalesce(nullif(btrim(profile.nickname), ''), profile.name)) as sort_name,
        jsonb_build_object(
          'profile_id', case when flags.hidden then null else starter.profile_id end,
          'name', case when flags.hidden then null else profile.name end,
          'nickname', case when flags.hidden then null else profile.nickname end,
          'position', case when flags.hidden then null else profile.position end,
          'account_removed', flags.hidden,
          'is_viewer', starter.profile_id = v_actor_id) as item
      from starter
      join public.profiles as profile on profile.id = starter.profile_id
      left join private.match_draw_members as member
        on member.draw_id = v_draw.id and member.profile_id = starter.profile_id
      cross join lateral (
        select profile.account_status in ('deletion_pending', 'deleted') as hidden) as flags
    )
    select
      (select jsonb_agg(jsonb_build_object('team_number', team.number,
          'players', coalesce((select jsonb_agg(entry.item
              order by entry.item ->> 'account_removed', entry.sort_name, entry.profile_id)
            from entry where entry.team_number = team.number), '[]'::jsonb))
          order by team.number)
        from generate_series(1, v_draw.team_count) as team(number)),
      coalesce((select jsonb_agg(entry.item order by entry.queue_seq)
        from entry where entry.team_number is null), '[]'::jsonb),
      exists (select 1 from entry where entry.team_number is null)
        or exists (select 1 from private.match_draw_members as member
          where member.draw_id = v_draw.id
            and not exists (select 1 from starter where starter.profile_id = member.profile_id))
        or (v_manage and exists (
          select 1 from private.match_draw_members as member
          left join private.ratings as rating
            on rating.group_id = v_match.group_id and rating.profile_id = member.profile_id
          where member.draw_id = v_draw.id
            and rating.current_history_id is distinct from member.rating_history_id))
    into v_teams, v_unassigned, v_stale;
  end if;

  return jsonb_build_object(
    'match_id', p_match_id,
    'can_draw', v_manage and v_match.canceled_at is null and v_match.ends_at > now(),
    'team_count', v_draw.team_count,
    'stale', v_stale,
    'teams', v_teams,
    'unassigned', v_unassigned);
end;
$function$;

revoke all on function public.get_match_teams(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_match_teams(uuid, uuid, uuid) to service_role;

commit;
