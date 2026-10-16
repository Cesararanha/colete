begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Tabela: uma linha, sem texto, sem ator, sem privilégio
-- ---------------------------------------------------------------------------
select has_table('private', 'geocode_throttle', 'the shared clock lives in private');
select columns_are('private', 'geocode_throttle', array['id', 'last_slot_at']::name[],
  'the schedule keeps only the last reserved slot: no text, actor or result');
select is((select format_type(prorettype, null) from pg_proc
  where oid = 'public.geocode_gate(uuid,uuid,boolean)'::regprocedure), 'integer',
  'the gate answers milliseconds until the reserved slot');
select is((select count(*)::integer from private.geocode_throttle), 1, 'exactly one row');
select throws_ok($$insert into private.geocode_throttle (id) values (false)$$,
  '23514', null, 'a second row cannot exist');
select is((select relrowsecurity from pg_class where oid = 'private.geocode_throttle'::regclass),
  false, 'private service table without RLS (docs/14 section 5.2)');

select has_function('public', 'geocode_gate', array['uuid', 'uuid', 'boolean'],
  'geocode_gate has the narrow actor signature');
select ok((select prosecdef and provolatile = 'v' and proconfig = array['search_path=""']
  from pg_proc where oid = 'public.geocode_gate(uuid,uuid,boolean)'::regprocedure),
  'geocode_gate is volatile security definer with fixed search_path');
select ok(not has_function_privilege('public', 'public.geocode_gate(uuid,uuid,boolean)', 'execute'),
  'public cannot execute geocode_gate');
select ok(not has_function_privilege('anon', 'public.geocode_gate(uuid,uuid,boolean)', 'execute'),
  'anon cannot execute geocode_gate');
select ok(not has_function_privilege('authenticated',
  'public.geocode_gate(uuid,uuid,boolean)', 'execute'),
  'authenticated cannot execute geocode_gate and spoof an actor');
select ok(has_function_privilege('service_role', 'public.geocode_gate(uuid,uuid,boolean)', 'execute'),
  'only the service role executes geocode_gate');

-- ---------------------------------------------------------------------------
-- Atores
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('23000000-0000-4000-8000-000000000001', 'geo-owner@example.invalid'),
  ('23000000-0000-4000-8000-000000000002', 'geo-organizer@example.invalid'),
  ('23000000-0000-4000-8000-000000000003', 'geo-player@example.invalid'),
  ('23000000-0000-4000-8000-000000000004', 'geo-archived@example.invalid'),
  ('23000000-0000-4000-8000-000000000005', 'geo-pending@example.invalid');
insert into public.profiles (id, auth_user_id, name, account_status) values
  ('23100000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', 'Dona', 'active'),
  ('23100000-0000-4000-8000-000000000002', '23000000-0000-4000-8000-000000000002', 'Org', 'active'),
  ('23100000-0000-4000-8000-000000000003', '23000000-0000-4000-8000-000000000003', 'Jogador', 'active'),
  ('23100000-0000-4000-8000-000000000004', '23000000-0000-4000-8000-000000000004', 'Arquivado', 'active'),
  ('23100000-0000-4000-8000-000000000005', '23000000-0000-4000-8000-000000000005', 'Pendente', 'active');
insert into public.groups (id, name, owner_id) values
  ('23200000-0000-4000-8000-000000000001', 'Grupo Geo', '23100000-0000-4000-8000-000000000001'),
  ('23200000-0000-4000-8000-000000000002', 'Grupo Velho', '23100000-0000-4000-8000-000000000004');
insert into public.group_members (group_id, profile_id, role, status) values
  ('23200000-0000-4000-8000-000000000001', '23100000-0000-4000-8000-000000000001', 'player', 'active'),
  ('23200000-0000-4000-8000-000000000001', '23100000-0000-4000-8000-000000000002', 'organizer', 'active'),
  ('23200000-0000-4000-8000-000000000001', '23100000-0000-4000-8000-000000000003', 'player', 'active'),
  ('23200000-0000-4000-8000-000000000001', '23100000-0000-4000-8000-000000000005', 'organizer', 'pending'),
  ('23200000-0000-4000-8000-000000000002', '23100000-0000-4000-8000-000000000004', 'organizer', 'active');
update public.groups set archived_at = now() where id = '23200000-0000-4000-8000-000000000002';

-- ---------------------------------------------------------------------------
-- Autoridade e sessão, sem gastar o relógio
-- ---------------------------------------------------------------------------
update private.geocode_throttle set last_slot_at = '-infinity';
select is(public.geocode_gate('23000000-0000-4000-8000-000000000001', gen_random_uuid(), false),
  0, 'the owner may search (owner_id, whatever the membership role)');
select is(public.geocode_gate('23000000-0000-4000-8000-000000000002', gen_random_uuid(), false),
  0, 'an active organizer may search');
select throws_ok($$select public.geocode_gate('23000000-0000-4000-8000-000000000003',
  gen_random_uuid(), false)$$, '42501', 'NOT_ORGANIZER', 'a player may not search');
