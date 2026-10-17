begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- RPC: assinatura estreita, ACL e modo
-- ---------------------------------------------------------------------------
select has_function('public', 'geocode_reserve', array['uuid', 'uuid', 'boolean'],
  'geocode_reserve has the narrow actor signature');
select is((select format_type(prorettype, null) from pg_proc
  where oid = 'public.geocode_reserve(uuid,uuid,boolean)'::regprocedure), 'jsonb',
  'it answers the wait and the slot spacing together');
select ok((select prosecdef and provolatile = 'v' and proconfig = array['search_path=""']
  from pg_proc where oid = 'public.geocode_reserve(uuid,uuid,boolean)'::regprocedure),
  'volatile security definer with fixed search_path');
select ok(not has_function_privilege('public', 'public.geocode_reserve(uuid,uuid,boolean)', 'execute')
  and not has_function_privilege('anon', 'public.geocode_reserve(uuid,uuid,boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.geocode_reserve(uuid,uuid,boolean)', 'execute'),
  'no client role executes geocode_reserve or spoofs an actor');
select ok(has_function_privilege('service_role', 'public.geocode_reserve(uuid,uuid,boolean)', 'execute'),
  'only the service role executes geocode_reserve');
select ok((select pg_get_functiondef(oid) like '%for no key update%'
  and pg_get_functiondef(oid) not like '%for update;%'
  from pg_proc where oid = 'public.geocode_reserve(uuid,uuid,boolean)'::regprocedure),
  'locks keep the M2-D13 mode');

-- ---------------------------------------------------------------------------
-- Atores
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('24000000-0000-4000-8000-000000000001', 'geo24-owner@example.invalid'),
  ('24000000-0000-4000-8000-000000000002', 'geo24-organizer@example.invalid'),
  ('24000000-0000-4000-8000-000000000003', 'geo24-player@example.invalid'),
  ('24000000-0000-4000-8000-000000000004', 'geo24-archived@example.invalid'),
  ('24000000-0000-4000-8000-000000000005', 'geo24-pending@example.invalid');
insert into public.profiles (id, auth_user_id, name, account_status) values
  ('24100000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', 'Dona', 'active'),
  ('24100000-0000-4000-8000-000000000002', '24000000-0000-4000-8000-000000000002', 'Org', 'active'),
  ('24100000-0000-4000-8000-000000000003', '24000000-0000-4000-8000-000000000003', 'Jogador', 'active'),
  ('24100000-0000-4000-8000-000000000004', '24000000-0000-4000-8000-000000000004', 'Arquivado', 'active'),
  ('24100000-0000-4000-8000-000000000005', '24000000-0000-4000-8000-000000000005', 'Pendente', 'active');
insert into public.groups (id, name, owner_id) values
  ('24200000-0000-4000-8000-000000000001', 'Grupo Geo', '24100000-0000-4000-8000-000000000001'),
  ('24200000-0000-4000-8000-000000000002', 'Grupo Velho', '24100000-0000-4000-8000-000000000004');
insert into public.group_members (group_id, profile_id, role, status) values
  ('24200000-0000-4000-8000-000000000001', '24100000-0000-4000-8000-000000000001', 'player', 'active'),
  ('24200000-0000-4000-8000-000000000001', '24100000-0000-4000-8000-000000000002', 'organizer', 'active'),
  ('24200000-0000-4000-8000-000000000001', '24100000-0000-4000-8000-000000000003', 'player', 'active'),
  ('24200000-0000-4000-8000-000000000001', '24100000-0000-4000-8000-000000000005', 'organizer', 'pending'),
  ('24200000-0000-4000-8000-000000000002', '24100000-0000-4000-8000-000000000004', 'organizer', 'active');
update public.groups set archived_at = now() where id = '24200000-0000-4000-8000-000000000002';

-- ---------------------------------------------------------------------------
-- Autoridade e sessão, sem gastar a agenda
-- ---------------------------------------------------------------------------
update private.geocode_throttle set last_slot_at = '-infinity';
select is(public.geocode_reserve('24000000-0000-4000-8000-000000000001', gen_random_uuid(), false),
  '{"wait_ms": 0, "spacing_ms": 2000}'::jsonb,
  'the owner may search (owner_id, whatever the membership role); a cached answer spends nothing');
select is(public.geocode_reserve('24000000-0000-4000-8000-000000000002', gen_random_uuid(), false)
  ->> 'wait_ms', '0', 'an active organizer may search');
select throws_ok($$select public.geocode_reserve('24000000-0000-4000-8000-000000000003',
  gen_random_uuid(), false)$$, '42501', 'NOT_ORGANIZER', 'a player may not search');
