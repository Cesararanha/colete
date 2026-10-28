begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

-- D63.5 (0033): o registro de operações de idempotência em tabela. As provas
-- comportamentais de cada operação continuam nos testes de cada fatia, que
-- rodam inalterados; aqui ficam o registro, a fronteira, as FKs, a
-- imutabilidade, o validador estável e a regra de conclusão.
select plan(63);

-- ---------------------------------------------------------------------------
-- O registro
-- ---------------------------------------------------------------------------
select is((select count(*)::int from private.idempotency_operations), 35, 'the registry has the 35 operations');
select is((select count(*)::int from private.idempotency_operation_results), 52, 'and the 52 (operation, result) pairs');
select is((select array_agg(family || ':' || n order by family) from
    (select family, count(*) as n from private.idempotency_operations group by family) as f),
  array['account:2', 'group:29', 'identity:4'], 'four identity, two account and 29 group operations');
select is((select array_agg(operation order by operation) from private.idempotency_operations
    where outcome_shape <> 'ids'), array['accept_policies', 'revoke_current_session'],
  'only accept_policies and revoke_current_session have their own shape');
select is((select array_agg(operation order by operation) from private.idempotency_operations
    where resource_is_actor), array['complete_profile', 'remove_profile_photo', 'set_profile_photo'],
  'the resource is the actor exactly where the old trigger said');
select is((select array_agg(operation order by operation) from private.idempotency_operations
    where resource_type is null), array['accept_policies', 'update_profile'],
  'only update_profile and accept_policies have no resource');

-- ---------------------------------------------------------------------------
-- Fronteira: sem RLS, sem grant, só funções leem
-- ---------------------------------------------------------------------------
select ok(not relrowsecurity, relname || ' has no RLS (14 §5.2)') from pg_class
  where oid in ('private.idempotency_operations'::regclass, 'private.idempotency_operation_results'::regclass);
select ok(not has_table_privilege(role, tbl, privilege), role || ' has no ' || privilege || ' on ' || tbl)
from (values ('anon'), ('authenticated'), ('service_role')) as roles(role),
  (values ('private.idempotency_operations'), ('private.idempotency_operation_results')) as tables(tbl),
  (values ('select'), ('insert')) as privileges(privilege);
select ok(not has_schema_privilege('service_role', 'private', 'usage'), 'service_role has no usage on private');

select is((select provolatile::text || prosecdef::text || array_to_string(proconfig, ',') from pg_proc
    where oid = 'private.validate_idempotency_outcome(text,jsonb)'::regprocedure),
  'sfalsesearch_path=""', 'the validator is stable, invoker, with an empty search_path');
select is((select provolatile::text || prosecdef::text || array_to_string(proconfig, ',') from pg_proc
    where oid = 'private.check_idempotency_conclusion(private.idempotency_records)'::regprocedure),
  'sfalsesearch_path=""', 'the conclusion rule is stable, invoker, with an empty search_path');
select ok((select prosecdef from pg_proc where oid = 'private.enforce_idempotency_conclusion()'::regprocedure),
  'the conclusion trigger stays security definer: it fires at commit under service_role');
select ok(not has_function_privilege(role, signature, 'execute'), signature || ' is not executable by ' || role)
from (values ('anon'), ('authenticated'), ('service_role')) as roles(role),
  (values ('private.check_idempotency_conclusion(private.idempotency_records)'),
    ('private.forbid_idempotency_registry_change()')) as functions(signature);

-- ---------------------------------------------------------------------------
-- Três FKs no lugar dos três CHECKs; o fim da cadeia
-- ---------------------------------------------------------------------------
select is((select array_agg(conname::text order by conname) from pg_constraint
    where conrelid = 'private.idempotency_records'::regclass and contype = 'f'
      and conname like 'idempotency_records_%_fkey' and conname <> 'idempotency_records_actor_id_fkey'),
  array['idempotency_records_operation_fkey', 'idempotency_records_outcome_code_fkey',
    'idempotency_records_resource_type_fkey'], 'the three registry FKs exist');
