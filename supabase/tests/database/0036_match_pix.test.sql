-- 0036: Pix manual do piloto (noite/plano-pix-manual.md, versão 3).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Privilégios: ninguém lê a tabela; só service_role executa as duas RPCs; os
-- helpers privados e os gatilhos não são executáveis por nenhum papel da API
-- nem por um papel de prova criado aqui.
-- ---------------------------------------------------------------------------
create role pix_probe nologin;
select ok(not has_table_privilege(role,'private.match_payment_secrets',privilege),
  role||' cannot '||privilege||' private.match_payment_secrets')
from (values('anon'),('authenticated'),('service_role'),('pix_probe')) roles(role),
(values('select'),('insert'),('update'),('delete'),('truncate'),('references'),('trigger')) perms(privilege);
select ok(has_function_privilege(role,signature,'execute')=(role='service_role'),role||' execute '||signature)
from (values('anon'),('authenticated'),('service_role'),('pix_probe')) roles(role),
(values('public.set_match_pix(uuid,uuid,uuid,text,integer,integer,uuid,jsonb)'),
('public.get_payment_instructions(uuid,uuid,uuid)')) funcs(signature);
select ok(not has_function_privilege(role,signature,'execute'),role||' cannot execute '||signature)
from (values('anon'),('authenticated'),('service_role'),('pix_probe')) roles(role),
(values('private.match_pix_expired(private.matches)'),('private.match_has_real_payment(uuid)'),
('private.purge_match_pix_rows(uuid[])'),('private.purge_match_pix_without_authority(uuid)'),
('private.purge_match_pix_on_membership_change()'),('private.purge_match_pix_on_group_change()'),
('private.purge_match_pix_on_deletion_request()'),('private.purge_match_pix()')) funcs(signature);
select is((select relrowsecurity from pg_class where oid='private.match_payment_secrets'::regclass),false,
  'private service table: no RLS, no grant');
select is((select count(*)::int from pg_proc where proname in ('set_match_pix','get_payment_instructions')),2,
  'no overload of the two RPCs');
select is((select array_agg(logical_result order by logical_result) from private.idempotency_operation_results
  where operation='set_match_pix'), array['pix_remove_unchanged','pix_removed','pix_set'],
  'set_match_pix has exactly its three logical results');
select is((select schedule from cron.job where jobname='colete_v1_purge_match_pix'),'53 3 * * *',
  'purge_match_pix runs daily at 03:53 UTC');