select throws_ok($$select public.geocode_gate('23000000-0000-4000-8000-000000000004',
  gen_random_uuid(), false)$$, '42501', 'NOT_ORGANIZER', 'an organizer of an archived group may not');
select throws_ok($$select public.geocode_gate('23000000-0000-4000-8000-000000000005',
  gen_random_uuid(), false)$$, '42501', 'NOT_ORGANIZER', 'a pending organizer may not');
select throws_ok($$select public.geocode_gate(null, gen_random_uuid(), false)$$,
  '28000', 'UNAUTHENTICATED', 'no actor, no search');
select throws_ok($$select public.geocode_gate('23000000-0000-4000-8000-000000000001', null, false)$$,
  '28000', 'UNAUTHENTICATED', 'no session, no search');
select throws_ok($$select public.geocode_gate('23000000-0000-4000-8000-000000000001',
  gen_random_uuid(), null)$$, '22023', 'VALIDATION', 'spend must be stated');
select is((select last_slot_at from private.geocode_throttle), '-infinity'::timestamptz,
  'checks without spend leave the clock untouched');

-- Sessão revogada: recusada também para uma resposta do cache (spend false).
insert into private.revoked_auth_sessions (session_id, profile_id, expires_at)
values ('23900000-0000-4000-8000-000000000001', '23100000-0000-4000-8000-000000000001',
  now() + interval '1 hour');
select throws_ok($$select public.geocode_gate('23000000-0000-4000-8000-000000000001',
  '23900000-0000-4000-8000-000000000001', false)$$, '28000', 'UNAUTHENTICATED',
  'a revoked session is refused even without spending');
select throws_ok($$select public.geocode_gate('23000000-0000-4000-8000-000000000001',
  '23900000-0000-4000-8000-000000000001', true)$$, '28000', 'UNAUTHENTICATED',
  'a revoked session is refused before the clock');
select is((select last_slot_at from private.geocode_throttle), '-infinity'::timestamptz,
  'a refused actor never spends the clock');

-- ---------------------------------------------------------------------------
-- Horários reservados a 1,25 s, para o app inteiro (revisão do #72, P1)
-- ---------------------------------------------------------------------------
-- A Edge chama no máximo 250 ms depois do horário; 1,25 s − 250 ms = 1 s.
select is(public.geocode_gate('23000000-0000-4000-8000-000000000001', gen_random_uuid(), true),
  0, 'with an idle schedule the first search goes now');
create temporary table slot_first as select last_slot_at as at from private.geocode_throttle;
select ok((select at > now() - interval '1 minute' from slot_first),
  'the schedule now holds that slot');
-- Cada reserva é lida uma vez: "f() between a and b" chamaria a função
-- volátil duas vezes e reservaria dois horários.
create temporary table slot_second as select public.geocode_gate(
  '23000000-0000-4000-8000-000000000002', gen_random_uuid(), true) as wait;
select ok((select wait between 1 and 1250 from slot_second),
  'another person gets the next slot, up to 1250 ms ahead');
select is((select last_slot_at - (select at from slot_first) from private.geocode_throttle),
  interval '1250 milliseconds', 'reserved slots are exactly 1250 ms apart');
create temporary table slot_third as select public.geocode_gate(
  '23000000-0000-4000-8000-000000000001', gen_random_uuid(), true) as wait;
select ok((select wait between 1251 and 2500 from slot_third),
  'a third one queues one more slot ahead');
select is((select last_slot_at - (select at from slot_first) from private.geocode_throttle),
  interval '2500 milliseconds', 'the schedule advanced by one slot again');
select is(public.geocode_gate('23000000-0000-4000-8000-000000000001', gen_random_uuid(), false),
  0, 'a cached answer is still served while the schedule is busy');
update private.geocode_throttle set last_slot_at = clock_timestamp() + interval '2 seconds';
select is(public.geocode_gate('23000000-0000-4000-8000-000000000002', gen_random_uuid(), true),
  null::integer, 'a slot more than 3 s ahead is not reserved: the Edge answers RATE_LIMITED');
select ok((select last_slot_at < clock_timestamp() + interval '2100 milliseconds'
  from private.geocode_throttle), 'a refused reservation leaves the schedule untouched');
update private.geocode_throttle set last_slot_at = clock_timestamp() - interval '10 seconds';
select is(public.geocode_gate('23000000-0000-4000-8000-000000000002', gen_random_uuid(), true),
  0, 'an old slot does not delay a new search: max(last + 1250 ms, now)');

-- Sonda negativa: nenhum papel cliente nem service_role toca a tabela.
set local role authenticated;
select throws_ok($$select * from private.geocode_throttle$$, '42501', null,
  'authenticated cannot read the clock');
reset role;
set local role service_role;
select throws_ok($$update private.geocode_throttle set last_slot_at = '-infinity'$$,
  '42501', null, 'service_role cannot move the schedule directly');
reset role;

select * from finish();
rollback;
