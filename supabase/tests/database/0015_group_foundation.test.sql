begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- Provas pgTAP da 0015 (docs/25 §3.5). O que depende de commit real, de
-- concorrência ou do Storage local fica em scripts/test-group-foundation.mjs:
-- trigger de owner no commit, transferência e arquivamento pela saga, guard
-- travando sob concorrência, ordem de locks e fence com objeto real.

-- ---------------------------------------------------------------------------
-- Estrutura de docs/10 §3
-- ---------------------------------------------------------------------------

select has_table('public', 'groups', 'groups existe em public');
select has_table('public', 'group_members', 'group_members existe em public');
select has_table('public', 'group_invites', 'group_invites existe em public');

select set_eq(
  $$select column_name::text from information_schema.columns
    where table_schema = 'public' and table_name = 'groups'$$,
  array['id', 'name', 'photo_url', 'owner_id', 'monthly_enabled', 'ratings_visibility',
        'suspended_at', 'archived_at', 'created_at'],
  'groups tem exatamente as colunas de docs/10 §3'
);
select set_eq(
  $$select column_name::text from information_schema.columns
    where table_schema = 'public' and table_name = 'group_members'$$,
  array['group_id', 'profile_id', 'role', 'status', 'is_monthly', 'joined_at',
        'last_requested_at', 'removed_at', 'removal_count'],
  'group_members tem exatamente as colunas de docs/10 §3, sem role owner'
);
select set_eq(
  $$select column_name::text from information_schema.columns
    where table_schema = 'public' and table_name = 'group_invites'$$,
  array['id', 'group_id', 'token_version', 'public_nonce', 'token_digest', 'created_by',
        'expires_at', 'revoked_at', 'max_uses', 'used_count', 'created_at'],
  'group_invites tem exatamente as colunas de docs/10 §3; code_digest é da 0017'
);
select col_is_pk('public', 'group_members', array['group_id', 'profile_id'],
  'a membership é única por grupo e perfil');
select fk_ok('public', 'groups', 'owner_id', 'public', 'profiles', 'id',
  'groups.owner_id referencia profiles');
select fk_ok('public', 'group_members', 'group_id', 'public', 'groups', 'id',
  'group_members.group_id referencia groups');
select fk_ok('public', 'group_members', 'profile_id', 'public', 'profiles', 'id',
  'group_members.profile_id referencia profiles');
select fk_ok('public', 'group_invites', 'group_id', 'public', 'groups', 'id',
  'group_invites.group_id referencia groups');
select fk_ok('public', 'group_invites', 'created_by', 'public', 'profiles', 'id',
  'group_invites.created_by referencia profiles');
select is(
  (select count(*) from pg_constraint
   where contype = 'f'
     and conrelid in ('public.groups'::regclass, 'public.group_members'::regclass,
                      'public.group_invites'::regclass)
     and confdeltype <> 'a'),
  0::bigint,
  'nenhuma FK do grafo de grupos usa cascade ou set null: grupo é arquivado, nunca apagado'
);
select has_index('public', 'groups', 'groups_owner_id_idx', 'índice por owner_id');
select has_index('public', 'group_members', 'group_members_profile_status_idx',
  'índice de memberships por perfil e status');
select has_index('public', 'group_members', 'group_members_open_by_group_idx',
  'índice parcial para contar pending + active por grupo');
select has_index('public', 'group_invites', 'group_invites_group_id_idx',
  'índice de convites por grupo');
select ok(
  (select indisunique from pg_index
   where indrelid = 'public.group_invites'::regclass
     and indkey::text = (select attnum::text from pg_attribute
                         where attrelid = 'public.group_invites'::regclass
                           and attname = 'token_digest')),
  'token_digest é único'
);

-- ---------------------------------------------------------------------------
-- Limites: app_limits e constraints coincidem
-- ---------------------------------------------------------------------------

select results_eq(
  $$select limit_key, limit_value, unit from private.app_limits
    where limit_key in ('max_active_groups_per_profile', 'max_group_capacity',
                        'group_invite_default_max_uses')
    order by limit_key$$,
  $$values ('group_invite_default_max_uses'::text, 100::bigint, 'uses'::text),
           ('max_active_groups_per_profile', 5, 'groups'),
           ('max_group_capacity', 100, 'members')$$,
  'os três limites normativos existem com unidade tipada'
);
select is(
  (select pg_get_expr(adbin, adrelid) from pg_attrdef
   where adrelid = 'public.group_invites'::regclass
     and adnum = (select attnum from pg_attribute
                  where attrelid = 'public.group_invites'::regclass and attname = 'max_uses')),
  (select limit_value::text from private.app_limits
   where limit_key = 'group_invite_default_max_uses'),
  'o default literal de max_uses coincide com a configuração'
);
select throws_ok(
  $$insert into private.app_limits (limit_key, limit_value, unit, notes)
    values ('group_unit_probe', 1, 'teams', 'probe')$$,
  '23514', null,
  'o vocabulário de unidades continua fechado'
);

insert into auth.users (id, email) values
  ('15000000-0000-4000-8000-000000000001', 'group-a-owner@example.invalid'),
  ('15000000-0000-4000-8000-000000000002', 'group-a-member@example.invalid'),
  ('15000000-0000-4000-8000-000000000003', 'group-a-pending@example.invalid'),
  ('15000000-0000-4000-8000-000000000004', 'group-a-removed@example.invalid'),
  ('15000000-0000-4000-8000-000000000005', 'group-a-organizer@example.invalid'),
  ('15000000-0000-4000-8000-000000000006', 'group-a-demoted@example.invalid'),
  ('15000000-0000-4000-8000-000000000007', 'group-b-owner@example.invalid'),
  ('15000000-0000-4000-8000-000000000008', 'group-b-organizer@example.invalid'),
  ('15000000-0000-4000-8000-000000000009', 'group-stranger@example.invalid'),
  ('15000000-0000-4000-8000-000000000010', 'group-a-deleting@example.invalid'),
  ('15000000-0000-4000-8000-000000000011', 'group-c-owner@example.invalid'),
  ('15000000-0000-4000-8000-000000000012', 'group-c-member@example.invalid');