select is((select count(*)::int from pg_constraint where conrelid = 'private.idempotency_records'::regclass
    and conname in ('idempotency_records_operation_check', 'idempotency_records_outcome_code_check',
      'idempotency_records_resource_type_check')), 0, 'the three CHECKs are gone');
select is((select count(*)::int from pg_proc where proname like 'validate\_through\_%\_outcome'
    or proname = 'validate_m1a_idempotency_outcome'), 0, 'the 13 links of the old chain are gone');

-- ---------------------------------------------------------------------------
-- Imutável (P-C): UPDATE, DELETE e TRUNCATE recusados
-- ---------------------------------------------------------------------------
select throws_ok($$update private.idempotency_operations set family = 'account' where operation = 'draw_teams'$$,
  '23514', 'IDEMPOTENCY_REGISTRY_IMMUTABLE', 'an operation never changes');
select throws_ok($$delete from private.idempotency_operation_results where operation = 'draw_teams'$$,
  '23514', 'IDEMPOTENCY_REGISTRY_IMMUTABLE', 'a result never goes away');
-- A FK de idempotency_records já recusa o TRUNCATE simples (0A000); o
-- gatilho de comando é o que segura o TRUNCATE ... CASCADE, logo abaixo.
select throws_ok($$truncate private.idempotency_operation_results$$,
  '0A000', null, 'nor by TRUNCATE');
select throws_ok($$truncate private.idempotency_operations cascade$$,
  '23514', 'IDEMPOTENCY_REGISTRY_IMMUTABLE', 'not even TRUNCATE ... CASCADE');

