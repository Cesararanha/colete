-- Piloto 1.3, decisões P1/P3/P4/P13–P17/P19/P20 e §14 do plano (06/11/2026).
-- Append-only: a 0033 permanece intacta. Sem Pix, referência livre ou ledger completo.
begin;
set local lock_timeout = '5s';

create table private.match_refunds (
  id uuid primary key default gen_random_uuid(),
  match_player_id uuid not null references private.match_players(id) on delete cascade,
  payment_marked_at timestamptz not null,
  payment_marked_by uuid not null references public.profiles(id),
  amount numeric(10,2) not null check (amount > 0),
  origin text not null check (origin in ('canceled', 'left_group')),
  status text not null default 'refund_due' check (status in ('refund_due', 'refunded')),
  created_at timestamptz not null default now(),
  refunded_at timestamptz,
  marked_by uuid references public.profiles(id),
  marked_at timestamptz,
  unique(match_player_id, payment_marked_at),
  check ((status = 'refunded') = (refunded_at is not null)),
  check ((marked_by is null) = (marked_at is null)),
  check (status <> 'refunded' or marked_by is not null),
  check (refunded_at is null or (refunded_at >= created_at and refunded_at <= marked_at))
);
-- Tabela privada de serviço: sem RLS e sem grants, por default privileges da 0004.
-- O cascade só serve ao purge físico; nenhuma RPC apaga inscrição.
create unique index match_refunds_one_cancellation_idx
  on private.match_refunds(match_player_id) where origin = 'canceled';
create index match_refunds_pending_idx on private.match_refunds(match_player_id) where status = 'refund_due';

insert into private.idempotency_operations
 (operation, family, outcome_shape, id_keys, resource_type, resource_key)
values
 ('record_canceled_match_payment','group','ids',array['group_id','match_id','refund_id'],'group','group_id'),
 ('mark_refunded','group','ids',array['group_id','match_id','refund_id'],'group','group_id'),
 ('correct_refund','group','ids',array['group_id','match_id','refund_id'],'group','group_id');
insert into private.idempotency_operation_results(operation,logical_result) values
 ('record_canceled_match_payment','canceled_payment_recorded'),
 ('mark_refunded','refund_recorded'), ('mark_refunded','refund_unchanged'),
 ('correct_refund','refund_corrected'), ('correct_refund','refund_correction_unchanged');

-- P20 + §14: todo removed pago, inclusive racha em andamento ou terminado.
-- Cancelado prevalece como origem, como no cancelamento daqui para frente.
insert into private.match_refunds(match_player_id,payment_marked_at,payment_marked_by,amount,origin)
select p.id,p.payment_marked_at,p.payment_marked_by,m.field_price,
 case when m.canceled_at is not null then 'canceled' else 'left_group' end
from private.match_players p join private.matches m on m.id=p.match_id
where p.paid and (p.status='removed' or m.canceled_at is not null);
update private.match_players p set paid=false,payment_marked_by=null,payment_marked_at=null
where p.paid and exists(select 1 from private.match_refunds r where r.match_player_id=p.id);
alter table private.match_players add constraint match_players_paid_starter_check
 check(not (paid and status <> 'starter'));

-- Chamador já detém perfil → grupo → membership → racha. Transfere uma marcação
-- para uma obrigação, conservando o valor e a identidade daquele pagamento.
create function private.move_match_payment_to_refund(p_player_id uuid,p_origin text)
returns uuid language plpgsql set search_path='' as $function$
declare v_id uuid;
begin
 insert into private.match_refunds(match_player_id,payment_marked_at,payment_marked_by,amount,origin)
 select p.id,p.payment_marked_at,p.payment_marked_by,m.field_price,p_origin
 from private.match_players p join private.matches m on m.id=p.match_id
 where p.id=p_player_id and p.paid
 returning id into v_id;
 if v_id is not null then
   update private.match_players set paid=false,payment_marked_at=null,payment_marked_by=null
   where id=p_player_id;
 end if;
 return v_id;