insert into public.profiles (id, auth_user_id, name, account_status) values
  ('15100000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001', 'A owner', 'active'),
  ('15100000-0000-4000-8000-000000000002', '15000000-0000-4000-8000-000000000002', 'A member', 'active'),
  ('15100000-0000-4000-8000-000000000003', '15000000-0000-4000-8000-000000000003', 'A pending', 'active'),
  ('15100000-0000-4000-8000-000000000004', '15000000-0000-4000-8000-000000000004', 'A removed', 'active'),
  ('15100000-0000-4000-8000-000000000005', '15000000-0000-4000-8000-000000000005', 'A organizer', 'active'),
  ('15100000-0000-4000-8000-000000000006', '15000000-0000-4000-8000-000000000006', 'A demoted', 'active'),
  ('15100000-0000-4000-8000-000000000007', '15000000-0000-4000-8000-000000000007', 'B owner', 'active'),
  ('15100000-0000-4000-8000-000000000008', '15000000-0000-4000-8000-000000000008', 'B organizer', 'active'),
  ('15100000-0000-4000-8000-000000000009', '15000000-0000-4000-8000-000000000009', 'Stranger', 'active'),
  ('15100000-0000-4000-8000-000000000010', '15000000-0000-4000-8000-000000000010', 'A deleting', 'deletion_pending'),
  ('15100000-0000-4000-8000-000000000011', '15000000-0000-4000-8000-000000000011', 'C owner', 'active'),
  ('15100000-0000-4000-8000-000000000012', '15000000-0000-4000-8000-000000000012', 'C member', 'active');

insert into public.groups (id, name, owner_id, photo_url, archived_at) values
  ('15200000-0000-4000-8000-000000000001', 'Grupo A',
   '15100000-0000-4000-8000-000000000001', 'groups/census-a-photo-path.webp', null),
  ('15200000-0000-4000-8000-000000000002', 'Grupo B',
   '15100000-0000-4000-8000-000000000007', null, null),
  ('15200000-0000-4000-8000-000000000003', 'Grupo C arquivado',
   '15100000-0000-4000-8000-000000000011', null, now());

insert into public.group_members (group_id, profile_id, role, status, removed_at) values
  ('15200000-0000-4000-8000-000000000001', '15100000-0000-4000-8000-000000000001', 'organizer', 'active', null),
  ('15200000-0000-4000-8000-000000000001', '15100000-0000-4000-8000-000000000002', 'player', 'active', null),
  ('15200000-0000-4000-8000-000000000001', '15100000-0000-4000-8000-000000000003', 'player', 'pending', null),
  ('15200000-0000-4000-8000-000000000001', '15100000-0000-4000-8000-000000000004', 'player', 'removed', now()),
  ('15200000-0000-4000-8000-000000000001', '15100000-0000-4000-8000-000000000005', 'organizer', 'active', null),
  ('15200000-0000-4000-8000-000000000001', '15100000-0000-4000-8000-000000000006', 'player', 'active', null),
  ('15200000-0000-4000-8000-000000000001', '15100000-0000-4000-8000-000000000010', 'player', 'active', null),
  ('15200000-0000-4000-8000-000000000002', '15100000-0000-4000-8000-000000000007', 'organizer', 'active', null),
  ('15200000-0000-4000-8000-000000000002', '15100000-0000-4000-8000-000000000008', 'organizer', 'active', null),
  ('15200000-0000-4000-8000-000000000002', '15100000-0000-4000-8000-000000000003', 'player', 'pending', null),
  ('15200000-0000-4000-8000-000000000003', '15100000-0000-4000-8000-000000000011', 'organizer', 'removed', now()),
  ('15200000-0000-4000-8000-000000000003', '15100000-0000-4000-8000-000000000012', 'player', 'active', null);

-- A demoted e A removed criaram convites quando ainda tinham autoridade.
insert into public.group_invites
  (id, group_id, public_nonce, token_digest, created_by, expires_at)
values
  ('15300000-0000-4000-8000-000000000001', '15200000-0000-4000-8000-000000000001',
   decode('00112233445566778899aabbccddeeff', 'hex'), 'census-token-digest-invite-one',
   '15100000-0000-4000-8000-000000000006', now() + interval '7 days'),
  ('15300000-0000-4000-8000-000000000002', '15200000-0000-4000-8000-000000000001',
   decode('ffeeddccbbaa99887766554433221100', 'hex'), 'census-token-digest-invite-two',
   '15100000-0000-4000-8000-000000000004', now() + interval '7 days'),
  ('15300000-0000-4000-8000-000000000003', '15200000-0000-4000-8000-000000000002',
   decode('0f1e2d3c4b5a69788796a5b4c3d2e1f0', 'hex'), 'census-token-digest-invite-three',
   '15100000-0000-4000-8000-000000000007', now() + interval '7 days');

-- ---------------------------------------------------------------------------
-- Constraints e FKs
-- ---------------------------------------------------------------------------

select is(
  (select max_uses::text || ':' || used_count::text || ':' || token_version::text
   from public.group_invites where id = '15300000-0000-4000-8000-000000000001'),
  '100:0:1',
  'convite nasce com max_uses=100, used_count=0 e token_version=1'
);
select throws_ok(
  $$update public.group_invites set max_uses = 0
    where id = '15300000-0000-4000-8000-000000000001'$$,
  '23514', null, 'max_uses precisa ser positivo');
select throws_ok(
  $$update public.group_invites set used_count = 101
    where id = '15300000-0000-4000-8000-000000000001'$$,
  '23514', null, 'used_count não passa de max_uses');
select throws_ok(
  $$update public.group_invites set used_count = -1
    where id = '15300000-0000-4000-8000-000000000001'$$,
  '23514', null, 'used_count não é negativo');
