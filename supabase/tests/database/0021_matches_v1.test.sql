begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Tabela e restrições
-- ---------------------------------------------------------------------------
select has_table('private', 'matches', 'matches lives in private (docs/14 section 5.2)');
select hasnt_table('public', 'matches', 'no client-facing copy of the table exists');
select columns_are('private', 'matches', array['id', 'group_id', 'starts_at', 'ends_at',
  'timezone', 'location_name', 'location_address', 'latitude', 'longitude',
  'field_slots', 'field_price', 'created_by', 'created_at', 'description', 'canceled_at',
  'canceled_by']::name[],
  'matches has exactly the v1 cut of docs/10 plus coordinates, the 0022 description and the 0028 cancellation');
select col_type_is('private', 'matches', 'latitude', 'numeric(6,4)', 'latitude keeps 4 decimals');
select col_type_is('private', 'matches', 'longitude', 'numeric(7,4)', 'longitude keeps 4 decimals');
select col_type_is('private', 'matches', 'field_price', 'numeric(10,2)', 'price is docs/10 numeric');
select fk_ok('private', 'matches', 'group_id', 'public', 'groups', 'id', 'match belongs to a group');
select fk_ok('private', 'matches', 'created_by', 'public', 'profiles', 'id', 'creator is a profile');

