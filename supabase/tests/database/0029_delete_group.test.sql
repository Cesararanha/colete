begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Estado do encerramento: tabela privada, sem RLS e sem privilégio
-- ---------------------------------------------------------------------------
select has_table('private', 'group_deletions', 'the closed state lives in private');
select columns_are('private', 'group_deletions',
  array['group_id', 'deleted_by', 'deleted_at']::name[],
  'group_deletions holds the group, who deleted it and when, nothing else');
select col_is_pk('private', 'group_deletions', 'group_id', 'one closure per group');
select fk_ok('private', 'group_deletions', 'group_id', 'public', 'groups', 'id',
  'the closure points at the preserved group row');
select fk_ok('private', 'group_deletions', 'deleted_by', 'public', 'profiles', 'id',
  'who deleted is a profile');
select col_not_null('private', 'group_deletions', 'deleted_by', 'the closure always has an author');
select col_not_null('private', 'group_deletions', 'deleted_at', 'the closure always has an instant');
select ok((select not relrowsecurity and not relforcerowsecurity from pg_class
  where oid = 'private.group_deletions'::regclass),
  'group_deletions is a private service table without RLS, by choice (docs/14 section 5.2)');
select ok(not has_table_privilege(role, 'private.group_deletions', privilege), role || ' has no ' || privilege)
from (values ('anon'), ('authenticated'), ('service_role')) as roles(role),
  (values ('select'), ('insert'), ('update'), ('delete')) as privileges(privilege);

-- ---------------------------------------------------------------------------
-- RPC e helpers: assinatura estreita, ACL e modo
-- ---------------------------------------------------------------------------
select ok(to_regprocedure('public.delete_group(uuid,uuid,uuid,text,integer,integer,uuid)') is not null,
  'delete_group(group_id, request_id) exists with the actor context');
select ok(not has_function_privilege(role, 'public.delete_group(uuid,uuid,uuid,text,integer,integer,uuid)', 'execute'),
  role || ' does not execute delete_group')
from (values ('public'), ('anon'), ('authenticated')) as roles(role);
select ok(has_function_privilege('service_role',
  'public.delete_group(uuid,uuid,uuid,text,integer,integer,uuid)', 'execute'),
  'only the nominal service role executes delete_group');
select ok((select prosecdef and provolatile = 'v' and proconfig = array['search_path=""']
  from pg_proc where oid = 'public.delete_group(uuid,uuid,uuid,text,integer,integer,uuid)'::regprocedure),
  'delete_group is volatile security definer with fixed search_path');
select ok(not has_function_privilege(role, signature, 'execute'), signature || ' is not executable by ' || role)
from (values ('private.is_group_deleted(uuid)'),
  ('private.check_idempotency_conclusion(private.idempotency_records)'),
  ('private.group_actor_authority(uuid,uuid)'), ('private.match_actor_authority(uuid,uuid)'),
  ('private.join_group_invite(text,uuid,uuid,uuid,text,integer,integer,uuid,smallint,text,text)'))
  as helpers(signature),
  (values ('anon'), ('authenticated'), ('service_role')) as roles(role);
select ok((select prosecdef and proconfig = array['search_path=""']
  and not has_function_privilege('authenticated', oid, 'execute')
  and has_function_privilege('service_role', oid, 'execute')
  from pg_proc where oid = to_regprocedure(signature)),
  signature || ' keeps its privileges and mode')
from (values ('public.create_match(uuid,uuid,uuid,text,integer,integer,uuid,jsonb)'),
  ('public.get_group_members(uuid,uuid,uuid)')) as reads(signature);
-- A prévia continua só leitura: o PostgreSQL recusa trava dentro dela.
select is((select provolatile::text from pg_proc
  where oid = 'private.preview_group_invite(uuid,uuid,uuid,smallint,text,text)'::regprocedure),
  's', 'the invite preview stays STABLE, without locks (0026/0027)');