select lives_ok(
  $$update public.group_invites set used_count = 100
    where id = '15300000-0000-4000-8000-000000000001'$$,
  'used_count igual a max_uses é o último uso válido');
select throws_ok(
  $$update public.group_invites set public_nonce = decode('00112233445566778899aabbccddee', 'hex')
    where id = '15300000-0000-4000-8000-000000000001'$$,
  '23514', null, 'public_nonce tem exatamente 16 bytes');
select throws_ok(
  $$update public.group_invites set token_version = 0
    where id = '15300000-0000-4000-8000-000000000001'$$,
  '23514', null, 'token_version é positivo');
select throws_ok(
  $$update public.group_invites set token_digest = 'census-token-digest-invite-two'
    where id = '15300000-0000-4000-8000-000000000001'$$,
  '23505', null, 'token_digest é único');
select throws_ok(
  $$update public.group_members set removal_count = -1
    where group_id = '15200000-0000-4000-8000-000000000001'
      and profile_id = '15100000-0000-4000-8000-000000000002'$$,
  '23514', null, 'removal_count não é negativo');
select throws_ok(
  $$update public.group_members set role = 'owner'
    where group_id = '15200000-0000-4000-8000-000000000001'
      and profile_id = '15100000-0000-4000-8000-000000000002'$$,
  '23514', null, 'role owner não existe: o dono deriva de groups.owner_id');
select throws_ok(
  $$update public.group_members set status = 'banned'
    where group_id = '15200000-0000-4000-8000-000000000001'
      and profile_id = '15100000-0000-4000-8000-000000000002'$$,
  '23514', null, 'status aceita somente pending, active e removed');
select throws_ok(
  $$update public.group_members set status = 'removed'
    where group_id = '15200000-0000-4000-8000-000000000001'
      and profile_id = '15100000-0000-4000-8000-000000000002'$$,
  '23514', null, 'removed exige removed_at preenchido');
select throws_ok(
  $$update public.group_members set removed_at = now()
    where group_id = '15200000-0000-4000-8000-000000000001'
      and profile_id = '15100000-0000-4000-8000-000000000002'$$,
  '23514', null, 'membership active não carrega removed_at');
select throws_ok(
  $$update public.groups set ratings_visibility = 'public'
    where id = '15200000-0000-4000-8000-000000000001'$$,
  '23514', null, 'visibilidade das notas nunca é pública');
select throws_ok(
  $$insert into public.group_members (group_id, profile_id)
    values ('15200000-0000-4000-8000-0000000000ff', '15100000-0000-4000-8000-000000000009')$$,
  '23503', null, 'membership exige grupo existente');
select throws_ok(
  $$insert into public.groups (name, owner_id)
    values ('Sem dono', '15100000-0000-4000-8000-0000000000ff')$$,
  '23503', null, 'groups.owner_id exige perfil existente');
select throws_ok(
  $$insert into public.group_invites (group_id, public_nonce, token_digest, created_by, expires_at)
    values ('15200000-0000-4000-8000-000000000001', decode('00112233445566778899aabbccddeeff', 'hex'),
            'census-token-digest-orphan', '15100000-0000-4000-8000-0000000000ff', now())$$,
  '23503', null, 'group_invites.created_by exige perfil existente');
select throws_ok(
  $$delete from public.groups where id = '15200000-0000-4000-8000-000000000002'$$,
  '23503', null, 'grupo com memberships não é apagado por FK');

-- ---------------------------------------------------------------------------
-- Trigger diferido de owner: forma. O comportamento no commit é provado com
-- commit real em db:test:groups, porque o rollback do pgTAP o esconderia.
-- ---------------------------------------------------------------------------

select results_eq(
  $$select tgrelid::regclass::text, tgdeferrable, tginitdeferred,
           (tgtype & 4) <> 0 as on_insert, (tgtype & 8) <> 0 as on_delete,
           (tgtype & 16) <> 0 as on_update,
           array(select attname::text collate "default" from pg_attribute
                 where attrelid = tgrelid and attnum = any(tgattr) order by attname)
    from pg_trigger
    where tgfoid = 'private.enforce_group_owner_membership()'::regprocedure
    order by 1$$,
  $$values ('group_members'::text, true, true, false, true, true,
            array['group_id', 'profile_id', 'status']::text[]),
           ('groups', true, true, true, false, true, array['archived_at', 'owner_id']::text[])$$,
  'o trigger de owner é DEFERRABLE INITIALLY DEFERRED em groups e em group_members'
);
select ok(
  (select prosecdef from pg_proc
   where oid = 'private.enforce_group_owner_membership()'::regprocedure),
  'o trigger de owner lê as tabelas com RLS forçada como definer, sem falhar aberto'
);

-- ---------------------------------------------------------------------------
-- Privilégios, RLS e policies
-- ---------------------------------------------------------------------------