-- ---------------------------------------------------------------------------
-- O validador estável: os três formatos e o endurecimento
-- ---------------------------------------------------------------------------
select lives_ok($$select private.validate_idempotency_outcome('join_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_waitlisted","match_id":"01890f7e-e948-7c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  'ids: exact keys, a result of the operation, any UUID version');
select lives_ok($$select private.validate_idempotency_outcome('update_profile', '{"logical_result":"profile_updated"}'::jsonb)$$,
  'ids: no UUID key at all');
select lives_ok($$select private.validate_idempotency_outcome('accept_policies',
  '{"accepted":[{"document_type":"privacy","version":"2026-09"},{"document_type":"terms","version":"2026-09"}],"logical_result":"policies_accepted"}'::jsonb)$$,
  'accept_policies keeps its own shape');
select lives_ok($$select private.validate_idempotency_outcome('revoke_current_session',
  '{"logical_result":"session_revoked","revoked_at":"2026-10-28T12:00:00.000000Z","session_id":"01890f7e-e948-7c53-b13a-4a36e4b7d21e"}'::jsonb)$$,
  'revoke_current_session keeps its own shape');
select throws_ok($$select private.validate_idempotency_outcome('join_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"teams_drawn","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  '22023', 'VALIDATION', 'a result of another operation is refused');
select throws_ok($$select private.validate_idempotency_outcome('join_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_joined","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f","extra":"x"}'::jsonb)$$,
  '22023', 'VALIDATION', 'a key too many is refused');
select throws_ok($$select private.validate_idempotency_outcome('join_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_joined"}'::jsonb)$$,
  '22023', 'VALIDATION', 'a key too few is refused');
select throws_ok($$select private.validate_idempotency_outcome('join_match',
  '{"group_id":"01890F7E-E948-4C53-B13A-4A36E4B7D21E","logical_result":"match_joined","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  '22023', 'VALIDATION', 'an ID must be canonical lowercase');
select throws_ok($$select private.validate_idempotency_outcome('accept_policies',
  '{"accepted":[{"document_type":"terms","version":"1"},{"document_type":"privacy","version":"1"}],"logical_result":"policies_accepted"}'::jsonb)$$,
  '22023', 'VALIDATION', 'accept_policies still demands the byte order');
select throws_ok($$select private.validate_idempotency_outcome('revoke_current_session',
  '{"logical_result":"session_revoked","revoked_at":"2026-10-28T12:00:00Z","session_id":"01890f7e-e948-7c53-b13a-4a36e4b7d21e"}'::jsonb)$$,
  '22023', 'VALIDATION', 'revoke_current_session still demands six decimals in UTC');
-- Endurecimento deliberado (caminho que nenhuma RPC alcança): logical_result
-- JSON null era aceito por estes dois elos e agora é recusado.
select throws_ok($$select private.validate_idempotency_outcome('rename_group',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":null}'::jsonb)$$,
  '22023', 'VALIDATION', 'rename_group refuses a null logical_result');
select throws_ok($$select private.validate_idempotency_outcome('request_data_export',
  '{"export_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":null}'::jsonb)$$,
  '22023', 'VALIDATION', 'request_data_export refuses a null logical_result');
select throws_ok($$select private.validate_idempotency_outcome('draw_teams',
  ('{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"teams_drawn","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f","pad":"' || repeat('x', 4100) || '"}')::jsonb)$$,
  '22023', 'VALIDATION', 'the 4096-byte limit now holds for every operation');

-- ---------------------------------------------------------------------------
-- As FKs, por DML direto (P2-4)
-- ---------------------------------------------------------------------------
insert into private.idempotency_records (actor_key, operation, request_id, request_hash, hash_key_version)
values
  ('system:d635_probe', 'join_match', '33000000-0000-4000-8000-000000000001', repeat('a', 64), 1),
  ('system:d635_probe', 'begin_photo_upload', '33000000-0000-4000-8000-000000000002', repeat('a', 64), 1),
  ('system:d635_probe', 'update_profile', '33000000-0000-4000-8000-000000000003', repeat('a', 64), 1),
  ('system:d635_probe', 'approve_member', '33000000-0000-4000-8000-000000000004', repeat('a', 64), 1),
  ('system:d635_probe', 'request_data_export', '33000000-0000-4000-8000-000000000005', repeat('a', 64), 1),
  ('system:d635_probe', 'leave_group', '33000000-0000-4000-8000-000000000006', repeat('a', 64), 1);
select pass('an executing_uncommitted record with nulls passes the three FKs');
select throws_ok($$update private.idempotency_records
    set state = 'completed', outcome_code = 'teams_drawn', completed_at = now(),
      resource_type = 'group', resource_id = '01890f7e-e948-4c53-b13a-4a36e4b7d21e',
      outcome = '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"teams_drawn","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'
    where request_id = '33000000-0000-4000-8000-000000000001'$$,
  '23503', null, 'a result of another operation is refused at once by the FK');
select throws_ok($$update private.idempotency_records
    set state = 'completed', outcome_code = 'photo_upload_started', completed_at = now(),
      resource_type = 'group', resource_id = '01890f7e-e948-4c53-b13a-4a36e4b7d21e',
      outcome = '{"logical_result":"photo_upload_started","upload_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e"}'
    where request_id = '33000000-0000-4000-8000-000000000002'$$,
  '23503', null, 'a resource type of another operation is refused by the FK');
select throws_ok($$update private.idempotency_records
    set state = 'completed', outcome_code = 'profile_updated', completed_at = now(),
      resource_type = 'profile', resource_id = '01890f7e-e948-4c53-b13a-4a36e4b7d21e',
      outcome = '{"logical_result":"profile_updated"}'
    where request_id = '33000000-0000-4000-8000-000000000003'$$,
  '23503', null, 'update_profile has no resource: a resource type is refused by the FK');

-- Para a revalidação e o payload_expired: registros completed plantados, que o
-- gatilho diferido só veria no commit (o pgTAP desfaz tudo).
update private.idempotency_records
  set state = 'completed', outcome_code = 'match_joined', completed_at = now(),
    resource_type = 'group', resource_id = '01890f7e-e948-4c53-b13a-4a36e4b7d21e',
    outcome = '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_joined","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'
  where request_id = '33000000-0000-4000-8000-000000000001';
select throws_ok($$update private.idempotency_records
    set state = 'payload_expired', outcome = null, outcome_code = 'teams_drawn', payload_expired_at = outcome_expires_at
    where request_id = '33000000-0000-4000-8000-000000000001'$$,
  '23503', null, 'payload_expired is also held to the results of its operation');

-- ---------------------------------------------------------------------------
-- A regra de conclusão (P-D): a mesma da revalidação e do gatilho
-- ---------------------------------------------------------------------------
select lives_ok($$select private.check_idempotency_conclusion(r) from private.idempotency_records r
    where request_id = '33000000-0000-4000-8000-000000000001'$$,
  'a coherent completed record passes');
update private.idempotency_records
  set state = 'completed', outcome_code = 'member_refused', completed_at = now(),
    resource_type = 'group', resource_id = '01890f7e-e948-4c53-b13a-4a36e4b7d21e',
    outcome = '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"member_approved","profile_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'
  where request_id = '33000000-0000-4000-8000-000000000004';
select throws_ok($$select private.check_idempotency_conclusion(r) from private.idempotency_records r
    where request_id = '33000000-0000-4000-8000-000000000004'$$,
  '23514', 'IDEMPOTENCY_OUTCOME_INVALID', 'outcome_code different from logical_result, within valid pairs, is refused');
update private.idempotency_records
  set state = 'completed', outcome_code = 'group_left', completed_at = now(),
    resource_type = 'group', resource_id = '01890f7e-e948-4c53-b13a-4a36e4b7d210',
    outcome = '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_left"}'
  where request_id = '33000000-0000-4000-8000-000000000006';
select throws_ok($$select private.check_idempotency_conclusion(r) from private.idempotency_records r
    where request_id = '33000000-0000-4000-8000-000000000006'$$,
  '23514', 'IDEMPOTENCY_OUTCOME_INVALID', 'a resource_id different from the outcome is refused');
update private.idempotency_records
  set state = 'completed', outcome_code = 'data_export_requested', completed_at = now(),
    resource_type = 'data_export', resource_id = '01890f7e-e948-4c53-b13a-4a36e4b7d21e',
    outcome = '{"export_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":null}'
  where request_id = '33000000-0000-4000-8000-000000000005';
select throws_ok($$select private.check_idempotency_conclusion(r) from private.idempotency_records r
    where request_id = '33000000-0000-4000-8000-000000000005'$$,
  '22023', 'VALIDATION', 'what the old chain accepted and the new validator refuses is caught by the revalidation');
update private.idempotency_records
  set state = 'payload_expired', outcome = null, payload_expired_at = outcome_expires_at
  where request_id = '33000000-0000-4000-8000-000000000006';
select lives_ok($$select private.check_idempotency_conclusion(r) from private.idempotency_records r
    where request_id = '33000000-0000-4000-8000-000000000006'$$,
  'a coherent payload_expired record passes');

-- ---------------------------------------------------------------------------
-- Os helpers da família group leem o registro
-- ---------------------------------------------------------------------------
-- Um perfil real: sem ele, o acquire recusa pelo ator antes de olhar a família,
-- e o teste passaria pelo motivo errado (mutante M4 da revisão).
insert into auth.users (id, email) values
  ('33000000-0000-4000-8000-0000000000a1', 'd635-actor@example.invalid');
insert into public.profiles (id, auth_user_id, name, account_status) values
  ('33100000-0000-4000-8000-0000000000a1', '33000000-0000-4000-8000-0000000000a1', 'D635', 'active');
select lives_ok($$select private.acquire_group_idempotency('profile:33100000-0000-4000-8000-0000000000a1',
    'leave_group', '33000000-0000-4000-8000-000000000008', repeat('a', 64), 1, 1)$$,
  'control: the same actor acquires an operation of the group family');
select throws_ok($$select private.acquire_group_idempotency('profile:33100000-0000-4000-8000-0000000000a1',
    'delete_account', '33000000-0000-4000-8000-000000000009', repeat('a', 64), 1, 1)$$,
  '22023', 'VALIDATION', 'acquire_group_idempotency refuses an operation of another family');
select throws_ok($$select private.complete_group_idempotency('profile:33100000-0000-4000-8000-0000000000a1',
    'delete_account', '33000000-0000-4000-8000-000000000009', repeat('a', 64), 1, 1,
    '{"deletion_request_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"deletion_requested"}'::jsonb)$$,
  '22023', 'VALIDATION', 'complete_group_idempotency refuses an operation of another family');

select * from finish();
rollback;
