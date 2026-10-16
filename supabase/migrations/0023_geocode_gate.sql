-- Fatia 0023: busca de endereço dos Rachas, modo apresentação (PR E,
-- "Rachas: usabilidade", decisões humanas de 17/10/2026). O app nunca chama o
-- OpenStreetMap: pede à Edge (operação search_address do gateway groups), que
-- consulta o Nominatim. Esta migration guarda somente o portão dessa saída:
-- a sessão do ator, a autoridade de quem cria racha e o limite de uma
-- requisição por segundo para o app inteiro, exigido pela política de uso do
-- Nominatim. Nenhum texto buscado, resultado, coordenada ou ator é gravado.
begin;

-- ---------------------------------------------------------------------------
-- Agenda compartilhada de saídas
-- ---------------------------------------------------------------------------
-- Uma linha só: o último horário de saída reservado. Todas as instâncias da
-- Edge disputam a mesma linha, então o limite vale para o app inteiro, e não
-- por instância. Tabela privada de serviço, sem RLS e sem grant (docs/14
-- §5.2); só public.geocode_gate a escreve.
--
-- Revisão do #72 (P1): espaçar concessões não basta, porque a Edge chama o
-- Nominatim depois de receber a resposta, com atraso arbitrário. Por isso o
-- portão reserva horários espaçados por 1,25 s e devolve quanto falta até o
-- horário reservado. A Edge só chama dentro de uma janela de 250 ms a partir
-- dele, medida no próprio relógio (supabase/functions/_shared/geocode.ts):
-- quem chega atrasado desiste e pede outro horário. Cada saída fica então em
-- [horário, horário + 250 ms], e duas saídas distam no mínimo
-- 1,25 s − 250 ms = 1 s, em qualquer instância.
create table private.geocode_throttle (
  id           boolean primary key default true check (id),
  last_slot_at timestamptz not null default '-infinity'
);

comment on table private.geocode_throttle is
  'Uma linha: último horário reservado para uma busca no Nominatim (horários a 1,25 s; saída em até 250 ms do horário). Sem texto, ator ou resultado.';

insert into private.geocode_throttle default values;

-- ---------------------------------------------------------------------------
-- geocode_gate(actor, session, spend)
-- ---------------------------------------------------------------------------
-- Chamada pela Edge antes de cada busca, inclusive quando a resposta sai do
-- cache curto da Edge (p_spend = false, devolve 0): sessão revogada recusada
-- (UNAUTHENTICATED), perfil travado e revalidado como nas leituras, e só dono
-- ou organizador ativo de grupo não arquivado busca (NOT_ORGANIZER), porque
-- só essas pessoas criam racha. Com p_spend = true, reserva o próximo
-- horário, max(último + 1,25 s, agora), e devolve os milissegundos até ele;
-- se esse horário estiver a mais de 3 s, não reserva e devolve null (a Edge
-- responde RATE_LIMITED). A trava da linha serializa as instâncias: cada
-- reserva lê a anterior já commitada.
create function public.geocode_gate(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_spend boolean
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor uuid;
  v_now timestamptz;
  v_slot timestamptz;
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
    return 0;
  end if;
  perform 1 from private.geocode_throttle where id for no key update;
  v_now := clock_timestamp();
  select greatest(last_slot_at + interval '1250 milliseconds', v_now) into v_slot
  from private.geocode_throttle where id;
  if v_slot > v_now + interval '3 seconds' then
    return null;
  end if;
  update private.geocode_throttle set last_slot_at = v_slot where id;
  return ceil(extract(epoch from (v_slot - v_now)) * 1000)::integer;
end;
$function$;

revoke all on function public.geocode_gate(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.geocode_gate(uuid, uuid, boolean) to service_role;

commit;