select ok(
  (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
   where oid in ('public.groups'::regclass, 'public.group_members'::regclass,
                 'public.group_invites'::regclass)),
  'as três tabelas têm RLS ligada e forçada'
);
select results_eq(
  $$select tablename::text collate "default", policyname::text collate "default",
           cmd::text, roles::text collate "default"
    from pg_policies
    where schemaname = 'public'
      and tablename in ('groups', 'group_members', 'group_invites')
    order by tablename, policyname$$,
  $$values ('group_invites'::text, 'group_invites_select_authority'::text, 'SELECT'::text,
            '{authenticated}'::text),
           ('group_members', 'group_members_select_visible', 'SELECT', '{authenticated}'),
           ('groups', 'groups_select_active_member', 'SELECT', '{authenticated}')$$,
  'uma policy de leitura por tabela, somente para authenticated, e nenhuma de escrita'
);
select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('groups', 'group_members', 'group_invites')
     and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')),
  0::bigint,
  'nenhum papel tem privilégio de tabela inteira: só colunas'
);
select set_eq(
  $$select table_name::text || '.' || column_name::text || ':' || privilege_type::text
    from information_schema.column_privileges
    where table_schema = 'public'
      and table_name in ('groups', 'group_members', 'group_invites')
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')$$,
  array[
    'groups.id:SELECT', 'groups.name:SELECT', 'groups.owner_id:SELECT',
    'groups.monthly_enabled:SELECT', 'groups.ratings_visibility:SELECT',
    'groups.suspended_at:SELECT',
    'group_members.group_id:SELECT', 'group_members.profile_id:SELECT',
    'group_members.role:SELECT', 'group_members.status:SELECT',
    'group_members.is_monthly:SELECT', 'group_members.joined_at:SELECT',
    'group_members.last_requested_at:SELECT',
    'group_invites.id:SELECT', 'group_invites.group_id:SELECT',
    'group_invites.expires_at:SELECT', 'group_invites.revoked_at:SELECT',
    'group_invites.max_uses:SELECT', 'group_invites.used_count:SELECT',
    'group_invites.created_at:SELECT'
  ],
  'grants por coluna exatos: sem photo_url, token_digest, public_nonce ou created_by, e só SELECT'
);
select is(
  (select count(*) from information_schema.column_privileges
   where table_schema = 'public'
     and table_name in ('groups', 'group_members', 'group_invites')
     and grantee <> 'authenticated'
     and grantee in ('PUBLIC', 'anon', 'service_role')),
  0::bigint,
  'anon e service_role não recebem coluna alguma: zero DML administrativo direto'
);
select ok(
  not (select rolbypassrls from pg_roles where rolname = 'authenticated'),
  'o papel-sonda authenticated não tem BYPASSRLS'
);
select ok(
  (select defaclacl::text !~ 'service_role' from pg_default_acl
   where defaclrole = 'postgres'::regrole
     and defaclnamespace = 'public'::regnamespace and defaclobjtype = 'r'),
  'os defaults da 0004 continuam negando tabelas futuras a service_role'
);
select results_eq(
  $$select public::text, coalesce(file_size_limit::text, 'null'),
           coalesce(allowed_mime_types::text, 'null')
    from storage.buckets where id = 'group-photos'$$,
  $$values ('false'::text, 'null'::text, 'null'::text)$$,
  'o bucket group-photos nasce privado, sem limites inventados antes do produtor'
);
select is(
  (select count(*) from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and (qual like '%group-photos%' or with_check like '%group-photos%')),
  0::bigint,
  'o bucket group-photos não tem policy de cliente'
);

-- ---------------------------------------------------------------------------
-- RLS positiva e cruzada com o papel-sonda
-- ---------------------------------------------------------------------------

set local role authenticated;

-- Caminho positivo de cada leitor, antes das negações.
set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000002"}';
select results_eq(
  $$select id, name from public.groups order by id$$,
  $$values ('15200000-0000-4000-8000-000000000001'::uuid, 'Grupo A'::text)$$,
  'membro ativo de A lê a linha de A'
);
select results_eq(
  $$select profile_id::text, status from public.group_members order by profile_id$$,
  $$values ('15100000-0000-4000-8000-000000000001'::text, 'active'::text),
           ('15100000-0000-4000-8000-000000000002', 'active'),
           ('15100000-0000-4000-8000-000000000003', 'pending'),
           ('15100000-0000-4000-8000-000000000004', 'removed'),
           ('15100000-0000-4000-8000-000000000005', 'active'),
           ('15100000-0000-4000-8000-000000000006', 'active'),
           ('15100000-0000-4000-8000-000000000010', 'active')$$,
  'membro ativo de A lê as memberships de A e nenhuma de B ou C'
);
select is((select count(*) from public.group_invites), 0::bigint,
  'membro comum não lê convite');

set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000001"}';
select results_eq(
  $$select id from public.group_invites order by id$$,
  $$values ('15300000-0000-4000-8000-000000000001'::uuid),
           ('15300000-0000-4000-8000-000000000002'::uuid)$$,
  'o dono ativo lê somente os convites do próprio grupo'
);

set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000005"}';
select results_eq(
  $$select id, max_uses, used_count from public.group_invites order by id$$,
  $$values ('15300000-0000-4000-8000-000000000001'::uuid, 100, 100),
           ('15300000-0000-4000-8000-000000000002'::uuid, 100, 0)$$,
  'o organizador ativo de A lê a projeção allowlisted dos convites de A'
);

set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000003"}';
select results_eq(
  $$select group_id::text, profile_id::text, status from public.group_members
    order by group_id$$,
  $$values ('15200000-0000-4000-8000-000000000001'::text,
            '15100000-0000-4000-8000-000000000003'::text, 'pending'::text),
           ('15200000-0000-4000-8000-000000000002',
            '15100000-0000-4000-8000-000000000003', 'pending')$$,
  'o pendente lê somente os próprios pedidos'
);

-- Negações cruzadas.
select is((select count(*) from public.groups), 0::bigint,
  'o pendente não lê a linha do grupo');
select is((select count(*) from public.group_invites), 0::bigint,
  'o pendente não lê convite');

set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000004"}';
select is((select count(*) from public.groups), 0::bigint,
  'membership removed não lê a linha do grupo');
select is((select count(*) from public.group_members), 0::bigint,
  'membership removed não enumera membros nem a própria linha');
select is((select count(*) from public.group_invites), 0::bigint,
  'o criador removido não lê o convite que criou');

set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000006"}';
select is((select count(*) from public.group_invites), 0::bigint,
  'o criador rebaixado a player não lê o convite que criou: created_by não é autoridade');

