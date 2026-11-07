-- Piloto 1.4: P7/P8/P10/P16/P18, decisões de César (28/10 e 06/11/2026).
-- Append-only; autor da remoção somente na idempotência por 30 dias.
begin;
set local lock_timeout = '5s';

alter table private.match_refunds drop constraint match_refunds_origin_check;
alter table private.match_refunds add constraint match_refunds_origin_check
  check (origin in ('canceled', 'left_group', 'removed'));

insert into private.idempotency_operations
  (operation, family, outcome_shape, id_keys, resource_type, resource_key) values
  ('add_player','group','ids',array['group_id','match_id','profile_id'],'group','group_id'),
  ('remove_player','group','ids',array['group_id','match_id','profile_id'],'group','group_id');
insert into private.idempotency_operation_results(operation,logical_result) values
  ('add_player','player_added'), ('add_player','player_waitlisted'),
  ('add_player','player_add_unchanged'),
  ('remove_player','player_removed'), ('remove_player','player_remove_unchanged');

create function public.add_player(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_match_id uuid, p_profile_id uuid
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
  if p_match_id is null or p_profile_id is null then
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
    v_actor_key, 'add_player', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  v_group_id := private.lock_match_context(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id, p_match_id);

  -- M2-D20: só a perda de autoridade no grupo conserva o desfecho, sem
  -- current; autenticação negada já saiu com o erro normal no helper.
  begin
    if v_group_id is null then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
    if private.match_actor_authority(v_group_id, v_actor_id) not in ('owner', 'organizer') then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
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
    return jsonb_build_object('outcome', v_acquired.outcome);
  end if;

  if v_match.starts_at <= now() then
    raise exception using errcode = 'P0001', message = 'MATCH_STARTED';
  end if;

  -- Read the target only AFTER lock_match_context: group exit serializes here.
  if not exists (select 1 from public.group_members
      where group_id = v_group_id and profile_id = p_profile_id and status = 'active') then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;

  select * into v_player from private.match_players
  where match_id = p_match_id and profile_id = p_profile_id
  for no key update;

  if v_player.status in ('starter', 'waitlist') then
    v_result := 'player_add_unchanged';
  else
    perform private.promote_match_waitlist(p_match_id);
    select count(*) into v_starters from private.match_players
    where match_id = p_match_id and status = 'starter';
    v_status := case when v_starters < v_match.field_slots then 'starter' else 'waitlist' end;
    if v_player.id is null then
      insert into private.match_players (match_id, profile_id, status, queue_seq)
      values (p_match_id, p_profile_id, v_status, nextval('private.match_queue_seq'));
    else
      update private.match_players
      set status = v_status, queue_seq = nextval('private.match_queue_seq'),
          status_changed_at = now()
      where id = v_player.id;
    end if;
    v_result := case v_status when 'starter' then 'player_added' else 'player_waitlisted' end;
  end if;

  if (select count(*) from private.match_players
      where match_id = p_match_id and status = 'starter') > v_match.field_slots then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;

  v_outcome := jsonb_build_object('group_id', v_group_id::text,
    'logical_result', v_result, 'match_id', p_match_id::text, 'profile_id', p_profile_id::text);
  perform private.complete_group_idempotency(
    v_actor_key, 'add_player', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome);
end;
$function$;
revoke all on function public.add_player(uuid,uuid,uuid,text,integer,integer,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.add_player(uuid,uuid,uuid,text,integer,integer,uuid,uuid)
  to service_role;

create function public.remove_player(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_match_id uuid, p_profile_id uuid
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
  if p_match_id is null or p_profile_id is null then
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
    v_actor_key, 'remove_player', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  v_group_id := private.lock_match_context(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id, p_match_id);

  -- M2-D20: só a perda de autoridade no grupo conserva o desfecho, sem
  -- current; autenticação negada já saiu com o erro normal no helper.
  begin
    if v_group_id is null then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
    if private.match_actor_authority(v_group_id, v_actor_id) not in ('owner', 'organizer') then
      raise exception using errcode = 'P0002', message = 'NOT_FOUND';
    end if;
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
    return jsonb_build_object('outcome', v_acquired.outcome);
  end if;

  if v_match.starts_at <= now() then
    raise exception using errcode = 'P0001', message = 'MATCH_STARTED';
  end if;

  -- Read the target only AFTER lock_match_context: group exit serializes here.
  if not exists (select 1 from public.group_members
      where group_id = v_group_id and profile_id = p_profile_id and status = 'active') then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;

  select * into v_player from private.match_players
  where match_id = p_match_id and profile_id = p_profile_id
  for no key update;

  -- P18: self-removal always goes through leave_match (Desistir).
  if p_profile_id = v_actor_id then
    if v_player.paid then
      raise exception using errcode = 'P0001', message = 'PAYMENT_ALREADY_REAL';
    end if;
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  if v_player.id is null or v_player.status not in ('starter', 'waitlist') then
    v_result := 'player_remove_unchanged';
  else
    perform private.move_match_payment_to_refund(v_player.id, 'removed');
    update private.match_players
    set status = 'removed', status_changed_at = now()
    where id = v_player.id;
    perform private.promote_match_waitlist(p_match_id);
    v_result := 'player_removed';
  end if;

  v_outcome := jsonb_build_object('group_id', v_group_id::text,
    'logical_result', v_result, 'match_id', p_match_id::text, 'profile_id', p_profile_id::text);
  perform private.complete_group_idempotency(
    v_actor_key, 'remove_player', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome);
end;
$function$;
revoke all on function public.remove_player(uuid,uuid,uuid,text,integer,integer,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.remove_player(uuid,uuid,uuid,text,integer,integer,uuid,uuid)
  to service_role;

commit;
