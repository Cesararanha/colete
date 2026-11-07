begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
select ok(not has_table_privilege(role,tbl,privilege),role||' cannot '||privilege||' '||tbl)
from (values('anon'),('authenticated'),('service_role')) roles(role),
(values('private.match_players'),('private.match_refunds'),('private.idempotency_operations'),('private.idempotency_operation_results')) tables(tbl),
(values('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) perms(privilege);
select ok(has_function_privilege(role,signature,'execute')=(role='service_role'),role||' execute '||signature)
from (values('anon'),('authenticated'),('service_role')) roles(role),
(values('public.add_player(uuid,uuid,uuid,text,integer,integer,uuid,uuid)'),
('public.remove_player(uuid,uuid,uuid,text,integer,integer,uuid,uuid)')) funcs(signature);
insert into auth.users (id, email) values
  ('34000000-0000-4000-8000-000000000001', 'edit28-owner@example.invalid'),
  ('34000000-0000-4000-8000-000000000002', 'edit28-organizer@example.invalid'),
  ('34000000-0000-4000-8000-000000000003', 'edit28-player@example.invalid'),
  ('34000000-0000-4000-8000-000000000004', 'edit28-former@example.invalid'),
  ('34000000-0000-4000-8000-000000000005', 'edit28-pending@example.invalid'),
  ('34000000-0000-4000-8000-000000000006', 'edit28-stranger@example.invalid'),
  ('34000000-0000-4000-8000-000000000007', 'edit28-p7@example.invalid'),
  ('34000000-0000-4000-8000-000000000008', 'edit28-p8@example.invalid'),
  ('34000000-0000-4000-8000-000000000009', 'edit28-p9@example.invalid');
insert into public.profiles (id, auth_user_id, name, account_status) values
  ('34100000-0000-4000-8000-000000000001', '34000000-0000-4000-8000-000000000001', 'Dona', 'active'),
  ('34100000-0000-4000-8000-000000000002', '34000000-0000-4000-8000-000000000002', 'Org', 'active'),
  ('34100000-0000-4000-8000-000000000003', '34000000-0000-4000-8000-000000000003', 'Jogador', 'active'),
  ('34100000-0000-4000-8000-000000000004', '34000000-0000-4000-8000-000000000004', 'Ex', 'active'),
  ('34100000-0000-4000-8000-000000000005', '34000000-0000-4000-8000-000000000005', 'Pendente', 'active'),
  ('34100000-0000-4000-8000-000000000006', '34000000-0000-4000-8000-000000000006', 'Fora', 'active'),
  ('34100000-0000-4000-8000-000000000007', '34000000-0000-4000-8000-000000000007', 'Sete', 'active'),
  ('34100000-0000-4000-8000-000000000008', '34000000-0000-4000-8000-000000000008', 'Oito', 'active'),
  ('34100000-0000-4000-8000-000000000009', '34000000-0000-4000-8000-000000000009', 'Nove', 'active');
insert into public.groups (id, name, owner_id) values
  ('34200000-0000-4000-8000-000000000001', 'Grupo Edição', '34100000-0000-4000-8000-000000000001');
insert into public.group_members (group_id, profile_id, role, status, removed_at) values
  ('34200000-0000-4000-8000-000000000001', '34100000-0000-4000-8000-000000000001', 'player', 'active', null),
  ('34200000-0000-4000-8000-000000000001', '34100000-0000-4000-8000-000000000002', 'organizer', 'active', null),
  ('34200000-0000-4000-8000-000000000001', '34100000-0000-4000-8000-000000000003', 'player', 'active', null),
  ('34200000-0000-4000-8000-000000000001', '34100000-0000-4000-8000-000000000004', 'organizer', 'removed', now()),
  ('34200000-0000-4000-8000-000000000001', '34100000-0000-4000-8000-000000000005', 'organizer', 'pending', null),
  ('34200000-0000-4000-8000-000000000001', '34100000-0000-4000-8000-000000000007', 'player', 'active', null),
  ('34200000-0000-4000-8000-000000000001', '34100000-0000-4000-8000-000000000008', 'player', 'active', null),
  ('34200000-0000-4000-8000-000000000001', '34100000-0000-4000-8000-000000000009', 'player', 'active', null);

-- 301: futuro, 2 vagas, 2 confirmados e 2 na espera (8 antes de 9).
-- 302: em andamento. 303: terminado. 304: futuro, para cancelar.
insert into private.matches (id, group_id, starts_at, ends_at, timezone, location_name,
  field_slots, field_price, created_by) values
  ('34300000-0000-4000-8000-000000000001', '34200000-0000-4000-8000-000000000001',
   date_trunc('minute', now()) + interval '2 days',
   date_trunc('minute', now()) + interval '2 days 90 minutes', 'America/Sao_Paulo',
   'Arena', 2, 15, '34100000-0000-4000-8000-000000000001'),
  ('34300000-0000-4000-8000-000000000002', '34200000-0000-4000-8000-000000000001',
   date_trunc('minute', now()) - interval '30 minutes',
   date_trunc('minute', now()) + interval '60 minutes', 'America/Sao_Paulo',
   'Quadra', 3, 20, '34100000-0000-4000-8000-000000000001'),
  ('34300000-0000-4000-8000-000000000003', '34200000-0000-4000-8000-000000000001',
   date_trunc('minute', now()) - interval '3 hours',
   date_trunc('minute', now()) - interval '1 hour', 'America/Sao_Paulo',
   'Campo', 3, 20, '34100000-0000-4000-8000-000000000001'),
  ('34300000-0000-4000-8000-000000000004', '34200000-0000-4000-8000-000000000001',
   date_trunc('minute', now()) + interval '3 days',
   date_trunc('minute', now()) + interval '3 days 90 minutes', 'America/Sao_Paulo',
   'Ginásio', 2, 10, '34100000-0000-4000-8000-000000000001');
insert into private.match_players (match_id, profile_id, status, queue_seq) values
  ('34300000-0000-4000-8000-000000000001', '34100000-0000-4000-8000-000000000003', 'starter', nextval('private.match_queue_seq')),
  ('34300000-0000-4000-8000-000000000001', '34100000-0000-4000-8000-000000000007', 'starter', nextval('private.match_queue_seq')),
  ('34300000-0000-4000-8000-000000000001', '34100000-0000-4000-8000-000000000008', 'waitlist', nextval('private.match_queue_seq')),
  ('34300000-0000-4000-8000-000000000001', '34100000-0000-4000-8000-000000000009', 'waitlist', nextval('private.match_queue_seq')),
  ('34300000-0000-4000-8000-000000000004', '34100000-0000-4000-8000-000000000003', 'starter', nextval('private.match_queue_seq')),
  ('34300000-0000-4000-8000-000000000004', '34100000-0000-4000-8000-000000000007', 'starter', nextval('private.match_queue_seq')),
  ('34300000-0000-4000-8000-000000000004', '34100000-0000-4000-8000-000000000008', 'waitlist', nextval('private.match_queue_seq'));
update private.match_players set paid = true,
  payment_marked_by = '34100000-0000-4000-8000-000000000001', payment_marked_at = now() - interval '1 hour'
where match_id = '34300000-0000-4000-8000-000000000001'
  and profile_id = '34100000-0000-4000-8000-000000000003';


create function pg_temp.manage(op text,a int,t int,m int default 1,r uuid default gen_random_uuid()) returns jsonb language plpgsql as $$
declare result jsonb;
begin
 execute format('select public.%I($1,$2,$3,$4,1,1,$5,$6)',op) into result using
 ('34000000-0000-4000-8000-'||lpad(a::text,12,'0'))::uuid,
 '34900000-0000-4000-8000-000000000000'::uuid,r,repeat('a',64),
 ('34300000-0000-4000-8000-'||lpad(m::text,12,'0'))::uuid,
 ('34100000-0000-4000-8000-'||lpad(t::text,12,'0'))::uuid;
 return result;
end; $$;
grant execute on function pg_temp.manage(text,int,int,int,uuid) to service_role;
set local role service_role;
select throws_ok($$select pg_temp.manage('add_player',3,7,1)$$,'P0002','NOT_FOUND','add_player actor 3 match 1: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('add_player',3,7,99)$$,'P0002','NOT_FOUND','add_player actor 3 match 99: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('add_player',4,7,1)$$,'P0002','NOT_FOUND','add_player actor 4 match 1: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('add_player',4,7,99)$$,'P0002','NOT_FOUND','add_player actor 4 match 99: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('add_player',5,7,1)$$,'P0002','NOT_FOUND','add_player actor 5 match 1: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('add_player',5,7,99)$$,'P0002','NOT_FOUND','add_player actor 5 match 99: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('add_player',6,7,1)$$,'P0002','NOT_FOUND','add_player actor 6 match 1: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('add_player',6,7,99)$$,'P0002','NOT_FOUND','add_player actor 6 match 99: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('add_player',1,4)$$,'P0002','NOT_FOUND','add_player inactive target 4');
select throws_ok($$select pg_temp.manage('add_player',1,5)$$,'P0002','NOT_FOUND','add_player inactive target 5');
select throws_ok($$select pg_temp.manage('add_player',1,6)$$,'P0002','NOT_FOUND','add_player inactive target 6');
select throws_ok($$select pg_temp.manage('add_player',1,7,2)$$,'P0001','MATCH_STARTED','add_player started or ended 2');
select throws_ok($$select pg_temp.manage('add_player',1,7,3)$$,'P0001','MATCH_STARTED','add_player started or ended 3');
select throws_ok($$select pg_temp.manage('remove_player',3,7,1)$$,'P0002','NOT_FOUND','remove_player actor 3 match 1: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('remove_player',3,7,99)$$,'P0002','NOT_FOUND','remove_player actor 3 match 99: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('remove_player',4,7,1)$$,'P0002','NOT_FOUND','remove_player actor 4 match 1: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('remove_player',4,7,99)$$,'P0002','NOT_FOUND','remove_player actor 4 match 99: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('remove_player',5,7,1)$$,'P0002','NOT_FOUND','remove_player actor 5 match 1: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('remove_player',5,7,99)$$,'P0002','NOT_FOUND','remove_player actor 5 match 99: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('remove_player',6,7,1)$$,'P0002','NOT_FOUND','remove_player actor 6 match 1: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('remove_player',6,7,99)$$,'P0002','NOT_FOUND','remove_player actor 6 match 99: indistinguishable NOT_FOUND');
select throws_ok($$select pg_temp.manage('remove_player',1,4)$$,'P0002','NOT_FOUND','remove_player inactive target 4');
select throws_ok($$select pg_temp.manage('remove_player',1,5)$$,'P0002','NOT_FOUND','remove_player inactive target 5');
select throws_ok($$select pg_temp.manage('remove_player',1,6)$$,'P0002','NOT_FOUND','remove_player inactive target 6');
select throws_ok($$select pg_temp.manage('remove_player',1,7,2)$$,'P0001','MATCH_STARTED','remove_player started or ended 2');
select throws_ok($$select pg_temp.manage('remove_player',1,7,3)$$,'P0001','MATCH_STARTED','remove_player started or ended 3');

select is(pg_temp.manage('add_player',1,1)->'outcome'->>'logical_result','player_waitlisted','owner adds at the end of full list');
select is(pg_temp.manage('add_player',2,1)->'outcome'->>'logical_result','player_add_unchanged','organizer already listed has no effect');
select is(pg_temp.manage('remove_player',2,3)->'outcome'->>'logical_result','player_removed','organizer removes paid starter');
reset role;
select is((select origin from private.match_refunds),'removed','paid removal creates removed obligation');
select is((select amount::text from private.match_refunds),'15.00','refund freezes price');
select ok((select not paid and payment_marked_at is null and payment_marked_by is null from private.match_players where match_id='34300000-0000-4000-8000-000000000001' and profile_id='34100000-0000-4000-8000-000000000003'),'removal clears paid and both metadata');
select is((select status from private.match_players where match_id='34300000-0000-4000-8000-000000000001' and profile_id='34100000-0000-4000-8000-000000000008'),'starter','first waiting promoted');
select is((select status from public.group_members where profile_id='34100000-0000-4000-8000-000000000003'),'active','removal from match preserves group membership');
set local role service_role;
select is(pg_temp.manage('remove_player',1,3)->'outcome'->>'logical_result','player_remove_unchanged','repeat removal has no effect');
select is(pg_temp.manage('remove_player',1,9)->'outcome'->>'logical_result','player_removed','owner removes waitlist');
reset role;
select is((select count(*)::int from private.match_refunds),1,'unpaid waitlist creates no obligation');
set local role service_role;
select throws_ok($$select pg_temp.manage('remove_player',1,1)$$,'42501','FORBIDDEN','unpaid self-removal goes through Desistir');
select is(public.join_match('34000000-0000-4000-8000-000000000003',gen_random_uuid(),gen_random_uuid(),repeat('a',64),1,1,'34300000-0000-4000-8000-000000000001')->'current'->>'waitlist_position','2','removed player returns at the end behind owner');
reset role;
select ok((select not paid from private.match_players where match_id='34300000-0000-4000-8000-000000000001' and profile_id='34100000-0000-4000-8000-000000000003'),'return remains unpaid with old refund pending');
-- Add/remove replay with a fresh target each and exact IDs-only shape.
set local role service_role;
select is(pg_temp.manage('add_player',1,9,1,'35400000-0000-4000-8000-000000000001'), pg_temp.manage('add_player',1,9,1,'35400000-0000-4000-8000-000000000001'),'add replay');
select is(pg_temp.manage('remove_player',2,9,1,'35400000-0000-4000-8000-000000000002'), pg_temp.manage('remove_player',2,9,1,'35400000-0000-4000-8000-000000000002'),'remove replay');
reset role;
select throws_ok($$select private.validate_idempotency_outcome('add_player','{"group_id":"34200000-0000-4000-8000-000000000001","match_id":"34300000-0000-4000-8000-000000000001","profile_id":"34100000-0000-4000-8000-000000000003","logical_result":"player_removed"}')$$,'22023','VALIDATION','outcome cannot cross operations');
update private.matches set canceled_at=now(), canceled_by='34100000-0000-4000-8000-000000000001' where id='34300000-0000-4000-8000-000000000001';
set local role service_role;
select throws_ok($$select pg_temp.manage('add_player',1,9)$$,'P0001','MATCH_CANCELED','add canceled');
select throws_ok($$select pg_temp.manage('remove_player',2,9)$$,'P0001','MATCH_CANCELED','remove canceled');
reset role;
select * from finish();
rollback;
