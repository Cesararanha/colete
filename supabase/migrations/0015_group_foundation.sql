begin;

-- M2, fatia 1: fundação de grupos, isolamento por tabela e extensão da saga de
-- exclusão e do export para o novo domínio.
-- Fontes: docs/25-plano-m2.md §2 e §3 (normativo desta fatia, decisões M2-D2,
-- M2-D7 a M2-D10); docs/10-schema-db.md §3, §6 (seleção determinística do
-- organizador elegível), §9 e §11; docs/13-contratos-funcoes.md §0, §2.11 e
-- §5.3; docs/14-convencoes-app.md §5.2; docs/17-mapa-dados-lgpd.md §2; e
-- docs/22-plano-m1-b.md §5.1.
--
-- Esta migration é a fonte textual canônica de toda função que ela redefine.
-- Em particular, public.delete_account não tinha texto literal da versão viva
-- em migration nenhuma: a 0013 a reescreveu dinamicamente a partir da 0012.
-- O texto abaixo parte do pg_get_functiondef do banco recriado até a 0014, não
-- da 0012, e o harness db:test:groups compara o corpo vivo com este arquivo.

-- ---------------------------------------------------------------------------
-- Limites normativos
-- ---------------------------------------------------------------------------
-- docs/25 §3.1: os três limites vivem aqui e nas constraints. São valores de
-- contrato (docs/10 §3), não calibragem livre: só mudam por migration que
-- também atualize o contrato. A unidade de cada um é tipada, e o vocabulário
-- fechado de unidades cresce de forma append-only, como na 0004 e na 0011.

alter table private.app_limits
  drop constraint app_limits_unit_check;

alter table private.app_limits
  add constraint app_limits_unit_check
  check (unit in ('bytes', 'seconds', 'attempts', 'milliseconds', 'effects',
                  'groups', 'members', 'uses'));

insert into private.app_limits (limit_key, limit_value, unit, notes) values
  ('max_active_groups_per_profile', 5, 'groups',
   'Memberships active em grupos não arquivados por perfil, grupo próprio incluído; '
   'pedido pending não conta. Valor normativo de docs/10 §3, não calibragem.'),
  ('max_group_capacity', 100, 'members',
   'Memberships pending + active por grupo. Valor normativo de docs/10 §3, não calibragem.'),
  ('group_invite_default_max_uses', 100, 'uses',
   'Usos de um convite de grupo; precisa coincidir com o default literal de '
   'group_invites.max_uses. Valor normativo de docs/10 §3, não calibragem.');

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------
-- docs/10 §3. As três nascem juntas porque FKs, owner derivado, capacidade e
-- isolamento precisam ser provados como um grafo (docs/25 §2).

create table public.groups (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  photo_url          text,
  owner_id           uuid not null references public.profiles (id),
  monthly_enabled    boolean not null default false,
  ratings_visibility text not null default 'private'
                     check (ratings_visibility in ('private', 'members')),
  suspended_at       timestamptz,
  archived_at        timestamptz,
  created_at         timestamptz not null default now()
);

comment on table public.groups is
  'Grupo. owner_id é a única fonte de titularidade; photo_url é localizador interno de Storage e nunca é lido por cliente.';

create table public.group_members (
  group_id          uuid not null references public.groups (id),
  profile_id        uuid not null references public.profiles (id),
  role              text not null default 'player' check (role in ('organizer', 'player')),
  status            text not null default 'pending'
                    check (status in ('pending', 'active', 'removed')),
  is_monthly        boolean not null default false,
  joined_at         timestamptz not null default now(),
  last_requested_at timestamptz not null default now(),
  removed_at        timestamptz,
  removal_count     int not null default 0 check (removal_count >= 0),
  primary key (group_id, profile_id),
  -- docs/10 §3 e docs/25 M2-D9: removed sempre com removed_at preenchido; a
  -- reentrada zera removed_at. Não há terceiro estado para o instante.
  constraint group_members_removed_at_check
    check ((status = 'removed') = (removed_at is not null))
);

comment on table public.group_members is
  'Membership. Não existe role owner: o dono deriva de groups.owner_id.';

create table public.group_invites (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references public.groups (id),
  token_version smallint not null default 1 check (token_version > 0),
  public_nonce  bytea not null check (octet_length(public_nonce) = 16),
  token_digest  text unique not null,
  created_by    uuid not null references public.profiles (id),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  max_uses      int not null default 100 check (max_uses > 0),
  used_count    int not null default 0 check (used_count between 0 and max_uses),
  created_at    timestamptz not null default now()
);

comment on table public.group_invites is
  'Convite de grupo. token_digest e public_nonce nunca são concedidos a cliente; created_by é histórico, não autoridade (M2-D4).';

-- Índices cobrem as leituras previstas; nenhum substitui os locks das RPCs.
create index groups_owner_id_idx on public.groups (owner_id);
create index group_members_profile_status_idx on public.group_members (profile_id, status);
create index group_members_open_by_group_idx on public.group_members (group_id)
  where status in ('pending', 'active');
create index group_invites_group_id_idx on public.group_invites (group_id);

-- ---------------------------------------------------------------------------
-- Titularidade derivada: trigger constraint diferido
-- ---------------------------------------------------------------------------
-- docs/10 §3 e docs/25 §3.1: no commit, todo grupo não arquivado precisa de
-- membership active para owner_id. O trigger relê o estado corrente pelo
-- group_id, porque vários eventos da mesma transação são julgados todos no
-- commit, contra o estado final. Ele é security definer porque groups e
-- group_members têm RLS forçada: executado por um papel sujeito a RLS, leria
-- zero linhas e falharia aberto (docs/14 §5.2). O dono é postgres, que tem
-- BYPASSRLS.

create function private.enforce_group_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_group_ids uuid[];
begin
  if tg_table_name = 'groups' then
    v_group_ids := array[new.id];
  elsif tg_op = 'DELETE' then
    v_group_ids := array[old.group_id];
  else
    v_group_ids := array[old.group_id, new.group_id];
  end if;

  if exists (
    select 1
    from public.groups as grp
    where grp.id = any(v_group_ids)
      and grp.archived_at is null
      and not exists (
        select 1
        from public.group_members as membership
        where membership.group_id = grp.id
          and membership.profile_id = grp.owner_id
          and membership.status = 'active'
      )
  ) then
    raise exception using errcode = '23514', message = 'GROUP_OWNER_MEMBERSHIP_REQUIRED';
  end if;
  return null;
