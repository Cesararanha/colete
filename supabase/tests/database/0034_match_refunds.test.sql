begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();
select ok(not relrowsecurity and not relforcerowsecurity,'private service table has no RLS') from pg_class where oid='private.match_refunds'::regclass;
select ok(not has_table_privilege(role,'private.match_refunds',privilege),role||' cannot '||privilege)
from (values('anon'),('authenticated'),('service_role')) roles(role),
(values('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) perms(privilege);
select ok(has_function_privilege(role,signature,'execute')=(role='service_role'),role||' execute boundary '||signature)
from (values('anon'),('authenticated'),('service_role')) roles(role),
(values('public.record_canceled_match_payment(uuid,uuid,uuid,text,integer,integer,uuid,uuid)'),
('public.mark_refunded(uuid,uuid,uuid,text,integer,integer,uuid,uuid,timestamptz)'),
('public.correct_refund(uuid,uuid,uuid,text,integer,integer,uuid,uuid,timestamptz)'),
('public.get_match_refunds(uuid,uuid,uuid)')) funcs(signature);
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

-- O config como a Edge o canoniza, a partir do racha gravado, com um patch.
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
create function pg_temp.instant(p_value timestamptz) returns text language sql as $$
  select to_char(date_trunc('minute', p_value) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"');
$$;
-- Chamada como a Edge faz: transporte interno com HMAC de formato válido.
create function pg_temp.upd(p_auth uuid, p_match uuid, p_patch jsonb default '{}',
  p_request uuid default gen_random_uuid(), p_hmac text default repeat('a', 64)) returns jsonb
language sql as $$
  select public.update_match(p_auth, '34900000-0000-4000-8000-000000000000', p_request,
    p_hmac, 1, 1, p_match, pg_temp.cfg(p_match, p_patch));
$$;
create function pg_temp.cancel(p_auth uuid, p_match uuid,
  p_request uuid default gen_random_uuid(), p_hmac text default repeat('a', 64)) returns jsonb
language sql as $$
  select public.cancel_match(p_auth, '34900000-0000-4000-8000-000000000000', p_request,
    p_hmac, 1, 1, p_match);
$$;
create function pg_temp.slots(p_match uuid) returns text language sql as $$
  select string_agg(p.name || ':' || mp.status, ',' order by mp.queue_seq)
  from private.match_players mp join public.profiles p on p.id = mp.profile_id
  where mp.match_id = p_match and mp.status in ('starter', 'waitlist');
$$;


create function pg_temp.record_payment(p_auth uuid,p_target uuid,p_req uuid default gen_random_uuid()) returns jsonb language sql as $$
 select public.record_canceled_match_payment(p_auth,'34900000-0000-4000-8000-000000000000',p_req,repeat('a',64),1,1,'34300000-0000-4000-8000-000000000001',p_target);
$$;
create function pg_temp.refund(p_auth uuid,p_refund uuid,p_correct boolean default false,p_req uuid default gen_random_uuid(),p_at timestamptz default clock_timestamp()) returns jsonb language plpgsql as $$
begin
 if p_correct then return public.correct_refund(p_auth,'34900000-0000-4000-8000-000000000000',p_req,repeat('a',64),1,1,'34300000-0000-4000-8000-000000000001',p_refund,p_at);
 end if;
 return public.mark_refunded(p_auth,'34900000-0000-4000-8000-000000000000',p_req,repeat('a',64),1,1,'34300000-0000-4000-8000-000000000001',p_refund,p_at);
end; $$;
select throws_ok($$select pg_temp.upd('34000000-0000-4000-8000-000000000001','34300000-0000-4000-8000-000000000001','{"field_price":"19.00"}')$$,'P0001','PRICE_LOCKED','paid locks the price');
-- P3-6: counterproof for unlocking after unmarking; preserve the paid fixture.
savepoint unmark_unlock;
select lives_ok($$select public.set_match_payment('34000000-0000-4000-8000-000000000001',gen_random_uuid(),gen_random_uuid(),repeat('a',64),1,1,'34300000-0000-4000-8000-000000000001','34100000-0000-4000-8000-000000000003',false)$$,'unmarking the last paid registration');
select lives_ok($$select pg_temp.upd('34000000-0000-4000-8000-000000000001','34300000-0000-4000-8000-000000000001','{"field_price":"19.00"}')$$,'price unlocks after unmarking the last paid registration');
select is((select field_price::text from private.matches where id='34300000-0000-4000-8000-000000000001'),'19.00','unlocked price actually changes');
rollback to savepoint unmark_unlock;
select throws_ok($$select public.delete_group('34000000-0000-4000-8000-000000000001',gen_random_uuid(),gen_random_uuid(),repeat('a',64),1,1,'34200000-0000-4000-8000-000000000001')$$,'P0001','ACTIVE_PAYMENTS_REMAIN','paid future match blocks deletion');
select throws_ok($$select pg_temp.record_payment('34000000-0000-4000-8000-000000000001','34100000-0000-4000-8000-000000000007')$$,'P0001','MATCH_NOT_CANCELED','late payment needs cancellation');
create temporary table cancellation as select pg_temp.cancel('34000000-0000-4000-8000-000000000001','34300000-0000-4000-8000-000000000001','34400000-0000-4000-8000-000000000001') r;
select is((select array_agg(k order by k) from cancellation,jsonb_object_keys(r->'outcome') k),array['group_id','logical_result','match_id'],'cancel keeps exact 0033 keys');
select is(pg_temp.cancel('34000000-0000-4000-8000-000000000001','34300000-0000-4000-8000-000000000001','34400000-0000-4000-8000-000000000001'),(select r from cancellation),'cancel replay');
select is((select count(*)::int from private.match_refunds),1,'one obligation for one paid registration');
select is((select amount::text||':'||origin from private.match_refunds),'15.00:canceled','amount frozen with cancellation origin');
select ok((select not paid and payment_marked_by is null and payment_marked_at is null from private.match_players where match_id='34300000-0000-4000-8000-000000000001' and profile_id='34100000-0000-4000-8000-000000000003'),'paid and both metadata cleared atomically');
select throws_ok($$select pg_temp.record_payment('34000000-0000-4000-8000-000000000001','34100000-0000-4000-8000-000000000003')$$,'P0001','PAYMENT_ALREADY_RESOLVED','P13 x P17: zeroed paid does not allow a second cancellation payment');
select throws_ok($$select pg_temp.record_payment('34000000-0000-4000-8000-000000000001','34100000-0000-4000-8000-000000000008')$$,'P0002','PAYMENT_RELATION_NOT_FOUND','waitlist never qualifies');
select throws_ok($$insert into private.match_refunds(match_player_id,payment_marked_at,payment_marked_by,amount,origin) select match_player_id,payment_marked_at,payment_marked_by,amount,'left_group' from private.match_refunds$$,'23505',null,'structural counterproof: payment identity is unique regardless of origin');
select throws_ok($$select pg_temp.record_payment('34000000-0000-4000-8000-000000000003','34100000-0000-4000-8000-000000000007')$$,'42501','NOT_ORGANIZER','refund mutation authority 003');
select throws_ok($$select pg_temp.refund('34000000-0000-4000-8000-000000000003',(select id from private.match_refunds limit 1))$$,'42501','NOT_ORGANIZER','refund mutation authority 003');
select throws_ok($$select pg_temp.refund('34000000-0000-4000-8000-000000000003',(select id from private.match_refunds limit 1),true)$$,'42501','NOT_ORGANIZER','refund mutation authority 003');
select throws_ok($$select pg_temp.record_payment('34000000-0000-4000-8000-000000000004','34100000-0000-4000-8000-000000000007')$$,'P0002','NOT_FOUND','refund mutation authority 004');
select throws_ok($$select pg_temp.refund('34000000-0000-4000-8000-000000000004',(select id from private.match_refunds limit 1))$$,'P0002','NOT_FOUND','refund mutation authority 004');
select throws_ok($$select pg_temp.refund('34000000-0000-4000-8000-000000000004',(select id from private.match_refunds limit 1),true)$$,'P0002','NOT_FOUND','refund mutation authority 004');
select throws_ok($$select pg_temp.record_payment('34000000-0000-4000-8000-000000000005','34100000-0000-4000-8000-000000000007')$$,'P0002','NOT_FOUND','refund mutation authority 005');
select throws_ok($$select pg_temp.refund('34000000-0000-4000-8000-000000000005',(select id from private.match_refunds limit 1))$$,'P0002','NOT_FOUND','refund mutation authority 005');
select throws_ok($$select pg_temp.refund('34000000-0000-4000-8000-000000000005',(select id from private.match_refunds limit 1),true)$$,'P0002','NOT_FOUND','refund mutation authority 005');
select throws_ok($$select pg_temp.record_payment('34000000-0000-4000-8000-000000000006','34100000-0000-4000-8000-000000000007')$$,'P0002','NOT_FOUND','refund mutation authority 006');
select throws_ok($$select pg_temp.refund('34000000-0000-4000-8000-000000000006',(select id from private.match_refunds limit 1))$$,'P0002','NOT_FOUND','refund mutation authority 006');
select throws_ok($$select pg_temp.refund('34000000-0000-4000-8000-000000000006',(select id from private.match_refunds limit 1),true)$$,'P0002','NOT_FOUND','refund mutation authority 006');

create temporary table late_payment as select pg_temp.record_payment('34000000-0000-4000-8000-000000000002','34100000-0000-4000-8000-000000000007','34400000-0000-4000-8000-000000000002') r;
select is(pg_temp.record_payment('34000000-0000-4000-8000-000000000002','34100000-0000-4000-8000-000000000007','34400000-0000-4000-8000-000000000002'),(select r from late_payment),'organizer late payment replay');
select is((select count(*)::int from private.match_refunds),2,'late payment adds exactly one obligation');
select is(jsonb_array_length(public.get_match_roster('34000000-0000-4000-8000-000000000003',gen_random_uuid(),'34300000-0000-4000-8000-000000000001')->'viewer'->'refunds'),1,'player sees only own refund');
select is((select array_agg(k order by k) from jsonb_object_keys(item) k),array['amount','created_at','id','refunded_at','status'],'player refund has exactly the allowed keys')
from jsonb_array_elements(public.get_match_roster('34000000-0000-4000-8000-000000000003',gen_random_uuid(),'34300000-0000-4000-8000-000000000001')->'viewer'->'refunds') item;
select is((select array_agg(k order by k) from jsonb_object_keys(item) k),array['account_removed','amount','created_at','id','name','nickname','refunded_at','status'],'organization refund has exactly the allowed keys')
from jsonb_array_elements(public.get_match_refunds('34000000-0000-4000-8000-000000000001',gen_random_uuid(),'34300000-0000-4000-8000-000000000001')) item;
select throws_ok($$select public.get_match_refunds('34000000-0000-4000-8000-000000000003',gen_random_uuid(),'34300000-0000-4000-8000-000000000001')$$,'42501','NOT_ORGANIZER','player cannot read organization projection');
select throws_ok($$select pg_temp.refund('34000000-0000-4000-8000-000000000001',(select id from private.match_refunds limit 1),false,gen_random_uuid(),now()-interval '1 day')$$,'22023','VALIDATION','refund cannot predate obligation');
select throws_ok($$select pg_temp.refund('34000000-0000-4000-8000-000000000001',(select id from private.match_refunds limit 1),false,gen_random_uuid(),now()+interval '1 day')$$,'22023','VALIDATION','refund cannot be future');
create temporary table marked as select pg_temp.refund('34000000-0000-4000-8000-000000000001',(select id from private.match_refunds order by id limit 1),false,'34400000-0000-4000-8000-000000000003') r;
select is(pg_temp.refund('34000000-0000-4000-8000-000000000001',(select id from private.match_refunds order by id limit 1),false,'34400000-0000-4000-8000-000000000003'),(select r from marked),'mark replay keeps outcome');
select is((select status from private.match_refunds order by id limit 1),'refunded','mark changes state');
select ok((select marked_by='34100000-0000-4000-8000-000000000001' and marked_at is not null from private.match_refunds order by id limit 1),'mark records actor and time');
select throws_ok($$select pg_temp.refund('34000000-0000-4000-8000-000000000001',(select id from private.match_refunds where status='refunded' limit 1),true,gen_random_uuid(),now()-interval '1 day')$$,'22023','VALIDATION','correction cannot predate obligation');
select throws_ok($$select pg_temp.refund('34000000-0000-4000-8000-000000000001',(select id from private.match_refunds where status='refunded' limit 1),true,gen_random_uuid(),clock_timestamp()+interval '1 day')$$,'22023','VALIDATION','correction cannot be future');
-- A backwards server-clock adjustment must not put implicit now before creation.
savepoint server_clock_floor;
update private.match_refunds set status='refund_due',refunded_at=null,marked_by=null,marked_at=null,created_at=clock_timestamp()+interval '1 minute' where id=(select id from private.match_refunds order by id limit 1);
select lives_ok($$select pg_temp.refund('34000000-0000-4000-8000-000000000001',(select id from private.match_refunds order by id limit 1),false,gen_random_uuid(),null)$$,'implicit mark respects created_at even after clock goes backwards');
select ok((select refunded_at=created_at and marked_at>=refunded_at from private.match_refunds order by id limit 1),'implicit mark uses creation as its lower bound');
update private.match_refunds set refunded_at=created_at+interval '1 second',marked_at=created_at+interval '2 seconds' where id=(select id from private.match_refunds order by id limit 1);
select lives_ok($$select pg_temp.refund('34000000-0000-4000-8000-000000000001',(select id from private.match_refunds order by id limit 1),true,gen_random_uuid(),null)$$,'implicit correction respects created_at even after clock goes backwards');
select ok((select refunded_at=created_at and marked_at>=refunded_at from private.match_refunds order by id limit 1),'implicit correction uses creation as its lower bound');
rollback to savepoint server_clock_floor;
create temporary table frozen_refund_facts as select to_jsonb(r)-array['refunded_at','marked_by','marked_at'] facts from private.match_refunds r order by id limit 1;
create temporary table corrected as select pg_temp.refund('34000000-0000-4000-8000-000000000002',(select id from private.match_refunds order by id limit 1),true,'34400000-0000-4000-8000-000000000004') r;
select is(pg_temp.refund('34000000-0000-4000-8000-000000000002',(select id from private.match_refunds order by id limit 1),true,'34400000-0000-4000-8000-000000000004'),(select r from corrected),'correction replay');
select ok((select status='refunded' and refunded_at is not null and marked_by='34100000-0000-4000-8000-000000000002' from private.match_refunds order by id limit 1),'only organizer corrects and actor is recorded');
select is((select to_jsonb(r)-array['refunded_at','marked_by','marked_at'] from private.match_refunds r order by id limit 1),(select facts from frozen_refund_facts),'correction preserves money, beneficiary, original payment and refunded state');
select lives_ok($$select public.leave_group('34000000-0000-4000-8000-000000000003',gen_random_uuid(),gen_random_uuid(),repeat('a',64),1,1,'34200000-0000-4000-8000-000000000001')$$,'leave_group in canceled match succeeds');
select is((select status from private.match_players where match_id='34300000-0000-4000-8000-000000000001' and profile_id='34100000-0000-4000-8000-000000000003'),'starter','canceled list remains history after group exit');
select is((select count(*)::int from private.match_refunds r join private.match_players p on p.id=r.match_player_id where p.profile_id='34100000-0000-4000-8000-000000000003' and p.match_id='34300000-0000-4000-8000-000000000001' and r.origin='canceled'),1,'exactly one canceled obligation survives exit');
select throws_ok($$select public.get_match_roster('34000000-0000-4000-8000-000000000003',gen_random_uuid(),'34300000-0000-4000-8000-000000000001')$$,'P0002','NOT_FOUND','former member cannot read own refund (pilot limitation)');
select is(jsonb_array_length(public.get_match_refunds('34000000-0000-4000-8000-000000000001',gen_random_uuid(),'34300000-0000-4000-8000-000000000001')),2,'organization keeps former member obligations');
select throws_ok($$select public.delete_group('34000000-0000-4000-8000-000000000001',gen_random_uuid(),gen_random_uuid(),repeat('a',64),1,1,'34200000-0000-4000-8000-000000000001')$$,'P0001','REFUNDS_PENDING','pending refunds prevent inaccessible group');
-- Price locked by obligation without any paid, in an uncanceled match.
update private.matches set canceled_at=null,canceled_by=null where id='34300000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.upd('34000000-0000-4000-8000-000000000001','34300000-0000-4000-8000-000000000001','{"field_price":"19.00"}')$$,'P0001','PRICE_LOCKED','pending obligation alone locks price');
savepoint all_refunded_unlock;
select lives_ok(format('select pg_temp.refund(%L,%L,false,gen_random_uuid(),null)','34000000-0000-4000-8000-000000000001',id),'server clock marks outstanding refund') from private.match_refunds where status='refund_due';
select lives_ok($$select pg_temp.upd('34000000-0000-4000-8000-000000000001','34300000-0000-4000-8000-000000000001','{"field_price":"19.00"}')$$,'all refunded without paid unlocks the price');
select is((select field_price::text from private.matches where id='34300000-0000-4000-8000-000000000001'),'19.00','all refunded price actually changes');
rollback to savepoint all_refunded_unlock;
-- Two exits with a return and a fresh payment make two obligations (P13).
update public.group_members set status='active',removed_at=null where group_id='34200000-0000-4000-8000-000000000001' and profile_id='34100000-0000-4000-8000-000000000007';
update private.match_players set paid=true,payment_marked_at=clock_timestamp(),payment_marked_by='34100000-0000-4000-8000-000000000001' where match_id='34300000-0000-4000-8000-000000000004' and profile_id='34100000-0000-4000-8000-000000000007';
select lives_ok($$select public.leave_group('34000000-0000-4000-8000-000000000007',gen_random_uuid(),gen_random_uuid(),repeat('a',64),1,1,'34200000-0000-4000-8000-000000000001')$$,'paid group exit creates obligation');
update public.group_members set status='active',removed_at=null where group_id='34200000-0000-4000-8000-000000000001' and profile_id='34100000-0000-4000-8000-000000000007';
select lives_ok($$select public.join_match('34000000-0000-4000-8000-000000000007',gen_random_uuid(),gen_random_uuid(),repeat('a',64),1,1,'34300000-0000-4000-8000-000000000004')$$,'return allowed with old refund pending');
select ok((select not paid and payment_marked_at is null and payment_marked_by is null from private.match_players where match_id='34300000-0000-4000-8000-000000000004' and profile_id='34100000-0000-4000-8000-000000000007'),'return is unpaid while old obligation remains');
select lives_ok($$select public.set_match_payment('34000000-0000-4000-8000-000000000001',gen_random_uuid(),gen_random_uuid(),repeat('a',64),1,1,'34300000-0000-4000-8000-000000000004','34100000-0000-4000-8000-000000000007',true)$$,'fresh payment after return');
select lives_ok($$select public.leave_group('34000000-0000-4000-8000-000000000007',gen_random_uuid(),gen_random_uuid(),repeat('a',64),1,1,'34200000-0000-4000-8000-000000000001')$$,'second paid exit');
select is((select count(*)::int from private.match_refunds r join private.match_players p on p.id=r.match_player_id where p.match_id='34300000-0000-4000-8000-000000000004' and p.profile_id='34100000-0000-4000-8000-000000000007'),2,'second payment is a second obligation on same registration');
-- Pending obligation in a finished match still blocks deletion.
update private.matches set starts_at=now()-interval '3 hours',ends_at=now()-interval '1 hour' where id in ('34300000-0000-4000-8000-000000000001','34300000-0000-4000-8000-000000000004');
select throws_ok($$select public.delete_group('34000000-0000-4000-8000-000000000001',gen_random_uuid(),gen_random_uuid(),repeat('a',64),1,1,'34200000-0000-4000-8000-000000000001')$$,'P0001','REFUNDS_PENDING','ended match refunds still block deletion');
-- A payment on the match in progress blocks deletion too.
update private.match_players set paid=true,payment_marked_at=clock_timestamp(),payment_marked_by='34100000-0000-4000-8000-000000000001' where match_id='34300000-0000-4000-8000-000000000002';
-- That fixture has no participants yet: create one explicitly.
insert into private.match_players(match_id,profile_id,status,queue_seq,paid,payment_marked_at,payment_marked_by)
values('34300000-0000-4000-8000-000000000002','34100000-0000-4000-8000-000000000001','starter',nextval('private.match_queue_seq'),true,clock_timestamp(),'34100000-0000-4000-8000-000000000001');
select throws_ok($$select public.delete_group('34000000-0000-4000-8000-000000000001',gen_random_uuid(),gen_random_uuid(),repeat('a',64),1,1,'34200000-0000-4000-8000-000000000001')$$,'P0001','ACTIVE_PAYMENTS_REMAIN','in-progress paid match blocks deletion before refund check');
update public.profiles set account_status='deletion_pending' where id='34100000-0000-4000-8000-000000000007';
select ok((select bool_and(item->'name'='null'::jsonb and item->'nickname'='null'::jsonb and item->>'account_removed'='true') from jsonb_array_elements(public.get_match_refunds('34000000-0000-4000-8000-000000000001',gen_random_uuid(),'34300000-0000-4000-8000-000000000004')) item),'financial projection deidentifies account pending deletion');
-- Current pilot gap: solo owner account deletion can archive third-party obligations.
update public.group_members set status='removed',removed_at=now()
where group_id='34200000-0000-4000-8000-000000000001' and profile_id<>'34100000-0000-4000-8000-000000000001' and status='active';
select lives_ok($$select public.delete_account('34000000-0000-4000-8000-000000000001',gen_random_uuid(),gen_random_uuid(),repeat('a',64),1,1)$$,'known M5 gap: solo owner account deletion is not financially blocked');
select ok((select archived_at is not null from public.groups where id='34200000-0000-4000-8000-000000000001'),'solo group archived despite third-party obligation');
select ok(exists(select 1 from private.match_refunds r join private.match_players p on p.id=r.match_player_id where p.match_id='34300000-0000-4000-8000-000000000004' and r.status='refund_due'),'third-party pending obligations survive as documented debt');
select * from finish();
rollback;