select is(private.worker_job_slot('purge_match_pix','2026-10-20 05:00:00+00'::timestamptz),
  '2026-10-20 03:53:00+00'::timestamptz, 'purge_match_pix shares the daily retention slot');

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- 1 dono (papel player), 2 organizador, 3 jogador confirmado não pago,
-- 4 ex-membro, 5 pendente, 6 estranho, 7 jogador pago, 8 na espera,
-- 9 segundo organizador, 10 dono do grupo 2, 11 organizador do grupo 2.
insert into auth.users (id, email)
select ('36000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid, 'pix36-'||n||'@example.invalid'
from generate_series(1,11) n;
insert into public.profiles (id, auth_user_id, name, account_status)
select ('36100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
       ('36000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
       (array['Dona','Org','Jogador','Ex','Pendente','Fora','Pago','Espera','Org Dois','Dono Dois','Org Tres'])[n],
       'active'
from generate_series(1,11) n;
insert into public.groups (id, name, owner_id) values
  ('36200000-0000-4000-8000-000000000001', 'Grupo Pix', '36100000-0000-4000-8000-000000000001'),
  ('36200000-0000-4000-8000-000000000002', 'Grupo Pix Dois', '36100000-0000-4000-8000-000000000010');
insert into public.group_members (group_id, profile_id, role, status, removed_at) values
  ('36200000-0000-4000-8000-000000000001', '36100000-0000-4000-8000-000000000001', 'player', 'active', null),
  ('36200000-0000-4000-8000-000000000001', '36100000-0000-4000-8000-000000000002', 'organizer', 'active', null),
  ('36200000-0000-4000-8000-000000000001', '36100000-0000-4000-8000-000000000003', 'player', 'active', null),
  ('36200000-0000-4000-8000-000000000001', '36100000-0000-4000-8000-000000000004', 'organizer', 'removed', now()),
  ('36200000-0000-4000-8000-000000000001', '36100000-0000-4000-8000-000000000005', 'organizer', 'pending', null),
  ('36200000-0000-4000-8000-000000000001', '36100000-0000-4000-8000-000000000007', 'player', 'active', null),
  ('36200000-0000-4000-8000-000000000001', '36100000-0000-4000-8000-000000000008', 'player', 'active', null),
  ('36200000-0000-4000-8000-000000000001', '36100000-0000-4000-8000-000000000009', 'organizer', 'active', null),
  ('36200000-0000-4000-8000-000000000002', '36100000-0000-4000-8000-000000000010', 'player', 'active', null),
  ('36200000-0000-4000-8000-000000000002', '36100000-0000-4000-8000-000000000011', 'organizer', 'active', null);

-- Rachas do grupo 1 (field_price 15): 1 futuro sem pagamento; 2 futuro com
-- pago; 3 futuro que terá Pix e depois pago; 4 futuro com «a devolver»;
-- 5 terminou há 59 dias; 6 terminou há 61 dias; 7 cancelado ontem;
-- 8 cancelado há 61 dias; 10 futuro da matriz de leitura; 11 futuro sem Pix;
-- 12, 13, 14 futuros para os gatilhos. Grupo 2: 20 e 21 futuros.
create function pg_temp.mk(n int, g int, ends interval, canceled interval default null)
returns void language sql as $$
  insert into private.matches (id, group_id, starts_at, ends_at, timezone, location_name,
    field_slots, field_price, created_by, canceled_at, canceled_by)
  values (('36300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
    ('36200000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,
    date_trunc('minute', now()) + ends - interval '90 minutes',
    date_trunc('minute', now()) + ends, 'America/Sao_Paulo', 'Arena', 4, 15,
    case g when 1 then '36100000-0000-4000-8000-000000000001'::uuid
           else '36100000-0000-4000-8000-000000000010'::uuid end,
    case when canceled is null then null else now() + canceled end,
    case when canceled is null then null
         else '36100000-0000-4000-8000-000000000001'::uuid end);
$$;
select pg_temp.mk(1,1,interval '2 days'), pg_temp.mk(2,1,interval '2 days'),
  pg_temp.mk(3,1,interval '2 days'), pg_temp.mk(4,1,interval '2 days'),
  pg_temp.mk(5,1,-interval '59 days'), pg_temp.mk(6,1,-interval '61 days'),
  pg_temp.mk(7,1,interval '2 days',-interval '1 day'),
  pg_temp.mk(8,1,-interval '62 days',-interval '61 days'),
  pg_temp.mk(10,1,interval '2 days'), pg_temp.mk(11,1,interval '2 days'),
  pg_temp.mk(12,1,interval '2 days'), pg_temp.mk(13,1,interval '2 days'),
  pg_temp.mk(14,1,interval '2 days'), pg_temp.mk(20,2,interval '2 days'),
  pg_temp.mk(21,2,interval '2 days');

create function pg_temp.mp(m int) returns uuid language sql as
$$ select ('36300000-0000-4000-8000-'||lpad(m::text,12,'0'))::uuid $$;
create function pg_temp.pp(p int) returns uuid language sql as
$$ select ('36100000-0000-4000-8000-'||lpad(p::text,12,'0'))::uuid $$;

insert into private.match_players (match_id, profile_id, status, queue_seq) values
  (pg_temp.mp(2), pg_temp.pp(7), 'starter', nextval('private.match_queue_seq')),
  (pg_temp.mp(3), pg_temp.pp(7), 'starter', nextval('private.match_queue_seq')),
  (pg_temp.mp(4), pg_temp.pp(7), 'starter', nextval('private.match_queue_seq')),
  (pg_temp.mp(5), pg_temp.pp(3), 'starter', nextval('private.match_queue_seq')),
  (pg_temp.mp(10), pg_temp.pp(3), 'starter', nextval('private.match_queue_seq')),
  (pg_temp.mp(10), pg_temp.pp(7), 'starter', nextval('private.match_queue_seq')),
  (pg_temp.mp(10), pg_temp.pp(8), 'waitlist', nextval('private.match_queue_seq')),
  (pg_temp.mp(11), pg_temp.pp(3), 'starter', nextval('private.match_queue_seq'));
update private.match_players set paid = true, payment_marked_by = pg_temp.pp(1),
  payment_marked_at = now() - interval '1 hour'
where profile_id = pg_temp.pp(7) and match_id in (pg_temp.mp(2), pg_temp.mp(10));
-- Racha 4: o pagamento virou «a devolver» pendente (pago desmarcado).
insert into private.match_refunds (match_player_id, payment_marked_at, payment_marked_by, amount, origin)
select id, now() - interval '2 hours', pg_temp.pp(1), 15, 'left_group'
from private.match_players where match_id = pg_temp.mp(4) and profile_id = pg_temp.pp(7);

-- Uma cifra de 32 bytes: o banco só confere forma e tamanho.
create function pg_temp.pix(last4 text default '0001', typ text default 'cpf') returns jsonb
language sql as $$
  select jsonb_build_object('type', typ, 'ciphertext', encode(decode(repeat('ab',32),'hex'),'base64'),
    'key_version', 1, 'last4', last4, 'receiver_name', 'DONA DO RACHA', 'receiver_city', 'SAO PAULO');
$$;
create function pg_temp.set(a int, m int, p jsonb, r uuid default gen_random_uuid()) returns jsonb
language sql as $$
  select public.set_match_pix(('36000000-0000-4000-8000-'||lpad(a::text,12,'0'))::uuid,
    '36900000-0000-4000-8000-000000000000'::uuid, r, repeat('a',64), 1, 1, pg_temp.mp(m), p);
$$;
create function pg_temp.res(a int, m int, p jsonb, r uuid default gen_random_uuid()) returns text
language sql as $$ select pg_temp.set(a, m, p, r)->'outcome'->>'logical_result' $$;
create function pg_temp.read(a int, m int) returns jsonb language sql as $$
  select public.get_payment_instructions(('36000000-0000-4000-8000-'||lpad(a::text,12,'0'))::uuid,
    '36900000-0000-4000-8000-000000000000'::uuid, pg_temp.mp(m));
$$;
create function pg_temp.state(m int) returns text language sql as
$$ select coalesce((select state from private.match_payment_secrets where match_id = pg_temp.mp(m)), 'none') $$;
grant execute on all functions in schema pg_temp to service_role;

set local role service_role;

-- ---------------------------------------------------------------------------
-- Validação: o banco recusa forma inválida antes de qualquer leitura
-- ---------------------------------------------------------------------------
select throws_ok($$select pg_temp.set(1,1,pg_temp.pix()||'{"extra":1}')$$,'22023','PIX_INVALID','extra key');
select throws_ok($$select pg_temp.set(1,1,pg_temp.pix()-'last4')$$,'22023','PIX_INVALID','missing key');
select throws_ok($$select pg_temp.set(1,1,pg_temp.pix()||'{"key_version":2}')$$,'22023','PIX_INVALID','unknown key version');
select throws_ok($$select pg_temp.set(1,1,pg_temp.pix()||'{"key_version":"1"}')$$,'22023','PIX_INVALID','key version as text');
select throws_ok($$select pg_temp.set(1,1,pg_temp.pix(typ=>'boleto'))$$,'22023','PIX_INVALID','unknown key type');
select throws_ok($$select pg_temp.set(1,1,pg_temp.pix(''))$$,'22023','PIX_INVALID','empty last4');
select throws_ok($$select pg_temp.set(1,1,pg_temp.pix('12345'))$$,'22023','PIX_INVALID','last4 longer than four');
select throws_ok($$select pg_temp.set(1,1,pg_temp.pix()||'{"receiver_name":"Dona"}')$$,'22023','PIX_INVALID','receiver name not normalised');
select throws_ok($$select pg_temp.set(1,1,pg_temp.pix()||jsonb_build_object('receiver_name',repeat('A',26)))$$,'22023','PIX_INVALID','receiver name over 25');
select throws_ok($$select pg_temp.set(1,1,pg_temp.pix()||jsonb_build_object('receiver_city',repeat('A',16)))$$,'22023','PIX_INVALID','receiver city over 15');
select throws_ok($$select pg_temp.set(1,1,pg_temp.pix()||'{"ciphertext":"not base64!"}')$$,'22023','PIX_INVALID','ciphertext not base64');
select throws_ok($$select pg_temp.set(1,1,pg_temp.pix()||jsonb_build_object('ciphertext',encode(decode(repeat('ab',28),'hex'),'base64')))$$,'22023','PIX_INVALID','ciphertext shorter than nonce, one byte and tag');
select throws_ok($$select pg_temp.set(1,1,'[]'::jsonb)$$,'22023','VALIDATION','pix must be an object or null');
select throws_ok($$select public.set_match_pix('36000000-0000-4000-8000-000000000001','36900000-0000-4000-8000-000000000000',gen_random_uuid(),repeat('a',64),1,1,null,null)$$,'22023','VALIDATION','match id required');
reset role;
select is(pg_temp.state(1),'none','no validation failure wrote a row');
set local role service_role;

-- ---------------------------------------------------------------------------
-- Autoridade: só dono e organizador ativos; os demais, NOT_FOUND igual
-- ---------------------------------------------------------------------------
select throws_ok(format('select pg_temp.set(%s,%s,pg_temp.pix())',a,m),'P0002','NOT_FOUND',
  'set_match_pix actor '||a||' match '||m||': indistinguishable NOT_FOUND')
from (values(3),(4),(5),(6),(7)) actors(a), (values(1),(99)) matches(m);
select throws_ok($$select pg_temp.set(10,1,pg_temp.pix())$$,'P0002','NOT_FOUND','owner of another group');
select throws_ok($$select pg_temp.set(1,7,pg_temp.pix())$$,'P0001','MATCH_CANCELED','canceled match refuses');
select throws_ok($$select pg_temp.set(1,7,null)$$,'P0001','MATCH_CANCELED','canceled match refuses removal too');

-- ---------------------------------------------------------------------------
-- Ciclo sem pagamento: inclui, troca (replaced), remove (purged), reinclui
-- ---------------------------------------------------------------------------
select is(pg_temp.res(1,1,null),'pix_remove_unchanged','removing a Pix that never existed has no effect');
reset role;
select is(pg_temp.state(1),'none','and writes no row');
set local role service_role;
select is(pg_temp.set(1,1,pg_temp.pix(),'36400000-0000-4000-8000-000000000001'),
  jsonb_build_object('outcome',jsonb_build_object('group_id','36200000-0000-4000-8000-000000000001',
    'logical_result','pix_set','match_id','36300000-0000-4000-8000-000000000001')),
  'owner sets Pix: IDs-only outcome');
select is(pg_temp.set(1,1,pg_temp.pix(),'36400000-0000-4000-8000-000000000001'),
  jsonb_build_object('outcome',jsonb_build_object('group_id','36200000-0000-4000-8000-000000000001',
    'logical_result','pix_set','match_id','36300000-0000-4000-8000-000000000001')),
  'replay returns the same outcome');
reset role;
select is((select row(state, pix_key_type, octet_length(pix_key_ciphertext), pix_key_key_version, pix_key_last4,
    pix_receiver_name, pix_receiver_city, set_by, replaced, purged_at is null)::text
  from private.match_payment_secrets where match_id = pg_temp.mp(1)),
  row('active','cpf',32,1,'0001','DONA DO RACHA','SAO PAULO',pg_temp.pp(1),false,true)::text,
  'first Pix: active, sealed, not replaced');
select is((select count(*)::int from private.match_payment_secrets),1,'the replay wrote nothing');
set local role service_role;
select is(pg_temp.res(2,1,pg_temp.pix('9999','email')),'pix_set','organizer replaces');
reset role;
select is((select row(state, pix_key_type, pix_key_last4, set_by, replaced)::text
  from private.match_payment_secrets where match_id = pg_temp.mp(1)),
  row('active','email','9999',pg_temp.pp(2),true)::text, 'replacement: new author, replaced');
set local role service_role;
select is(pg_temp.res(9,1,'null'::jsonb),'pix_removed','JSON null removes like SQL null');
reset role;
select is((select row(state, pix_key_ciphertext, pix_key_key_version, pix_key_last4, pix_receiver_name,
    pix_receiver_city, set_by, purged_at is not null)::text
  from private.match_payment_secrets where match_id = pg_temp.mp(1)),
  row('purged',null::bytea,null::smallint,null::text,null::text,null::text,null::uuid,true)::text,
  'removal keeps the row as purged and clears every Pix field');
set local role service_role;
select is(pg_temp.res(1,1,null),'pix_remove_unchanged','removing again has no effect');
select is(pg_temp.res(1,1,pg_temp.pix()),'pix_set','reinclusion without payment is free');
reset role;
select is((select replaced from private.match_payment_secrets where match_id = pg_temp.mp(1)),true,
  'reinclusion after removal is a replacement (a previous row existed)');
set local role service_role;

-- ---------------------------------------------------------------------------
-- Trava (P2, CN1 a): pago ou «a devolver» pendente
-- ---------------------------------------------------------------------------
select is(pg_temp.res(1,2,pg_temp.pix()),'pix_set','with a payment, a match that never had Pix accepts the first Pix');
select throws_ok($$select pg_temp.set(2,2,pg_temp.pix('9999'))$$,'P0001','PIX_LOCKED','then replacing is locked');
select throws_ok($$select pg_temp.set(1,2,pg_temp.pix())$$,'P0001','PIX_LOCKED','even with the same type and last4');
select throws_ok($$select pg_temp.set(1,2,pg_temp.pix('0001','email'))$$,'P0001','PIX_LOCKED','an e-mail with the same last4 is still a replacement');
select throws_ok($$select pg_temp.set(1,2,null)$$,'P0001','PIX_LOCKED','and removing is locked');
select is(pg_temp.res(1,3,pg_temp.pix()),'pix_set','match 3 gets a Pix before any payment');
select is(pg_temp.res(1,3,null),'pix_removed','and loses it before any payment');
reset role;
update private.match_players set paid = true, payment_marked_by = pg_temp.pp(1), payment_marked_at = now()
where match_id = pg_temp.mp(3) and profile_id = pg_temp.pp(7);
set local role service_role;
select throws_ok($$select pg_temp.set(1,3,pg_temp.pix())$$,'P0001','PIX_LOCKED',
  'a match that had Pix (now purged) does not take a new one once paid');
select is(pg_temp.res(1,3,null),'pix_remove_unchanged','removing a purged Pix stays a no-op even when paid');
reset role;
insert into private.match_payment_secrets (match_id, state, pix_key_type, pix_key_ciphertext, pix_key_key_version,
  pix_key_last4, pix_receiver_name, pix_receiver_city, set_by, set_at)
values (pg_temp.mp(4), 'active', 'cpf', decode(repeat('ab',32),'hex'), 1, '0001', 'DONA', 'SAO PAULO', pg_temp.pp(1), now());
set local role service_role;
select throws_ok($$select pg_temp.set(1,4,pg_temp.pix('0002'))$$,'P0001','PIX_LOCKED','a pending refund locks replacement');
select throws_ok($$select pg_temp.set(1,4,null)$$,'P0001','PIX_LOCKED','and removal');
reset role;
update private.match_refunds set status = 'refunded', refunded_at = now(), marked_by = pg_temp.pp(1), marked_at = now();
set local role service_role;
select is(pg_temp.res(1,4,pg_temp.pix('0002')),'pix_set','once the refund is settled, replacing is free again');

-- ---------------------------------------------------------------------------
-- 60 dias (P3)
-- ---------------------------------------------------------------------------
select is(pg_temp.res(1,5,pg_temp.pix()),'pix_set','a match ended 59 days ago still takes a Pix');
select throws_ok($$select pg_temp.set(1,6,pg_temp.pix())$$,'P0001','PIX_PURGED','61 days after the end it does not');
select throws_ok($$select pg_temp.set(1,6,null)$$,'P0001','PIX_PURGED','nor a removal');
select is((pg_temp.read(3,5))->>'type','cpf','an unpaid starter reads the Pix of a match ended 59 days ago');

-- ---------------------------------------------------------------------------
-- Leitura (corte do docs/13 §1.3.1)
-- ---------------------------------------------------------------------------
select is(pg_temp.res(2,10,pg_temp.pix('0010','phone')),'pix_set','matrix match: first Pix with a payment already made');
select is(pg_temp.read(a,10)->>'amount','15.00','actor '||a||' reads the Pix')
from (values(1),(2),(9),(3)) actors(a);
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.read(3,10)) k),
  array['amount','ciphertext','key_version','receiver_city','receiver_name','replaced','set_at','set_by_name','type'],
  'the read returns exactly the sealed shape, never last4 or the author id');
select is(pg_temp.read(3,10)->>'set_by_name','Org','set_by_name names the author');
select throws_ok(format('select pg_temp.read(%s,%s)',a,m),'42501','FORBIDDEN',
  'actor '||a||' match '||m||': FORBIDDEN with or without Pix')
from (values(7),(8)) actors(a), (values(10),(11)) matches(m);
select throws_ok($$select pg_temp.read(3,12)$$,'42501','FORBIDDEN','a member outside the match cannot read');
select throws_ok(format('select pg_temp.read(%s,%s)',a,m),'P0002','NOT_FOUND',
  'actor '||a||' match '||m||': indistinguishable NOT_FOUND')
from (values(4),(5),(6),(10)) actors(a), (values(10),(99)) matches(m);
select throws_ok($$select pg_temp.read(1,11)$$,'P0002','PIX_NOT_CONFIGURED','organizer: match without Pix');
select throws_ok($$select pg_temp.read(3,11)$$,'P0002','PIX_NOT_CONFIGURED','starter: match without Pix');
select throws_ok($$select pg_temp.read(1,3)$$,'P0002','PIX_NOT_CONFIGURED','purged Pix reads as not configured');
reset role;
insert into private.match_payment_secrets (match_id, state, pix_key_type, pix_key_ciphertext, pix_key_key_version,
  pix_key_last4, pix_receiver_name, pix_receiver_city, set_by, set_at)
values (pg_temp.mp(7), 'active', 'cpf', decode(repeat('ab',32),'hex'), 1, '0001', 'DONA', 'SAO PAULO', pg_temp.pp(1), now()),
       (pg_temp.mp(8), 'active', 'cpf', decode(repeat('ab',32),'hex'), 1, '0001', 'DONA', 'SAO PAULO', pg_temp.pp(1), now() - interval '70 days');
insert into private.match_players (match_id, profile_id, status, queue_seq)
values (pg_temp.mp(7), pg_temp.pp(3), 'starter', nextval('private.match_queue_seq'));
set local role service_role;
select throws_ok($$select pg_temp.read(1,7)$$,'42501','FORBIDDEN','canceled match: organizer cannot read');
select throws_ok($$select pg_temp.read(3,7)$$,'42501','FORBIDDEN','canceled match: starter cannot read');
reset role;
-- Autor em exclusão: o nome sai mascarado (o gatilho do pedido cuida do Pix).
update public.profiles set account_status = 'deletion_pending' where id = pg_temp.pp(2);
set local role service_role;
select is(pg_temp.read(3,10)->'set_by_name','null'::jsonb,'an author in deletion is not named');
reset role;
update public.profiles set account_status = 'active' where id = pg_temp.pp(2);

-- ---------------------------------------------------------------------------
-- A leitura aplica os 60 dias sem esperar o worker; o worker expurga
-- ---------------------------------------------------------------------------
update private.matches set starts_at = now() - interval '61 days 2 hours', ends_at = now() - interval '61 days'
where id = pg_temp.mp(5);
set local role service_role;
select throws_ok($$select pg_temp.read(3,5)$$,'P0002','PIX_NOT_CONFIGURED','past 60 days the read hides the Pix at once');
reset role;
select is(pg_temp.state(5),'active','the row is still there until the worker runs');
-- Racha 8 (cancelado há 61 dias) ainda deve devolução: expurga mesmo assim (N3).
insert into private.match_players (match_id, profile_id, status, queue_seq)
values (pg_temp.mp(8), pg_temp.pp(3), 'starter', nextval('private.match_queue_seq'));
insert into private.match_refunds (match_player_id, payment_marked_at, payment_marked_by, amount, origin)
select id, now() - interval '62 days', pg_temp.pp(1), 15, 'canceled'
from private.match_players where match_id = pg_temp.mp(8);
select is(private.purge_match_pix(), jsonb_build_object('scanned',2,'purged',2),
  'purge_match_pix takes exactly the two expired Pix');
select is(pg_temp.state(5)||'/'||pg_temp.state(8)||'/'||pg_temp.state(7),'purged/purged/active',
  'ended 61 days ago and canceled 61 days ago with a pending refund go; canceled yesterday stays');
select is((select policy||':'||purged||'/'||scanned from private.retention_runs order by id desc limit 1),
  'purge_match_pix:2/2','the run leaves only counts');
select is(private.purge_match_pix(), jsonb_build_object('scanned',0,'purged',0),'a second run finds nothing');

-- ---------------------------------------------------------------------------
-- Gatilhos de expurgo (N5, N7, P5)
-- ---------------------------------------------------------------------------
set local role service_role;
select is(pg_temp.res(2,12,pg_temp.pix()),'pix_set','match 12: Pix by organizer 2');
select is(pg_temp.res(9,13,pg_temp.pix(),'36400000-0000-4000-8000-000000000002'),'pix_set','match 13: Pix by organizer 9');
select is(pg_temp.res(1,14,pg_temp.pix()),'pix_set','match 14: Pix by the owner');
select is(pg_temp.res(11,20,pg_temp.pix()),'pix_set','group 2, match 20: Pix by organizer 11');
select is(pg_temp.res(10,21,pg_temp.pix()),'pix_set','group 2, match 21: Pix by its owner');
reset role;

update public.group_members set role = 'player' where profile_id = pg_temp.pp(2);
select is(pg_temp.state(12)||'/'||pg_temp.state(10)||'/'||pg_temp.state(13)||'/'||pg_temp.state(14),
  'purged/purged/active/active','demoting organizer 2 purges only the Pix 2 set');

update public.group_members set status = 'removed', removed_at = now() where profile_id = pg_temp.pp(9);
select is(pg_temp.state(13)||'/'||pg_temp.state(14),'purged/active','removing organizer 9 purges the Pix 9 set');
set local role service_role;
select is(pg_temp.set(9,13,pg_temp.pix(),'36400000-0000-4000-8000-000000000002')->'outcome'->>'logical_result','pix_set',
  'M2-D20: the replay after losing authority keeps the stored outcome');
select throws_ok($$select pg_temp.set(9,13,pg_temp.pix())$$,'P0002','NOT_FOUND','but a new request is NOT_FOUND');
reset role;
select is(pg_temp.state(13),'purged','and the replay wrote nothing');

-- O dono tem papel player no grupo: ao transferir, perde a autoridade.
update public.groups set owner_id = pg_temp.pp(3) where id = '36200000-0000-4000-8000-000000000001';
select is(pg_temp.state(14)||'/'||pg_temp.state(2)||'/'||pg_temp.state(4)||'/'||pg_temp.state(7),
  'purged/purged/purged/purged','transferring ownership away from a player-role owner purges every Pix the owner set, paid or not');
select is((select count(*)::int from private.match_payment_secrets s join private.matches m on m.id = s.match_id
  where m.group_id = '36200000-0000-4000-8000-000000000001' and s.state = 'active'),0,'group 1 has no active Pix left');

insert into private.deletion_requests (profile_id, auth_user_id)
values (pg_temp.pp(11), '36000000-0000-4000-8000-000000000011');
select is(pg_temp.state(20)||'/'||pg_temp.state(21),'purged/active',
  'a deletion request purges, in the same transaction, the Pix the requester set');

update public.groups set archived_at = now() where id = '36200000-0000-4000-8000-000000000002';
select is(pg_temp.state(21),'purged','archiving a group purges its remaining Pix');

-- ---------------------------------------------------------------------------
-- C2-P2-1: as saídas reais concluem com Pix cadastrado, e expurgam
-- ---------------------------------------------------------------------------
-- Grupo 3: 12 dono (organizador), 13 a 16 organizadores, 17 jogador.
insert into auth.users (id, email)
select ('36000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid, 'pix36-'||n||'@example.invalid'
from generate_series(12,17) n;
insert into public.profiles (id, auth_user_id, name, account_status)
select pg_temp.pp(n), ('36000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid, 'Saida '||n, 'active'
from generate_series(12,17) n;
insert into public.groups (id, name, owner_id) values
  ('36200000-0000-4000-8000-000000000003', 'Grupo Saidas', pg_temp.pp(12));
insert into public.group_members (group_id, profile_id, role, status)
select '36200000-0000-4000-8000-000000000003', pg_temp.pp(n),
  case when n = 17 then 'player' else 'organizer' end, 'active'
from generate_series(12,17) n;
select pg_temp.mk(n,3,interval '2 days') from generate_series(30,34) n;
-- Cada ator com a própria sessão: delete_account revoga a sessão de quem pede.
create function pg_temp.call(sig text, a int, args text default '') returns jsonb language plpgsql as $$
declare result jsonb;
begin
  execute format('select public.%s($1,$2,$3,$4,1,1%s)', sig, args) into result using
    ('36000000-0000-4000-8000-'||lpad(a::text,12,'0'))::uuid,
    ('36900000-0000-4000-8000-'||lpad(a::text,12,'0'))::uuid, gen_random_uuid(), repeat('a',64);
  return result;
end; $$;
grant execute on all functions in schema pg_temp to service_role;
set local role service_role;
select is(pg_temp.res(13,30,pg_temp.pix()),'pix_set','match 30: Pix by organizer 13');
select is(pg_temp.res(14,31,pg_temp.pix()),'pix_set','match 31: Pix by organizer 14');
select is(pg_temp.res(15,32,pg_temp.pix()),'pix_set','match 32: Pix by organizer 15');
select is(pg_temp.res(16,33,pg_temp.pix()),'pix_set','match 33: Pix by organizer 16');
select is(pg_temp.res(12,34,pg_temp.pix()),'pix_set','match 34: Pix by the owner, organizer by role');
select lives_ok($$select pg_temp.call('leave_group',13,',''36200000-0000-4000-8000-000000000003''::uuid')$$,
  'leave_group concludes for an organizer with Pix');
select lives_ok($$select pg_temp.call('remove_member',12,',''36200000-0000-4000-8000-000000000003''::uuid,''36100000-0000-4000-8000-000000000014''::uuid,''Saiu do grupo''')$$,
  'remove_member concludes for an organizer with Pix');
select lives_ok($$select pg_temp.call('set_role',12,',''36200000-0000-4000-8000-000000000003''::uuid,''36100000-0000-4000-8000-000000000015''::uuid,''player''')$$,
  'set_role to player concludes for an organizer with Pix');
select lives_ok($$select pg_temp.call('delete_account',16)$$,
  'delete_account concludes for an organizer with Pix');
select lives_ok($$select pg_temp.call('transfer_ownership',12,',''36200000-0000-4000-8000-000000000003''::uuid,''36100000-0000-4000-8000-000000000017''::uuid')$$,
  'transfer_ownership concludes for an owner with Pix');
reset role;
select is(pg_temp.state(30)||'/'||pg_temp.state(31)||'/'||pg_temp.state(32)||'/'||pg_temp.state(33),
  'purged/purged/purged/purged','each real exit purged the Pix of the one who left');
select is(pg_temp.state(34),'active','a former owner who stays organizer keeps the Pix');
set local role service_role;
select lives_ok($$select pg_temp.call('delete_group',17,',''36200000-0000-4000-8000-000000000003''::uuid')$$,
  'delete_group concludes with a Pix registered');
reset role;
select is(pg_temp.state(34),'purged','deleting the group purged the last Pix');

select is((select count(*)::int from private.match_payment_secrets where state = 'purged' and
  (pix_key_ciphertext is not null or pix_key_last4 is not null or set_by is not null)),0,
  'no purged row keeps any Pix field');

select * from finish();
rollback;