end;
$function$;

create constraint trigger groups_owner_membership
after insert or update of owner_id, archived_at on public.groups
deferrable initially deferred
for each row
execute function private.enforce_group_owner_membership();

-- O plano exige update de status e delete. As colunas da chave também entram:
-- mudar group_id ou profile_id da linha do dono o retiraria do grupo do mesmo
-- modo, por isso o antigo e o novo group_id são reavaliados.
create constraint trigger group_members_owner_membership
after update of status, group_id, profile_id or delete on public.group_members
deferrable initially deferred
for each row
execute function private.enforce_group_owner_membership();

revoke all on function private.enforce_group_owner_membership()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Isolamento: RLS forçada, privilégios revogados antes das policies
-- ---------------------------------------------------------------------------
-- docs/25 §3.2 e docs/10 §11. RLS filtra linhas, não colunas: por isso os
-- grants são por coluna. Nenhum papel recebe insert, update ou delete; toda
-- escrita virá por RPC. service_role não recebe nada: a 0004 revogou e os
-- defaults cobrem tabelas novas, o que a suíte prova.

alter table public.groups enable row level security;
alter table public.groups force row level security;
alter table public.group_members enable row level security;
alter table public.group_members force row level security;
alter table public.group_invites enable row level security;
alter table public.group_invites force row level security;

revoke all on table public.groups from public, anon, authenticated, service_role;
revoke all on table public.group_members from public, anon, authenticated, service_role;
revoke all on table public.group_invites from public, anon, authenticated, service_role;

-- Perfil do chamador para leitura de grupo. Conta deletion_pending|deleted não
-- tem autoridade de domínio (docs/13 §5.3), então não resolve perfil aqui.
-- Conta suspensa conserva leitura própria (docs/10 §11).
create function private.current_group_profile_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select profile.id
  from public.profiles as profile
  where profile.auth_user_id = auth.uid()
    and profile.account_status not in ('deletion_pending', 'deleted');
$function$;

-- Membership active do chamador em grupo não arquivado. security definer para
-- que a policy de group_members possa consultá-la sem recursão de RLS.
create function private.is_active_group_member(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.group_members as membership
    join public.groups as grp on grp.id = membership.group_id
    where membership.group_id = p_group_id
      and membership.profile_id = (select private.current_group_profile_id())
      and membership.status = 'active'
      and grp.archived_at is null
  );
$function$;

-- Autoridade de leitura de convite (M2-D4): dono ou organizador com membership
-- active no momento da leitura. created_by não participa.
create function private.can_read_group_invites(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.group_members as membership
    join public.groups as grp on grp.id = membership.group_id
    where membership.group_id = p_group_id
      and membership.profile_id = (select private.current_group_profile_id())
      and membership.status = 'active'
      and grp.archived_at is null
      and (membership.role = 'organizer' or grp.owner_id = membership.profile_id)
  );
$function$;

revoke all on function private.current_group_profile_id()
  from public, anon, authenticated, service_role;
