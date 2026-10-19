begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Colunas: valores fechados e padrão bola/azul
-- ---------------------------------------------------------------------------
select col_not_null('public', 'groups', 'icon', 'icon is never null');
select col_not_null('public', 'groups', 'color', 'color is never null');
select col_default_is('public', 'groups', 'icon', 'ball', 'icon defaults to the ball');
select col_default_is('public', 'groups', 'color', 'blue', 'color defaults to blue');
select is((select pg_get_constraintdef(oid) from pg_constraint
  where conrelid = 'public.groups'::regclass and conname = 'groups_icon_check'),
  $$CHECK ((icon = ANY (ARRAY['ball'::text, 'goal'::text, 'field'::text, 'whistle'::text, 'shirt'::text, 'trophy'::text, 'bolt'::text, 'flame'::text])))$$,
  'the icon list is exactly the eight of the prévia');
select is((select pg_get_constraintdef(oid) from pg_constraint
  where conrelid = 'public.groups'::regclass and conname = 'groups_color_check'),
  $$CHECK ((color = ANY (ARRAY['blue'::text, 'green'::text, 'orange'::text, 'pink'::text, 'lilac'::text, 'sand'::text])))$$,
  'the colour list is exactly the six of the prévia');

-- ---------------------------------------------------------------------------
-- RPC: assinatura estreita, ACL e modo
-- ---------------------------------------------------------------------------
select has_function('public', 'set_group_appearance',
  array['uuid','uuid','uuid','text','integer','integer','uuid','text','text']::name[],
  'set_group_appearance has the narrow internal signature');
select ok(not has_function_privilege('public',
  'public.set_group_appearance(uuid,uuid,uuid,text,integer,integer,uuid,text,text)', 'execute')
  and not has_function_privilege('anon',
  'public.set_group_appearance(uuid,uuid,uuid,text,integer,integer,uuid,text,text)', 'execute')
  and not has_function_privilege('authenticated',
  'public.set_group_appearance(uuid,uuid,uuid,text,integer,integer,uuid,text,text)', 'execute'),
  'no client role executes set_group_appearance or spoofs an actor');
select ok(has_function_privilege('service_role',
  'public.set_group_appearance(uuid,uuid,uuid,text,integer,integer,uuid,text,text)', 'execute'),
  'only the nominal service role executes set_group_appearance');
select ok((select prosecdef and provolatile = 'v' and proconfig = array['search_path=""']
  from pg_proc where oid =
  'public.set_group_appearance(uuid,uuid,uuid,text,integer,integer,uuid,text,text)'::regprocedure),
  'volatile security definer with fixed search_path');
select ok((select pg_get_functiondef(oid) like '%for no key update%'
  and pg_get_functiondef(oid) not like '%for update;%'
  from pg_proc where oid =
  'public.set_group_appearance(uuid,uuid,uuid,text,integer,integer,uuid,text,text)'::regprocedure),
  'domain locks keep the M2-D13 mode');
select ok(not has_table_privilege('service_role', 'public.groups', 'SELECT,INSERT,UPDATE,DELETE'),
  'service_role still has no direct group DML or SELECT');
