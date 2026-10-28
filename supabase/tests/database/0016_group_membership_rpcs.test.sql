begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- Provas pgTAP da 0016 (docs/25 §4.3). O que depende de commit real, de
-- concorrência, do gateway HTTP ou dos logs do Postgres fica em
-- scripts/test-group-membership.mjs: trigger diferido e idempotência no
-- commit, pares pela barreira, cota sob 25 conexões, contraprovas de lock e o
-- censo do motivo por HTTP real.
--
-- IDs: 1600… usuários Auth, 1610… perfis, 1620… grupos, 1640… sessões,
-- 1650… pedidos.

-- ---------------------------------------------------------------------------
-- Envelope: allowlists append-only e validador de outcome
-- ---------------------------------------------------------------------------

-- D63.5 (0033): as listas moram no registro de operações, não em CHECKs.
select ok(
  (select count(*) = 9 from private.idempotency_operations where operation in ('complete_profile', 'request_data_export', 'approve_member', 'remove_member', 'set_role', 'set_monthly', 'set_ratings_visibility', 'transfer_ownership', 'leave_group')),
  'o registro de operações conserva as seis anteriores e as sete da fatia'
);
select ok(
  (select count(distinct logical_result) = 10 from private.idempotency_operation_results where logical_result in ('profile_created', 'data_export_requested', 'member_approved', 'member_refused', 'member_removed', 'role_set', 'monthly_set', 'ratings_visibility_set', 'ownership_transferred', 'group_left')),
  'o registro de resultados conserva os anteriores'
);
select ok(
  (select bool_and(resource_type = 'group') from private.idempotency_operations
     where operation in ('approve_member', 'remove_member', 'set_role', 'set_monthly',
       'set_ratings_visibility', 'transfer_ownership', 'leave_group'))
  and exists (select 1 from private.idempotency_operations where resource_type = 'deletion_request')
  and exists (select 1 from private.idempotency_operations where resource_type = 'data_export'),
  'o resource das operações de grupo é o grupo'
);

select lives_ok(
  $$select private.validate_idempotency_outcome('approve_member',
      '{"group_id":"16200000-0000-4000-8000-000000000001","profile_id":"16100000-0000-4000-8000-000000000004","logical_result":"member_refused"}')$$,
  'o validador aceita a forma exata de approve_member'
);
select lives_ok(
  $$select private.validate_idempotency_outcome('request_data_export',
      '{"export_id":"16200000-0000-4000-8000-000000000001","logical_result":"data_export_requested"}')$$,
  'o validador ainda delega as formas anteriores'
);
select throws_ok(
  $$select private.validate_idempotency_outcome('remove_member',
      '{"group_id":"16200000-0000-4000-8000-000000000001","profile_id":"16100000-0000-4000-8000-000000000004","logical_result":"member_removed","reason":"x"}')$$,
  '22023', 'VALIDATION', 'M2-D18: o outcome de remove_member recusa qualquer chave de motivo'
);
select throws_ok(
  $$select private.validate_idempotency_outcome('set_role',
      '{"group_id":"16200000-0000-4000-8000-000000000001","profile_id":"16100000-0000-4000-8000-000000000004","logical_result":"role_set","role":"organizer"}')$$,
  '22023', 'VALIDATION', 'papel atual não entra no outcome: vem da projeção fresca'
);
select throws_ok(
  $$select private.validate_idempotency_outcome('leave_group',
      '{"group_id":"16200000-0000-4000-8000-000000000001","logical_result":"member_removed"}')$$,
  '22023', 'VALIDATION', 'logical_result de outra operação é recusado'
);
select throws_ok(
  $$select private.validate_idempotency_outcome('transfer_ownership',
      '{"group_id":"16200000-0000-4000-8000-000000000001","new_owner_id":"16100000-0000-4000-8000-00000000000A","logical_result":"ownership_transferred"}')$$,
  '22023', 'VALIDATION', 'UUID fora da forma canônica minúscula é recusado'
);
select throws_ok(
  $$select * from private.acquire_group_idempotency('profile:16100000-0000-4000-8000-000000000001',
      'update_profile', '16500000-0000-4000-8000-000000000999', repeat('a', 64), 1, 1)$$,
  '22023', 'VALIDATION', 'a aquisição de grupo só aceita as sete operações da fatia'
);

-- ---------------------------------------------------------------------------
-- ACL de toda função nova ou redefinida pela 0016
-- ---------------------------------------------------------------------------

