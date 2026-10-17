-- Fatia 0024: espaçamento da busca de endereço com ida e volta real (PR F,
-- "Ajustes do teste do César", 17/10/2026). A 0023 reservava horários a
-- 1250 ms e a Edge só chamava o Nominatim até 250 ms depois do horário,
-- medido no próprio relógio: com a ida e volta da RPC acima de 250 ms, comum
-- no servidor real, a janela ficava vazia em toda tentativa e a busca
-- terminava em RATE_LIMITED.
--
-- Agora os horários ficam a 2000 ms e a RPC devolve também esse espaçamento.
-- A Edge chama dentro de [horário, horário + T], com T = espaçamento − 1000 ms
-- = 1000 ms, o que aceita ida e volta de até 999 ms. Duas saídas distam no
-- mínimo 2000 − 1000 = 1000 ms, em qualquer instância.
--
-- geocode_gate (0023) sai: a Edge desta fatia chama geocode_reserve, e uma
-- Edge anterior, sem o portão, falha fechada. Qualquer ordem de deploy entre
-- esta migration e a função mantém o espaçamento; no intervalo a busca fica
-- indisponível, nunca rápida demais. A tabela e a linha da 0023 continuam.
begin;

drop function public.geocode_gate(uuid, uuid, boolean);

comment on table private.geocode_throttle is
  'Uma linha: último horário reservado para uma busca no Nominatim (horários a 2 s; saída em até 1 s do horário). Sem texto, ator ou resultado.';

-- ---------------------------------------------------------------------------
-- geocode_reserve(actor, session, spend)
-- ---------------------------------------------------------------------------
-- Mesmas checagens do portão da 0023: sessão revogada recusada
-- (UNAUTHENTICATED), perfil travado e revalidado, só dono ou organizador
-- ativo de grupo não arquivado (NOT_ORGANIZER). Com p_spend = false (resposta
-- do cache da Edge) devolve {"wait_ms": 0, "spacing_ms": 2000} sem tocar na
-- agenda. Com p_spend = true reserva max(último + 2000 ms, agora) e devolve
-- os milissegundos até ele; se o horário estiver a mais de 6 s, não reserva e
-- devolve wait_ms null (a Edge responde RATE_LIMITED).
create function public.geocode_reserve(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_spend boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_now timestamptz;
  v_slot timestamptz;
  v_spacing constant interval := interval '2000 milliseconds';
  v_horizon constant interval := interval '6 seconds';
begin
  if p_spend is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id);
  perform 1 from public.profiles as profile where profile.id = v_actor for no key update;
  v_actor := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id);
  if not exists (
    select 1
    from public.group_members as membership
    join public.groups as grp on grp.id = membership.group_id and grp.archived_at is null
    where membership.profile_id = v_actor and membership.status = 'active'
      and (membership.role = 'organizer' or grp.owner_id = v_actor)
  ) then
    raise exception using errcode = '42501', message = 'NOT_ORGANIZER';
  end if;
  if not p_spend then
    return jsonb_build_object('wait_ms', 0, 'spacing_ms', 2000);
  end if;
  perform 1 from private.geocode_throttle where id for no key update;
  v_now := clock_timestamp();
  select greatest(last_slot_at + v_spacing, v_now) into v_slot
  from private.geocode_throttle where id;
  if v_slot > v_now + v_horizon then
    return jsonb_build_object('wait_ms', null, 'spacing_ms', 2000);
  end if;
  update private.geocode_throttle set last_slot_at = v_slot where id;
  return jsonb_build_object(
    'wait_ms', ceil(extract(epoch from (v_slot - v_now)) * 1000)::integer,
    'spacing_ms', 2000);
end;
$function$;

revoke all on function public.geocode_reserve(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.geocode_reserve(uuid, uuid, boolean) to service_role;

commit;