select ok(not has_column_privilege('authenticated', 'public.groups', 'icon', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.groups', 'color', 'UPDATE')
  and has_column_privilege('authenticated', 'public.groups', 'icon', 'SELECT')
  and has_column_privilege('authenticated', 'public.groups', 'color', 'SELECT'),
  'a member reads icon and color; no client writes them');

-- ---------------------------------------------------------------------------
-- Livro de idempotência: desfecho fechado, só o ID do grupo
-- ---------------------------------------------------------------------------
select lives_ok($$select private.validate_idempotency_outcome('set_group_appearance',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_appearance_set"}'::jsonb)$$,
  'the exact safe outcome is valid');
select throws_ok($$select private.validate_idempotency_outcome('set_group_appearance',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_appearance_set","icon":"ball"}'::jsonb)$$,
  '22023', 'VALIDATION', 'the choice cannot be stored in the outcome');
select throws_ok($$select private.validate_idempotency_outcome('set_group_appearance',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_renamed"}'::jsonb)$$,
  '22023', 'VALIDATION', 'the logical result is closed');
select throws_ok($$select private.validate_idempotency_outcome('set_group_appearance',
  '{"group_id":"01890F7E-E948-4C53-B13A-4A36E4B7D21E","logical_result":"group_appearance_set"}'::jsonb)$$,
  '22023', 'VALIDATION', 'the group ID is canonical lowercase');
select lives_ok($$select private.validate_idempotency_outcome('set_match_payment',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"payment_unchanged","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f","profile_id":"01890f7e-e948-4c53-b13a-4a36e4b7d210"}'::jsonb)$$,
  'the chain still delegates earlier operations');
select ok((select pg_get_constraintdef(oid) like '%set_group_appearance%' from pg_constraint
  where conname = 'idempotency_records_operation_check'),
  'operation list includes set_group_appearance');
select ok((select pg_get_constraintdef(oid) like '%group_appearance_set%' from pg_constraint
  where conname = 'idempotency_records_outcome_code_check'),
  'outcome list includes group_appearance_set');

-- ---------------------------------------------------------------------------
-- Atores: dono, organizador, jogador, ex-membro, pendente e estranho
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('25000000-0000-4000-8000-000000000001', 'look25-owner@example.invalid'),
  ('25000000-0000-4000-8000-000000000002', 'look25-organizer@example.invalid'),
  ('25000000-0000-4000-8000-000000000003', 'look25-player@example.invalid'),
  ('25000000-0000-4000-8000-000000000004', 'look25-former@example.invalid'),
  ('25000000-0000-4000-8000-000000000005', 'look25-pending@example.invalid'),
  ('25000000-0000-4000-8000-000000000006', 'look25-stranger@example.invalid');
insert into public.profiles (id, auth_user_id, name, account_status) values
  ('25100000-0000-4000-8000-000000000001', '25000000-0000-4000-8000-000000000001', 'Dona', 'active'),
  ('25100000-0000-4000-8000-000000000002', '25000000-0000-4000-8000-000000000002', 'Org', 'active'),
  ('25100000-0000-4000-8000-000000000003', '25000000-0000-4000-8000-000000000003', 'Jogador', 'active'),
  ('25100000-0000-4000-8000-000000000004', '25000000-0000-4000-8000-000000000004', 'Ex', 'active'),
  ('25100000-0000-4000-8000-000000000005', '25000000-0000-4000-8000-000000000005', 'Pendente', 'active'),
  ('25100000-0000-4000-8000-000000000006', '25000000-0000-4000-8000-000000000006', 'Fora', 'active');
-- Grupo criado sem ícone nem cor: o padrão vale para os novos.
insert into public.groups (id, name, owner_id) values
  ('25200000-0000-4000-8000-000000000001', 'Grupo Visual', '25100000-0000-4000-8000-000000000001'),
  ('25200000-0000-4000-8000-000000000002', 'Grupo Arquivado', '25100000-0000-4000-8000-000000000001');
insert into public.group_members (group_id, profile_id, role, status, removed_at) values
  ('25200000-0000-4000-8000-000000000001', '25100000-0000-4000-8000-000000000001', 'player', 'active', null),
  ('25200000-0000-4000-8000-000000000001', '25100000-0000-4000-8000-000000000002', 'organizer', 'active', null),
  ('25200000-0000-4000-8000-000000000001', '25100000-0000-4000-8000-000000000003', 'player', 'active', null),
  ('25200000-0000-4000-8000-000000000001', '25100000-0000-4000-8000-000000000004', 'organizer', 'removed', now()),
  ('25200000-0000-4000-8000-000000000001', '25100000-0000-4000-8000-000000000005', 'organizer', 'pending', null),
  ('25200000-0000-4000-8000-000000000002', '25100000-0000-4000-8000-000000000001', 'player', 'active', null);
update public.groups set archived_at = now() where id = '25200000-0000-4000-8000-000000000002';

select is((select icon || '/' || color from public.groups
  where id = '25200000-0000-4000-8000-000000000001'), 'ball/blue',
  'a group created without a choice is the blue ball');
select throws_ok($$update public.groups set icon = 'rocket'
  where id = '25200000-0000-4000-8000-000000000001'$$, '23514', null,
  'the table refuses an icon outside the list');
select throws_ok($$update public.groups set color = '#FF0000'
  where id = '25200000-0000-4000-8000-000000000001'$$, '23514', null,
  'the table refuses a colour outside the list');

-- Chamada como a Edge faz: transporte interno com HMAC de formato válido.
create temporary table look_calls (label text, auth_id uuid, icon text, color text, code text, message text);
insert into look_calls values
  ('organizer', '25000000-0000-4000-8000-000000000002', 'trophy', 'green', '42501', 'OWNER_ONLY'),
  ('player', '25000000-0000-4000-8000-000000000003', 'trophy', 'green', '42501', 'OWNER_ONLY'),
  ('former member', '25000000-0000-4000-8000-000000000004', 'trophy', 'green', '42501', 'NOT_MEMBER'),
  ('pending organizer', '25000000-0000-4000-8000-000000000005', 'trophy', 'green', '42501', 'NOT_MEMBER'),
  ('stranger', '25000000-0000-4000-8000-000000000006', 'trophy', 'green', '42501', 'NOT_MEMBER'),
  ('owner, icon outside the list', '25000000-0000-4000-8000-000000000001', 'rocket', 'green', '22023', 'VALIDATION'),
  ('owner, colour outside the list', '25000000-0000-4000-8000-000000000001', 'trophy', '#FF0000', '22023', 'VALIDATION'),
  ('owner, label instead of key', '25000000-0000-4000-8000-000000000001', 'Bola', 'Azul', '22023', 'VALIDATION'),
  ('owner, no icon', '25000000-0000-4000-8000-000000000001', null, 'green', '22023', 'VALIDATION'),
  ('owner, no colour', '25000000-0000-4000-8000-000000000001', 'trophy', null, '22023', 'VALIDATION');
select throws_ok(format($$select public.set_group_appearance(%L, gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1,
    '25200000-0000-4000-8000-000000000001', %L, %L)$$, auth_id, icon, color),
  code, message, 'refused: ' || label)
from look_calls;
select is((select icon || '/' || color from public.groups
  where id = '25200000-0000-4000-8000-000000000001'), 'ball/blue',
  'every refusal leaves the choice untouched');
select is((select count(*)::integer from private.idempotency_records
  where operation = 'set_group_appearance'), 0, 'no refusal leaves a ledger row behind');
select throws_ok($$select public.set_group_appearance('25000000-0000-4000-8000-000000000001',
    gen_random_uuid(), gen_random_uuid(), repeat('a', 64), 1, 1,
    '25200000-0000-4000-8000-000000000002', 'trophy', 'green')$$,
  'P0001', 'GROUP_ARCHIVED', 'an archived group refuses the change');
select throws_ok($$select public.set_group_appearance(null, gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1,
    '25200000-0000-4000-8000-000000000001', 'trophy', 'green')$$,
  '28000', 'UNAUTHENTICATED', 'no actor, no change');
insert into private.revoked_auth_sessions (session_id, profile_id, expires_at) values
  ('25900000-0000-4000-8000-000000000001', '25100000-0000-4000-8000-000000000001',
   now() + interval '1 hour');
select throws_ok($$select public.set_group_appearance('25000000-0000-4000-8000-000000000001',
    '25900000-0000-4000-8000-000000000001', gen_random_uuid(), repeat('a', 64), 1, 1,
    '25200000-0000-4000-8000-000000000001', 'trophy', 'green')$$,
  '28000', 'UNAUTHENTICATED', 'a revoked session cannot change the choice');

-- O dono troca; o replay devolve o mesmo desfecho e a escolha corrente.
create temporary table look_answers (n integer, answer jsonb);
insert into look_answers select 1, public.set_group_appearance(
  '25000000-0000-4000-8000-000000000001', '25900000-0000-4000-8000-000000000002',
  '25800000-0000-4000-8000-000000000001', repeat('b', 64), 1, 1,
  '25200000-0000-4000-8000-000000000001', 'trophy', 'green');
select is((select answer from look_answers where n = 1),
  '{"outcome":{"group_id":"25200000-0000-4000-8000-000000000001","logical_result":"group_appearance_set"},"current":{"group_id":"25200000-0000-4000-8000-000000000001","icon":"trophy","color":"green"}}'::jsonb,
  'the owner sets trophy/green and gets the safe outcome with the current choice');
select is((select icon || '/' || color from public.groups
  where id = '25200000-0000-4000-8000-000000000001'), 'trophy/green',
  'the group now carries the owner''s choice');
select is((select outcome from private.idempotency_records
  where operation = 'set_group_appearance'),
  '{"group_id":"25200000-0000-4000-8000-000000000001","logical_result":"group_appearance_set"}'::jsonb,
  'the ledger keeps only the group ID and the logical result');
update public.groups set color = 'sand' where id = '25200000-0000-4000-8000-000000000001';
insert into look_answers select 2, public.set_group_appearance(
  '25000000-0000-4000-8000-000000000001', '25900000-0000-4000-8000-000000000002',
  '25800000-0000-4000-8000-000000000001', repeat('b', 64), 1, 1,
  '25200000-0000-4000-8000-000000000001', 'trophy', 'green');
select is((select answer -> 'current' ->> 'color' from look_answers where n = 2), 'sand',
  'a replay does not write again and projects the fresh choice');
select throws_ok($$select public.set_group_appearance('25000000-0000-4000-8000-000000000001',
    '25900000-0000-4000-8000-000000000002', '25800000-0000-4000-8000-000000000001',
    repeat('c', 64), 1, 1, '25200000-0000-4000-8000-000000000001', 'flame', 'pink')$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'the same key with another intention conflicts');

-- ---------------------------------------------------------------------------
-- Leituras: lista e detalhe pela policy; Agenda pelas RPCs da Edge
-- ---------------------------------------------------------------------------
insert into private.matches (id, group_id, starts_at, ends_at, timezone, location_name,
  field_slots, field_price, created_by) values
  ('25300000-0000-4000-8000-000000000001', '25200000-0000-4000-8000-000000000001',
   now() + interval '1 day', now() + interval '1 day 90 minutes', 'America/Sao_Paulo',
   'Arena', 14, 25, '25100000-0000-4000-8000-000000000001');
select is((select group_icon || '/' || group_color from public.list_my_matches(
  '25000000-0000-4000-8000-000000000003', gen_random_uuid())), 'trophy/sand',
  'the Agenda list projects the group icon and colour to a player');
select is((select group_icon || '/' || group_color from public.get_match(
  '25000000-0000-4000-8000-000000000003', gen_random_uuid(),
  '25300000-0000-4000-8000-000000000001')), 'trophy/sand',
  'the match detail projects the group icon and colour');
select ok((select prosecdef and proconfig = array['search_path=""']
  and not has_function_privilege('authenticated', oid, 'execute')
  and has_function_privilege('service_role', oid, 'execute')
  from pg_proc where oid = 'public.list_my_matches(uuid,uuid)'::regprocedure)
  and (select prosecdef and proconfig = array['search_path=""']
  and not has_function_privilege('authenticated', oid, 'execute')
  and has_function_privilege('service_role', oid, 'execute')
  from pg_proc where oid = 'public.get_match(uuid,uuid,uuid)'::regprocedure),
  'the recreated reads keep their privileges and mode');

set local role authenticated;
set local request.jwt.claims = '{"sub":"25000000-0000-4000-8000-000000000003","role":"authenticated"}';
select is((select icon || '/' || color from public.groups
  where id = '25200000-0000-4000-8000-000000000001'), 'trophy/sand',
  'every active member reads the choice in the list and the detail');
select throws_ok($$update public.groups set icon = 'flame'
  where id = '25200000-0000-4000-8000-000000000001'$$, '42501', null,
  'a member cannot write the icon around the RPC');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"25000000-0000-4000-8000-000000000006","role":"authenticated"}';
select is((select count(*)::integer from public.groups
  where id = '25200000-0000-4000-8000-000000000001'), 0, 'a stranger reads nothing');
reset role;

select * from finish();
rollback;