end;
$function$;
revoke all on function private.move_match_payment_to_refund(uuid,text) from public,anon,authenticated,service_role;

create or replace function public.cancel_match(
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
  v_player_id uuid;
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
    for v_player_id in select id from private.match_players where match_id=p_match_id and paid order by id loop
      perform private.move_match_payment_to_refund(v_player_id,'canceled');
    end loop;
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

create or replace function public.update_match(
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

  if v_config.field_price is distinct from v_match.field_price and (
    exists(select 1 from private.match_players where match_id=p_match_id and paid)
    or exists(select 1 from private.match_refunds r join private.match_players p
      on p.id=r.match_player_id where p.match_id=p_match_id and r.status='refund_due')) then
    raise exception using errcode='P0001',message='PRICE_LOCKED';
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
      and player.status in ('starter', 'waitlist') and match.starts_at > now() and match.canceled_at is null
    order by player.match_id
  loop
    perform 1 from private.matches where id = v_match_id for no key update;
    v_status := null;
    select status into v_status from private.match_players
    where match_id = v_match_id and profile_id = new.profile_id
    for no key update;
    if v_status in ('starter', 'waitlist') then
      perform private.move_match_payment_to_refund(
        (select id from private.match_players where match_id=v_match_id and profile_id=new.profile_id),'left_group');
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

create or replace function public.delete_group(
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
  perform 1 from public.groups where id = p_group_id and not private.is_group_deleted(id)
    for no key update;
  perform 1 from public.group_members
    where group_id = p_group_id and profile_id = v_actor_id
      and not private.is_group_deleted(group_id) for no key update;
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);

  if not v_acquired.acquired then
    return jsonb_build_object('outcome', v_acquired.outcome);
  end if;

  if private.group_actor_authority(p_group_id, v_actor_id) <> 'owner' then
    raise exception using errcode = '42501', message = 'OWNER_ONLY';
  end if;
  perform private.require_group_not_suspended(p_group_id);

  if exists(select 1 from private.match_players p join private.matches m on m.id=p.match_id
    where m.group_id=p_group_id and m.canceled_at is null and m.ends_at>now() and p.paid) then
    raise exception using errcode='P0001',message='ACTIVE_PAYMENTS_REMAIN';
  end if;
  if exists(select 1 from private.match_refunds r join private.match_players p on p.id=r.match_player_id
    join private.matches m on m.id=p.match_id where m.group_id=p_group_id and r.status='refund_due') then
    raise exception using errcode='P0001',message='REFUNDS_PENDING';
  end if;

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

create function public.record_canceled_match_payment(
 p_actor_auth_user_id uuid,p_actor_session_id uuid,p_request_id uuid,
 p_input_hmac text,p_canonical_version integer,p_hash_key_version integer,
 p_match_id uuid,p_profile_id uuid) returns jsonb language plpgsql volatile security definer
 set search_path='' as $function$
declare
 v_actor_id uuid; v_actor_key text; v_acquired record; v_group_id uuid;
 v_authority text; v_match private.matches%rowtype; v_refund private.match_refunds%rowtype;
 v_player private.match_players%rowtype; v_refund_id uuid; v_result text; v_outcome jsonb;
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
    v_actor_key, 'record_canceled_match_payment', p_request_id, p_input_hmac,
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

  select * into strict v_match from private.matches where id=p_match_id;
  if v_match.canceled_at is null then
    raise exception using errcode='P0001',message='MATCH_NOT_CANCELED';
  end if;
  select * into v_player from private.match_players where match_id=p_match_id and profile_id=p_profile_id;
  if v_player.id is null or v_player.status <> 'starter' then
    raise exception using errcode='P0002',message='PAYMENT_RELATION_NOT_FOUND';
  end if;
  if v_player.paid or exists(select 1 from private.match_refunds where match_player_id=v_player.id and origin='canceled') then
    raise exception using errcode='P0001',message='PAYMENT_ALREADY_RESOLVED';
  end if;
  insert into private.match_refunds(match_player_id,payment_marked_at,payment_marked_by,amount,origin)
  values(v_player.id,clock_timestamp(),v_actor_id,v_match.field_price,'canceled') returning id into v_refund_id;
  v_result:='canceled_payment_recorded';
  v_outcome:=jsonb_build_object('group_id',v_group_id,'match_id',p_match_id,'refund_id',v_refund_id,'logical_result',v_result);
  perform private.complete_group_idempotency(v_actor_key,'record_canceled_match_payment',p_request_id,p_input_hmac,
    p_canonical_version,p_hash_key_version,v_outcome);
  return jsonb_build_object('outcome',v_outcome);
end;
$function$;
revoke all on function public.record_canceled_match_payment(uuid,uuid,uuid,text,integer,integer,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.record_canceled_match_payment(uuid,uuid,uuid,text,integer,integer,uuid,uuid) to service_role;

create function public.mark_refunded(
 p_actor_auth_user_id uuid,p_actor_session_id uuid,p_request_id uuid,
 p_input_hmac text,p_canonical_version integer,p_hash_key_version integer,
 p_match_id uuid,p_refund_id uuid, p_refunded_at timestamptz) returns jsonb language plpgsql volatile security definer
 set search_path='' as $function$
declare
 v_actor_id uuid; v_actor_key text; v_acquired record; v_group_id uuid;
 v_authority text; v_match private.matches%rowtype; v_refund private.match_refunds%rowtype;
 v_player private.match_players%rowtype; v_refund_id uuid; v_result text; v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_match_id is null or p_refund_id is null or p_refunded_at is null then
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
    v_actor_key, 'mark_refunded', p_request_id, p_input_hmac,
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

  select r.* into v_refund from private.match_refunds r join private.match_players p on p.id=r.match_player_id
    where r.id=p_refund_id and p.match_id=p_match_id for no key update of r;
  if not found then raise exception using errcode='P0002',message='REFUND_NOT_FOUND'; end if;
  v_refund_id:=v_refund.id;
  if p_refunded_at < v_refund.created_at or p_refunded_at > clock_timestamp() then
    raise exception using errcode='22023',message='VALIDATION';
  end if;
  if v_refund.status='refunded' then v_result:='refund_unchanged';
  else
    update private.match_refunds set status='refunded',refunded_at=p_refunded_at,
      marked_by=v_actor_id,marked_at=clock_timestamp() where id=p_refund_id;
    v_result:='refund_recorded';
  end if;
  v_outcome:=jsonb_build_object('group_id',v_group_id,'match_id',p_match_id,'refund_id',v_refund_id,'logical_result',v_result);
  perform private.complete_group_idempotency(v_actor_key,'mark_refunded',p_request_id,p_input_hmac,
    p_canonical_version,p_hash_key_version,v_outcome);
  return jsonb_build_object('outcome',v_outcome);
end;
$function$;
revoke all on function public.mark_refunded(uuid,uuid,uuid,text,integer,integer,uuid,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.mark_refunded(uuid,uuid,uuid,text,integer,integer,uuid,uuid,timestamptz) to service_role;

create function public.correct_refund(
 p_actor_auth_user_id uuid,p_actor_session_id uuid,p_request_id uuid,
 p_input_hmac text,p_canonical_version integer,p_hash_key_version integer,
 p_match_id uuid,p_refund_id uuid,p_corrected_at timestamptz) returns jsonb language plpgsql volatile security definer
 set search_path='' as $function$
declare
 v_actor_id uuid; v_actor_key text; v_acquired record; v_group_id uuid;
 v_authority text; v_match private.matches%rowtype; v_refund private.match_refunds%rowtype;
 v_player private.match_players%rowtype; v_refund_id uuid; v_result text; v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_match_id is null or p_refund_id is null or p_corrected_at is null then
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
    v_actor_key, 'correct_refund', p_request_id, p_input_hmac,
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

  select r.* into v_refund from private.match_refunds r join private.match_players p on p.id=r.match_player_id
    where r.id=p_refund_id and p.match_id=p_match_id for no key update of r;
  if not found then raise exception using errcode='P0002',message='REFUND_NOT_FOUND'; end if;
  v_refund_id:=v_refund.id;
  if v_refund.status <> 'refunded' then
    raise exception using errcode='P0002',message='REFUND_NOT_FOUND';
  end if;
  if p_corrected_at < v_refund.created_at or p_corrected_at > clock_timestamp() then
    raise exception using errcode='22023',message='VALIDATION';
  end if;
  if v_refund.refunded_at=p_corrected_at then v_result:='refund_correction_unchanged';
  else
    update private.match_refunds set refunded_at=p_corrected_at,
      marked_by=v_actor_id,marked_at=clock_timestamp() where id=p_refund_id;
    v_result:='refund_corrected';
  end if;
  v_outcome:=jsonb_build_object('group_id',v_group_id,'match_id',p_match_id,'refund_id',v_refund_id,'logical_result',v_result);
  perform private.complete_group_idempotency(v_actor_key,'correct_refund',p_request_id,p_input_hmac,
    p_canonical_version,p_hash_key_version,v_outcome);
  return jsonb_build_object('outcome',v_outcome);
end;
$function$;
revoke all on function public.correct_refund(uuid,uuid,uuid,text,integer,integer,uuid,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.correct_refund(uuid,uuid,uuid,text,integer,integer,uuid,uuid,timestamptz) to service_role;

-- Projeção financeira da organização, inclusive ex-membros; jogador lê só
-- a própria devolução em get_match_roster. Nunca há acesso financeiro fora do grupo.
create function public.get_match_refunds(p_actor_auth_user_id uuid,p_actor_session_id uuid,p_match_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare v_actor uuid; v_group uuid;
begin
 v_actor:=private.require_actor_context(p_actor_auth_user_id,p_actor_session_id,true);
 select group_id into v_group from private.matches where id=p_match_id;
 if v_group is null then raise exception using errcode='P0002',message='NOT_FOUND'; end if;
 if private.match_actor_authority(v_group,v_actor) not in ('owner','organizer') then
   raise exception using errcode='42501',message='NOT_ORGANIZER';
 end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
   'id',r.id,'amount',r.amount,'status',r.status,'created_at',r.created_at,'refunded_at',r.refunded_at,
   'name',case when pr.account_status in ('deletion_pending','deleted') then null else pr.name end,
   'nickname',case when pr.account_status in ('deletion_pending','deleted') then null else pr.nickname end,
   'account_removed',pr.account_status in ('deletion_pending','deleted')) order by r.created_at,r.id)
   from private.match_refunds r join private.match_players p on p.id=r.match_player_id
   join public.profiles pr on pr.id=p.profile_id where p.match_id=p_match_id),'[]'::jsonb);
end;
$function$;
revoke all on function public.get_match_refunds(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_match_refunds(uuid,uuid,uuid) to service_role;

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
    || case when v_manage and v_match.canceled_at is not null then jsonb_build_object(
      'can_record_canceled_payment', player.status='starter' and not exists(
        select 1 from private.match_refunds r where r.match_player_id=player.id and r.origin='canceled')) else '{}'::jsonb end
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
      'refunds', coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'amount',r.amount,
        'status',r.status,'created_at',r.created_at,'refunded_at',r.refunded_at) order by r.created_at,r.id)
        from private.match_refunds r join private.match_players p on p.id=r.match_player_id
        where p.match_id=p_match_id and p.profile_id=v_actor_id),'[]'::jsonb),
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
    set paid = p_paid, payment_marked_by = v_actor_id, payment_marked_at = clock_timestamp()
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

commit;