-- ---------------------------------------------------------------------------
-- Livro de idempotência: desfecho fechado e operações anteriores preservadas
-- ---------------------------------------------------------------------------
select lives_ok($$select private.validate_idempotency_outcome('delete_group',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_deleted"}'::jsonb)$$,
  'delete_group outcome with the group only is valid');
select throws_ok($$select private.validate_idempotency_outcome('delete_group',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_deleted","canceled_matches":2}'::jsonb)$$,
  '22023', 'VALIDATION', 'nothing but the group and the result enters the outcome');
select throws_ok($$select private.validate_idempotency_outcome('delete_group',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_renamed"}'::jsonb)$$,
  '22023', 'VALIDATION', 'delete_group has its own closed result');
select lives_ok($$select private.validate_idempotency_outcome('cancel_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_canceled","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  'the chain still delegates cancel_match (0028)');
select lives_ok($$select private.validate_idempotency_outcome('set_group_appearance',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_appearance_set"}'::jsonb)$$,
  'and set_group_appearance (0027)');
select ok((select count(*) = 18 from private.idempotency_operations where operation in ('complete_profile', 'delete_account', 'request_data_export', 'approve_member', 'transfer_ownership', 'leave_group', 'create_group', 'join_by_code', 'issue_group_invite', 'rename_group', 'create_match', 'join_match', 'leave_match', 'set_match_payment', 'set_group_appearance', 'update_match', 'cancel_match', 'delete_group')),
  'the operation registry keeps every earlier operation and has delete_group');
select ok((select count(distinct logical_result) = 3 from private.idempotency_operation_results where logical_result in ('group_appearance_set', 'match_cancel_unchanged', 'group_deleted')),
  'the result registry keeps the earlier results and has group_deleted');

-- ---------------------------------------------------------------------------
-- Atores, grupos, rachas e convites
-- ---------------------------------------------------------------------------
insert into auth.users (id, email)
select ('29000000-0000-4000-8000-0000000000' || n)::uuid, 'del29-' || n || '@example.invalid'
from (values ('01'), ('02'), ('03'), ('04'), ('05'), ('06'), ('07'), ('08'), ('09'), ('10'),
  ('11'), ('12')) as actors(n);
insert into public.profiles (id, auth_user_id, name, account_status)
select ('29100000-0000-4000-8000-0000000000' || n)::uuid,
  ('29000000-0000-4000-8000-0000000000' || n)::uuid, name, 'active'
from (values ('01', 'Dona'), ('02', 'Org'), ('03', 'Jogador'), ('04', 'Ex'), ('05', 'Pendente'),
  ('06', 'Fora'), ('07', 'Cinco'), ('08', 'Oito'), ('09', 'Nove'), ('10', 'Dez'),
  ('11', 'Onze'), ('12', 'Doze')) as actors(n, name);

-- 01: o grupo apagado. 02: grupo vivo de controle. 03 a 06: os outros quatro
-- grupos ativos de Cinco. 07: o grupo em que Cinco tenta entrar.
insert into public.groups (id, name, owner_id) values
  ('29200000-0000-4000-8000-000000000001', 'Grupo Apagar', '29100000-0000-4000-8000-000000000001'),
  ('29200000-0000-4000-8000-000000000002', 'Grupo Vivo', '29100000-0000-4000-8000-000000000002'),
  ('29200000-0000-4000-8000-000000000003', 'Grupo Três', '29100000-0000-4000-8000-000000000006'),
  ('29200000-0000-4000-8000-000000000004', 'Grupo Quatro', '29100000-0000-4000-8000-000000000006'),
  ('29200000-0000-4000-8000-000000000005', 'Grupo Cinco', '29100000-0000-4000-8000-000000000006'),
  ('29200000-0000-4000-8000-000000000006', 'Grupo Seis', '29100000-0000-4000-8000-000000000006'),
  ('29200000-0000-4000-8000-000000000007', 'Grupo Sete', '29100000-0000-4000-8000-000000000006');
insert into public.group_members (group_id, profile_id, role, status, removed_at) values
  ('29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000001', 'organizer', 'active', null),
  ('29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000002', 'organizer', 'active', null),
  ('29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000003', 'player', 'active', null),
  ('29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000004', 'organizer', 'removed', now() - interval '2 days'),
  ('29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000005', 'player', 'pending', null),
  ('29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000007', 'player', 'active', null),
  ('29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000008', 'player', 'active', null),
  ('29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000009', 'player', 'pending', null),
  ('29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000011', 'player', 'active', null),
  ('29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000012', 'player', 'active', null),
  ('29200000-0000-4000-8000-000000000002', '29100000-0000-4000-8000-000000000002', 'organizer', 'active', null),
  ('29200000-0000-4000-8000-000000000002', '29100000-0000-4000-8000-000000000003', 'player', 'active', null);
update public.group_members set removal_count = 1
where group_id = '29200000-0000-4000-8000-000000000001'
  and profile_id = '29100000-0000-4000-8000-000000000005';
insert into public.group_members (group_id, profile_id, role, status)
select grp, '29100000-0000-4000-8000-000000000006'::uuid, 'organizer', 'active'
from unnest(array['29200000-0000-4000-8000-000000000003', '29200000-0000-4000-8000-000000000004',
  '29200000-0000-4000-8000-000000000005', '29200000-0000-4000-8000-000000000006',
  '29200000-0000-4000-8000-000000000007']::uuid[]) as grp
union all
select grp, '29100000-0000-4000-8000-000000000007'::uuid, 'player', 'active'
from unnest(array['29200000-0000-4000-8000-000000000003', '29200000-0000-4000-8000-000000000004',
  '29200000-0000-4000-8000-000000000005', '29200000-0000-4000-8000-000000000006']::uuid[]) as grp;

-- 01: futuro, 2 vagas, Jogador e Cinco confirmados, Doze na espera.
-- 02: em andamento. 03: terminado. 04: futuro, cancelado antes por Org.
-- 05: futuro, no grupo vivo.
insert into private.matches (id, group_id, starts_at, ends_at, timezone, location_name,
  field_slots, field_price, created_by) values
  ('29300000-0000-4000-8000-000000000001', '29200000-0000-4000-8000-000000000001',
   date_trunc('minute', now()) + interval '2 days',
   date_trunc('minute', now()) + interval '2 days 90 minutes', 'America/Sao_Paulo',
   'Arena', 2, 15, '29100000-0000-4000-8000-000000000001'),
  ('29300000-0000-4000-8000-000000000002', '29200000-0000-4000-8000-000000000001',
   date_trunc('minute', now()) - interval '30 minutes',
   date_trunc('minute', now()) + interval '60 minutes', 'America/Sao_Paulo',
   'Quadra', 3, 20, '29100000-0000-4000-8000-000000000001'),
  ('29300000-0000-4000-8000-000000000003', '29200000-0000-4000-8000-000000000001',
   date_trunc('minute', now()) - interval '3 hours',
   date_trunc('minute', now()) - interval '1 hour', 'America/Sao_Paulo',
   'Campo', 3, 20, '29100000-0000-4000-8000-000000000001'),
  ('29300000-0000-4000-8000-000000000004', '29200000-0000-4000-8000-000000000001',
   date_trunc('minute', now()) + interval '3 days',
   date_trunc('minute', now()) + interval '3 days 90 minutes', 'America/Sao_Paulo',
   'Ginásio', 2, 10, '29100000-0000-4000-8000-000000000001'),
  ('29300000-0000-4000-8000-000000000005', '29200000-0000-4000-8000-000000000002',
   date_trunc('minute', now()) + interval '2 days',
   date_trunc('minute', now()) + interval '2 days 90 minutes', 'America/Sao_Paulo',
   'Vivo', 2, 10, '29100000-0000-4000-8000-000000000002');
insert into private.match_players (match_id, profile_id, status, queue_seq) values
  ('29300000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000003', 'starter', nextval('private.match_queue_seq')),
  ('29300000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000007', 'starter', nextval('private.match_queue_seq')),
  ('29300000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000012', 'waitlist', nextval('private.match_queue_seq'));

-- 01: vivo. 02: revogado antes. 03: expirado. 04: vivo, revogado por Org antes
-- do encerramento. 05: vivo, no grupo vivo. 07: vivo, no grupo de Fora.
insert into public.group_invites (id, group_id, public_nonce, token_digest, code_digest,
  created_by, expires_at, revoked_at)
select ('29400000-0000-4000-8000-0000000000' || n)::uuid, grp::uuid,
  decode(repeat(n, 16), 'hex'), repeat(n, 31) || 'aa', repeat(n, 31) || 'cc',
  '29100000-0000-4000-8000-000000000001', expires, revoked
from (values
  ('01', '29200000-0000-4000-8000-000000000001', now() + interval '20 days', null::timestamptz),
  ('02', '29200000-0000-4000-8000-000000000001', now() + interval '20 days', now() - interval '1 day'),
  ('03', '29200000-0000-4000-8000-000000000001', now() - interval '1 day', null),
  ('04', '29200000-0000-4000-8000-000000000001', now() + interval '20 days', null),
  ('05', '29200000-0000-4000-8000-000000000002', now() + interval '20 days', null),
  ('07', '29200000-0000-4000-8000-000000000007', now() + interval '20 days', null))
  as invites(n, grp, expires, revoked);

-- Chamadas como a Edge faz: transporte interno com HMAC de formato válido e a
-- sessão de cada ator, que não está na denylist.
create function pg_temp.auth(p_n text) returns uuid language sql as $$
  select ('29000000-0000-4000-8000-0000000000' || p_n)::uuid;
$$;
create function pg_temp.del(p_n text, p_group uuid default '29200000-0000-4000-8000-000000000001',
  p_request uuid default gen_random_uuid()) returns jsonb language sql as $$
  select public.delete_group(pg_temp.auth(p_n), '29900000-0000-4000-8000-000000000000',
    p_request, repeat('a', 64), 1, 1, p_group);
$$;
create function pg_temp.instant(p_value timestamptz) returns text language sql as $$
  select to_char(date_trunc('minute', p_value) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"');
$$;
create function pg_temp.new_cfg(p_days integer) returns jsonb language sql as $$
  select jsonb_build_object('starts_at', pg_temp.instant(now() + make_interval(days => p_days)),
    'ends_at', pg_temp.instant(now() + make_interval(days => p_days, mins => 90)),
    'timezone', 'America/Sao_Paulo', 'location_name', 'Campo novo', 'location_address', null,
    'description', null, 'latitude', null, 'longitude', null, 'field_slots', 8,
    'field_price', '12.00');
$$;
create function pg_temp.cfg(p_match uuid, p_patch jsonb default '{}') returns jsonb
language sql as $$
  select jsonb_build_object(
    'starts_at', to_char(m.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"'),
    'ends_at', to_char(m.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"'),
    'timezone', m.timezone, 'location_name', m.location_name,
    'location_address', m.location_address, 'description', m.description,
    'latitude', m.latitude::text, 'longitude', m.longitude::text,
    'field_slots', m.field_slots, 'field_price', m.field_price::text) || p_patch
  from private.matches m where m.id = p_match;
$$;

-- ---------------------------------------------------------------------------
-- Permissões: só o dono ativo apaga; os demais, a recusa padrão
-- ---------------------------------------------------------------------------
select throws_ok(format($$select pg_temp.del(%L)$$, n), code, message, 'delete refused: ' || label)
from (values
  ('organizer', '02', '42501', 'OWNER_ONLY'),
  ('player', '03', '42501', 'OWNER_ONLY'),
  ('former organizer', '04', '42501', 'NOT_MEMBER'),
  ('pending', '05', '42501', 'NOT_MEMBER'),
  ('stranger', '06', '42501', 'NOT_MEMBER')) as refusals(label, n, code, message);
select throws_ok($$select pg_temp.del('01', '29200000-0000-4000-8000-0000000000ff')$$,
  'P0002', 'NOT_FOUND', 'an unknown group is NOT_FOUND');
select throws_ok($$select public.delete_group(null, gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000001')$$,
  '28000', 'UNAUTHENTICATED', 'no actor, no deletion');
select throws_ok($$select public.delete_group(pg_temp.auth('01'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, null)$$,
  '22023', 'VALIDATION', 'the group is required');
insert into private.revoked_auth_sessions (session_id, profile_id, expires_at) values
  ('29900000-0000-4000-8000-000000000009', '29100000-0000-4000-8000-000000000001',
   now() + interval '1 hour');
select throws_ok($$select public.delete_group(pg_temp.auth('01'),
    '29900000-0000-4000-8000-000000000009', gen_random_uuid(), repeat('a', 64), 1, 1,
    '29200000-0000-4000-8000-000000000001')$$,
  '28000', 'UNAUTHENTICATED', 'a revoked session cannot delete');
update public.groups set suspended_at = now() where id = '29200000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.del('01')$$, 'P0001', 'GROUP_SUSPENDED',
  'a suspended group refuses the deletion');
update public.groups set suspended_at = null where id = '29200000-0000-4000-8000-000000000001';
update public.groups set archived_at = now() where id = '29200000-0000-4000-8000-000000000003';
select throws_ok($$select pg_temp.del('06', '29200000-0000-4000-8000-000000000003')$$,
  'P0001', 'GROUP_ARCHIVED', 'a group archived by account deletion keeps GROUP_ARCHIVED');
update public.groups set archived_at = null where id = '29200000-0000-4000-8000-000000000003';
select is((select count(*)::integer from private.idempotency_records where operation = 'delete_group'),
  0, 'no refusal leaves a ledger row behind');
select is((select count(*)::integer from private.group_deletions), 0, 'and nothing was closed');

-- ---------------------------------------------------------------------------
-- Antes do encerramento: pedidos que depois serão repetidos
-- ---------------------------------------------------------------------------
create temporary table replay_calls (ord serial, label text, call text, first jsonb);
insert into replay_calls (label, call) values
  ('approve_member', $$select public.approve_member(pg_temp.auth('01'), '29900000-0000-4000-8000-000000000000',
    '29700000-0000-4000-8000-000000000001', repeat('a', 64), 1, 1,
    '29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000009', true)$$),
  ('set_role', $$select public.set_role(pg_temp.auth('01'), '29900000-0000-4000-8000-000000000000',
    '29700000-0000-4000-8000-000000000002', repeat('a', 64), 1, 1,
    '29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000008', 'organizer')$$),
  ('set_ratings_visibility', $$select public.set_ratings_visibility(pg_temp.auth('01'),
    '29900000-0000-4000-8000-000000000000', '29700000-0000-4000-8000-000000000003', repeat('a', 64), 1, 1,
    '29200000-0000-4000-8000-000000000001', 'private', false)$$),
  ('rename_group', $$select public.rename_group(pg_temp.auth('01'), '29900000-0000-4000-8000-000000000000',
    '29700000-0000-4000-8000-000000000004', repeat('a', 64), 1, 1,
    '29200000-0000-4000-8000-000000000001', 'Grupo Apagar')$$),
  ('set_group_appearance', $$select public.set_group_appearance(pg_temp.auth('01'),
    '29900000-0000-4000-8000-000000000000', '29700000-0000-4000-8000-000000000005', repeat('a', 64), 1, 1,
    '29200000-0000-4000-8000-000000000001', 'trophy', 'green')$$),
  ('revoke_group_invite', $$select public.revoke_group_invite(pg_temp.auth('02'),
    '29900000-0000-4000-8000-000000000000', '29700000-0000-4000-8000-000000000006', repeat('a', 64), 1, 1,
    '29400000-0000-4000-8000-000000000004')$$),
  ('join_by_code', $$select public.join_by_code(pg_temp.auth('10'), '29900000-0000-4000-8000-000000000000',
    '29700000-0000-4000-8000-000000000007', repeat('a', 64), 1, 1, repeat('01', 31) || 'cc')$$),
  ('create_match', $$select public.create_match(pg_temp.auth('01'), '29900000-0000-4000-8000-000000000000',
    '29700000-0000-4000-8000-000000000008', repeat('a', 64), 1, 1,
    '29200000-0000-4000-8000-000000000001', pg_temp.new_cfg(5))$$),
  ('update_match', $$select public.update_match(pg_temp.auth('02'), '29900000-0000-4000-8000-000000000000',
    '29700000-0000-4000-8000-000000000009', repeat('a', 64), 1, 1,
    '29300000-0000-4000-8000-000000000001',
    pg_temp.cfg('29300000-0000-4000-8000-000000000001', '{"description": "Traga colete"}'))$$),
  ('cancel_match', $$select public.cancel_match(pg_temp.auth('02'), '29900000-0000-4000-8000-000000000000',
    '29700000-0000-4000-8000-000000000010', repeat('a', 64), 1, 1,
    '29300000-0000-4000-8000-000000000004')$$),
  ('join_match', $$select public.join_match(pg_temp.auth('08'), '29900000-0000-4000-8000-000000000000',
    '29700000-0000-4000-8000-000000000011', repeat('a', 64), 1, 1,
    '29300000-0000-4000-8000-000000000001')$$),
  ('leave_match', $$select public.leave_match(pg_temp.auth('07'), '29900000-0000-4000-8000-000000000000',
    '29700000-0000-4000-8000-000000000012', repeat('a', 64), 1, 1,
    '29300000-0000-4000-8000-000000000001')$$),
  ('set_match_payment', $$select public.set_match_payment(pg_temp.auth('01'),
    '29900000-0000-4000-8000-000000000000', '29700000-0000-4000-8000-000000000013', repeat('a', 64), 1, 1,
    '29300000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000003', true)$$),
  ('leave_group, by a member who then is a former member', $$select public.leave_group(pg_temp.auth('11'),
    '29900000-0000-4000-8000-000000000000', '29700000-0000-4000-8000-000000000014', repeat('a', 64), 1, 1,
    '29200000-0000-4000-8000-000000000001')$$);
create function pg_temp.run(p_call text) returns jsonb language plpgsql as $$
declare v_result jsonb;
begin
  execute p_call into v_result;
  return v_result;
end;
$$;
-- Em ordem: a espera de 01 depende de quem entra e de quem sai.
do $$
declare v_ord integer;
begin
  for v_ord in select ord from replay_calls order by ord loop
    update replay_calls set first = pg_temp.run(call) where ord = v_ord;
  end loop;
end;
$$;
select ok(first ? 'outcome', 'before the deletion: ' || label || ' succeeds') from replay_calls;
select results_eq(
  $$select profile_id::text, status from private.match_players
    where match_id = '29300000-0000-4000-8000-000000000001' order by queue_seq$$,
  $$values ('29100000-0000-4000-8000-000000000003', 'starter'),
           ('29100000-0000-4000-8000-000000000007', 'left'),
           ('29100000-0000-4000-8000-000000000012', 'starter'),
           ('29100000-0000-4000-8000-000000000008', 'waitlist')$$,
  'the match before the deletion: Doze promoted, Oito waiting');
-- Cinco tem 5 grupos ativos: o pedido a outro grupo esbarra no limite.
select throws_ok($$select public.join_by_code(pg_temp.auth('07'), '29900000-0000-4000-8000-000000000000',
    gen_random_uuid(), repeat('a', 64), 1, 1, repeat('07', 31) || 'cc')$$,
  'P0001', 'GROUP_LIMIT', 'five active groups block a sixth request before the deletion');
select is((select public.preview_group_by_code(pg_temp.auth('07'), gen_random_uuid(),
    repeat('07', 31) || 'cc') ->> 'refusal'), 'GROUP_LIMIT', 'the invite page shows the limit too');
select is((select count(*)::integer from public.list_my_matches(pg_temp.auth('03'), gen_random_uuid())),
  5, 'the Agenda lists the unfinished matches of both groups before the deletion');

-- 0034: prove the new gate, then unmark explicitly for the closure/replay suite.
select throws_ok($$select pg_temp.del('01')$$,'P0001','ACTIVE_PAYMENTS_REMAIN','marked payment prevents deletion');
update private.match_players p set paid=false,payment_marked_at=null,payment_marked_by=null
from private.matches m where m.id=p.match_id and m.group_id='29200000-0000-4000-8000-000000000001'
 and m.canceled_at is null and m.ends_at>now();

create temporary table ledger_before as
  select operation, request_id, state, outcome, updated_at from private.idempotency_records;
create temporary table matches_before as
  select id, canceled_at, canceled_by from private.matches;

-- ---------------------------------------------------------------------------
-- O dono apaga
-- ---------------------------------------------------------------------------
select is(pg_temp.del('01', p_request => '29700000-0000-4000-8000-000000000099'),
  jsonb_build_object('outcome', jsonb_build_object(
    'group_id', '29200000-0000-4000-8000-000000000001', 'logical_result', 'group_deleted')),
  'the owner deletes the group; the outcome carries only the group and the result');

-- Estado e data.
select results_eq(
  $$select deleted_by::text, deleted_at = now() from private.group_deletions$$,
  $$values ('29100000-0000-4000-8000-000000000001', true)$$,
  'the closure records who and when, at the server instant');
select is((select archived_at from public.groups where id = '29200000-0000-4000-8000-000000000001'),
  now(), 'the group is archived at the same instant');
select is((select row(name, owner_id, icon, color)::text from public.groups
  where id = '29200000-0000-4000-8000-000000000001'),
  row('Grupo Apagar', '29100000-0000-4000-8000-000000000001'::uuid, 'trophy', 'green')::text,
  'the group row is preserved, not deleted');

-- Rachas: o futuro e o em andamento passam a cancelados pelo dono; o
-- terminado e o já cancelado ficam como estavam; o grupo vivo não muda.
select results_eq(
  $$select m.id::text, coalesce(m.canceled_by::text, 'live'),
      m.canceled_at is not distinct from case when m.group_id = '29200000-0000-4000-8000-000000000001'
        and b.canceled_at is null and m.ends_at > now() then now() else b.canceled_at end
    from private.matches m join matches_before b on b.id = m.id
    where m.id::text like '293%' order by m.id$$,
  $$values ('29300000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000001', true),
           ('29300000-0000-4000-8000-000000000002', '29100000-0000-4000-8000-000000000001', true),
           ('29300000-0000-4000-8000-000000000003', 'live', true),
           ('29300000-0000-4000-8000-000000000004', '29100000-0000-4000-8000-000000000002', true),
           ('29300000-0000-4000-8000-000000000005', 'live', true)$$,
  'future and in-progress matches are canceled by the owner; ended, already canceled and other groups are not');
select is((select canceled_by from private.matches
  where id = ((select first from replay_calls where label = 'create_match') -> 'outcome' ->> 'match_id')::uuid),
  '29100000-0000-4000-8000-000000000001'::uuid, 'a match created just before is canceled too');
select is((select count(*)::integer from private.matches m
  join public.groups g on g.id = m.group_id
  where g.id = '29200000-0000-4000-8000-000000000001' and m.canceled_at is null and m.ends_at > now()),
  0, 'no unfinished match of the group is left live');
select results_eq(
  $$select profile_id::text, status, paid from private.match_players
    where match_id = '29300000-0000-4000-8000-000000000001' order by queue_seq$$,
  $$values ('29100000-0000-4000-8000-000000000003', 'starter', false),
           ('29100000-0000-4000-8000-000000000007', 'left', false),
           ('29100000-0000-4000-8000-000000000012', 'starter', false),
           ('29100000-0000-4000-8000-000000000008', 'waitlist', false)$$,
  'the canceled match keeps its lists after the paid mark was cleared for deletion');

-- Convites: todos revogados; o já revogado conserva o instante; o vivo de
-- outro grupo não muda.
select results_eq(
  $$select id::text, revoked_at = now() from public.group_invites
    where id::text like '294%' order by id$$,
  $$values ('29400000-0000-4000-8000-000000000001', true),
           ('29400000-0000-4000-8000-000000000002', false),
           ('29400000-0000-4000-8000-000000000003', true),
           ('29400000-0000-4000-8000-000000000004', true),
           ('29400000-0000-4000-8000-000000000005', null),
           ('29400000-0000-4000-8000-000000000007', null)$$,
  'every invite of the group is revoked, the earlier revocation keeps its instant');
select is((select revoked_at from public.group_invites where id = '29400000-0000-4000-8000-000000000002'),
  now() - interval '1 day', 'the earlier revocation is untouched');
select is((select count(*)::integer from public.group_invites
  where group_id = '29200000-0000-4000-8000-000000000001'), 4, 'no invite row is deleted');

-- Pedidos e memberships.
select results_eq(
  $$select profile_id::text, status, removed_at is not distinct from
      case when profile_id in ('29100000-0000-4000-8000-000000000005', '29100000-0000-4000-8000-000000000010')
        then now() else removed_at end, removal_count
    from public.group_members where group_id = '29200000-0000-4000-8000-000000000001'
    order by profile_id$$,
  $$values ('29100000-0000-4000-8000-000000000001', 'active', true, 0),
           ('29100000-0000-4000-8000-000000000002', 'active', true, 0),
           ('29100000-0000-4000-8000-000000000003', 'active', true, 0),
           ('29100000-0000-4000-8000-000000000004', 'removed', true, 0),
           ('29100000-0000-4000-8000-000000000005', 'removed', true, 1),
           ('29100000-0000-4000-8000-000000000007', 'active', true, 0),
           ('29100000-0000-4000-8000-000000000008', 'active', true, 0),
           ('29100000-0000-4000-8000-000000000009', 'active', true, 0),
           ('29100000-0000-4000-8000-000000000010', 'removed', true, 0),
           ('29100000-0000-4000-8000-000000000011', 'removed', true, 0),
           ('29100000-0000-4000-8000-000000000012', 'active', true, 0)$$,
  'pending requests close as removed now, removal_count unchanged (M2-D9); active stay as history');

-- O livro: um registro concluído, com o grupo como recurso.
select results_eq(
  $$select state, outcome_code, resource_type, resource_id::text from private.idempotency_records
    where operation = 'delete_group'$$,
  $$values ('completed', 'group_deleted', 'group', '29200000-0000-4000-8000-000000000001')$$,
  'the ledger records the deletion with the group as resource');

-- ---------------------------------------------------------------------------
-- Depois: todo replay feito antes do encerramento é recusado
-- ---------------------------------------------------------------------------
create temporary table state_after as
  select 'member' as kind, group_id::text || profile_id::text || status || role as fact
  from public.group_members
  union all select 'player', match_id::text || profile_id::text || status || paid::text from private.match_players
  union all select 'match', id::text || coalesce(canceled_at::text, '-') || coalesce(description, '-') from private.matches
  union all select 'invite', id::text || coalesce(revoked_at::text, '-') from public.group_invites
  union all select 'group', id::text || name || icon || color || coalesce(archived_at::text, '-') from public.groups;
-- O convite de grupo apagado não é achado, como um inexistente: a revogação
-- recusa com NOT_FOUND na busca, antes de qualquer trava (P1 da revisão do #80).
select throws_ok(call, 'P0002',
  case when label = 'revoke_group_invite' then 'NOT_FOUND' else 'GROUP_DELETED' end,
  'replay after the deletion: ' || label)
from replay_calls;
select is((select count(*)::integer from (
    select operation, request_id, state, outcome, updated_at from private.idempotency_records
    except select * from ledger_before) as changed
  where changed.operation <> 'delete_group'), 0,
  'the refused replays keep the completed ledger records as they were');

-- ---------------------------------------------------------------------------
-- Depois: toda chamada nova é recusada, inclusive a do dono
-- ---------------------------------------------------------------------------
create temporary table new_calls (label text, call text, code text, message text);
insert into new_calls values
  ('approve_member', $$select public.approve_member(pg_temp.auth('01'), gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000005', true)$$,
    'P0002', 'GROUP_DELETED'),
  ('remove_member', $$select public.remove_member(pg_temp.auth('01'), gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000003', 'motivo')$$,
    'P0002', 'GROUP_DELETED'),
  ('set_role', $$select public.set_role(pg_temp.auth('01'), gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000003', 'organizer')$$,
    'P0002', 'GROUP_DELETED'),
  ('set_monthly', $$select public.set_monthly(pg_temp.auth('01'), gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000001', '29100000-0000-4000-8000-000000000003', true)$$,
    'P0002', 'GROUP_DELETED'),
  ('set_ratings_visibility', $$select public.set_ratings_visibility(pg_temp.auth('01'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000001', 'members', true)$$,
    'P0002', 'GROUP_DELETED'),
  ('transfer_ownership', $$select public.transfer_ownership(pg_temp.auth('01'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000001',
    '29100000-0000-4000-8000-000000000002')$$, 'P0002', 'GROUP_DELETED'),
  ('leave_group by a member', $$select public.leave_group(pg_temp.auth('03'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000001')$$,
    'P0002', 'GROUP_DELETED'),
  ('leave_group by the owner', $$select public.leave_group(pg_temp.auth('01'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000001')$$,
    'P0002', 'GROUP_DELETED'),
  ('rename_group by the owner', $$select public.rename_group(pg_temp.auth('01'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000001', 'Outro nome')$$,
    'P0002', 'GROUP_DELETED'),
  ('rename_group by a stranger', $$select public.rename_group(pg_temp.auth('06'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000001', 'Outro nome')$$,
    'P0002', 'GROUP_DELETED'),
  ('set_group_appearance', $$select public.set_group_appearance(pg_temp.auth('01'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000001', 'ball', 'blue')$$,
    'P0002', 'GROUP_DELETED'),
  ('revoke_group_invite', $$select public.revoke_group_invite(pg_temp.auth('01'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, '29400000-0000-4000-8000-000000000001')$$,
    'P0002', 'NOT_FOUND'),
  ('regenerate_group_invite', $$select public.regenerate_group_invite(pg_temp.auth('01'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, '29400000-0000-4000-8000-000000000001', 1::smallint,
    repeat('9', 32), repeat('9a', 32), repeat('9c', 32))$$, 'P0002', 'NOT_FOUND'),
  ('issue_group_invite', $$select public.issue_group_invite(pg_temp.auth('01'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000001',
    '29400000-0000-4000-8000-000000000099', 1::smallint, repeat('8', 32), repeat('8a', 32), repeat('8c', 32))$$,
    'P0002', 'NOT_FOUND'),
  ('create_match', $$select public.create_match(pg_temp.auth('01'), gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000001', pg_temp.new_cfg(6))$$,
    'P0002', 'GROUP_DELETED'),
  ('update_match', $$select public.update_match(pg_temp.auth('01'), gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1, '29300000-0000-4000-8000-000000000001',
    pg_temp.cfg('29300000-0000-4000-8000-000000000001', '{"field_slots": 9}'))$$,
    'P0002', 'GROUP_DELETED'),
  ('cancel_match', $$select public.cancel_match(pg_temp.auth('01'), gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1, '29300000-0000-4000-8000-000000000003')$$, 'P0002', 'GROUP_DELETED'),
  ('join_match', $$select public.join_match(pg_temp.auth('09'), gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1, '29300000-0000-4000-8000-000000000001')$$, 'P0002', 'GROUP_DELETED'),
  ('leave_match', $$select public.leave_match(pg_temp.auth('12'), gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1, '29300000-0000-4000-8000-000000000001')$$, 'P0002', 'GROUP_DELETED'),
  ('set_match_payment', $$select public.set_match_payment(pg_temp.auth('01'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, '29300000-0000-4000-8000-000000000001',
    '29100000-0000-4000-8000-000000000012', true)$$, 'P0002', 'GROUP_DELETED'),
  ('delete_group again', $$select pg_temp.del('01')$$, 'P0002', 'GROUP_DELETED'),
  ('join_by_code with the revoked code', $$select public.join_by_code(pg_temp.auth('06'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, repeat('01', 31) || 'cc')$$, 'P0001', 'INVITE_REVOKED'),
  ('join_by_invite with the revoked link', $$select public.join_by_invite(pg_temp.auth('06'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, '29400000-0000-4000-8000-000000000001', 1::smallint,
    repeat('01', 31) || 'aa')$$, 'P0001', 'INVITE_REVOKED');
select throws_ok(call, code, message, 'new call after the deletion: ' || label) from new_calls;
select is((select count(*)::integer from (
    select 'member' as kind, group_id::text || profile_id::text || status || role as fact
    from public.group_members
    union all select 'player', match_id::text || profile_id::text || status || paid::text from private.match_players
    union all select 'match', id::text || coalesce(canceled_at::text, '-') || coalesce(description, '-') from private.matches
    union all select 'invite', id::text || coalesce(revoked_at::text, '-') from public.group_invites
    union all select 'group', id::text || name || icon || color || coalesce(archived_at::text, '-') from public.groups
    except select * from state_after) as changed), 0,
  'no refused call or replay changes a line');
select is((select count(*)::integer from private.idempotency_records ledger
  where not exists (select 1 from ledger_before b where b.request_id = ledger.request_id)
    and ledger.operation <> 'delete_group'), 0,
  'and no refusal leaves a ledger row behind');

-- ---------------------------------------------------------------------------
-- Depois: as leituras respondem como a um grupo que não existe
-- ---------------------------------------------------------------------------
select throws_ok($$select * from public.get_group_members(pg_temp.auth('01'), gen_random_uuid(),
    '29200000-0000-4000-8000-000000000001')$$, '42501', 'NOT_MEMBER',
  'the owner reads no member list, as for an unknown group');
select throws_ok($$select * from public.get_group_members(pg_temp.auth('01'), gen_random_uuid(),
    '29200000-0000-4000-8000-0000000000ff')$$, '42501', 'NOT_MEMBER',
  'which is exactly the unknown group answer');
select throws_ok($$select * from public.get_match(pg_temp.auth('03'), gen_random_uuid(),
    '29300000-0000-4000-8000-000000000001')$$, 'P0002', 'NOT_FOUND',
  'the match detail is NOT_FOUND');
select throws_ok($$select public.get_match_roster(pg_temp.auth('03'), gen_random_uuid(),
    '29300000-0000-4000-8000-000000000001')$$, 'P0002', 'GROUP_DELETED',
  'the roster refuses (the Edge answers NOT_FOUND)');
select throws_ok($$select public.get_invite_share_link(pg_temp.auth('01'), gen_random_uuid(),
    '29400000-0000-4000-8000-000000000001')$$, 'P0002', 'NOT_FOUND',
  'the share link of a deleted group is NOT_FOUND');
select throws_ok($$select public.get_invite_share_link(pg_temp.auth('01'), gen_random_uuid(),
    '29400000-0000-4000-8000-0000000000ee')$$, 'P0002', 'NOT_FOUND',
  'which is exactly the unknown invite answer');
-- Mesmo erro do grupo inexistente na emissão, pela mesma busca travada.
select throws_ok($$select public.issue_group_invite(pg_temp.auth('01'), gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, '29200000-0000-4000-8000-0000000000ff',
    '29400000-0000-4000-8000-000000000098', 1::smallint, repeat('7', 32), repeat('7a', 32), repeat('7c', 32))$$,
  'P0002', 'NOT_FOUND', 'issuing for an unknown group is the same NOT_FOUND');
select is((select count(*)::integer from public.list_my_matches(pg_temp.auth('03'), gen_random_uuid())
  where group_id = '29200000-0000-4000-8000-000000000001'), 0,
  'the Agenda no longer lists the matches of the group');
select is((select string_agg(id::text, ',') from public.list_my_matches(pg_temp.auth('03'), gen_random_uuid())),
  '29300000-0000-4000-8000-000000000005', 'and still lists the other group');
select is((select count(*)::integer from public.get_matches_occupancy(pg_temp.auth('03'), gen_random_uuid())
  where match_id in (select id from private.matches
    where group_id = '29200000-0000-4000-8000-000000000001')),
  0, 'nor counts their occupancy');
select is((select public.get_my_pending_group_requests(pg_temp.auth('05'), gen_random_uuid())),
  '[]'::jsonb, 'the closed request is gone from the pending list');

-- A prévia: o mesmo CODE_INVALID genérico de um código que nunca existiu.
select throws_ok($$select public.preview_group_by_code(pg_temp.auth('06'), gen_random_uuid(),
    repeat('01', 31) || 'cc')$$, '22023', 'CODE_INVALID', 'the code preview is the generic CODE_INVALID');
select throws_ok($$select public.preview_group_by_code(pg_temp.auth('06'), gen_random_uuid(),
    repeat('ee', 32))$$, '22023', 'CODE_INVALID', 'the same answer as a code that never existed');
select throws_ok($$select public.preview_group_by_invite(pg_temp.auth('01'), gen_random_uuid(),
    '29400000-0000-4000-8000-000000000001', 1::smallint, repeat('01', 31) || 'aa')$$,
  '22023', 'CODE_INVALID', 'the link preview too, even for the owner');

-- RLS: nenhum papel cliente lê o grupo, as memberships ou os convites.
set local role authenticated;
set local request.jwt.claims = '{"sub":"29000000-0000-4000-8000-000000000001"}';
select is((select count(*)::integer from public.groups where id = '29200000-0000-4000-8000-000000000001'),
  0, 'the owner no longer reads the group row');
select is((select count(*)::integer from public.group_members
  where group_id = '29200000-0000-4000-8000-000000000001'), 0, 'nor its memberships');
select is((select count(*)::integer from public.group_invites
  where group_id = '29200000-0000-4000-8000-000000000001'), 0, 'nor its invites');
set local request.jwt.claims = '{"sub":"29000000-0000-4000-8000-000000000003"}';
select is((select string_agg(name, ',') from public.groups), 'Grupo Vivo',
  'a member lists only the other group');
reset role;

-- ---------------------------------------------------------------------------
-- O limite de 5 grupos ativos é liberado
-- ---------------------------------------------------------------------------
select is((select public.preview_group_by_code(pg_temp.auth('07'), gen_random_uuid(),
    repeat('07', 31) || 'cc') ->> 'refusal'), null, 'the invite page no longer shows the limit');
select is((select public.join_by_code(pg_temp.auth('07'), gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1, repeat('07', 31) || 'cc') -> 'outcome' ->> 'logical_result'),
  'membership_requested', 'a member of five groups, one of them deleted, asks to join another');
select is((select public.approve_member(pg_temp.auth('06'), gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1, '29200000-0000-4000-8000-000000000007',
    '29100000-0000-4000-8000-000000000007', true) -> 'outcome' ->> 'logical_result'),
  'member_approved', 'and the approval recounts five active groups, not six');

-- ---------------------------------------------------------------------------
-- O replay do próprio encerramento devolve o desfecho, sem repetir o efeito
-- ---------------------------------------------------------------------------
select is(pg_temp.del('01', p_request => '29700000-0000-4000-8000-000000000099'),
  jsonb_build_object('outcome', jsonb_build_object(
    'group_id', '29200000-0000-4000-8000-000000000001', 'logical_result', 'group_deleted')),
  'the same request_id replays the stored outcome');
select is((select count(*)::integer from private.group_deletions), 1, 'without a second closure');
select throws_ok($$select pg_temp.del('02', p_request => '29700000-0000-4000-8000-000000000099')$$,
  'P0002', 'GROUP_DELETED', 'another actor with the same request_id is a new call, refused');
select throws_ok($$select public.delete_group(pg_temp.auth('01'), '29900000-0000-4000-8000-000000000009',
    '29700000-0000-4000-8000-000000000099', repeat('a', 64), 1, 1,
    '29200000-0000-4000-8000-000000000001')$$,
  '28000', 'UNAUTHENTICATED', 'a revoked session gets no outcome on replay (M2-D20)');

-- Um grupo criado pela RPC: apagado, o replay da criação também é recusado.
select is((select public.create_group(pg_temp.auth('11'), gen_random_uuid(),
    '29700000-0000-4000-8000-000000000020', repeat('a', 64), 1, 1, 'Grupo Novo',
    '29400000-0000-4000-8000-000000000020', 1::smallint, repeat('2', 32), repeat('2a', 32), repeat('2c', 32))
    -> 'outcome' ->> 'logical_result'), 'group_created', 'Onze creates a group by the RPC');
select is((select pg_temp.del('11', (select id from public.groups where name = 'Grupo Novo'))
    -> 'outcome' ->> 'logical_result'), 'group_deleted', 'and deletes it, with its initial invite');
select throws_ok($$select public.create_group(pg_temp.auth('11'), gen_random_uuid(),
    '29700000-0000-4000-8000-000000000020', repeat('a', 64), 1, 1, 'Grupo Novo',
    '29400000-0000-4000-8000-000000000020', 1::smallint, repeat('2', 32), repeat('2a', 32), repeat('2c', 32))$$,
  'P0002', 'GROUP_DELETED', 'the creation replay is refused after the deletion');

-- ---------------------------------------------------------------------------
-- Exportação e exclusão de conta continuam com o grupo encerrado
-- ---------------------------------------------------------------------------
insert into public.privacy_requests (id, profile_id, kind) values
  ('29500000-0000-4000-8000-000000000003', '29100000-0000-4000-8000-000000000003', 'access');
insert into private.data_exports (id, privacy_request_id, profile_id) values
  ('29600000-0000-4000-8000-000000000003', '29500000-0000-4000-8000-000000000003',
   '29100000-0000-4000-8000-000000000003');
insert into private.external_effects (id, kind, resource_type, resource_id, dedupe_key, status,
  attempts, lease_token, lease_until) values
  ('29800000-0000-4000-8000-000000000003', 'build_data_export', 'data_export',
   '29600000-0000-4000-8000-000000000003', 'build_data_export:29600000-0000-4000-8000-000000000003',
   'leased', 1, '29800000-0000-4000-8000-000000000004', clock_timestamp() + interval '1 hour');
create temporary table export_target as select public.worker_get_data_export_build_target(
  '29800000-0000-4000-8000-000000000003', '29800000-0000-4000-8000-000000000004') as target;
select is((select target ->> 'action' from export_target), 'build', 'the export still builds');
select is((select jsonb_agg(entry ->> 'group_name' order by entry ->> 'group_name')
  from export_target, jsonb_array_elements(target -> 'snapshot' -> 'groups') as entry),
  '["Grupo Apagar", "Grupo Vivo"]'::jsonb, 'and keeps the deleted group among the memberships');

-- Um membro do grupo apagado exclui a conta: a saída não promove a espera do
-- racha cancelado.
select is((select public.delete_account(pg_temp.auth('03'), gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1) -> 'outcome' ->> 'logical_result'), 'deletion_requested',
  'a member of the deleted group deletes the account');
select results_eq(
  $$select profile_id::text, status from private.match_players
    where match_id = '29300000-0000-4000-8000-000000000001' order by queue_seq$$,
  $$values ('29100000-0000-4000-8000-000000000003', 'starter'),
           ('29100000-0000-4000-8000-000000000007', 'left'),
           ('29100000-0000-4000-8000-000000000012', 'starter'),
           ('29100000-0000-4000-8000-000000000008', 'waitlist')$$,
  'the canceled match preserves history without promoting the waitlist');
-- O dono exclui a conta: o grupo apagado não pede substituto nem troca de dono.
select is((select public.delete_account(pg_temp.auth('01'), gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1) -> 'outcome' ->> 'logical_result'), 'deletion_requested',
  'the owner of the deleted group deletes the account, with active members left in it');
select is((select owner_id from public.groups where id = '29200000-0000-4000-8000-000000000001'),
  '29100000-0000-4000-8000-000000000001'::uuid, 'the deleted group is not handed to the organizer');
select is((select status from public.group_members where group_id = '29200000-0000-4000-8000-000000000001'
  and profile_id = '29100000-0000-4000-8000-000000000001'), 'removed',
  'and the owner membership leaves with the account');

select * from finish();
rollback;