set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000008"}';
select results_eq(
  $$select id from public.groups$$,
  $$values ('15200000-0000-4000-8000-000000000002'::uuid)$$,
  'o organizador de B lê somente B'
);
select is(
  (select count(*) from public.group_members
   where group_id = '15200000-0000-4000-8000-000000000001'),
  0::bigint,
  'o organizador de B não lê memberships de A'
);
select results_eq(
  $$select id from public.group_invites$$,
  $$values ('15300000-0000-4000-8000-000000000003'::uuid)$$,
  'o organizador de B não lê convite de A'
);

set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000009"}';
select is(
  (select count(*) from public.groups) + (select count(*) from public.group_members)
    + (select count(*) from public.group_invites),
  0::bigint,
  'identidade alheia não lê nada'
);

set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000010"}';
select is(
  (select count(*) from public.groups) + (select count(*) from public.group_members),
  0::bigint,
  'conta deletion_pending perde a leitura de grupo com o JWT antigo'
);

set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000012"}';
select is(
  (select count(*) from public.groups) + (select count(*) from public.group_members),
  0::bigint,
  'grupo arquivado não é enumerável nem por membership active residual'
);

set local request.jwt.claims = '{"sub":"15000000-0000-4000-8000-000000000001"}';
select throws_ok($$select photo_url from public.groups$$, '42501', null,
  'o dono não lê o localizador da foto');
select throws_ok($$select archived_at from public.groups$$, '42501', null,
  'archived_at não é concedido');
select throws_ok($$select token_digest from public.group_invites$$, '42501', null,
  'token_digest nunca chega ao cliente');
select throws_ok($$select public_nonce from public.group_invites$$, '42501', null,
  'public_nonce nunca chega ao cliente');
select throws_ok($$select created_by from public.group_invites$$, '42501', null,
  'created_by não é concedido');
select throws_ok($$select removal_count from public.group_members$$, '42501', null,
  'removal_count não é concedido');
select throws_ok($$select * from public.groups$$, '42501', null,
  'select * falha: o cliente precisa pedir colunas allowlisted');
select throws_ok(
  $$insert into public.groups (name, owner_id)
    values ('Direto', '15100000-0000-4000-8000-000000000001')$$,
  '42501', null, 'cliente não insere grupo');
select throws_ok(
  $$update public.group_members set role = 'organizer'
    where profile_id = '15100000-0000-4000-8000-000000000002'$$,
  '42501', null, 'cliente não promove membership');
select throws_ok(
  $$delete from public.group_invites$$,
  '42501', null, 'cliente não apaga convite');

reset role;
set local role anon;
select throws_ok($$select id from public.groups$$, '42501', null, 'anon não lê groups');
reset role;
set local role service_role;
select throws_ok($$select id from public.groups$$, '42501', null,
  'service_role não lê groups diretamente');
select throws_ok(
  $$update public.group_members set status = 'active'
    where profile_id = '15100000-0000-4000-8000-000000000003'$$,
  '42501', null, 'service_role não faz DML direto em memberships');
select throws_ok(
  $$select private.require_financial_deletion_substitute(
      '15100000-0000-4000-8000-000000000001', '{}'::uuid[], '{}'::uuid[])$$,
  '42501', 'permission denied for schema private',
  'service_role não alcança o guard: o 42501 vem da falta de USAGE no schema private; a ACL da função é afirmada à parte');
reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- Funções da extensão: assinatura, volatilidade e ACL
-- ---------------------------------------------------------------------------

select hasnt_function('private', 'require_financial_deletion_substitute', array['uuid'],
  'a assinatura antiga do guard não sobrevive como overload morto');
select is(
  (select provolatile from pg_proc
   where oid = 'private.require_financial_deletion_substitute(uuid,uuid[],uuid[])'::regprocedure),
  'v'::"char",
  'o guard é volatile: select for update e update não abortam dentro dele'
);
select is(
  (select proacl::text from pg_proc
   where oid = 'private.require_financial_deletion_substitute(uuid,uuid[],uuid[])'::regprocedure),
  '{postgres=X/postgres}',
  'o guard nasce fechado'
);
select ok(
  not has_function_privilege('authenticated', 'private.group_deletion_candidates(uuid,uuid[])', 'execute')
  and not has_function_privilege('service_role', 'private.group_deletion_candidates(uuid,uuid[])', 'execute')
  and not has_function_privilege('authenticated', 'private.group_photo_deletion_request(uuid,text)', 'execute')
  and not has_function_privilege('service_role', 'private.group_photo_deletion_request(uuid,text)', 'execute'),
  'os helpers da saga não são executáveis por cliente nem pelo worker'
);
select ok(
  has_function_privilege('authenticated', 'private.is_active_group_member(uuid)', 'execute')
  and has_function_privilege('authenticated', 'private.can_read_group_invites(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.is_active_group_member(uuid)', 'execute')
  and not has_function_privilege('service_role', 'private.can_read_group_invites(uuid)', 'execute')
  and not has_schema_privilege('authenticated', 'private', 'usage'),
  'os helpers das policies só servem ao papel cliente, sem abrir o schema private'
);

-- ---------------------------------------------------------------------------
-- ACL de toda função nova ou redefinida pela 0015
-- ---------------------------------------------------------------------------