revoke all on function private.is_active_group_member(uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.can_read_group_invites(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.current_group_profile_id() to authenticated;
grant execute on function private.is_active_group_member(uuid) to authenticated;
grant execute on function private.can_read_group_invites(uuid) to authenticated;

-- groups: somente as colunas que as telas 10, 11, 17 e 25 exibem. photo_url
-- fica de fora (localizador interno, docs/25 §3.3); archived_at e created_at
-- também, porque a policy não devolve grupo arquivado e nenhuma dessas telas
-- mostra a data de criação.
grant select (id, name, owner_id, monthly_enabled, ratings_visibility, suspended_at)
  on public.groups to authenticated;

create policy groups_select_active_member
  on public.groups
  for select
  to authenticated
  using (archived_at is null and private.is_active_group_member(id));

-- group_members: membro ativo lê as memberships do próprio grupo; pendente lê
-- somente a própria linha. removed_at e removal_count ficam de fora: nenhuma
-- tela os exibe, e a reentrada chega ao cliente pelo outcome da RPC.
grant select (group_id, profile_id, role, status, is_monthly, joined_at, last_requested_at)
  on public.group_members to authenticated;

create policy group_members_select_visible
  on public.group_members
  for select
  to authenticated
  using (
    (profile_id = (select private.current_group_profile_id()) and status = 'pending')
    or private.is_active_group_member(group_id)
  );

-- group_invites: somente a projeção administrativa allowlisted de docs/25 §3.2.
-- token_digest, public_nonce, token_version e created_by nunca são concedidos.
grant select (id, group_id, expires_at, revoked_at, max_uses, used_count, created_at)
  on public.group_invites to authenticated;

create policy group_invites_select_authority
  on public.group_invites
  for select
  to authenticated
  using (private.can_read_group_invites(group_id));

-- ---------------------------------------------------------------------------
-- Storage da foto de grupo
-- ---------------------------------------------------------------------------
-- docs/25 §3.3: bucket privado, sem policy de cliente. Nenhum upload, rota de
-- leitura ou limite de tamanho/MIME nasce aqui: o produtor da foto é outra
-- fatia, que publica o contrato em docs/13 antes. service_role ignora RLS de
-- Storage por desenho da plataforma.

insert into storage.buckets (id, name, public)
values ('group-photos', 'group-photos', false);

-- ---------------------------------------------------------------------------
-- Extensão da exclusão (docs/25 §3.3)
-- ---------------------------------------------------------------------------

-- Organizadores elegíveis para receber a titularidade de grupos do titular.
-- Elegível é perfil active, membership active, papel organizer, no mesmo grupo
-- e diferente de quem sai (docs/10 §6). Sem lock: delete_account a usa para
-- resolver os candidatos antes do primeiro lock de perfil, e o guard a usa de
-- novo, sob lock, para revalidar.
create function private.group_deletion_candidates(p_profile_id uuid, p_group_ids uuid[])
returns table (group_id uuid, profile_id uuid, joined_at timestamptz)
language sql
stable
set search_path = ''
as $function$
  select membership.group_id, membership.profile_id, membership.joined_at
  from public.group_members as membership
  join public.profiles as candidate on candidate.id = membership.profile_id
  where membership.group_id = any(p_group_ids)
    and membership.profile_id <> p_profile_id
    and membership.status = 'active'
    and membership.role = 'organizer'
    and candidate.account_status = 'active';
$function$;

revoke all on function private.group_deletion_candidates(uuid, uuid[])
  from public, anon, authenticated, service_role;

-- O guard deixa de operar sobre conjunto vazio. A assinatura muda porque ele
-- recebe de delete_account os grupos e os candidatos já resolvidos e travados;
-- a antiga é removida para não restar overload morto com o mesmo nome.
drop function private.require_financial_deletion_substitute(uuid);

-- volatile é obrigatório: em função stable o plpgsql executa por SPI em modo
-- somente leitura, e select … for no key update ou update abortam em execução.
create function private.require_financial_deletion_substitute(
  p_profile_id uuid,
  p_group_ids uuid[],
  p_candidate_ids uuid[]
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_group_id uuid;
  v_successor_id uuid;
begin
  if p_profile_id is null or p_group_ids is null or p_candidate_ids is null
     or not exists (select 1 from public.profiles where id = p_profile_id) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  -- O guard nunca opera sobre linha que não travou. delete_account já travou
  -- estes grupos em ordem crescente depois dos perfis; a nova aquisição, na
  -- mesma ordem, não espera e não inverte a ordem global. FOR NO KEY UPDATE
  -- (M2-D13): o guard altera owner_id e archived_at, que não são chave, e
  -- nunca apaga o grupo.
  perform 1
  from public.groups as grp
  where grp.id = any(p_group_ids)
  order by grp.id
  for no key update;

  -- Revalidação sob lock (docs/25 §3.3, caso 1). Qualquer divergência do
  -- conjunto resolvido sem lock aborta: nunca se trava perfil depois de grupo,
  -- e o trigger de owner nunca é quem decide.
  if exists (
       select 1 from public.groups as grp
       where grp.owner_id = p_profile_id and grp.archived_at is null
         and not (grp.id = any(p_group_ids)))
     or exists (
       select 1 from public.groups as grp
       where grp.id = any(p_group_ids)
         and (grp.owner_id <> p_profile_id or grp.archived_at is not null))
     or array(
       select distinct candidate.profile_id
       from private.group_deletion_candidates(p_profile_id, p_group_ids) as candidate
       order by candidate.profile_id)
       is distinct from array(
       select distinct candidate_id
       from unnest(p_candidate_ids) as candidate_id
       order by candidate_id) then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;

  for v_group_id in
    select grp.id from public.groups as grp
    where grp.id = any(p_group_ids)
    order by grp.id
  loop
    -- Caso 2 e M2-D8: menor (joined_at, profile_id em bytes). uuid compara por
    -- bytes. A transferência vale em grupo suspenso e não toca suspended_at
    -- (M2-D10); no M2 não emite N28 nem trilha (M2-D7).
    select candidate.profile_id into v_successor_id
    from private.group_deletion_candidates(p_profile_id, array[v_group_id]) as candidate
    order by candidate.joined_at, candidate.profile_id
    limit 1;

    if v_successor_id is not null then
      update public.groups
      set owner_id = v_successor_id
      where id = v_group_id;
      update public.group_members
      set status = 'removed', removed_at = now()
      where group_id = v_group_id and profile_id = p_profile_id
        and status in ('pending', 'active');
    elsif exists (
      select 1 from public.group_members as membership
      where membership.group_id = v_group_id
        and membership.profile_id <> p_profile_id
        and membership.status = 'active'
    ) then
      -- Caso 3: há outro membro ativo e nenhum organizador ativo elegível. O
      -- guard nunca promove pending nem player.
      raise exception using errcode = 'P0001', message = 'FINANCIAL_SUBSTITUTE_REQUIRED';
    else
      -- Caso 4 e M2-D9: grupo solo, ainda que com pedidos pendentes. Arquiva e
      -- passa o owner e cada pendente a removed; removal_count não muda, porque
      -- só a reentrada o incrementa (docs/10 §3).
      update public.groups
      set archived_at = now()
      where id = v_group_id;
      update public.group_members
      set status = 'removed', removed_at = now()
      where group_id = v_group_id and status in ('pending', 'active');
    end if;
  end loop;
  -- Caso 5: a extensão financeira do M5 consulta casos antes do arquivamento
  -- e conserva esta mesma chamada em delete_account.
end;
$function$;

revoke all on function private.require_financial_deletion_substitute(uuid, uuid[], uuid[])
  from public, anon, authenticated, service_role;

-- Pedido de exclusão dono da foto de um grupo. A relação é
-- group_photo → grupo → owner → deletion_request, e a chave do efeito precisa
-- ser a da ocasião desta saga. Grupo transferido tem outro dono e não casa:
-- sua foto continua com o grupo vivo.
create function private.group_photo_deletion_request(p_group_id uuid, p_dedupe_key text)
returns uuid
language sql
stable
set search_path = ''
as $function$
  select request.id
  from private.deletion_requests as request
  join public.groups as grp on grp.owner_id = request.profile_id
  where grp.id = p_group_id
    and grp.archived_at is not null
    and p_dedupe_key = 'delete_storage_object:group_photo:' || grp.id::text
                       || ':' || request.id::text;
$function$;

revoke all on function private.group_photo_deletion_request(uuid, text)
  from public, anon, authenticated, service_role;

-- Ordem de locks (docs/25 §2): idempotência → perfis do titular e dos
-- candidatos em bytes crescentes → grupos em ordem crescente → memberships →
-- exports → pedido → efeitos. Os candidatos e os grupos próprios são
-- resolvidos sem lock entre a idempotência e o primeiro lock de perfil.
--
-- Modo das travas (M2-D13): FOR NO KEY UPDATE em perfis, grupos e
-- memberships, porque esta transação não apaga nenhuma dessas linhas nem
-- altera coluna de chave. O INSERT da idempotência executa a FK
-- idempotency_records.actor_id → profiles, que toma FOR KEY SHARE no perfil
-- do titular antes dos locks ordenados e o segura até o commit. FOR UPDATE
-- conflita com FOR KEY SHARE: dois titulares candidatos um do outro, cada um
-- com o FOR KEY SHARE do próprio perfil, esperariam um pelo outro no lock de
-- perfis (40P01). FOR NO KEY UPDATE é compatível com FOR KEY SHARE e continua
-- serializando duas exclusões entre si e a exclusão com o build do export.
create or replace function public.delete_account(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_profile_id uuid;
  v_profile public.profiles%rowtype;
  v_actor_key text;
  v_acquired record;
  v_request_id uuid;
  v_lifetime_seconds bigint;
  v_outcome jsonb;
  v_owned_group_ids uuid[];
  v_candidate_ids uuid[];
  v_locked_group_ids uuid[];
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;

  select id into v_profile_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if v_profile_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_profile_id::text;

  select * into v_acquired
  from private.acquire_delete_account_idempotency(
    v_actor_key, p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);
  if not v_acquired.acquired then
    return jsonb_build_object(
      'outcome', v_acquired.outcome,
      'current', private.deletion_request_projection(v_profile_id)
    );
  end if;

  -- Resolução sem lock (docs/25 §2 e §3.3, caso 1): grupos próprios não
  -- arquivados e organizadores candidatos. A leitura só descobre as chaves;
  -- o guard revalida tudo sob lock.
  v_owned_group_ids := array(
    select grp.id from public.groups as grp
    where grp.owner_id = v_profile_id and grp.archived_at is null
    order by grp.id);
  v_candidate_ids := array(
    select distinct candidate.profile_id
    from private.group_deletion_candidates(v_profile_id, v_owned_group_ids) as candidate
    order by candidate.profile_id);

  -- Lock order: idempotência, depois os perfis do titular e dos candidatos em
  -- bytes crescentes, antes do primeiro grupo. A detecção de saga anterior é
  -- a primeira decisão sob esse lock, antes do ponto de extensão financeiro.
  perform 1
  from public.profiles as profile
  where profile.id = any(array_append(v_candidate_ids, v_profile_id))
  order by profile.id
  for no key update;

  select profile.* into v_profile
  from public.profiles as profile
  where profile.id = v_profile_id and profile.auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;
  if exists (select 1 from private.deletion_requests where profile_id = v_profile_id) then
    raise exception using errcode = 'P0001', message = 'DELETION_ALREADY_PENDING';
  end if;
  if private.is_actor_session_revoked(p_actor_session_id) then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  if v_profile.account_status not in ('active', 'suspended', 'banned') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  -- Grupos: os próprios resolvidos acima e os das demais memberships
  -- pending|active do titular, em ordem crescente. Com o perfil do titular
  -- travado, nenhuma dessas memberships pode passar a active nem surgir.
  v_locked_group_ids := array(
    select locked.group_id
    from (
      select unnest(v_owned_group_ids) as group_id
      union
      select membership.group_id
      from public.group_members as membership
      where membership.profile_id = v_profile_id
        and membership.status in ('pending', 'active')
    ) as locked
    order by locked.group_id);

  perform 1
  from public.groups as grp
  where grp.id = any(v_locked_group_ids)
  order by grp.id
  for no key update;

  -- Memberships: todas as dos grupos próprios e as do titular nos demais.
  perform 1
  from public.group_members as membership
  where membership.group_id = any(v_locked_group_ids)
    and (membership.group_id = any(v_owned_group_ids)
         or membership.profile_id = v_profile_id)
  order by membership.group_id, membership.profile_id
  for no key update;

  perform private.require_financial_deletion_substitute(
    v_profile_id, v_owned_group_ids, v_candidate_ids);

  -- Toda membership não-dona do titular sai no mesmo commit: a capacidade
  -- conta pending + active, e um perfil desidentificado não pode ocupar vaga
  -- para sempre (docs/25 §3.3).
  update public.group_members
  set status = 'removed', removed_at = now()
  where profile_id = v_profile_id and status in ('pending', 'active');

  -- No object may later become ready. Rows without an object terminate as
  -- failed/cancelled; every existing object becomes cleanup_pending and gets a
  -- deduplicated purge intent.
  update private.data_exports
  set status = 'failed'
  where profile_id = v_profile_id and status in ('queued', 'building');

  update private.data_exports
  set status = 'cleanup_pending'
  where profile_id = v_profile_id and storage_path is not null
    and status in ('ready', 'downloaded', 'cleanup_pending');

  insert into private.deletion_requests (profile_id, auth_user_id)
  values (v_profile_id, p_actor_auth_user_id)
  returning id into v_request_id;

  insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
  select 'delete_data_export', 'data_export', export.id,
         'delete_data_export:' || export.id::text || ':' || v_request_id::text
  from private.data_exports as export
  where export.profile_id = v_profile_id and export.storage_path is not null
  on conflict (dedupe_key) do nothing;

  if v_profile.photo_url is not null then
    insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
    values ('delete_storage_object', 'profile_avatar', v_profile_id,
            'delete_storage_object:profile_avatar:' || v_profile_id::text)
    on conflict (dedupe_key) do nothing;
  end if;

  -- Foto de grupo arquivado do titular: chave por ocasião da saga, como a do
  -- export e diferente da do avatar. O path nunca entra na chave.
  insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
  select 'delete_storage_object', 'group_photo', grp.id,
         'delete_storage_object:group_photo:' || grp.id::text || ':' || v_request_id::text
  from public.groups as grp
  where grp.owner_id = v_profile_id and grp.archived_at is not null
    and grp.photo_url is not null
  on conflict (dedupe_key) do nothing;

  -- Enqueueing is not advancing the saga. If there is no known Storage work,
  -- create the Auth intent now so the worker has something to acquire, while
  -- the request itself remains in the contractual initial state.
  if v_profile.photo_url is null and not exists (
    select 1 from private.data_exports
    where profile_id = v_profile_id and storage_path is not null
  ) and not exists (
    select 1 from public.groups
    where owner_id = v_profile_id and archived_at is not null and photo_url is not null
  ) then
    insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
    values ('delete_auth_user', 'deletion_request', v_request_id,
            'delete_auth_user:' || v_request_id::text)
    on conflict (dedupe_key) do nothing;
  end if;

  select limit_value into v_lifetime_seconds
  from private.app_limits where limit_key = 'auth_session_max_lifetime_seconds';
  if v_lifetime_seconds is null or v_lifetime_seconds <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  insert into private.revoked_auth_sessions (session_id, profile_id, expires_at)
  values (p_actor_session_id, v_profile_id,
          now() + make_interval(secs => v_lifetime_seconds::integer))
  on conflict (session_id) do nothing;

  update public.profiles
  set account_status = 'deletion_pending', status_changed_at = now()
  where id = v_profile_id;

  v_outcome := jsonb_build_object(
    'deletion_request_id', v_request_id::text,
    'logical_result', 'deletion_requested');
  perform private.complete_delete_account_idempotency(
    v_actor_key, p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);

  return jsonb_build_object(
    'outcome', v_outcome,
    'current', jsonb_build_object(
      'id', v_request_id,
      'status', 'requested',
      'requested_at', (select requested_at from private.deletion_requests where id = v_request_id),
      'completed_at', null,
      'has_operational_failure', false
    )
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- M2-D14: funções do M1 que gravam idempotência e travam o perfil do ator
-- ---------------------------------------------------------------------------
-- O INSERT do registro de idempotência executa a FK actor_id → profiles e
-- segura FOR KEY SHARE no perfil do ator até o commit. Estas duas funções
-- travavam depois o mesmo perfil FOR UPDATE, que conflita com FOR KEY SHARE:
-- duas chamadas concorrentes do mesmo ator (dois cliques, duas abas), cada uma
-- com o próprio FOR KEY SHARE, esperavam uma pela outra no upgrade e terminavam
-- em 40P01. A auditoria pelo banco vivo depois do db:reset (docs/26) encontrou
-- somente estas duas: accept_policies, complete_profile e
-- revoke_current_session gravam idempotência sem travar o perfil, e
-- finalize_deletion trava o perfil sem gravar idempotência. Os corpos partem do
-- pg_get_functiondef do banco recriado até a 0014; a única mudança de
-- comportamento é o modo da trava. create or replace preserva a ACL da 0006 e
-- da 0013.

create or replace function public.update_profile(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_profile_id uuid;
  v_actor_key text;
  v_acquired record;
  v_patch jsonb;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);

  v_profile_id := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id);
  v_actor_key := 'profile:' || v_profile_id::text;

  select * into v_acquired
  from private.acquire_idempotency(
    v_actor_key, 'update_profile', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  -- The replay path runs before the policy gate on purpose: a mandatory version
  -- published after the original commit must not turn an already-committed
  -- mutation into an error on retry.
  if not v_acquired.acquired then
    return jsonb_build_object(
      'outcome', v_acquired.outcome,
      'current', private.profile_projection(v_profile_id));
  end if;

  perform private.require_policies_accepted(v_profile_id);

  v_patch := private.validate_profile_patch(p_patch, false);

  -- Lock order of docs/10 section 1: idempotency, then profiles.
  -- M2-D14: FOR NO KEY UPDATE. A idempotência acima já segura FOR KEY SHARE
  -- neste perfil pela FK actor_id; FOR UPDATE faria duas chamadas do mesmo
  -- ator esperarem uma pelo FOR KEY SHARE da outra. O UPDATE abaixo não toca
  -- coluna de chave.
  perform 1 from public.profiles as profile
  where profile.id = v_profile_id
  for no key update;

  -- An empty patch is a success with no effect, so the update below is a no-op
  -- rather than a special case.
  update public.profiles as profile
  set name = case when v_patch ? 'name'
                  then v_patch ->> 'name' else profile.name end,
      nickname = case when v_patch ? 'nickname'
                      then v_patch ->> 'nickname' else profile.nickname end,
      position = case when v_patch ? 'position'
                      then v_patch ->> 'position' else profile.position end,
      dominant_foot = case when v_patch ? 'dominant_foot'
                           then v_patch ->> 'dominant_foot' else profile.dominant_foot end,
      shirt_number = case when v_patch ? 'shirt_number'
                          then (v_patch ->> 'shirt_number')::int else profile.shirt_number end
  where profile.id = v_profile_id;

  v_outcome := jsonb_build_object('logical_result', 'profile_updated');

  perform private.complete_idempotency(
    v_actor_key, 'update_profile', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);

  return jsonb_build_object(
    'outcome', v_outcome,
    'current', private.profile_projection(v_profile_id));
end;
$function$;

create or replace function public.request_data_export(
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_profile public.profiles%rowtype;
  v_actor_key text;
  v_acquired record;
  v_privacy_request_id uuid;
  v_export_id uuid;
  v_outcome jsonb;
begin
  perform private.require_internal_transport(p_request_id,p_input_hmac,p_canonical_version,p_hash_key_version);
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode='28000',message='UNAUTHENTICATED';
  end if;
  select profile.* into v_profile from public.profiles profile
  where profile.auth_user_id=p_actor_auth_user_id;
  if not found then raise exception using errcode='P0002',message='NOT_FOUND'; end if;
  v_actor_key := 'profile:' || v_profile.id::text;
  select * into v_acquired from private.acquire_request_data_export_idempotency(
    v_actor_key,p_request_id,p_input_hmac,p_canonical_version,p_hash_key_version);
  if not v_acquired.acquired then
    return jsonb_build_object('outcome',v_acquired.outcome,
      'current',private.data_export_projection(v_profile.id));
  end if;
  -- M2-D14: FOR NO KEY UPDATE. A idempotência acima já segura FOR KEY SHARE
  -- neste perfil pela FK actor_id; FOR UPDATE faria dois pedidos do mesmo
  -- titular esperarem um pelo FOR KEY SHARE do outro. A transação não altera o
  -- perfil, e o lock continua serializando os pedidos: o segundo encontra o
  -- export do primeiro e recebe EXPORT_ALREADY_PENDING.
  select profile.* into v_profile from public.profiles profile
  where profile.id=v_profile.id and profile.auth_user_id=p_actor_auth_user_id for no key update;
  if not found then raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  if private.is_actor_session_revoked(p_actor_session_id) then
    raise exception using errcode='28000',message='UNAUTHENTICATED';
  end if;
  if v_profile.account_status not in ('active','suspended','banned') then
    raise exception using errcode='42501',message='FORBIDDEN';
  end if;
  if exists(select 1 from private.data_exports export where export.profile_id=v_profile.id
    and (export.status in ('queued','building','ready','cleanup_pending')
      or (export.status='downloaded' and export.storage_path is not null))) then
    raise exception using errcode='P0001',message='EXPORT_ALREADY_PENDING';
  end if;
  insert into public.privacy_requests(profile_id,kind)
  values(v_profile.id,'access') returning id into v_privacy_request_id;
  insert into private.data_exports(privacy_request_id,profile_id)
  values(v_privacy_request_id,v_profile.id) returning id into v_export_id;
  insert into private.external_effects(kind,resource_type,resource_id,dedupe_key)
  values('build_data_export','data_export',v_export_id,'build_data_export:'||v_export_id::text);
  v_outcome := jsonb_build_object('export_id',v_export_id::text,
                                  'logical_result','data_export_requested');
  perform private.complete_request_data_export_idempotency(v_actor_key,p_request_id,p_input_hmac,
    p_canonical_version,p_hash_key_version,v_outcome);
  return jsonb_build_object('outcome',v_outcome,'current',private.data_export_projection(v_profile.id));
end;
$function$;

-- Lista fechada do fence de Storage. docs/25 §3.3: toda fatia que introduz
-- objeto de Storage acrescenta seu tipo aqui na mesma migration. group_photo
-- entra pelo efeito da ocasião desta saga e, enquanto o grupo arquivado do
-- titular ainda guarda photo_url sem efeito dead, pelo próprio objeto.
create or replace function private.deletion_has_pending_storage(p_request_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $function$
  with target_request as (
    select request.profile_id
    from private.deletion_requests as request
    where request.id = p_request_id
  ),
  storage_effects as (
    select effect.*
    from private.external_effects as effect
    cross join target_request as request
    where effect.kind in (
      'build_data_export', 'delete_data_export', 'delete_storage_object'
    )
      and (
        (effect.resource_type = 'data_export' and exists (
          select 1 from private.data_exports as export
          where export.id = effect.resource_id
            and export.profile_id = request.profile_id
        ))
        or (effect.resource_type = 'profile_avatar'
            and effect.resource_id = request.profile_id)
        or (effect.resource_type = 'group_photo'
            and effect.dedupe_key = 'delete_storage_object:group_photo:'
                                    || effect.resource_id::text || ':' || p_request_id::text)
      )
  )
  select coalesce(
    exists (
      select 1 from storage_effects
      where status in ('pending', 'leased', 'failed_retryable')
    )
    or exists (
      select 1
      from public.profiles as profile
      cross join target_request as request
      where profile.id = request.profile_id
        and profile.photo_url is not null
        and not exists (
          select 1 from storage_effects
          where resource_type = 'profile_avatar' and status = 'dead'
        )
    )
    or exists (
      select 1
      from private.data_exports as export
      cross join target_request as request
      where export.profile_id = request.profile_id
        and export.storage_path is not null
        and not exists (
          select 1 from storage_effects
          where resource_type = 'data_export'
            and resource_id = export.id
            and status = 'dead'
        )
    )
    or exists (
      select 1
      from public.groups as grp
      cross join target_request as request
      where grp.owner_id = request.profile_id
        and grp.archived_at is not null
        and grp.photo_url is not null
        and not exists (
          select 1 from storage_effects
          where resource_type = 'group_photo'
            and resource_id = grp.id
            and status = 'dead'
        )
    ),
    false
  );
$function$;

-- Mapeamento efeito → pedido e política terminal. group_photo segue o avatar:
-- dead registra falha operacional durável e reconcilia; o localizador fica
-- somente em groups.photo_url, na fronteira privada, porque a ausência não foi
-- confirmada.
create or replace function private.sync_deletion_failure_from_effect()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_request_id uuid;
begin
  if new.kind = 'build_data_export' and new.status = 'dead' then
    -- Upload may have committed before the terminal database failure. The path
    -- is deterministic, so terminal build accounting always becomes a real
    -- absence-confirming purge attempt instead of dropping the object.
    update private.data_exports
    set status = 'failed'
    where id = new.resource_id and status in ('queued', 'building');
    insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
    values ('delete_data_export', 'data_export', new.resource_id,
            'delete_data_export:' || new.resource_id::text)
    on conflict (dedupe_key) do nothing;
  end if;

  if new.resource_type = 'deletion_request' and new.kind = 'delete_auth_user' then
    v_request_id := new.resource_id;
  elsif new.resource_type = 'data_export' then
    select request.id into v_request_id
    from private.data_exports as export
    join private.deletion_requests as request on request.profile_id = export.profile_id
    where export.id = new.resource_id;
  elsif new.resource_type = 'profile_avatar' then
    select id into v_request_id from private.deletion_requests
    where profile_id = new.resource_id;
  elsif new.resource_type = 'group_photo' then
    v_request_id := private.group_photo_deletion_request(new.resource_id, new.dedupe_key);
  end if;

  if v_request_id is null then return new; end if;

  if new.status = 'failed_retryable' then
    update private.deletion_requests
    set status = 'failed_retryable',
        attempts = greatest(attempts, new.attempts),
        next_attempt_at = new.next_attempt_at,
        last_error_code = new.last_error_code
    where id = v_request_id and status <> 'completed';
  elsif new.status = 'dead'
        and new.resource_type in ('data_export', 'profile_avatar', 'group_photo') then
    if new.kind = 'delete_data_export' then
      -- The provider never confirmed absence. Keep path/digest, keep purged_at
      -- null, and release the export state honestly as failed.
      update private.data_exports
      set status = 'failed'
      where id = new.resource_id;
    end if;
    update private.deletion_requests
    set status = 'failed_retryable',
        attempts = greatest(attempts, new.attempts),
        next_attempt_at = null,
        last_error_code = new.last_error_code,
        has_operational_failure = true
    where id = v_request_id and status <> 'completed';
  elsif new.status = 'dead' then
    -- Auth dead-letter remains an actionable stalled saga. This item changes
    -- only the human-approved terminal policy for Storage.
    update private.deletion_requests
    set status = 'failed_retryable',
        attempts = greatest(attempts, new.attempts),
        next_attempt_at = null,
        last_error_code = new.last_error_code
    where id = v_request_id and status <> 'completed';
  end if;

  if new.resource_type in ('data_export', 'profile_avatar', 'group_photo')
     and new.status in ('pending', 'succeeded', 'dead') then
    perform private.reconcile_deletion_request(v_request_id);
  end if;
  return new;
end;
$function$;

-- Alvo fenced do handler genérico de Storage. A foto de grupo só é alvo quando
-- o efeito pertence à saga do dono de um grupo arquivado; fora disso a
-- resposta é VALIDATION, e a foto de um grupo vivo nunca é apagada.
create or replace function public.worker_get_deletion_effect_target(
  p_effect_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_effect private.external_effects%rowtype;
  v_path text;
  v_profile_id uuid;
  v_request_id uuid;
  v_request private.deletion_requests%rowtype;
begin
  -- FOR NO KEY UPDATE (M2-D13): esta transação não apaga o efeito nem altera
  -- id ou dedupe_key.
  select effect.* into v_effect from private.external_effects as effect
  where effect.id = p_effect_id for no key update;
  if not found or v_effect.status <> 'leased'
     or v_effect.lease_token <> p_lease_token
     or v_effect.lease_until <= clock_timestamp()
     or v_effect.kind not in ('delete_data_export', 'delete_storage_object', 'delete_auth_user') then
    raise exception using errcode = 'P0001', message = 'CONCURRENT_CHANGE';
  end if;

  if v_effect.kind = 'delete_data_export' then
    select coalesce(export.storage_path,
                    'exports/' || export.profile_id::text || '/' || export.id::text || '.zip'),
           export.profile_id
    into v_path, v_profile_id
    from private.data_exports as export
    where export.id = v_effect.resource_id;
    select id into v_request_id from private.deletion_requests
    where profile_id = v_profile_id;
    if v_request_id is not null then
      perform private.reconcile_deletion_request(v_request_id);
    end if;
    return jsonb_build_object('action', case when v_path is null then 'none' else 'storage' end,
      'bucket', 'data-exports', 'path', v_path);
  elsif v_effect.kind = 'delete_storage_object' and v_effect.resource_type = 'profile_avatar' then
    select id into v_request_id from private.deletion_requests
    where profile_id = v_effect.resource_id;
    if v_request_id is not null then
      perform private.reconcile_deletion_request(v_request_id);
    end if;
    select photo_url into v_path from public.profiles where id = v_effect.resource_id;
    return jsonb_build_object('action', case when v_path is null then 'none' else 'storage' end,
      'bucket', 'avatars', 'path', v_path);
  elsif v_effect.kind = 'delete_storage_object' and v_effect.resource_type = 'group_photo' then
    v_request_id := private.group_photo_deletion_request(v_effect.resource_id, v_effect.dedupe_key);
    if v_request_id is null then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
    perform private.reconcile_deletion_request(v_request_id);
    select photo_url into v_path from public.groups where id = v_effect.resource_id;
    return jsonb_build_object('action', case when v_path is null then 'none' else 'storage' end,
      'bucket', 'group-photos', 'path', v_path);
  elsif v_effect.kind = 'delete_auth_user' and v_effect.resource_type = 'deletion_request' then
    select request.* into v_request from private.deletion_requests as request
    where request.id = v_effect.resource_id;
    if found and v_request.status in ('requested', 'failed_retryable') then
      perform private.reconcile_deletion_request(v_effect.resource_id);
      select request.* into v_request from private.deletion_requests as request
      where request.id = v_effect.resource_id;
    end if;
    if not found or v_request.status = 'completed' or v_request.auth_user_id is null then
      return jsonb_build_object('action', 'none', 'deletion_request_id', v_effect.resource_id);
    end if;
    return jsonb_build_object('action', 'auth',
      'auth_user_id', v_request.auth_user_id,
      'deletion_request_id', v_request.id);
  end if;

  raise exception using errcode = '22023', message = 'VALIDATION';
end;
$function$;

-- Confirmador fenced. Depois de o handler observar a ausência do objeto, a
-- foto de grupo perde o localizador e o pedido reconcilia.
create or replace function public.worker_confirm_deletion_effect(
  p_effect_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_effect private.external_effects%rowtype; v_export private.data_exports%rowtype;
        v_profile_id uuid; v_request_id uuid; v_status text;
begin
  -- FOR NO KEY UPDATE no efeito (M2-D13): esta transação não o apaga nem
  -- altera id ou dedupe_key. O export fica em FOR UPDATE, a exceção da regra:
  -- a confirmação zera storage_path, coluna com índice único, e o próprio
  -- UPDATE tomaria FOR UPDATE; travar mais fraco antes seria promover o lock
  -- dentro da transação.
  select effect.* into v_effect from private.external_effects effect where effect.id=p_effect_id for no key update;
  if not found or v_effect.status<>'leased' or v_effect.lease_token<>p_lease_token
     or v_effect.lease_until<=clock_timestamp() then
    raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  if v_effect.kind='delete_data_export' then
    select export.* into v_export from private.data_exports export where export.id=v_effect.resource_id for update;
    if not found then return jsonb_build_object('status','orphan_reconciled'); end if;
    v_profile_id:=v_export.profile_id;
    select id into v_request_id from private.deletion_requests where profile_id=v_profile_id;
    update private.data_exports set
      status=case when v_request_id is not null then 'failed'
                  when v_export.status='downloaded' then 'downloaded'
                  when v_export.status='failed' then 'failed' else 'expired' end,
      storage_path=null,content_digest=null,purged_at=coalesce(purged_at,now())
    where id=v_export.id;
  elsif v_effect.kind='delete_storage_object' and v_effect.resource_type='profile_avatar' then
    v_profile_id:=v_effect.resource_id;
    update public.profiles set photo_url=null where id=v_profile_id;
    select id into v_request_id from private.deletion_requests where profile_id=v_profile_id;
  elsif v_effect.kind='delete_storage_object' and v_effect.resource_type='group_photo' then
    v_request_id:=private.group_photo_deletion_request(v_effect.resource_id,v_effect.dedupe_key);
    if v_request_id is null then raise exception using errcode='22023',message='VALIDATION'; end if;
    update public.groups set photo_url=null where id=v_effect.resource_id;
  elsif v_effect.kind='delete_auth_user' and v_effect.resource_type='deletion_request' then
    v_request_id:=v_effect.resource_id;
    if exists(select 1 from auth.users u join private.deletion_requests r on r.auth_user_id=u.id
      where r.id=v_request_id) then raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
    update private.deletion_requests set status='finalizing',auth_deleted_at=coalesce(auth_deleted_at,now()),
      next_attempt_at=null,last_error_code=null where id=v_request_id and status<>'completed';
    return jsonb_build_object('deletion_request_id',v_request_id,'status','finalizing');
  else raise exception using errcode='22023',message='VALIDATION'; end if;
  if v_request_id is null then return jsonb_build_object('status','orphan_reconciled'); end if;
  v_status:=private.reconcile_deletion_request(v_request_id);
  return jsonb_build_object('deletion_request_id',v_request_id,'status',v_status);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Extensão do colete-export-v1 (docs/25 §3.4 e docs/22 §5.1)
-- ---------------------------------------------------------------------------
-- groups entra no snapshot com uma entrada por membership própria do titular,
-- somente os oito campos do plano, em ordem determinística por group_id. Nunca
-- entram membros terceiros, digest, nonce, token nem localizador de foto. A
-- leitura de grupos não trava: o snapshot não decide nada, e a ordem
-- efeito → perfil → export é preservada.
create or replace function public.worker_get_data_export_build_target(
  p_effect_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare v_effect private.external_effects%rowtype; v_export private.data_exports%rowtype;
        v_profile public.profiles%rowtype; v_profile_id uuid;
begin
  -- FOR NO KEY UPDATE no efeito, no perfil e no export (M2-D13): esta
  -- transação não apaga nenhuma das três linhas, e o único UPDATE, em
  -- data_exports, muda status e snapshot_at, que não são chave. O lock do
  -- perfil continua conflitando com o de delete_account e com o FOR UPDATE
  -- das funções do M1-B que não são redefinidas aqui.
  select effect.* into v_effect from private.external_effects effect
  where effect.id=p_effect_id for no key update;
  if not found or v_effect.kind<>'build_data_export' or v_effect.status<>'leased'
     or v_effect.lease_token<>p_lease_token or v_effect.lease_until<=clock_timestamp() then
    raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  -- Read only the key needed to acquire the canonical profile -> export lock
  -- order. The export row is deliberately not locked until the profile is.
  select export.profile_id into v_profile_id from private.data_exports export
  where export.id=v_effect.resource_id;
  if not found then return jsonb_build_object('action','none'); end if;
  select profile.* into v_profile from public.profiles profile where profile.id=v_profile_id for no key update;
  if not found then return jsonb_build_object('action','purge'); end if;
  select export.* into v_export from private.data_exports export
  where export.id=v_effect.resource_id and export.profile_id=v_profile_id for no key update;
  if not found then return jsonb_build_object('action','none'); end if;
  if v_export.status in ('failed','expired') then return jsonb_build_object('action','purge'); end if;
  if v_profile.account_status in ('deletion_pending','deleted')
     or v_export.status='cleanup_pending' then return jsonb_build_object('action','purge'); end if;
  if v_export.status='ready' then return jsonb_build_object('action','none'); end if;
  if v_export.status not in ('queued','building') then
    raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  update private.data_exports
  set status=case when status='queued' then 'building' else status end,
      snapshot_at=coalesce(snapshot_at,clock_timestamp())
  where id=v_export.id
  returning * into v_export;
  return jsonb_build_object(
    'action','build','path','exports/'||v_profile.id::text||'/'||v_export.id::text||'.zip',
    'auth_user_id',v_profile.auth_user_id,
    'snapshot',jsonb_build_object(
      'snapshot_at',to_char(v_export.snapshot_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'profile',jsonb_build_object('id',v_profile.id,'name',v_profile.name,'nickname',v_profile.nickname,
        'position',v_profile.position,'dominant_foot',v_profile.dominant_foot,
        'shirt_number',v_profile.shirt_number,'account_status',v_profile.account_status,'created_at',v_profile.created_at),
      'policy_acceptances',coalesce((select jsonb_agg(jsonb_build_object(
        'document_type',a.document_type,'version',a.version,'source',a.source,'accepted_at',a.accepted_at)
        order by a.document_type,a.version) from public.policy_acceptances a where a.profile_id=v_profile.id),'[]'::jsonb),
      'privacy_requests',coalesce((select jsonb_agg(jsonb_build_object(
        'kind',r.kind,'status',r.status,'response',r.response,
        'opened_at',r.opened_at,'resolved_at',r.resolved_at) order by r.opened_at,r.id)
        from public.privacy_requests r where r.profile_id=v_profile.id),'[]'::jsonb),
      'data_exports',coalesce((select jsonb_agg(jsonb_build_object(
        'id',e.id,'status',e.status,'created_at',e.created_at,'ready_at',e.ready_at,
        'expires_at',e.expires_at,'downloaded_at',e.downloaded_at,'purged_at',e.purged_at)
        order by e.created_at,e.id) from private.data_exports e where e.profile_id=v_profile.id),'[]'::jsonb),
      'groups',coalesce((select jsonb_agg(jsonb_build_object(
        'group_id',m.group_id,'group_name',g.name,'role',m.role,'status',m.status,
        'is_monthly',m.is_monthly,'joined_at',m.joined_at,'removed_at',m.removed_at,
        'removal_count',m.removal_count) order by m.group_id)
        from public.group_members m join public.groups g on g.id=m.group_id
        where m.profile_id=v_profile.id),'[]'::jsonb)
    ));
end;
$function$;

commit;