select throws_ok($$select public.geocode_reserve('24000000-0000-4000-8000-000000000004',
  gen_random_uuid(), false)$$, '42501', 'NOT_ORGANIZER', 'an organizer of an archived group may not');
select throws_ok($$select public.geocode_reserve('24000000-0000-4000-8000-000000000005',
  gen_random_uuid(), false)$$, '42501', 'NOT_ORGANIZER', 'a pending organizer may not');
select throws_ok($$select public.geocode_reserve(null, gen_random_uuid(), false)$$,
  '28000', 'UNAUTHENTICATED', 'no actor, no search');
select throws_ok($$select public.geocode_reserve('24000000-0000-4000-8000-000000000001', null, false)$$,
  '28000', 'UNAUTHENTICATED', 'no session, no search');
select throws_ok($$select public.geocode_reserve('24000000-0000-4000-8000-000000000001',
  gen_random_uuid(), null)$$, '22023', 'VALIDATION', 'spend must be stated');
insert into private.revoked_auth_sessions (session_id, profile_id, expires_at)
values ('24900000-0000-4000-8000-000000000001', '24100000-0000-4000-8000-000000000001',
  now() + interval '1 hour');
select throws_ok($$select public.geocode_reserve('24000000-0000-4000-8000-000000000001',
  '24900000-0000-4000-8000-000000000001', false)$$, '28000', 'UNAUTHENTICATED',
  'a revoked session is refused even without spending');
select throws_ok($$select public.geocode_reserve('24000000-0000-4000-8000-000000000001',
  '24900000-0000-4000-8000-000000000001', true)$$, '28000', 'UNAUTHENTICATED',
  'a revoked session is refused before the schedule');
select is((select last_slot_at from private.geocode_throttle), '-infinity'::timestamptz,
  'checks and refusals leave the schedule untouched');

-- ---------------------------------------------------------------------------
-- Horários a 2 s: a Edge chama até 1 s depois; 2000 − 1000 = 1000 ms
-- ---------------------------------------------------------------------------
-- Cada reserva é lida uma vez: "f() ->> x between a and b" chamaria a função
-- volátil duas vezes e reservaria dois horários.
create temporary table reservations (n integer, answer jsonb);
insert into reservations select 1, public.geocode_reserve(
  '24000000-0000-4000-8000-000000000001', gen_random_uuid(), true);
select is((select answer from reservations where n = 1),
  '{"wait_ms": 0, "spacing_ms": 2000}'::jsonb, 'with an idle schedule the first search goes now');
create temporary table slot_first as select last_slot_at as at from private.geocode_throttle;
insert into reservations select 2, public.geocode_reserve(
  '24000000-0000-4000-8000-000000000002', gen_random_uuid(), true);
select ok((select (answer ->> 'wait_ms')::integer between 1 and 2000 from reservations where n = 2),
  'another person gets the next slot, up to 2000 ms ahead');
select is((select last_slot_at - (select at from slot_first) from private.geocode_throttle),
  interval '2000 milliseconds', 'reserved slots are exactly 2000 ms apart');
insert into reservations select 3, public.geocode_reserve(
  '24000000-0000-4000-8000-000000000001', gen_random_uuid(), true);
insert into reservations select 4, public.geocode_reserve(
  '24000000-0000-4000-8000-000000000002', gen_random_uuid(), true);
select ok((select (answer ->> 'wait_ms')::integer between 4001 and 6000 from reservations where n = 4),
  'the fourth search queues three slots ahead, inside the 6 s horizon');
select is((select last_slot_at - (select at from slot_first) from private.geocode_throttle),
  interval '6000 milliseconds', 'the schedule advanced one slot per reservation');
insert into reservations select 5, public.geocode_reserve(
  '24000000-0000-4000-8000-000000000001', gen_random_uuid(), true);
select is((select answer from reservations where n = 5),
  '{"wait_ms": null, "spacing_ms": 2000}'::jsonb,
  'a slot more than 6 s ahead is not reserved: the Edge answers RATE_LIMITED');
select is((select last_slot_at - (select at from slot_first) from private.geocode_throttle),
  interval '6000 milliseconds', 'a refused reservation leaves the schedule untouched');
update private.geocode_throttle set last_slot_at = clock_timestamp() - interval '10 seconds';
insert into reservations select 6, public.geocode_reserve(
  '24000000-0000-4000-8000-000000000002', gen_random_uuid(), true);
select is((select answer ->> 'wait_ms' from reservations where n = 6), '0',
  'an old slot does not delay a new search: max(last + 2000 ms, now)');

select * from finish();
rollback;