-- A negação por papel acima passa pela falta de USAGE no schema private e
-- passaria mesmo com EXECUTE concedido. Estas asserções leem a ACL da própria
-- função: pg_proc.proacl exato e has_function_privilege, que não consulta o
-- schema, para service_role, authenticated, anon e PUBLIC. A lista é a mesma
-- lista fechada que scripts/test-group-foundation.mjs extrai da migration.
create temporary table acl_0015 (signature text, acl text, execute boolean[]) on commit drop;
insert into acl_0015 values
  ('private.require_financial_deletion_substitute(uuid,uuid[],uuid[])', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.group_deletion_candidates(uuid,uuid[])', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.group_photo_deletion_request(uuid,text)', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.enforce_group_owner_membership()', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.deletion_has_pending_storage(uuid)', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.sync_deletion_failure_from_effect()', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.current_group_profile_id()', '{postgres=X/postgres,authenticated=X/postgres}', array[false,true,false,false]),
  ('private.is_active_group_member(uuid)', '{postgres=X/postgres,authenticated=X/postgres}', array[false,true,false,false]),
  ('private.can_read_group_invites(uuid)', '{postgres=X/postgres,authenticated=X/postgres}', array[false,true,false,false]),
  ('public.delete_account(uuid,uuid,uuid,text,integer,integer)', '{postgres=X/postgres,service_role=X/postgres}', array[true,false,false,false]),
  ('public.worker_get_deletion_effect_target(uuid,uuid)', '{postgres=X/postgres,service_role=X/postgres}', array[true,false,false,false]),
  ('public.worker_confirm_deletion_effect(uuid,uuid)', '{postgres=X/postgres,service_role=X/postgres}', array[true,false,false,false]),
  ('public.worker_get_data_export_build_target(uuid,uuid)', '{postgres=X/postgres,service_role=X/postgres}', array[true,false,false,false]),
  ('public.update_profile(uuid,uuid,uuid,text,integer,integer,jsonb)', '{postgres=X/postgres,service_role=X/postgres}', array[true,false,false,false]),
  ('public.request_data_export(uuid,uuid,uuid,text,integer,integer)', '{postgres=X/postgres,service_role=X/postgres}', array[true,false,false,false]);

select is(
  (select count(*)::integer from acl_0015),
  15,
  'a lista de ACL cobre as 15 funções que a 0015 cria ou redefine'
);
select is(
  (select proacl::text from pg_proc where oid = signature::regprocedure),
  acl,
  signature || ': proacl exato'
)
from acl_0015 order by signature;
select is(
  array[
    has_function_privilege('service_role', signature, 'execute'),
    has_function_privilege('authenticated', signature, 'execute'),
    has_function_privilege('anon', signature, 'execute'),
    has_function_privilege('public', signature, 'execute')
  ],
  execute,
  signature || ': EXECUTE por service_role, authenticated, anon e PUBLIC pela ACL da função'
)
from acl_0015 order by signature;

-- ---------------------------------------------------------------------------
-- delete_account: bloqueio atômico sem organizador elegível
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('15000000-0000-4000-8000-000000000020', 'group-blocked-owner@example.invalid'),
  ('15000000-0000-4000-8000-000000000021', 'group-blocked-player@example.invalid'),
  ('15000000-0000-4000-8000-000000000022', 'group-blocked-pending@example.invalid'),
  ('15000000-0000-4000-8000-000000000023', 'group-blocked-suspended@example.invalid');
insert into public.profiles (id, auth_user_id, name, account_status) values
  ('15100000-0000-4000-8000-000000000020', '15000000-0000-4000-8000-000000000020', 'Blocked owner', 'active'),
  ('15100000-0000-4000-8000-000000000021', '15000000-0000-4000-8000-000000000021', 'Blocked player', 'active'),
  ('15100000-0000-4000-8000-000000000022', '15000000-0000-4000-8000-000000000022', 'Blocked pending', 'active'),
  ('15100000-0000-4000-8000-000000000023', '15000000-0000-4000-8000-000000000023', 'Suspended organizer', 'suspended');
insert into public.groups (id, name, owner_id) values
  ('15200000-0000-4000-8000-000000000020', 'Sem substituto', '15100000-0000-4000-8000-000000000020');
insert into public.group_members (group_id, profile_id, role, status) values
  ('15200000-0000-4000-8000-000000000020', '15100000-0000-4000-8000-000000000020', 'organizer', 'active'),
  ('15200000-0000-4000-8000-000000000020', '15100000-0000-4000-8000-000000000021', 'player', 'active'),
  ('15200000-0000-4000-8000-000000000020', '15100000-0000-4000-8000-000000000022', 'organizer', 'pending'),
  ('15200000-0000-4000-8000-000000000020', '15100000-0000-4000-8000-000000000023', 'organizer', 'active');

select throws_ok(
  $$select public.delete_account(
      '15000000-0000-4000-8000-000000000020', '15400000-0000-4000-8000-000000000020',
      '15500000-0000-4000-8000-000000000020', repeat('a', 64), 1, 1)$$,
  'P0001', 'FINANCIAL_SUBSTITUTE_REQUIRED',
  'player ativo, pedido pendente e organizador suspenso não são substitutos'
);
select results_eq(
  $$select profile_id::text, role, status from public.group_members
    where group_id = '15200000-0000-4000-8000-000000000020' order by profile_id$$,
  $$values ('15100000-0000-4000-8000-000000000020'::text, 'organizer'::text, 'active'::text),
           ('15100000-0000-4000-8000-000000000021', 'player', 'active'),
           ('15100000-0000-4000-8000-000000000022', 'organizer', 'pending'),
           ('15100000-0000-4000-8000-000000000023', 'organizer', 'active')$$,
  'o guard nunca promove pending nem player e não deixa mudança parcial'
);
select is(
  (select owner_id::text || ':' || (archived_at is null)::text from public.groups
   where id = '15200000-0000-4000-8000-000000000020'),
  '15100000-0000-4000-8000-000000000020:true',
  'o grupo bloqueado conserva dono e continua ativo'
);
select is(
  (select count(*) from private.deletion_requests
   where profile_id = '15100000-0000-4000-8000-000000000020')
  + (select count(*) from private.idempotency_records
     where actor_key = 'profile:15100000-0000-4000-8000-000000000020'),
  0::bigint,
  'o bloqueio não inicia a saga nem deixa a linha executing'
);

-- ---------------------------------------------------------------------------
-- Fence de Storage da foto de grupo
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('15000000-0000-4000-8000-000000000030', 'group-photo-owner@example.invalid'),
  ('15000000-0000-4000-8000-000000000031', 'group-photo-pending@example.invalid');
insert into public.profiles (id, auth_user_id, name, account_status) values
  ('15100000-0000-4000-8000-000000000030', '15000000-0000-4000-8000-000000000030', 'Photo owner', 'active'),
  ('15100000-0000-4000-8000-000000000031', '15000000-0000-4000-8000-000000000031', 'Photo pending', 'active');