create temporary table acl_0016 (signature text, acl text, execute boolean[]) on commit drop;
insert into acl_0016 values
  ('public.approve_member(uuid,uuid,uuid,text,integer,integer,uuid,uuid,boolean)', '{postgres=X/postgres,service_role=X/postgres}', array[true,false,false,false]),
  ('public.remove_member(uuid,uuid,uuid,text,integer,integer,uuid,uuid,text)', '{postgres=X/postgres,service_role=X/postgres}', array[true,false,false,false]),
  ('public.set_role(uuid,uuid,uuid,text,integer,integer,uuid,uuid,text)', '{postgres=X/postgres,service_role=X/postgres}', array[true,false,false,false]),
  ('public.set_monthly(uuid,uuid,uuid,text,integer,integer,uuid,uuid,boolean)', '{postgres=X/postgres,service_role=X/postgres}', array[true,false,false,false]),
  ('public.set_ratings_visibility(uuid,uuid,uuid,text,integer,integer,uuid,text,boolean)', '{postgres=X/postgres,service_role=X/postgres}', array[true,false,false,false]),
  ('public.transfer_ownership(uuid,uuid,uuid,text,integer,integer,uuid,uuid)', '{postgres=X/postgres,service_role=X/postgres}', array[true,false,false,false]),
  ('public.leave_group(uuid,uuid,uuid,text,integer,integer,uuid)', '{postgres=X/postgres,service_role=X/postgres}', array[true,false,false,false]),
  ('public.worker_execute_database_job(bigint)', '{postgres=X/postgres,service_role=X/postgres}', array[true,false,false,false]),
  ('private.validate_idempotency_outcome(text,jsonb)', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.check_idempotency_conclusion(private.idempotency_records)', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.acquire_group_idempotency(text,text,uuid,text,integer,integer)', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.complete_group_idempotency(text,text,uuid,text,integer,integer,jsonb)', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.enforce_idempotency_conclusion()', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.require_group_actor_after_locks(uuid,uuid,uuid)', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.group_actor_authority(uuid,uuid)', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.require_group_not_suspended(uuid)', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.purge_removed_memberships()', '{postgres=X/postgres}', array[false,false,false,false]),
  ('private.worker_job_slot(text,timestamp with time zone)', '{postgres=X/postgres}', array[false,false,false,false]);

select is(
  (select count(*)::integer from acl_0016),
  18,
  'a lista de ACL cobre as 18 funções que a 0016 cria, renomeia ou redefine'
);
select is(
  (select proacl::text from pg_proc where oid = signature::regprocedure),
  acl,
  signature || ': proacl exato'
)
from acl_0016 order by signature;
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
from acl_0016 order by signature;
select is(
  (select count(*)::integer from pg_proc
   where oid = any(array(select signature::regprocedure from acl_0016))
     and proname in ('approve_member', 'remove_member', 'set_role', 'set_monthly',
                     'set_ratings_visibility', 'transfer_ownership', 'leave_group')
     and prosecdef and provolatile = 'v' and proconfig @> array['search_path=""']),
  7,
  'as sete RPCs são security definer, volatile e com search_path vazio'
);
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_group'),
  1,
  'create_group foi entregue na 0017 (docs/25 §2)'
);

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------