-- ---------------------------------------------------------------------------
-- Isolamento: private, sem RLS, sem policy, sem privilégio (revisão #70 P1-1)
-- ---------------------------------------------------------------------------
select ok((select not relrowsecurity and not relforcerowsecurity from pg_class
  where oid = 'private.matches'::regclass),
  'matches does not rely on RLS: the protection is schema and grants');
select is((select count(*)::integer from pg_policy where polrelid = 'private.matches'::regclass),
  0, 'matches has no policy');
select is((select count(*)::integer from information_schema.table_privileges
  where table_schema = 'private' and table_name = 'matches'
    and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')), 0,
  'no direct table privilege for anon, authenticated or service_role');
select is((select count(*)::integer from information_schema.column_privileges
  where table_schema = 'private' and table_name = 'matches'
    and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')), 0,
  'no column privilege either');
select ok(not has_schema_privilege('authenticated', 'private', 'usage')
  and not has_schema_privilege('anon', 'private', 'usage'),
  'client roles cannot reach the private schema');
select fk_ok('private', 'job_runs', 'match_id', 'private', 'matches', 'id',
  'job_runs.match_id now references matches (docs/10 section 9)');

-- ---------------------------------------------------------------------------
-- RPC: assinatura estreita, ACL e modo
-- ---------------------------------------------------------------------------
select has_function('public', 'create_match',
  array['uuid','uuid','uuid','text','integer','integer','uuid','jsonb']::name[],
  'create_match has the narrow internal signature');
select ok(not has_function_privilege('public',
  'public.create_match(uuid,uuid,uuid,text,integer,integer,uuid,jsonb)', 'execute'),
  'public cannot execute create_match');
select ok(not has_function_privilege('anon',
  'public.create_match(uuid,uuid,uuid,text,integer,integer,uuid,jsonb)', 'execute'),
  'anon cannot execute create_match');
select ok(not has_function_privilege('authenticated',
  'public.create_match(uuid,uuid,uuid,text,integer,integer,uuid,jsonb)', 'execute'),
  'authenticated cannot execute create_match and spoof an actor');
select ok(has_function_privilege('service_role',
  'public.create_match(uuid,uuid,uuid,text,integer,integer,uuid,jsonb)', 'execute'),
  'only the nominal service role executes create_match');
select ok((select prosecdef and provolatile = 'v' and proconfig @> array['search_path=""']
  from pg_proc where oid = 'public.create_match(uuid,uuid,uuid,text,integer,integer,uuid,jsonb)'::regprocedure),
  'create_match is volatile security definer with fixed search_path');
select ok((select pg_get_functiondef(oid) like '%for no key update%'
  and pg_get_functiondef(oid) not like '%for update;%'
  from pg_proc where oid = 'public.create_match(uuid,uuid,uuid,text,integer,integer,uuid,jsonb)'::regprocedure),
  'domain locks keep the M2-D13 mode');
create temporary table match_read (signature text);
insert into match_read values ('public.get_match(uuid,uuid,uuid)'),
  ('public.list_my_matches(uuid,uuid)');
select ok(not has_function_privilege('public', signature, 'execute')
  and not has_function_privilege('anon', signature, 'execute')
  and not has_function_privilege('authenticated', signature, 'execute')
  and has_function_privilege('service_role', signature, 'execute'),
  'only the service role executes ' || signature) from match_read;
select ok((select prosecdef and proconfig @> array['search_path=""']
  and pg_get_functiondef(oid) like '%require_actor_context%'
  from pg_proc where oid = to_regprocedure(signature)),
  signature || ' is security definer with actor context') from match_read;
select ok(not has_function_privilege('service_role',
  'private.normalize_match_text(text,integer,integer)', 'execute'),
  'the text normalizer is not a gateway routine');

-- ---------------------------------------------------------------------------
-- Livro de idempotência: desfecho fechado, só IDs
-- ---------------------------------------------------------------------------
select lives_ok($$select private.validate_idempotency_outcome('create_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_created","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  'the exact safe create_match outcome is valid');
select throws_ok($$select private.validate_idempotency_outcome('create_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_created","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f","latitude":-23.5505}'::jsonb)$$,
  '22023', 'VALIDATION', 'coordinates cannot be stored in the outcome');
select throws_ok($$select private.validate_idempotency_outcome('create_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_created","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  '22023', 'VALIDATION', 'the logical result is closed');
select throws_ok($$select private.validate_idempotency_outcome('create_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_created","match_id":"01890F7E-E948-4C53-B13A-4A36E4B7D21F"}'::jsonb)$$,
  '22023', 'VALIDATION', 'the match ID is canonical lowercase');
select lives_ok($$select private.validate_idempotency_outcome('rename_group',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_renamed"}'::jsonb)$$,
  'the chain still delegates earlier operations');
select ok((select count(*) = 1 from private.idempotency_operations where operation in ('create_match')), 'operation registry includes create_match');
select ok((select count(distinct logical_result) = 1 from private.idempotency_operation_results where logical_result in ('match_created')), 'result registry includes match_created');

-- ---------------------------------------------------------------------------
-- Validação do config antes de qualquer ator ou chave idempotente
-- ---------------------------------------------------------------------------
create temporary table match_config_cases (label text, config jsonb, code text);
insert into match_config_cases values
  ('missing key', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":null,"longitude":null,"field_slots":14}', 'VALIDATION'),
  ('extra key', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":null,"longitude":null,"field_slots":14,"field_price":"25.00","pix_key":"x"}', 'VALIDATION'),
  ('seconds', '{"starts_at":"2030-01-01T22:00:30.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":null,"longitude":null,"field_slots":14,"field_price":"25.00"}', 'VALIDATION'),
  ('offset instant', '{"starts_at":"2030-01-01T19:00:00-03:00","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":null,"longitude":null,"field_slots":14,"field_price":"25.00"}', 'VALIDATION'),
  ('impossible date', '{"starts_at":"2030-02-30T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":null,"longitude":null,"field_slots":14,"field_price":"25.00"}', 'VALIDATION'),
  ('unknown timezone', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"Mars/Olympus","location_name":"Arena","location_address":null,"latitude":null,"longitude":null,"field_slots":14,"field_price":"25.00"}', 'VALIDATION'),
  ('short name', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":" A ","location_address":null,"latitude":null,"longitude":null,"field_slots":14,"field_price":"25.00"}', 'VALIDATION'),
  ('zero width', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Are​na","location_address":null,"latitude":null,"longitude":null,"field_slots":14,"field_price":"25.00"}', 'VALIDATION'),
  ('blank address', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":"  ","latitude":null,"longitude":null,"field_slots":14,"field_price":"25.00"}', 'VALIDATION'),
  ('five decimals', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":"-23.55052","longitude":"-46.6333","field_slots":14,"field_price":"25.00"}', 'VALIDATION'),
  ('half pair', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":"-23.5505","longitude":null,"field_slots":14,"field_price":"25.00"}', 'VALIDATION'),
  ('latitude range', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":"91.0000","longitude":"-46.6333","field_slots":14,"field_price":"25.00"}', 'VALIDATION'),
  ('numeric coordinate', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":-23.5505,"longitude":-46.6333,"field_slots":14,"field_price":"25.00"}', 'VALIDATION'),
  ('zero slots', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":null,"longitude":null,"field_slots":0,"field_price":"25.00"}', 'VALIDATION'),
  ('hundred slots', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":null,"longitude":null,"field_slots":100,"field_price":"25.00"}', 'VALIDATION'),
  ('fractional slots', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":null,"longitude":null,"field_slots":14.5,"field_price":"25.00"}', 'VALIDATION'),
  ('numeric price', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":null,"longitude":null,"field_slots":14,"field_price":25}', 'VALIDATION'),
  ('one decimal price', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":null,"longitude":null,"field_slots":14,"field_price":"25.0"}', 'VALIDATION'),
  ('zero price', '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","description":null,"location_name":"Arena","location_address":null,"latitude":null,"longitude":null,"field_slots":14,"field_price":"0.00"}', 'PRICE_INVALID');

select throws_ok(format($$select public.create_match(
    '15000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001',
    '01890f7e-e948-4c53-b13a-4a36e4b7d21e', repeat('a', 64), 1, 1,
    '01890f7e-e948-4c53-b13a-4a36e4b7d21e', %L::jsonb)$$, config),
  case when code = 'PRICE_INVALID' then 'P0001' else '22023' end, code,
  'config refused before any actor: ' || label)
from match_config_cases;

select is(private.normalize_match_text(E'  Café　 Arena  ', 2, 80), 'Café Arena',
  'match text is NFC, collapsed and trimmed');
select throws_ok($$select private.normalize_match_text(E'Arena‮', 2, 80)$$,
  '22023', 'VALIDATION', 'bidi override is refused');

-- ---------------------------------------------------------------------------
-- Sonda negativa de leitura: membro ativo lê, os demais não
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('21000000-0000-4000-8000-000000000001', 'match-owner@example.invalid'),
  ('21000000-0000-4000-8000-000000000002', 'match-player@example.invalid'),
  ('21000000-0000-4000-8000-000000000003', 'match-pending@example.invalid'),
  ('21000000-0000-4000-8000-000000000004', 'match-removed@example.invalid'),
  ('21000000-0000-4000-8000-000000000005', 'match-stranger@example.invalid'),
  ('21000000-0000-4000-8000-000000000006', 'match-deleting@example.invalid');
insert into public.profiles (id, auth_user_id, name, account_status) values
  ('21100000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'Owner', 'active'),
  ('21100000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000002', 'Player', 'active'),
  ('21100000-0000-4000-8000-000000000003', '21000000-0000-4000-8000-000000000003', 'Pending', 'active'),
  ('21100000-0000-4000-8000-000000000004', '21000000-0000-4000-8000-000000000004', 'Removed', 'active'),
  ('21100000-0000-4000-8000-000000000005', '21000000-0000-4000-8000-000000000005', 'Stranger', 'active'),
  ('21100000-0000-4000-8000-000000000006', '21000000-0000-4000-8000-000000000006', 'Deleting', 'deletion_pending');
insert into public.groups (id, name, owner_id) values
  ('21200000-0000-4000-8000-000000000001', 'Grupo Racha', '21100000-0000-4000-8000-000000000001'),
  ('21200000-0000-4000-8000-000000000002', 'Grupo Arquivado', '21100000-0000-4000-8000-000000000001');
insert into public.group_members (group_id, profile_id, role, status, removed_at) values
  ('21200000-0000-4000-8000-000000000001', '21100000-0000-4000-8000-000000000001', 'organizer', 'active', null),
  ('21200000-0000-4000-8000-000000000001', '21100000-0000-4000-8000-000000000002', 'player', 'active', null),
  ('21200000-0000-4000-8000-000000000001', '21100000-0000-4000-8000-000000000003', 'player', 'pending', null),
  ('21200000-0000-4000-8000-000000000001', '21100000-0000-4000-8000-000000000004', 'player', 'removed', now()),
  ('21200000-0000-4000-8000-000000000001', '21100000-0000-4000-8000-000000000006', 'player', 'active', null),
  ('21200000-0000-4000-8000-000000000002', '21100000-0000-4000-8000-000000000001', 'organizer', 'active', null),
  ('21200000-0000-4000-8000-000000000002', '21100000-0000-4000-8000-000000000002', 'player', 'active', null);
insert into private.matches (id, group_id, starts_at, ends_at, timezone, location_name,
  latitude, longitude, field_slots, field_price, created_by) values
  ('21300000-0000-4000-8000-000000000001', '21200000-0000-4000-8000-000000000001',
   '2030-01-01 22:00Z', '2030-01-01 23:30Z', 'America/Sao_Paulo', 'Arena',
   -23.5505, -46.6333, 14, 25, '21100000-0000-4000-8000-000000000001'),
  ('21300000-0000-4000-8000-000000000002', '21200000-0000-4000-8000-000000000002',
   '2030-01-02 22:00Z', '2030-01-02 23:30Z', 'America/Sao_Paulo', 'Quadra',
   null, null, 10, 20, '21100000-0000-4000-8000-000000000001');
update public.groups set archived_at = now() where id = '21200000-0000-4000-8000-000000000002';

select throws_ok($$insert into private.matches (group_id, starts_at, ends_at, timezone,
  location_name, latitude, longitude, field_slots, field_price, created_by) values
  ('21200000-0000-4000-8000-000000000001', '2030-01-01 22:00Z', '2030-01-01 23:00Z',
   'UTC', 'Arena', -23.5505, null, 14, 25, '21100000-0000-4000-8000-000000000001')$$,
  '23514', null, 'the table refuses half a coordinate pair');
select throws_ok($$insert into private.matches (group_id, starts_at, ends_at, timezone,
  location_name, field_slots, field_price, created_by) values
  ('21200000-0000-4000-8000-000000000001', '2030-01-01 22:00Z', '2030-01-01 22:00Z',
   'UTC', 'Arena', 14, 25, '21100000-0000-4000-8000-000000000001')$$,
  '23514', null, 'the table refuses an empty interval');

-- Leitura pelas RPCs, como a Edge chama: sessão viva lê; os demais recebem
-- o mesmo NOT_FOUND para ID existente e inexistente.
select is((select array_agg(id::text || ':' || group_name) from public.get_match(
  '21000000-0000-4000-8000-000000000001', gen_random_uuid(),
  '21300000-0000-4000-8000-000000000001')),
  array['21300000-0000-4000-8000-000000000001:Grupo Racha'], 'owner reads the match');
select is((select latitude::text || ',' || longitude::text from public.get_match(
  '21000000-0000-4000-8000-000000000002', gen_random_uuid(),
  '21300000-0000-4000-8000-000000000001')),
  '-23.5505,-46.6333', 'an active player reads the rounded coordinates');
select is((select count(*)::integer from public.list_my_matches(
  '21000000-0000-4000-8000-000000000001', gen_random_uuid())), 1,
  'the owner lists the live group match and not the archived one');
create temporary table read_denials (label text, auth_id uuid, match_id uuid);
insert into read_denials values
  ('pending member', '21000000-0000-4000-8000-000000000003', '21300000-0000-4000-8000-000000000001'),
  ('removed member', '21000000-0000-4000-8000-000000000004', '21300000-0000-4000-8000-000000000001'),
  ('stranger, existing ID', '21000000-0000-4000-8000-000000000005', '21300000-0000-4000-8000-000000000001'),
  ('stranger, unknown ID', '21000000-0000-4000-8000-000000000005', '21300000-0000-4000-8000-0000000000ff'),
  ('member, archived group', '21000000-0000-4000-8000-000000000002', '21300000-0000-4000-8000-000000000002');
select throws_ok(format($$select * from public.get_match(%L, gen_random_uuid(), %L)$$,
  auth_id, match_id), 'P0002', 'NOT_FOUND', 'same NOT_FOUND: ' || label) from read_denials;
select is((select count(*)::integer from public.list_my_matches(
  '21000000-0000-4000-8000-000000000005', gen_random_uuid())), 0, 'a stranger lists nothing');
select throws_ok($$select * from public.get_match('21000000-0000-4000-8000-000000000006',
  gen_random_uuid(), '21300000-0000-4000-8000-000000000001')$$, '42501', 'FORBIDDEN',
  'an account in deletion has no read authority');

insert into private.revoked_auth_sessions (session_id, profile_id, expires_at) values
  ('21400000-0000-4000-8000-000000000001', '21100000-0000-4000-8000-000000000001',
   now() + interval '1 hour');
select throws_ok($$select * from public.get_match('21000000-0000-4000-8000-000000000001',
  '21400000-0000-4000-8000-000000000001', '21300000-0000-4000-8000-000000000001')$$,
  '28000', 'UNAUTHENTICATED', 'a revoked session cannot read the match');
select throws_ok($$select * from public.list_my_matches('21000000-0000-4000-8000-000000000001',
  '21400000-0000-4000-8000-000000000001')$$, '28000', 'UNAUTHENTICATED',
  'a revoked session cannot list matches');

set local role authenticated;
set local request.jwt.claims = '{"sub":"21000000-0000-4000-8000-000000000001"}';
select throws_ok($$select id from private.matches$$, '42501', null,
  'a client cannot read matches directly');
select throws_ok($$insert into private.matches (group_id, starts_at, ends_at, timezone,
  location_name, field_slots, field_price, created_by) values
  ('21200000-0000-4000-8000-000000000001', '2030-01-01 22:00Z', '2030-01-01 23:00Z',
   'UTC', 'Arena', 14, 25, '21100000-0000-4000-8000-000000000001')$$,
  '42501', null, 'client cannot insert a match directly');
reset role;
set local role anon;
select throws_ok($$select id from private.matches$$, '42501', null, 'anon cannot read matches');
reset role;
set local role service_role;
select throws_ok($$select id from private.matches$$, '42501', null,
  'service_role cannot read matches directly');
reset role;

-- Contraprova: um grant direto faz a sonda ler, e a negação acima cai.
grant usage on schema private to authenticated;
grant select on private.matches to authenticated;
set local role authenticated;
select lives_ok($$select id from private.matches$$,
  'with a direct grant the client reads: the denial is not vacuous');
reset role;
revoke select on private.matches from authenticated;
revoke usage on schema private from authenticated;

select * from finish();
rollback;