insert into public.groups (id, name, owner_id, photo_url) values
  ('15200000-0000-4000-8000-000000000030', 'Solo com foto',
   '15100000-0000-4000-8000-000000000030', 'groups/census-solo-photo-path.webp');
insert into public.group_members (group_id, profile_id, role, status, removal_count) values
  ('15200000-0000-4000-8000-000000000030', '15100000-0000-4000-8000-000000000030', 'organizer', 'active', 0),
  ('15200000-0000-4000-8000-000000000030', '15100000-0000-4000-8000-000000000031', 'player', 'pending', 2);

create temporary table photo_deletion as
select public.delete_account(
  '15000000-0000-4000-8000-000000000030', '15400000-0000-4000-8000-000000000030',
  '15500000-0000-4000-8000-000000000030', repeat('b', 64), 1, 1) as response;

select is(
  (select (archived_at is not null)::text || ':' || photo_url from public.groups
   where id = '15200000-0000-4000-8000-000000000030'),
  'true:groups/census-solo-photo-path.webp',
  'o grupo solo com foto é arquivado; o localizador fica na fronteira privada'
);
select results_eq(
  $$select profile_id::text, status, removed_at is not null, removal_count
    from public.group_members
    where group_id = '15200000-0000-4000-8000-000000000030' order by profile_id$$,
  $$values ('15100000-0000-4000-8000-000000000030'::text, 'removed'::text, true, 0),
           ('15100000-0000-4000-8000-000000000031', 'removed', true, 2)$$,
  'owner e pendente passam a removed com removed_at e removal_count inalterado (M2-D9)'
);
select is(
  (select dedupe_key from private.external_effects
   where resource_type = 'group_photo'
     and resource_id = '15200000-0000-4000-8000-000000000030'),
  'delete_storage_object:group_photo:15200000-0000-4000-8000-000000000030:'
    || (select response -> 'outcome' ->> 'deletion_request_id' from photo_deletion),
  'a chave do efeito da foto é por ocasião da saga'
);
select ok(
  private.deletion_has_pending_storage(
    (select (response -> 'outcome' ->> 'deletion_request_id')::uuid from photo_deletion)),
  'a foto pendente mantém o fence de Storage'
);
select is(
  (select count(*) from private.external_effects
   where kind = 'delete_auth_user'
     and resource_id = (select (response -> 'outcome' ->> 'deletion_request_id')::uuid
                        from photo_deletion)),
  0::bigint,
  'com foto de grupo pendente a saga não cria a intenção de Auth'
);
select is(
  (select status from private.deletion_requests
   where profile_id = '15100000-0000-4000-8000-000000000030'),
  'cleaning_storage',
  'o efeito da foto reconcilia a saga para cleaning_storage'
);

-- Efeitos concorrentes da suíte antiga não interferem: o lease é filtrado pela
-- chave desta prova.
update private.external_effects
set status = 'leased', attempts = 1, lease_token = '15600000-0000-4000-8000-000000000001',
    lease_until = clock_timestamp() + interval '5 minutes'
where resource_type = 'group_photo'
  and resource_id = '15200000-0000-4000-8000-000000000030';

select is(
  public.worker_get_deletion_effect_target(
    (select id from private.external_effects
     where resource_id = '15200000-0000-4000-8000-000000000030'),
    '15600000-0000-4000-8000-000000000001'),
  jsonb_build_object('action', 'storage', 'bucket', 'group-photos',
                     'path', 'groups/census-solo-photo-path.webp'),
  'o alvo fenced do handler aponta para o bucket privado da foto'
);
select ok(
  not private.deletion_auth_effect_is_ready(
    (select (response -> 'outcome' ->> 'deletion_request_id')::uuid from photo_deletion)),
  'o gate de aquisição do Auth continua fechado com o efeito leased'
);

-- Falha terminal: o fence libera, o marcador durável registra a falha e o
-- localizador continua somente em groups.photo_url.
update private.external_effects
set status = 'dead', lease_token = null, lease_until = null,
    last_error_code = 'STORAGE_UNAVAILABLE', completed_at = now()
where resource_id = '15200000-0000-4000-8000-000000000030';

select results_eq(
  $$select status, has_operational_failure from private.deletion_requests
    where profile_id = '15100000-0000-4000-8000-000000000030'$$,
  $$values ('deleting_auth'::text, true)$$,
  'dead de group_photo reconcilia com falha operacional durável'
);
select is(
  (select count(*) from private.external_effects
   where kind = 'delete_auth_user'
     and resource_id = (select (response -> 'outcome' ->> 'deletion_request_id')::uuid
                        from photo_deletion)),
  1::bigint,
  'a política terminal explícita libera o Auth'
);
select is(
  (select photo_url from public.groups where id = '15200000-0000-4000-8000-000000000030'),
  'groups/census-solo-photo-path.webp',
  'sem ausência confirmada, o path não é zerado'
);

-- Uma chave que não é da ocasião desta saga, ou um grupo que não foi
-- arquivado pela saga do dono, nunca vira alvo.
insert into private.external_effects
  (id, kind, resource_type, resource_id, dedupe_key, status, attempts, lease_token, lease_until)
values
  ('15700000-0000-4000-8000-000000000001', 'delete_storage_object', 'group_photo',
   '15200000-0000-4000-8000-000000000030', 'delete_storage_object:group_photo:forged',
   'leased', 1, '15600000-0000-4000-8000-000000000002', clock_timestamp() + interval '5 minutes'),
  ('15700000-0000-4000-8000-000000000002', 'delete_storage_object', 'group_photo',
   '15200000-0000-4000-8000-000000000001',
   'delete_storage_object:group_photo:15200000-0000-4000-8000-000000000001:15500000-0000-4000-8000-000000000001',
   'leased', 1, '15600000-0000-4000-8000-000000000003', clock_timestamp() + interval '5 minutes');
