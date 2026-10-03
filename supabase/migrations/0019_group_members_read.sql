begin;

-- M2-D44: projeção fresca de quatro campos, sem alterar grants ou RLS de profiles.
create function public.get_group_members(
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
  if v_member.status is distinct from 'active' then
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
revoke all on function public.get_group_members(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.get_group_members(uuid,uuid,uuid) to service_role;
commit;