insert into auth.users (id, email)
select ('16000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       'membership-pgtap-' || n || '@example.invalid'
from generate_series(1, 30) as n;
insert into public.profiles (id, auth_user_id, name, account_status)
select ('16100000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('16000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       'Membership ' || n,
       case when n = 8 then 'suspended' else 'active' end
from generate_series(1, 30) as n;

-- 01 dono O · 02 organizador R · 03 jogador P · 04 pendente Q · 05 estranho X
-- 06 perfil no limite L · 07 pendente Q2 (removal_count 2) · 08 perfil suspenso
-- ativo em G · 09 mensalista M · 10 pendente em SUSP.
insert into public.groups (id, name, owner_id, monthly_enabled, suspended_at, archived_at) values
  ('16200000-0000-4000-8000-000000000001', 'G', '16100000-0000-4000-8000-000000000001', true, null, null),
  ('16200000-0000-4000-8000-000000000002', 'H sem mensalista', '16100000-0000-4000-8000-000000000002', false, null, null),
  ('16200000-0000-4000-8000-000000000003', 'Suspenso', '16100000-0000-4000-8000-000000000001', true, now(), null),
  ('16200000-0000-4000-8000-000000000004', 'Arquivado', '16100000-0000-4000-8000-000000000001', false, null, now());
insert into public.groups (id, name, owner_id)
select ('16200000-0000-4000-8000-0000000000' || n)::uuid, 'Limite ' || n,
       '16100000-0000-4000-8000-000000000006'
from generate_series(10, 14) as n;

insert into public.group_members (group_id, profile_id, role, status, is_monthly, removal_count, removed_at) values
  ('16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000001', 'organizer', 'active', false, 0, null),
  ('16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000002', 'organizer', 'active', false, 0, null),
  ('16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000003', 'player', 'active', false, 0, null),
  ('16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000004', 'player', 'pending', false, 0, null),
  ('16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000006', 'player', 'pending', false, 0, null),
  ('16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000007', 'player', 'pending', false, 2, null),
  ('16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000008', 'player', 'active', false, 0, null),
  ('16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000009', 'player', 'active', true, 1, null),
  ('16200000-0000-4000-8000-000000000002', '16100000-0000-4000-8000-000000000002', 'organizer', 'active', false, 0, null),
  ('16200000-0000-4000-8000-000000000002', '16100000-0000-4000-8000-000000000003', 'player', 'active', false, 0, null),
  ('16200000-0000-4000-8000-000000000003', '16100000-0000-4000-8000-000000000001', 'organizer', 'active', false, 0, null),
  ('16200000-0000-4000-8000-000000000003', '16100000-0000-4000-8000-000000000003', 'player', 'active', false, 0, null),
  ('16200000-0000-4000-8000-000000000003', '16100000-0000-4000-8000-000000000010', 'player', 'pending', false, 0, null),
  ('16200000-0000-4000-8000-000000000004', '16100000-0000-4000-8000-000000000001', 'organizer', 'removed', false, 0, now()),
  ('16200000-0000-4000-8000-000000000004', '16100000-0000-4000-8000-000000000010', 'player', 'pending', false, 0, null);
insert into public.group_members (group_id, profile_id, role, status)
select ('16200000-0000-4000-8000-0000000000' || n)::uuid,
       '16100000-0000-4000-8000-000000000006', 'organizer', 'active'
from generate_series(10, 14) as n;


-- ---------------------------------------------------------------------------
-- approve_member
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.approve_member('16000000-0000-4000-8000-000000000005', '16400000-0000-4000-8000-000000000005',
      '16500000-0000-4000-8000-000000000101', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000004', true)$$,
  '42501', 'NOT_MEMBER', 'quem não é membro ativo não aprova'
);
select throws_ok(
  $$select public.approve_member('16000000-0000-4000-8000-000000000003', '16400000-0000-4000-8000-000000000003',
      '16500000-0000-4000-8000-000000000102', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000004', true)$$,
  '42501', 'NOT_ORGANIZER', 'jogador ativo não aprova'
);
select throws_ok(
  $$select public.approve_member('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
      '16500000-0000-4000-8000-000000000103', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000006', true)$$,
  'P0001', 'GROUP_LIMIT', 'a cota de cinco grupos ativos é recontada sob lock'
);
select throws_ok(
  $$select public.approve_member('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
      '16500000-0000-4000-8000-000000000104', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000005', true)$$,
  'P0002', 'NOT_FOUND', 'sem pedido não há o que decidir'
);
select throws_ok(
  $$select public.approve_member('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000105', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000003', '16100000-0000-4000-8000-000000000010', true)$$,
  'P0001', 'GROUP_SUSPENDED', 'grupo suspenso bloqueia aprovação'
);
select throws_ok(
  $$select public.approve_member('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000106', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000004', '16100000-0000-4000-8000-000000000010', true)$$,
  'P0001', 'GROUP_ARCHIVED', 'grupo arquivado responde GROUP_ARCHIVED'
);
select throws_ok(
  $$select public.approve_member('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000107', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-0000000000ff', '16100000-0000-4000-8000-000000000010', true)$$,
  'P0002', 'NOT_FOUND', 'grupo inexistente responde NOT_FOUND'
);
select is(
  (select count(*)::integer from private.idempotency_records),
  0,
  'recusas não deixam registro de idempotência'
);

select is(
  public.approve_member('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
    '16500000-0000-4000-8000-000000000110', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000004', true),
  '{"outcome":{"group_id":"16200000-0000-4000-8000-000000000001","profile_id":"16100000-0000-4000-8000-000000000004","logical_result":"member_approved"},"current":{"status":"active"}}'::jsonb,
  'o organizador aprova: outcome só com IDs e logical_result, status pela projeção'
);
select is(
  public.approve_member('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
    '16500000-0000-4000-8000-000000000110', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000004', true)
    -> 'outcome' ->> 'logical_result',
  'member_approved',
  'o replay devolve o mesmo outcome'
);
select throws_ok(
  $$select public.approve_member('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
      '16500000-0000-4000-8000-000000000110', repeat('b', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000004', false)$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'mesma chave com outra entrada é conflito'
);
select throws_ok(
  $$select public.approve_member('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000111', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000004', false)$$,
  'P0001', 'MEMBERSHIP_ALREADY_DECIDED', 'membership já ativa não é decidida de novo'
);
select is(
  public.approve_member('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
    '16500000-0000-4000-8000-000000000112', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000007', false)
    -> 'current' ->> 'status',
  'removed',
  'o dono recusa o pedido'
);
select results_eq(
  $$select status, removed_at is not null, removal_count, role, is_monthly
      from public.group_members
     where group_id = '16200000-0000-4000-8000-000000000001'
       and profile_id = '16100000-0000-4000-8000-000000000007'$$,
  $$values ('removed'::text, true, 2, 'player'::text, false)$$,
  'M2-D16: recusa faz pending → removed com removed_at e removal_count inalterado'
);
select is(
  (select count(*)::integer from public.group_members
   where profile_id = '16100000-0000-4000-8000-000000000007'),
  1,
  'recusa não fabrica outra linha'
);
select results_eq(
  $$select operation, outcome_code, resource_type, resource_id::text, state
      from private.idempotency_records order by created_at, operation$$,
  $$values ('approve_member'::text, 'member_approved'::text, 'group'::text,
            '16200000-0000-4000-8000-000000000001'::text, 'completed'::text),
           ('approve_member', 'member_refused', 'group', '16200000-0000-4000-8000-000000000001', 'completed')$$,
  'duas decisões, dois registros concluídos com resource = grupo'
);

-- ---------------------------------------------------------------------------
-- set_role (M2-D17) e set_monthly (M2-D17, M2-D6)
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.set_role('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
      '16500000-0000-4000-8000-000000000201', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000003', 'organizer')$$,
  '42501', 'OWNER_ONLY', 'organizador não muda papel'
);
select throws_ok(
  $$select public.set_role('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000202', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000006', 'organizer')$$,
  'P0001', 'NOT_ACTIVE_MEMBER', 'M2-D17: set_role sobre pendente devolve NOT_ACTIVE_MEMBER'
);
select throws_ok(
  $$select public.set_role('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000203', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000007', 'organizer')$$,
  'P0001', 'NOT_ACTIVE_MEMBER', 'M2-D17: set_role sobre removido devolve NOT_ACTIVE_MEMBER, sem reativar'
);
select throws_ok(
  $$select public.set_role('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000204', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000005', 'player')$$,
  'P0001', 'NOT_ACTIVE_MEMBER', 'M2-D17: set_role sobre perfil sem membership devolve NOT_ACTIVE_MEMBER'
);
select throws_ok(
  $$select public.set_role('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000205', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000003', 'owner')$$,
  '22023', 'VALIDATION', 'role owner não existe'
);
select is(
  public.set_role('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
    '16500000-0000-4000-8000-000000000206', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000003', 'organizer'),
  '{"outcome":{"group_id":"16200000-0000-4000-8000-000000000001","profile_id":"16100000-0000-4000-8000-000000000003","logical_result":"role_set"},"current":{"role":"organizer"}}'::jsonb,
  'o dono promove o jogador'
);
select is(
  (select owner_id::text from public.groups where id = '16200000-0000-4000-8000-000000000001'),
  '16100000-0000-4000-8000-000000000001',
  'o papel não toca a titularidade, que deriva de owner_id'
);

select throws_ok(
  $$select public.set_monthly('16000000-0000-4000-8000-000000000009', '16400000-0000-4000-8000-000000000009',
      '16500000-0000-4000-8000-000000000301', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000008', true)$$,
  '42501', 'NOT_ORGANIZER', 'jogador não liga mensalista'
);
select throws_ok(
  $$select public.set_monthly('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000302', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000006', true)$$,
  'P0001', 'NOT_ACTIVE_MEMBER', 'M2-D17: set_monthly sobre pendente devolve NOT_ACTIVE_MEMBER'
);
select throws_ok(
  $$select public.set_monthly('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
      '16500000-0000-4000-8000-000000000303', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000002', '16100000-0000-4000-8000-000000000003', true)$$,
  'P0001', 'MONTHLY_DISABLED', 'grupo sem mensalista habilitado recusa ligar'
);
select is(
  public.set_monthly('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
    '16500000-0000-4000-8000-000000000304', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000002', '16100000-0000-4000-8000-000000000003', false)
    -> 'current' ->> 'enabled',
  'false',
  'desligar vale mesmo com o mensalista do grupo desabilitado'
);
select is(
  public.set_monthly('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
    '16500000-0000-4000-8000-000000000305', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000008', true)
    -> 'current' ->> 'enabled',
  'true',
  'o organizador liga o mensalista em grupo habilitado'
);
select throws_ok(
  $$select public.set_monthly('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000306', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000003', '16100000-0000-4000-8000-000000000003', false)$$,
  'P0001', 'GROUP_SUSPENDED', 'grupo suspenso bloqueia mensalista'
);

-- ---------------------------------------------------------------------------
-- set_ratings_visibility
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.set_ratings_visibility('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
      '16500000-0000-4000-8000-000000000401', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', 'members', true)$$,
  '42501', 'OWNER_ONLY', 'organizador não muda a visibilidade'
);
select throws_ok(
  $$select public.set_ratings_visibility('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000402', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', 'members', false)$$,
  'P0001', 'VISIBILITY_CONFIRMATION_REQUIRED', 'members exige a confirmação explícita'
);
select throws_ok(
  $$select public.set_ratings_visibility('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000403', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000003', 'private', false)$$,
  'P0001', 'GROUP_SUSPENDED', 'grupo suspenso bloqueia visibilidade'
);
select is(
  public.set_ratings_visibility('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
    '16500000-0000-4000-8000-000000000404', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', 'members', true),
  '{"outcome":{"group_id":"16200000-0000-4000-8000-000000000001","logical_result":"ratings_visibility_set"},"current":{"visibility":"members"}}'::jsonb,
  'o dono confirma e muda a visibilidade'
);

-- ---------------------------------------------------------------------------
-- remove_member (M2-D18) e o estado removed
-- ---------------------------------------------------------------------------

select throws_ok(
  format($$select public.remove_member('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000501', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000009', %L)$$, reason),
  '22023', 'VALIDATION', 'M2-D18: motivo ' || label || ' é VALIDATION'
)
from (values (null::text, 'nulo'), ('', 'vazio'), (e' \t\n ', 'só com espaço'),
             (repeat('x', 501), 'com 501 caracteres')) as cases(reason, label);
select throws_ok(
  $$select public.remove_member('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
      '16500000-0000-4000-8000-000000000502', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000001', 'motivo')$$,
  'P0001', 'IS_OWNER', 'o dono não é removido'
);
select throws_ok(
  $$select public.remove_member('16000000-0000-4000-8000-000000000008', '16400000-0000-4000-8000-000000000008',
      '16500000-0000-4000-8000-000000000503', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000009', 'motivo')$$,
  '42501', 'PROFILE_SUSPENDED', 'conta suspensa não remove'
);
select throws_ok(
  $$select public.remove_member('16000000-0000-4000-8000-000000000009', '16400000-0000-4000-8000-000000000009',
      '16500000-0000-4000-8000-000000000504', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000008', 'motivo')$$,
  '42501', 'NOT_ORGANIZER', 'jogador não remove'
);
select throws_ok(
  $$select public.remove_member('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000505', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000006', 'motivo')$$,
  'P0001', 'NOT_ACTIVE_MEMBER', 'pendente não é removido por remove_member'
);
select is(
  public.remove_member('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
    '16500000-0000-4000-8000-000000000506', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000009',
    '  census-reason-marker-pgtap-0016  '),
  '{"outcome":{"group_id":"16200000-0000-4000-8000-000000000001","profile_id":"16100000-0000-4000-8000-000000000009","logical_result":"member_removed"},"current":{"ok":true,"refunds":[],"invalidated_matches":[]}}'::jsonb,
  'o organizador remove o mensalista; a resposta não carrega o motivo'
);
select results_eq(
  $$select status, removed_at is not null, is_monthly, removal_count
      from public.group_members
     where group_id = '16200000-0000-4000-8000-000000000001'
       and profile_id = '16100000-0000-4000-8000-000000000009'$$,
  $$values ('removed'::text, true, false, 1)$$,
  'active → removed grava removed_at, desliga is_monthly e conserva a linha e o contador'
);

-- Nenhuma RPC da 0016 reativa a membership nem a devolve a pending.
select throws_ok(
  $$select public.approve_member('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000507', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000009', true)$$,
  'P0001', 'MEMBERSHIP_ALREADY_DECIDED', 'aprovar não reativa removido'
);
select throws_ok(
  $$select public.set_monthly('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000508', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000009', true)$$,
  'P0001', 'NOT_ACTIVE_MEMBER', 'mensalista não religa em removido'
);
select throws_ok(
  $$select public.leave_group('16000000-0000-4000-8000-000000000009', '16400000-0000-4000-8000-000000000009',
      '16500000-0000-4000-8000-000000000509', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001')$$,
  '42501', 'NOT_MEMBER', 'o removido perde a autoridade já na chamada seguinte'
);
select is(
  (select status from public.group_members
   where group_id = '16200000-0000-4000-8000-000000000001'
     and profile_id = '16100000-0000-4000-8000-000000000009'),
  'removed',
  'a linha continua existindo, removed'
);

-- M2-D18: censo por valor. O marcador do motivo não aparece em nenhuma linha
-- de tabela de nenhum schema de aplicação ou plataforma. A contraprova grava o
-- marcador numa tabela temporária do teste e o censo passa a acusá-lo.
create function pg_temp.marker_census(p_marker text)
returns integer
language plpgsql
as $function$
declare
  v_table record;
  v_hits integer := 0;
  v_count integer;
begin
  for v_table in
    select c.oid::regclass as relation
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and (n.nspname in ('public', 'private', 'auth', 'storage', 'cron', 'vault', 'net',
                         'supabase_functions', 'realtime')
           or n.oid = pg_my_temp_schema())
  loop
    execute format('select count(*)::integer from %s as t where t::text like %L',
                   v_table.relation, '%' || p_marker || '%')
    into v_count;
    v_hits := v_hits + v_count;
  end loop;
  return v_hits;
end;
$function$;
select is(pg_temp.marker_census('census-reason-marker-pgtap-0016'), 0,
  'M2-D18: o motivo não é persistido em nenhuma tabela');
create temporary table census_counterproof (reason text);
insert into census_counterproof values ('  census-reason-marker-pgtap-0016  ');
select is(pg_temp.marker_census('census-reason-marker-pgtap-0016'), 1,
  'contraprova: o censo acusa o motivo gravado numa tabela');
drop table census_counterproof;

-- RLS nega ao removido já na leitura seguinte (docs/25 §4.3).
set local role authenticated;
set local request.jwt.claims = '{"sub":"16000000-0000-4000-8000-000000000009"}';
select is((select count(*)::integer from public.groups), 0,
  'o removido não lê a linha do grupo');
select is((select count(*)::integer from public.group_members), 0,
  'o removido não enumera memberships');
set local request.jwt.claims = '{"sub":"16000000-0000-4000-8000-000000000008"}';
select is((select count(*)::integer from public.groups), 1,
  'controle positivo: membro ativo do mesmo grupo lê a linha');
reset role;

-- P3-2: as duas edições faltantes também negam grupo suspenso.
select throws_ok(
  $$select public.set_role('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000580', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000003', '16100000-0000-4000-8000-000000000003', 'organizer')$$,
  'P0001', 'GROUP_SUSPENDED', 'grupo suspenso bloqueia set_role'
);
select throws_ok(
  $$select public.remove_member('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000581', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000003', '16100000-0000-4000-8000-000000000003', 'fixture')$$,
  'P0001', 'GROUP_SUSPENDED', 'grupo suspenso bloqueia remove_member'
);

-- ---------------------------------------------------------------------------
-- transfer_ownership
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.transfer_ownership('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
      '16500000-0000-4000-8000-000000000601', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000002')$$,
  '42501', 'OWNER_ONLY', 'organizador não transfere'
);
select throws_ok(
  $$select public.transfer_ownership('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000602', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000006')$$,
  'P0001', 'NOT_ACTIVE_MEMBER', 'o novo dono precisa estar ativo: pendente é recusado'
);
select throws_ok(
  $$select public.transfer_ownership('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000603', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000008')$$,
  'P0001', 'NOT_ACTIVE_MEMBER', 'perfil suspenso com membership ativa não recebe o grupo'
);
select throws_ok(
  $$select public.transfer_ownership('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
      '16500000-0000-4000-8000-000000000604', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000003', '16100000-0000-4000-8000-000000000003')$$,
  'P0001', 'GROUP_SUSPENDED', 'grupo suspenso bloqueia a transferência comum'
);
select is(
  public.transfer_ownership('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
    '16500000-0000-4000-8000-000000000605', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000002'),
  '{"outcome":{"group_id":"16200000-0000-4000-8000-000000000001","new_owner_id":"16100000-0000-4000-8000-000000000002","logical_result":"ownership_transferred"},"current":{"owner_id":"16100000-0000-4000-8000-000000000002"}}'::jsonb,
  'o dono transfere ao organizador ativo'
);
select results_eq(
  $$select profile_id::text, role, status from public.group_members
     where group_id = '16200000-0000-4000-8000-000000000001'
       and profile_id in ('16100000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000002')
     order by profile_id$$,
  $$values ('16100000-0000-4000-8000-000000000001'::text, 'organizer'::text, 'active'::text),
           ('16100000-0000-4000-8000-000000000002', 'organizer', 'active')$$,
  'a transferência altera somente groups.owner_id'
);

-- ---------------------------------------------------------------------------
-- leave_group
-- ---------------------------------------------------------------------------

select throws_ok(
  $$select public.leave_group('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
      '16500000-0000-4000-8000-000000000701', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000001')$$,
  'P0001', 'OWNER_MUST_TRANSFER', 'o novo dono não sai sem transferir'
);
select is(
  (select count(*)::integer from private.idempotency_records
   where operation = 'leave_group'),
  0,
  'OWNER_MUST_TRANSFER antes de qualquer efeito'
);
select throws_ok(
  $$select public.leave_group('16000000-0000-4000-8000-000000000010', '16400000-0000-4000-8000-000000000010',
      '16500000-0000-4000-8000-000000000702', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000003')$$,
  '42501', 'NOT_MEMBER', 'pendente não usa leave_group'
);
select is(
  public.leave_group('16000000-0000-4000-8000-000000000003', '16400000-0000-4000-8000-000000000003',
    '16500000-0000-4000-8000-000000000703', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000003') -> 'outcome' ->> 'logical_result',
  'group_left',
  'não-owner sai de grupo suspenso (allowlist de docs/25 §4.1)'
);
select is(
  public.leave_group('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
    '16500000-0000-4000-8000-000000000704', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001'),
  '{"outcome":{"group_id":"16200000-0000-4000-8000-000000000001","logical_result":"group_left"},"current":{"ok":true,"refunds":[],"invalidated_matches":[]}}'::jsonb,
  'o antigo dono, agora organizador, sai'
);
select results_eq(
  $$select status, removed_at is not null, is_monthly from public.group_members
     where group_id = '16200000-0000-4000-8000-000000000001'
       and profile_id = '16100000-0000-4000-8000-000000000001'$$,
  $$values ('removed'::text, true, false)$$,
  'leave_group faz active → removed'
);

-- M2-D20 emendada: o efeito que retirou a autoridade continua recuperável.
-- Commit real e caminho HTTP são provados no harness; aqui o papel é nominal.
set local role service_role;
select is(
  public.transfer_ownership('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
    '16500000-0000-4000-8000-000000000605', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000002'),
  '{"outcome":{"group_id":"16200000-0000-4000-8000-000000000001","new_owner_id":"16100000-0000-4000-8000-000000000002","logical_result":"ownership_transferred"}}'::jsonb,
  'transfer_ownership: replay conserva exatamente o desfecho, com current ausente'
);
select throws_ok(
  $$select public.transfer_ownership('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
    '16500000-0000-4000-8000-000000000625', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000002')$$,
  '42501', 'NOT_MEMBER', 'transfer_ownership: chamada nova continua negada após a saída'
);
select is(
  public.leave_group('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
    '16500000-0000-4000-8000-000000000704', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001'),
  '{"outcome":{"group_id":"16200000-0000-4000-8000-000000000001","logical_result":"group_left"}}'::jsonb,
  'leave_group: replay conserva exatamente o desfecho, com current ausente'
);
select throws_ok(
  $$select public.leave_group('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
    '16500000-0000-4000-8000-000000000724', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001')$$,
  '42501', 'NOT_MEMBER', 'leave_group: chamada nova continua negada após a saída'
);
reset role;

-- ---------------------------------------------------------------------------
-- Revalidação de sessão e de aceite depois dos locks
-- ---------------------------------------------------------------------------

insert into private.revoked_auth_sessions (session_id, profile_id, expires_at)
values ('16400000-0000-4000-8000-000000000003', '16100000-0000-4000-8000-000000000003', now() + interval '1 hour');
select throws_ok(
  $$select public.leave_group('16000000-0000-4000-8000-000000000003', '16400000-0000-4000-8000-000000000003',
      '16500000-0000-4000-8000-000000000801', repeat('a', 64), 1, 1,
      '16200000-0000-4000-8000-000000000002')$$,
  '28000', 'UNAUTHENTICATED', 'sessão revogada não muta grupo'
);

-- O caminho nominal: service_role chama a RPC pelo grant, sem ler tabela.
set local role service_role;
select is(
  public.set_ratings_visibility('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
    '16500000-0000-4000-8000-000000000802', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000002', 'private', false) -> 'current' ->> 'visibility',
  'private',
  'service_role executa a RPC pelo grant nominal; a RPC security definer faz o resto'
);
reset role;

-- 40d: sessão revogada nega também o replay das sete RPCs pelo grant nominal.
-- As chamadas abaixo são cópias das primeiras chamadas positivas já concluídas.
-- O harness prova a revogação por HTTP e o commit real; pgTAP prova o erro SQL.
select is(
  (select count(distinct operation)::integer from private.idempotency_records
   where operation in ('approve_member','remove_member','set_role','set_monthly',
                       'set_ratings_visibility','transfer_ownership','leave_group')
     and state = 'completed'),
  7, 'as sete operações têm desfecho concluído antes da negação de autenticação'
);
insert into private.revoked_auth_sessions (session_id, profile_id, expires_at)
values
  ('16400000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000001', now() + interval '1 hour'),
  ('16400000-0000-4000-8000-000000000002', '16100000-0000-4000-8000-000000000002', now() + interval '1 hour');
set local role service_role;
select throws_ok(
  $$select public.approve_member('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
    '16500000-0000-4000-8000-000000000110', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000004', true)$$,
  '28000', 'UNAUTHENTICATED', 'approve_member: replay com sessão revogada devolve o erro normal, sem desfecho'
);
select throws_ok(
  $$select public.remove_member('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
    '16500000-0000-4000-8000-000000000506', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000009',
    '  census-reason-marker-pgtap-0016  ')$$,
  '28000', 'UNAUTHENTICATED', 'remove_member: replay com sessão revogada devolve o erro normal, sem desfecho'
);
select throws_ok(
  $$select public.set_role('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
    '16500000-0000-4000-8000-000000000206', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000003', 'organizer')$$,
  '28000', 'UNAUTHENTICATED', 'set_role: replay com sessão revogada devolve o erro normal, sem desfecho'
);
select throws_ok(
  $$select public.set_monthly('16000000-0000-4000-8000-000000000002', '16400000-0000-4000-8000-000000000002',
    '16500000-0000-4000-8000-000000000304', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000002', '16100000-0000-4000-8000-000000000003', false)$$,
  '28000', 'UNAUTHENTICATED', 'set_monthly: replay com sessão revogada devolve o erro normal, sem desfecho'
);
select throws_ok(
  $$select public.set_ratings_visibility('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
    '16500000-0000-4000-8000-000000000404', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', 'members', true)$$,
  '28000', 'UNAUTHENTICATED', 'set_ratings_visibility: replay com sessão revogada devolve o erro normal, sem desfecho'
);
select throws_ok(
  $$select public.transfer_ownership('16000000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001',
    '16500000-0000-4000-8000-000000000605', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000001', '16100000-0000-4000-8000-000000000002')$$,
  '28000', 'UNAUTHENTICATED', 'transfer_ownership: replay com sessão revogada devolve o erro normal, sem desfecho'
);
select throws_ok(
  $$select public.leave_group('16000000-0000-4000-8000-000000000003', '16400000-0000-4000-8000-000000000003',
    '16500000-0000-4000-8000-000000000703', repeat('a', 64), 1, 1,
    '16200000-0000-4000-8000-000000000003')$$,
  '28000', 'UNAUTHENTICATED', 'leave_group: replay com sessão revogada devolve o erro normal, sem desfecho'
);
reset role;

-- Toda idempotência concluída e toda titularidade válida no commit.
select lives_ok('set constraints all immediate',
  'os triggers diferidos de owner e de idempotência aceitam o estado final');
set constraints all deferred;

-- ---------------------------------------------------------------------------
-- Retenção: purge_removed_memberships
-- ---------------------------------------------------------------------------

insert into public.groups (id, name, owner_id) values
  ('16200000-0000-4000-8000-000000000020', 'Retenção', '16100000-0000-4000-8000-000000000020');
insert into public.group_members (group_id, profile_id, role, status, joined_at, removed_at) values
  ('16200000-0000-4000-8000-000000000020', '16100000-0000-4000-8000-000000000020', 'organizer', 'active', now() - interval '3 years', null),
  ('16200000-0000-4000-8000-000000000020', '16100000-0000-4000-8000-000000000021', 'player', 'removed', now() - interval '2 years', now() - interval '12 months' - interval '1 second'),
  ('16200000-0000-4000-8000-000000000020', '16100000-0000-4000-8000-000000000022', 'player', 'removed', now() - interval '2 years', now() - interval '12 months' + interval '1 day'),
  ('16200000-0000-4000-8000-000000000020', '16100000-0000-4000-8000-000000000023', 'player', 'pending', now() - interval '3 years', null),
  ('16200000-0000-4000-8000-000000000020', '16100000-0000-4000-8000-000000000024', 'player', 'active', now() - interval '3 years', null),
  ('16200000-0000-4000-8000-000000000020', '16100000-0000-4000-8000-000000000025', 'player', 'removed', now() - interval '5 years', now() - interval '12 months');

create temporary table purge_before as
select count(*)::integer as removed_total from public.group_members where status = 'removed';

select is(
  private.purge_removed_memberships(),
  jsonb_build_object('scanned', 2, 'purged', 2),
  'o expurgo apaga as duas removidas com 12 meses ou mais'
);
select results_eq(
  $$select profile_id::text, status from public.group_members
     where group_id = '16200000-0000-4000-8000-000000000020' order by profile_id$$,
  $$values ('16100000-0000-4000-8000-000000000020'::text, 'active'::text),
           ('16100000-0000-4000-8000-000000000022', 'removed'),
           ('16100000-0000-4000-8000-000000000023', 'pending'),
           ('16100000-0000-4000-8000-000000000024', 'active')$$,
  'preserva a removida antes do prazo e não toca active nem pending antigos'
);
select is(
  (select count(*)::integer from public.group_members where status = 'removed'),
  (select removed_total - 2 from purge_before),
  'nenhuma outra membership removida mais recente saiu'
);
select is(
  (select count(*)::integer from public.groups where id = '16200000-0000-4000-8000-000000000020'),
  1,
  'o grupo fica'
);
select results_eq(
  $$select policy, scanned, purged, failed, window_start = window_end - interval '12 months'
      from private.retention_runs where policy = 'purge_removed_memberships'$$,
  $$values ('purge_removed_memberships'::text, 2, 2, 0, true)$$,
  'retention_runs registra política, janela e contagens, sem identificador'
);
select is(
  private.purge_removed_memberships(),
  jsonb_build_object('scanned', 0, 'purged', 0),
  'repetir é idempotente'
);

select is(private.worker_job_slot('purge_removed_memberships', '2026-09-14 03:52:59+00'),
  '2026-09-13 03:53:00+00'::timestamptz, 'antes das 03:53 UTC o slot é o do dia anterior');
select is(private.worker_job_slot('purge_removed_memberships', '2026-09-14 03:53:00+00'),
  '2026-09-14 03:53:00+00'::timestamptz, 'às 03:53 UTC o slot é o do dia');
select is(
  (select schedule from cron.job where jobname = 'colete_v1_purge_removed_memberships'),
  '53 3 * * *',
  'o job é agendado como os demais jobs diários'
);

create temporary table membership_run as
select (public.worker_begin_job('purge_removed_memberships') ->> 'run_id')::bigint as run_id;
select is(
  public.worker_execute_database_job((select run_id from membership_run)),
  '{"scanned":0,"changed":0,"skipped":0,"failed":0,"stale":0,"duration_ms":0}'::jsonb,
  'o worker despacha o job e devolve o sumário de seis contadores'
);

select * from finish();

rollback;