select throws_ok(
  $$select public.worker_get_deletion_effect_target(
      '15700000-0000-4000-8000-000000000001', '15600000-0000-4000-8000-000000000002')$$,
  '22023', 'VALIDATION', 'chave forjada não recebe alvo de Storage');
select throws_ok(
  $$select public.worker_confirm_deletion_effect(
      '15700000-0000-4000-8000-000000000002', '15600000-0000-4000-8000-000000000003')$$,
  '22023', 'VALIDATION', 'a foto de um grupo vivo nunca é confirmada como apagada');
select is(
  (select photo_url from public.groups where id = '15200000-0000-4000-8000-000000000001'),
  'groups/census-a-photo-path.webp',
  'o grupo vivo conserva a foto'
);
delete from private.external_effects
where id in ('15700000-0000-4000-8000-000000000001', '15700000-0000-4000-8000-000000000002');

-- ---------------------------------------------------------------------------
-- colete-export-v1: groups no snapshot do banco
-- ---------------------------------------------------------------------------

insert into public.privacy_requests (id, profile_id, kind) values
  ('15800000-0000-4000-8000-000000000001', '15100000-0000-4000-8000-000000000003', 'access');
insert into private.data_exports (id, privacy_request_id, profile_id) values
  ('15900000-0000-4000-8000-000000000001', '15800000-0000-4000-8000-000000000001',
   '15100000-0000-4000-8000-000000000003');
insert into private.external_effects
  (id, kind, resource_type, resource_id, dedupe_key, status, attempts, lease_token, lease_until)
values
  ('15700000-0000-4000-8000-000000000010', 'build_data_export', 'data_export',
   '15900000-0000-4000-8000-000000000001',
   'build_data_export:15900000-0000-4000-8000-000000000001', 'leased', 1,
   '15600000-0000-4000-8000-000000000010', clock_timestamp() + interval '5 minutes');

create temporary table group_export as
select public.worker_get_data_export_build_target(
  '15700000-0000-4000-8000-000000000010', '15600000-0000-4000-8000-000000000010') -> 'snapshot'
  as snapshot;

select results_eq(
  $$select entry ->> 'group_id', entry ->> 'group_name', entry ->> 'status'
    from group_export, jsonb_array_elements(snapshot -> 'groups') with ordinality as rows(entry, n)
    order by n$$,
  $$values ('15200000-0000-4000-8000-000000000001'::text, 'Grupo A'::text, 'pending'::text),
           ('15200000-0000-4000-8000-000000000002', 'Grupo B', 'pending')$$,
  'uma entrada por membership própria, em ordem de group_id'
);
select is(
  (select array_agg(distinct key order by key)
   from group_export, jsonb_array_elements(snapshot -> 'groups') entry,
        jsonb_object_keys(entry) key),
  array['group_id', 'group_name', 'is_monthly', 'joined_at', 'removal_count', 'removed_at',
        'role', 'status'],
  'cada entrada tem exatamente os oito campos de docs/25 §3.4'
);
select ok(
  (select (snapshot -> 'groups')::text !~ '(census-|15100000-0000-4000-8000-000000000001|group-a-|photo|digest|nonce|token)'
   from group_export),
  'groups.json não carrega membro terceiro, dono, digest, nonce, token nem foto'
);

-- ---------------------------------------------------------------------------
-- Censo por valor: path, token e PII de fixture
-- ---------------------------------------------------------------------------
-- No padrão da 0012: o censo procura os valores exatos da fixture, não só
-- rótulos. As colunas que guardam o valor por desenho (photo_url e
-- token_digest) ficam fora do texto examinado.

create temporary table census_needles as
select '(census-|example[.]invalid|15000000-0000-4000-8000-0000000000[0-9]{2}|15400000-0000-4000-8000-0000000000[0-9]{2}|00112233445566778899aabbccddeeff)'::text
  as pattern;

select is(
  (select count(*) from public.groups grp, census_needles
   where (to_jsonb(grp) - 'photo_url')::text ~* pattern),
  0::bigint,
  'groups não repete path, token nem PII fora de photo_url'
);
select is(
  (select count(*) from public.group_members membership, census_needles
   where to_jsonb(membership)::text ~* pattern),
  0::bigint,
  'group_members não contém path, token nem PII'
);
select is(
  (select count(*) from public.group_invites invite, census_needles
   where (to_jsonb(invite) - 'token_digest' - 'public_nonce')::text ~* pattern),
  0::bigint,
  'group_invites não repete o material fora das colunas de digest e nonce'
);
select is(
  (select count(*) from private.external_effects effect, census_needles
   where effect.dedupe_key ~* pattern or coalesce(effect.last_error_code, '') ~* pattern),
  0::bigint,
  'o livro de efeitos não contém path, token nem PII'
);
select is(
  (select count(*) from private.idempotency_records record, census_needles
   where coalesce(record.outcome::text, '') ~* pattern
      or record.actor_key ~* pattern),
  0::bigint,
  'o livro de idempotência não contém path, token nem PII'
);
select is(
  (select count(*) from private.deletion_requests request, census_needles
   where coalesce(request.last_error_code, '') ~* pattern),
  0::bigint,
  'a saga não guarda path nem token em texto operacional'
);
-- Contraprova do próprio censo: um path gravado onde não deveria é achado.
-- last_error_code já recusa texto livre por CHECK; a chave é o texto livre
-- restante do livro de efeitos.
insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
values ('delete_storage_object', 'group_photo', '15200000-0000-4000-8000-000000000099',
        'delete_storage_object:group_photo:groups/census-solo-photo-path.webp');
select is(
  (select count(*) from private.external_effects effect, census_needles
   where effect.dedupe_key ~* pattern),
  1::bigint,
  'o censo por valor detecta o path quando ele vaza para a chave de um efeito'
);

select * from finish();

rollback;
