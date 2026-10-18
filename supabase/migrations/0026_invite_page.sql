-- Fatia 0026: página do convite (PR D, itens 3 e 4 do feedback do César,
-- decisão humana de 18/10/2026). Quem tem um código, QR ou link vê o grupo
-- antes de pedir para entrar: nome, contagem de membros ativos, nome de
-- exibição do dono e o próprio estado no grupo.
--
-- A prévia continua sendo preview_group_by_code / preview_group_by_invite,
-- chamadas só pela Edge groups com o contexto do autor e depois do mesmo
-- limitador de tentativas da 0017 (check_and_debit_invite_attempt). As
-- assinaturas públicas, os grants e a ordem de locks (perfil → grupo →
-- membership própria → convite, M2-D13) não mudam; muda só o corpo privado.
--
-- Mudanças de contrato (docs/13 §5.0.2, docs/25 §5.3, docs/11 tela 12):
--   * convite inexistente, revogado, expirado ou esgotado dá a mesma resposta,
--     CODE_INVALID: a prévia não revela se o código existiu nem se o grupo
--     existe. O resgate (join_by_code / join_by_invite) mantém a M2-D42;
--   * com código vivo, devolve exatamente
--       { group_name, member_count, owner_name, viewer_status, group_id,
--         refusal }
--     sem lista de membros, ids de perfil, e-mail ou dado de racha.
--     group_id só sai para quem já é membro ativo (que já o lê pelas próprias
--     memberships), para abrir o grupo; nos demais casos é null;
--   * grupo cheio e cota pessoal deixam de ser erro da prévia e voltam em
--     refusal ('GROUP_FULL' | 'GROUP_LIMIT'), para a página mostrar o grupo
--     com a mensagem atual no lugar do botão. Arquivado e suspenso continuam
--     erro, sem página.
begin;

create or replace function private.preview_group_invite(
  p_actor_auth_user_id uuid, p_actor_session_id uuid,
  p_invite_id uuid, p_token_version smallint, p_token_digest text,
  p_code_digest text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
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
  v_actor_id := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id);
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
  if not found then raise exception using errcode='22023', message='CODE_INVALID'; end if;
  perform 1 from public.profiles where id=v_actor_id for no key update;
  select * into v_group from public.groups where id=v_invite.group_id for no key update;
  select * into v_membership from public.group_members
    where group_id=v_invite.group_id and profile_id=v_actor_id for no key update;
  select * into v_invite from public.group_invites where id=v_invite.id for no key update;
  perform private.require_group_actor_after_locks(v_actor_id,p_actor_auth_user_id,p_actor_session_id);
  -- Material divergente e convite terminal têm a mesma resposta: nenhuma
  -- causa, nenhum grupo. Só um convite vivo chega ao estado do grupo.
  if (p_code_digest is not null and v_invite.code_digest is distinct from p_code_digest)
     or (p_code_digest is null and (v_invite.token_version is distinct from p_token_version
         or v_invite.token_digest is distinct from p_token_digest))
     or v_invite.revoked_at is not null
     or v_invite.expires_at <= now()
     or v_invite.used_count >= v_invite.max_uses then
    raise exception using errcode='22023', message='CODE_INVALID';
  end if;
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
    'refusal', v_refusal);
end;
$function$;
revoke all on function private.preview_group_invite(uuid,uuid,uuid,smallint,text,text)
  from public, anon, authenticated, service_role;

-- As wrappers públicas da 0017 continuam as mesmas; a reafirmação dos grants
-- deixa a fronteira explícita nesta migration.
revoke all on function public.preview_group_by_code(uuid,uuid,text)
  from public,anon,authenticated,service_role;
revoke all on function public.preview_group_by_invite(uuid,uuid,uuid,smallint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.preview_group_by_code(uuid,uuid,text) to service_role;
grant execute on function public.preview_group_by_invite(uuid,uuid,uuid,smallint,text) to service_role;

commit;
