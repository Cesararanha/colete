begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Colunas do cancelamento
-- ---------------------------------------------------------------------------
select col_type_is('private', 'matches', 'canceled_at', 'timestamp with time zone',
  'canceled_at is an instant');
select col_is_null('private', 'matches', 'canceled_at', 'a match starts not canceled');
select fk_ok('private', 'matches', 'canceled_by', 'public', 'profiles', 'id',
  'who canceled is a profile');
select is((select pg_get_constraintdef(oid) from pg_constraint
  where conrelid = 'private.matches'::regclass and conname = 'matches_canceled_pair_check'),
  'CHECK (((canceled_at IS NULL) = (canceled_by IS NULL)))',
  'canceled_at and canceled_by travel together');
select ok((select not relrowsecurity and not relforcerowsecurity from pg_class
  where oid = 'private.matches'::regclass)
  and (select count(*) from information_schema.column_privileges
    where table_schema = 'private' and table_name = 'matches'
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) = 0,
  'matches still has no RLS and no privilege, new columns included');

-- ---------------------------------------------------------------------------
-- RPCs: assinatura estreita, ACL e modo
-- ---------------------------------------------------------------------------
create temporary table edit_rpc (signature text);
insert into edit_rpc values
  ('public.update_match(uuid,uuid,uuid,text,integer,integer,uuid,jsonb)'),
  ('public.cancel_match(uuid,uuid,uuid,text,integer,integer,uuid)');
select ok(to_regprocedure(signature) is not null, signature || ' exists') from edit_rpc;
select ok(not has_function_privilege('public', signature, 'execute')
  and not has_function_privilege('anon', signature, 'execute')
  and not has_function_privilege('authenticated', signature, 'execute'),
  'no client role executes ' || signature) from edit_rpc;
select ok(has_function_privilege('service_role', signature, 'execute'),
  'only the nominal service role executes ' || signature) from edit_rpc;
select ok((select prosecdef and provolatile = 'v' and proconfig = array['search_path=""']
  from pg_proc where oid = to_regprocedure(signature)),
  signature || ' is volatile security definer with fixed search_path') from edit_rpc;
select ok((select pg_get_functiondef(oid) like '%private.lock_match_context(%'
  from pg_proc where oid = to_regprocedure(signature)),
  signature || ' takes the match lock of join_match and leave_match') from edit_rpc;

create temporary table edit_helper (signature text);
insert into edit_helper values
  ('private.match_config_from_json(jsonb)'),
  ('private.validate_through_group_appearance_outcome(text,jsonb)');
select ok(not has_function_privilege('service_role', signature, 'execute')
  and not has_function_privilege('authenticated', signature, 'execute'),
  signature || ' is not a gateway routine') from edit_helper;

-- As leituras recriadas mantêm o modo e os privilégios.
create temporary table edit_read (signature text);
insert into edit_read values
  ('public.get_match(uuid,uuid,uuid)'), ('public.list_my_matches(uuid,uuid)'),
  ('public.get_matches_occupancy(uuid,uuid)'), ('public.get_match_roster(uuid,uuid,uuid)'),
  ('public.join_match(uuid,uuid,uuid,text,integer,integer,uuid)'),
  ('public.leave_match(uuid,uuid,uuid,text,integer,integer,uuid)'),
  ('public.set_match_payment(uuid,uuid,uuid,text,integer,integer,uuid,uuid,boolean)');
select ok((select prosecdef and proconfig = array['search_path=""']
  and not has_function_privilege('authenticated', oid, 'execute')
  and not has_function_privilege('anon', oid, 'execute')
  and has_function_privilege('service_role', oid, 'execute')
  from pg_proc where oid = to_regprocedure(signature)),
  signature || ' keeps its privileges and mode') from edit_read;

-- ---------------------------------------------------------------------------
-- Livro de idempotência: desfecho fechado e operações anteriores preservadas
-- ---------------------------------------------------------------------------
select lives_ok($$select private.validate_idempotency_outcome('update_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_updated","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  'update_match outcome with IDs only is valid');
select lives_ok($$select private.validate_idempotency_outcome('cancel_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_cancel_unchanged","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  'cancel_match unchanged outcome is valid');
select throws_ok($$select private.validate_idempotency_outcome('update_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_updated","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f","field_slots":3}'::jsonb)$$,
  '22023', 'VALIDATION', 'the config never enters the outcome');
select throws_ok($$select private.validate_idempotency_outcome('cancel_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_updated","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  '22023', 'VALIDATION', 'each operation has its own closed results');
select lives_ok($$select private.validate_idempotency_outcome('set_group_appearance',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_appearance_set"}'::jsonb)$$,
  'the chain still delegates set_group_appearance');
select ok((select pg_get_constraintdef(oid) like '%set_group_appearance%'
  and pg_get_constraintdef(oid) like '%update_match%'
  and pg_get_constraintdef(oid) like '%cancel_match%'
  and pg_get_constraintdef(oid) like '%set_match_payment%'
  and pg_get_constraintdef(oid) like '%create_match%'
  from pg_constraint where conname = 'idempotency_records_operation_check'),
  'operation list keeps every earlier operation and adds the two new ones');
select ok((select pg_get_constraintdef(oid) like '%group_appearance_set%'
  and pg_get_constraintdef(oid) like '%match_updated%'
  and pg_get_constraintdef(oid) like '%match_cancel_unchanged%'
  from pg_constraint where conname = 'idempotency_records_outcome_code_check'),
  'outcome list keeps group_appearance_set and adds the new results');

-- ---------------------------------------------------------------------------
-- Atores e rachas
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('28000000-0000-4000-8000-000000000001', 'edit28-owner@example.invalid'),
  ('28000000-0000-4000-8000-000000000002', 'edit28-organizer@example.invalid'),
  ('28000000-0000-4000-8000-000000000003', 'edit28-player@example.invalid'),
  ('28000000-0000-4000-8000-000000000004', 'edit28-former@example.invalid'),
  ('28000000-0000-4000-8000-000000000005', 'edit28-pending@example.invalid'),
  ('28000000-0000-4000-8000-000000000006', 'edit28-stranger@example.invalid'),
  ('28000000-0000-4000-8000-000000000007', 'edit28-p7@example.invalid'),
  ('28000000-0000-4000-8000-000000000008', 'edit28-p8@example.invalid'),
  ('28000000-0000-4000-8000-000000000009', 'edit28-p9@example.invalid');
insert into public.profiles (id, auth_user_id, name, account_status) values
  ('28100000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000001', 'Dona', 'active'),
  ('28100000-0000-4000-8000-000000000002', '28000000-0000-4000-8000-000000000002', 'Org', 'active'),
  ('28100000-0000-4000-8000-000000000003', '28000000-0000-4000-8000-000000000003', 'Jogador', 'active'),
  ('28100000-0000-4000-8000-000000000004', '28000000-0000-4000-8000-000000000004', 'Ex', 'active'),
  ('28100000-0000-4000-8000-000000000005', '28000000-0000-4000-8000-000000000005', 'Pendente', 'active'),
  ('28100000-0000-4000-8000-000000000006', '28000000-0000-4000-8000-000000000006', 'Fora', 'active'),
  ('28100000-0000-4000-8000-000000000007', '28000000-0000-4000-8000-000000000007', 'Sete', 'active'),
  ('28100000-0000-4000-8000-000000000008', '28000000-0000-4000-8000-000000000008', 'Oito', 'active'),
  ('28100000-0000-4000-8000-000000000009', '28000000-0000-4000-8000-000000000009', 'Nove', 'active');
insert into public.groups (id, name, owner_id) values
  ('28200000-0000-4000-8000-000000000001', 'Grupo Edição', '28100000-0000-4000-8000-000000000001');
insert into public.group_members (group_id, profile_id, role, status, removed_at) values
  ('28200000-0000-4000-8000-000000000001', '28100000-0000-4000-8000-000000000001', 'player', 'active', null),
  ('28200000-0000-4000-8000-000000000001', '28100000-0000-4000-8000-000000000002', 'organizer', 'active', null),
  ('28200000-0000-4000-8000-000000000001', '28100000-0000-4000-8000-000000000003', 'player', 'active', null),
  ('28200000-0000-4000-8000-000000000001', '28100000-0000-4000-8000-000000000004', 'organizer', 'removed', now()),
  ('28200000-0000-4000-8000-000000000001', '28100000-0000-4000-8000-000000000005', 'organizer', 'pending', null),
  ('28200000-0000-4000-8000-000000000001', '28100000-0000-4000-8000-000000000007', 'player', 'active', null),
  ('28200000-0000-4000-8000-000000000001', '28100000-0000-4000-8000-000000000008', 'player', 'active', null),
  ('28200000-0000-4000-8000-000000000001', '28100000-0000-4000-8000-000000000009', 'player', 'active', null);

-- 301: futuro, 2 vagas, 2 confirmados e 2 na espera (8 antes de 9).
-- 302: em andamento. 303: terminado. 304: futuro, para cancelar.
insert into private.matches (id, group_id, starts_at, ends_at, timezone, location_name,
  field_slots, field_price, created_by) values
  ('28300000-0000-4000-8000-000000000001', '28200000-0000-4000-8000-000000000001',
   date_trunc('minute', now()) + interval '2 days',
   date_trunc('minute', now()) + interval '2 days 90 minutes', 'America/Sao_Paulo',
   'Arena', 2, 15, '28100000-0000-4000-8000-000000000001'),
  ('28300000-0000-4000-8000-000000000002', '28200000-0000-4000-8000-000000000001',
   date_trunc('minute', now()) - interval '30 minutes',
   date_trunc('minute', now()) + interval '60 minutes', 'America/Sao_Paulo',
   'Quadra', 3, 20, '28100000-0000-4000-8000-000000000001'),
  ('28300000-0000-4000-8000-000000000003', '28200000-0000-4000-8000-000000000001',
   date_trunc('minute', now()) - interval '3 hours',
   date_trunc('minute', now()) - interval '1 hour', 'America/Sao_Paulo',
   'Campo', 3, 20, '28100000-0000-4000-8000-000000000001'),
  ('28300000-0000-4000-8000-000000000004', '28200000-0000-4000-8000-000000000001',
   date_trunc('minute', now()) + interval '3 days',
   date_trunc('minute', now()) + interval '3 days 90 minutes', 'America/Sao_Paulo',
   'Ginásio', 2, 10, '28100000-0000-4000-8000-000000000001');
insert into private.match_players (match_id, profile_id, status, queue_seq) values
  ('28300000-0000-4000-8000-000000000001', '28100000-0000-4000-8000-000000000003', 'starter', nextval('private.match_queue_seq')),
  ('28300000-0000-4000-8000-000000000001', '28100000-0000-4000-8000-000000000007', 'starter', nextval('private.match_queue_seq')),
  ('28300000-0000-4000-8000-000000000001', '28100000-0000-4000-8000-000000000008', 'waitlist', nextval('private.match_queue_seq')),
  ('28300000-0000-4000-8000-000000000001', '28100000-0000-4000-8000-000000000009', 'waitlist', nextval('private.match_queue_seq')),
  ('28300000-0000-4000-8000-000000000004', '28100000-0000-4000-8000-000000000003', 'starter', nextval('private.match_queue_seq')),
  ('28300000-0000-4000-8000-000000000004', '28100000-0000-4000-8000-000000000007', 'starter', nextval('private.match_queue_seq')),
  ('28300000-0000-4000-8000-000000000004', '28100000-0000-4000-8000-000000000008', 'waitlist', nextval('private.match_queue_seq'));
update private.match_players set paid = true,
  payment_marked_by = '28100000-0000-4000-8000-000000000001', payment_marked_at = now() - interval '1 hour'
where match_id = '28300000-0000-4000-8000-000000000001'
  and profile_id = '28100000-0000-4000-8000-000000000003';

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
  select public.update_match(p_auth, '28900000-0000-4000-8000-000000000000', p_request,
    p_hmac, 1, 1, p_match, pg_temp.cfg(p_match, p_patch));
$$;
create function pg_temp.cancel(p_auth uuid, p_match uuid,
  p_request uuid default gen_random_uuid(), p_hmac text default repeat('a', 64)) returns jsonb
language sql as $$
  select public.cancel_match(p_auth, '28900000-0000-4000-8000-000000000000', p_request,
    p_hmac, 1, 1, p_match);
$$;
create function pg_temp.slots(p_match uuid) returns text language sql as $$
  select string_agg(p.name || ':' || mp.status, ',' order by mp.queue_seq)
  from private.match_players mp join public.profiles p on p.id = mp.profile_id
  where mp.match_id = p_match and mp.status in ('starter', 'waitlist');
$$;

-- ---------------------------------------------------------------------------
-- Permissões: só quem cria racha edita e cancela; os demais, a recusa padrão
-- ---------------------------------------------------------------------------
create temporary table edit_refusals (label text, auth_id uuid, match_id uuid, code text, message text);
insert into edit_refusals values
  ('player', '28000000-0000-4000-8000-000000000003', '28300000-0000-4000-8000-000000000001', '42501', 'NOT_ORGANIZER'),
  ('former organizer', '28000000-0000-4000-8000-000000000004', '28300000-0000-4000-8000-000000000001', 'P0002', 'NOT_FOUND'),
  ('pending organizer', '28000000-0000-4000-8000-000000000005', '28300000-0000-4000-8000-000000000001', 'P0002', 'NOT_FOUND'),
  ('stranger', '28000000-0000-4000-8000-000000000006', '28300000-0000-4000-8000-000000000001', 'P0002', 'NOT_FOUND'),
  ('owner, unknown match', '28000000-0000-4000-8000-000000000001', '28300000-0000-4000-8000-0000000000ff', 'P0002', 'NOT_FOUND');
select throws_ok(format($$select public.update_match(%L, gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1, %L, pg_temp.cfg('28300000-0000-4000-8000-000000000001',
    '{"field_slots": 9}'))$$, auth_id, match_id), code, message, 'update refused: ' || label)
from edit_refusals;
select throws_ok(format($$select pg_temp.cancel(%L, %L)$$, auth_id, match_id), code, message,
  'cancel refused: ' || label)
from edit_refusals;
select is((select field_slots || '/' || coalesce(canceled_at::text, 'live') from private.matches
  where id = '28300000-0000-4000-8000-000000000001'), '2/live',
  'every refusal leaves the match untouched');
select is((select count(*)::integer from private.idempotency_records
  where operation in ('update_match', 'cancel_match')), 0,
  'no refusal leaves a ledger row behind');
select throws_ok($$select public.update_match(null, gen_random_uuid(), gen_random_uuid(),
    repeat('a', 64), 1, 1, '28300000-0000-4000-8000-000000000001',
    pg_temp.cfg('28300000-0000-4000-8000-000000000001'))$$,
  '28000', 'UNAUTHENTICATED', 'no actor, no edit');
insert into private.revoked_auth_sessions (session_id, profile_id, expires_at) values
  ('28900000-0000-4000-8000-000000000009', '28100000-0000-4000-8000-000000000001',
   now() + interval '1 hour');
select throws_ok($$select public.cancel_match('28000000-0000-4000-8000-000000000001',
    '28900000-0000-4000-8000-000000000009', gen_random_uuid(), repeat('a', 64), 1, 1,
    '28300000-0000-4000-8000-000000000001')$$,
  '28000', 'UNAUTHENTICATED', 'a revoked session cannot cancel');
update public.groups set suspended_at = now() where id = '28200000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.upd('28000000-0000-4000-8000-000000000001',
    '28300000-0000-4000-8000-000000000001')$$, 'P0001', 'GROUP_SUSPENDED',
  'a suspended group refuses the edit');
select throws_ok($$select pg_temp.cancel('28000000-0000-4000-8000-000000000001',
    '28300000-0000-4000-8000-000000000001')$$, 'P0001', 'GROUP_SUSPENDED',
  'a suspended group refuses the cancellation');
update public.groups set suspended_at = null where id = '28200000-0000-4000-8000-000000000001';

-- Forma antes do ator, como create_match: nada se aprende sobre o racha.
select throws_ok($$select public.update_match(null, null, gen_random_uuid(), repeat('a', 64),
    1, 1, '28300000-0000-4000-8000-000000000001',
    pg_temp.cfg('28300000-0000-4000-8000-000000000001') - 'description')$$,
  '22023', 'VALIDATION', 'a config without one of the ten keys is VALIDATION');
select throws_ok($$select public.update_match(null, null, gen_random_uuid(), repeat('a', 64),
    1, 1, '28300000-0000-4000-8000-000000000001',
    pg_temp.cfg('28300000-0000-4000-8000-000000000001', '{"group_id": "x"}'))$$,
  '22023', 'VALIDATION', 'the group never travels in the config');
select throws_ok($$select pg_temp.upd(null, '28300000-0000-4000-8000-000000000001',
    '{"field_price": "0.00"}')$$, 'P0001', 'PRICE_INVALID', 'a zero price is PRICE_INVALID');
select throws_ok($$select pg_temp.upd('28000000-0000-4000-8000-000000000001',
    '28300000-0000-4000-8000-000000000001', '{"field_slots": 0}')$$,
  '22023', 'VALIDATION', 'zero slots is VALIDATION');

-- ---------------------------------------------------------------------------
-- Vagas: nunca abaixo dos confirmados; aumentar promove a espera em ordem
-- ---------------------------------------------------------------------------
select throws_ok($$select pg_temp.upd('28000000-0000-4000-8000-000000000002',
    '28300000-0000-4000-8000-000000000001', '{"field_slots": 1}')$$,
  'P0001', 'SLOTS_BELOW_CONFIRMED', 'slots below the two confirmed are refused');
select is(pg_temp.slots('28300000-0000-4000-8000-000000000001'),
  'Jogador:starter,Sete:starter,Oito:waitlist,Nove:waitlist', 'the refusal changes nobody');
select is((select pg_temp.upd('28000000-0000-4000-8000-000000000002',
    '28300000-0000-4000-8000-000000000001', '{"field_slots": 2, "description": "Sem mudança"}')
    -> 'outcome' ->> 'logical_result'), 'match_updated',
  'the organizer may keep the slots equal to the confirmed');
select is((select pg_temp.upd('28000000-0000-4000-8000-000000000001',
    '28300000-0000-4000-8000-000000000001', '{"field_slots": 3}')
    -> 'outcome'), jsonb_build_object('group_id', '28200000-0000-4000-8000-000000000001',
    'logical_result', 'match_updated', 'match_id', '28300000-0000-4000-8000-000000000001'),
  'the owner raises to 3 and gets the IDs-only outcome');
select is(pg_temp.slots('28300000-0000-4000-8000-000000000001'),
  'Jogador:starter,Sete:starter,Oito:starter,Nove:waitlist',
  'one more slot promotes the head of the waitlist, and only it');
select is((select pg_temp.upd('28000000-0000-4000-8000-000000000001',
    '28300000-0000-4000-8000-000000000001', '{"field_slots": 10}')
    -> 'outcome' ->> 'logical_result'), 'match_updated', 'raising again works');
select is(pg_temp.slots('28300000-0000-4000-8000-000000000001'),
  'Jogador:starter,Sete:starter,Oito:starter,Nove:starter',
  'enough slots promote the whole waitlist in order');

-- Preço muda; a marcação de pago fica como estava.
select is((select pg_temp.upd('28000000-0000-4000-8000-000000000001',
    '28300000-0000-4000-8000-000000000001', '{"field_price": "22.50"}')
    -> 'outcome' ->> 'logical_result'), 'match_updated', 'the price can change');
select is((select field_price::text from private.matches
  where id = '28300000-0000-4000-8000-000000000001'), '22.50', 'the new price is stored');
select is((select paid::text || '/' || payment_marked_by::text || '/'
    || (payment_marked_at < now() - interval '59 minutes')::text
  from private.match_players where match_id = '28300000-0000-4000-8000-000000000001'
    and profile_id = '28100000-0000-4000-8000-000000000003'),
  'true/28100000-0000-4000-8000-000000000001/true',
  'the paid mark keeps its value, author and time');
select is((select public.get_match_roster('28000000-0000-4000-8000-000000000001',
    gen_random_uuid(), '28300000-0000-4000-8000-000000000001') -> 'payment_summary' ->> 'total'),
  '22.50', 'the total follows the new price');

-- Local, endereço, descrição, coordenadas e horário: tudo o que o formulário edita.
select is((select pg_temp.upd('28000000-0000-4000-8000-000000000001',
    '28300000-0000-4000-8000-000000000001', jsonb_build_object(
      'starts_at', pg_temp.instant(now() + interval '4 days'),
      'ends_at', pg_temp.instant(now() + interval '4 days 2 hours'),
      'location_name', '  Arena   Nova ', 'location_address', 'Rua Um, 10',
      'description', E'Traga colete\r\nescuro', 'latitude', '-9.6658', 'longitude', '-35.7353'))
    -> 'outcome' ->> 'logical_result'), 'match_updated', 'every editable field at once');
select is((select location_name || '|' || location_address || '|' || description || '|'
    || latitude::text || ',' || longitude::text || '|' || (ends_at - starts_at)::text
    || '|' || group_id::text
  from private.matches where id = '28300000-0000-4000-8000-000000000001'),
  E'Arena Nova|Rua Um, 10|Traga colete\nescuro|-9.6658,-35.7353|02:00:00|28200000-0000-4000-8000-000000000001',
  'the text is normalised like create_match and the group stays');
select is((select pg_temp.upd('28000000-0000-4000-8000-000000000001',
    '28300000-0000-4000-8000-000000000001',
    '{"location_address": null, "description": null, "latitude": null, "longitude": null}')
    -> 'outcome' ->> 'logical_result'), 'match_updated', 'optional fields can be cleared');
select is((select coalesce(location_address, 'none') || coalesce(description, 'none')
    || coalesce(latitude::text, 'none')
  from private.matches where id = '28300000-0000-4000-8000-000000000001'), 'nonenonenone',
  'clearing stores null');

-- Horários: as regras de create_match quando mudam.
create temporary table edit_times (label text, starts interval, ends interval);
insert into edit_times values
  ('start in the past', interval '-2 hours', interval '1 hour'),
  ('end before start', interval '2 days', interval '1 day'),
  ('end equal to start', interval '2 days', interval '2 days'),
  ('over 12 hours', interval '2 days', interval '2 days 12 hours 1 minute'),
  ('over 365 days ahead', interval '366 days', interval '366 days 1 hour');
select throws_ok(format($$select pg_temp.upd('28000000-0000-4000-8000-000000000001',
    '28300000-0000-4000-8000-000000000001', jsonb_build_object(
      'starts_at', pg_temp.instant(now() + %L::interval),
      'ends_at', pg_temp.instant(now() + %L::interval)))$$, starts, ends),
  'P0001', 'TIME_ORDER', 'TIME_ORDER: ' || label)
from edit_times;

-- Em andamento: o resto se edita mantendo início e fim; mudar o início para o passado não.
select is((select pg_temp.upd('28000000-0000-4000-8000-000000000002',
    '28300000-0000-4000-8000-000000000002', '{"description": "Começou atrasado"}')
    -> 'outcome' ->> 'logical_result'), 'match_updated',
  'a match in progress keeps its times and edits the rest');
select throws_ok($$select pg_temp.upd('28000000-0000-4000-8000-000000000002',
    '28300000-0000-4000-8000-000000000002', jsonb_build_object(
      'starts_at', pg_temp.instant(now() - interval '20 minutes')))$$,
  'P0001', 'TIME_ORDER', 'moving the start of a match in progress keeps the create rule');

-- Terminado: nem edição nem cancelamento.
select throws_ok($$select pg_temp.upd('28000000-0000-4000-8000-000000000001',
    '28300000-0000-4000-8000-000000000003', '{"description": "Tarde"}')$$,
  'P0001', 'MATCH_DONE', 'an ended match cannot be edited');
select throws_ok($$select pg_temp.cancel('28000000-0000-4000-8000-000000000001',
    '28300000-0000-4000-8000-000000000003')$$,
  'P0001', 'MATCH_DONE', 'an ended match cannot be canceled');

-- Replay: mesmo desfecho, sem repetir; outra intenção conflita; autoridade perdida conserva.
create temporary table edit_answers (n integer, answer jsonb);
insert into edit_answers select 1, pg_temp.upd('28000000-0000-4000-8000-000000000002',
  '28300000-0000-4000-8000-000000000001', '{"field_slots": 12}',
  '28800000-0000-4000-8000-000000000001', repeat('b', 64));
update private.matches set field_slots = 11 where id = '28300000-0000-4000-8000-000000000001';
insert into edit_answers select 2, public.update_match('28000000-0000-4000-8000-000000000002',
  gen_random_uuid(), '28800000-0000-4000-8000-000000000001', repeat('b', 64), 1, 1,
  '28300000-0000-4000-8000-000000000001',
  pg_temp.cfg('28300000-0000-4000-8000-000000000001', '{"field_slots": 12}'));
select is((select answer from edit_answers where n = 2),
  (select answer from edit_answers where n = 1), 'the replay returns the same outcome');
select is((select field_slots from private.matches
  where id = '28300000-0000-4000-8000-000000000001'), 11, 'the replay does not write again');
select throws_ok($$select pg_temp.upd('28000000-0000-4000-8000-000000000002',
    '28300000-0000-4000-8000-000000000001', '{"field_slots": 13}',
    '28800000-0000-4000-8000-000000000001', repeat('c', 64))$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'the same key with another intention conflicts');
update public.group_members set role = 'player'
where group_id = '28200000-0000-4000-8000-000000000001'
  and profile_id = '28100000-0000-4000-8000-000000000002';
select is((select public.update_match('28000000-0000-4000-8000-000000000002',
    gen_random_uuid(), '28800000-0000-4000-8000-000000000001', repeat('b', 64), 1, 1,
    '28300000-0000-4000-8000-000000000001',
    pg_temp.cfg('28300000-0000-4000-8000-000000000001', '{"field_slots": 12}'))),
  (select answer from edit_answers where n = 1),
  'a former organizer replays the recorded outcome (M2-D20)');
select throws_ok($$select pg_temp.upd('28000000-0000-4000-8000-000000000002',
    '28300000-0000-4000-8000-000000000001', '{"field_slots": 12}')$$,
  '42501', 'NOT_ORGANIZER', 'but a new edit is refused');
update public.group_members set role = 'organizer'
where group_id = '28200000-0000-4000-8000-000000000001'
  and profile_id = '28100000-0000-4000-8000-000000000002';
select is((select outcome from private.idempotency_records
  where request_id = '28800000-0000-4000-8000-000000000001'),
  jsonb_build_object('group_id', '28200000-0000-4000-8000-000000000001',
    'logical_result', 'match_updated', 'match_id', '28300000-0000-4000-8000-000000000001'),
  'the ledger keeps only the IDs and the logical result');

-- O padrão idempotente da 0027 continua aceito depois da redefinição.
select is((select public.set_group_appearance('28000000-0000-4000-8000-000000000001',
    gen_random_uuid(), gen_random_uuid(), repeat('a', 64), 1, 1,
    '28200000-0000-4000-8000-000000000001', 'trophy', 'green') -> 'outcome' ->> 'logical_result'),
  'group_appearance_set', 'set_group_appearance still completes in the ledger');

-- ---------------------------------------------------------------------------
-- Cancelar: definitivo; presença, espera e pagamento recusam
-- ---------------------------------------------------------------------------
select is((select pg_temp.cancel('28000000-0000-4000-8000-000000000002',
    '28300000-0000-4000-8000-000000000004') -> 'outcome' ->> 'logical_result'),
  'match_canceled', 'the organizer cancels');
select is((select (canceled_at is not null)::text || '/' || canceled_by::text
  from private.matches where id = '28300000-0000-4000-8000-000000000004'),
  'true/28100000-0000-4000-8000-000000000002', 'the match records when and who');
select is(pg_temp.slots('28300000-0000-4000-8000-000000000004'),
  'Jogador:starter,Sete:starter,Oito:waitlist', 'nobody is removed from the lists');
select is((select pg_temp.cancel('28000000-0000-4000-8000-000000000001',
    '28300000-0000-4000-8000-000000000004') -> 'outcome' ->> 'logical_result'),
  'match_cancel_unchanged', 'canceling again is success without effect');
select is((select canceled_by::text from private.matches
  where id = '28300000-0000-4000-8000-000000000004'),
  '28100000-0000-4000-8000-000000000002', 'and keeps the first cancellation');
select throws_ok($$select pg_temp.upd('28000000-0000-4000-8000-000000000001',
    '28300000-0000-4000-8000-000000000004', '{"field_slots": 5}')$$,
  'P0001', 'MATCH_CANCELED', 'a canceled match cannot be edited');
select throws_ok($$select public.join_match('28000000-0000-4000-8000-000000000009',
    gen_random_uuid(), gen_random_uuid(), repeat('a', 64), 1, 1,
    '28300000-0000-4000-8000-000000000004')$$,
  'P0001', 'MATCH_CANCELED', 'nobody joins a canceled match');
select throws_ok($$select public.leave_match('28000000-0000-4000-8000-000000000007',
    gen_random_uuid(), gen_random_uuid(), repeat('a', 64), 1, 1,
    '28300000-0000-4000-8000-000000000004')$$,
  'P0001', 'MATCH_CANCELED', 'a confirmed player does not leave a canceled match');
select throws_ok($$select public.leave_match('28000000-0000-4000-8000-000000000008',
    gen_random_uuid(), gen_random_uuid(), repeat('a', 64), 1, 1,
    '28300000-0000-4000-8000-000000000004')$$,
  'P0001', 'MATCH_CANCELED', 'the waitlist is frozen too');
select throws_ok($$select public.set_match_payment('28000000-0000-4000-8000-000000000001',
    gen_random_uuid(), gen_random_uuid(), repeat('a', 64), 1, 1,
    '28300000-0000-4000-8000-000000000004', '28100000-0000-4000-8000-000000000003', true)$$,
  'P0001', 'MATCH_CANCELED', 'no payment is marked on a canceled match');
select throws_ok($$select public.join_match('28000000-0000-4000-8000-000000000006',
    gen_random_uuid(), gen_random_uuid(), repeat('a', 64), 1, 1,
    '28300000-0000-4000-8000-000000000004')$$,
  'P0002', 'NOT_FOUND', 'a stranger still gets NOT_FOUND, not the cancellation');
-- Sair do grupo continua liberando a inscrição, mas não promove a espera do cancelado.
update public.group_members set status = 'removed', removed_at = now()
where group_id = '28200000-0000-4000-8000-000000000001'
  and profile_id = '28100000-0000-4000-8000-000000000007';
select is(pg_temp.slots('28300000-0000-4000-8000-000000000004'),
  'Jogador:starter,Oito:waitlist',
  'leaving the group frees the line without promoting a canceled waitlist');
select is(pg_temp.slots('28300000-0000-4000-8000-000000000001'),
  'Jogador:starter,Oito:starter,Nove:starter',
  'a live match still drops the leaver');

-- ---------------------------------------------------------------------------
-- Leituras: o estado cancelado chega ao detalhe, à Agenda e à ocupação
-- ---------------------------------------------------------------------------
select is((select canceled from public.get_match('28000000-0000-4000-8000-000000000003',
    gen_random_uuid(), '28300000-0000-4000-8000-000000000004')), true,
  'get_match says canceled to a member');
select is((select canceled from public.get_match('28000000-0000-4000-8000-000000000003',
    gen_random_uuid(), '28300000-0000-4000-8000-000000000001')), false,
  'and not canceled for a live match');
select is((select array_agg(location_name || ':' || canceled order by starts_at)
  from public.list_my_matches('28000000-0000-4000-8000-000000000003', gen_random_uuid())),
  array['Quadra:false', 'Ginásio:true', 'Arena Nova:false'],
  'the Agenda keeps the canceled match until it ends, marked');
select is((select array_agg(canceled order by match_id)
  from public.get_matches_occupancy('28000000-0000-4000-8000-000000000003', gen_random_uuid())),
  array[false, false, true], 'the occupancy carries the state');
select is((select public.get_match_roster('28000000-0000-4000-8000-000000000003',
    gen_random_uuid(), '28300000-0000-4000-8000-000000000004') -> 'canceled'), 'true'::jsonb,
  'the roster says canceled');
select is((select jsonb_path_query_array(public.get_match_roster(
    '28000000-0000-4000-8000-000000000003', gen_random_uuid(),
    '28300000-0000-4000-8000-000000000004'), '$.confirmed[*].name')),
  '["Jogador"]'::jsonb, 'and still shows who was confirmed');
select ok(not exists (select 1 from public.get_match('28000000-0000-4000-8000-000000000003',
    gen_random_uuid(), '28300000-0000-4000-8000-000000000004') as m
  where to_jsonb(m) ?| array['canceled_at', 'canceled_by']),
  'who and when are never projected');
select throws_ok($$select * from public.get_match('28000000-0000-4000-8000-000000000006',
    gen_random_uuid(), '28300000-0000-4000-8000-000000000004')$$,
  'P0002', 'NOT_FOUND', 'a stranger reads nothing of a canceled match');

-- ---------------------------------------------------------------------------
-- Replay depois do cancelamento (P1 da revisão do #79): a mesma chave de uma
-- chamada feita antes recebe a recusa de uma chamada nova, sem resposta
-- guardada, current ou resumo, e nada muda.
-- ---------------------------------------------------------------------------
-- 305: 1 vaga. Jogador confirma (J1), Oito vai à espera (J2), Nove entra e
-- desiste (L1), a dona marca o Jogador como pago (P1); depois, cancela.
insert into private.matches (id, group_id, starts_at, ends_at, timezone, location_name,
  field_slots, field_price, created_by) values
  ('28300000-0000-4000-8000-000000000005', '28200000-0000-4000-8000-000000000001',
   date_trunc('minute', now()) + interval '5 days',
   date_trunc('minute', now()) + interval '5 days 90 minutes', 'America/Sao_Paulo',
   'Replay', 1, 10, '28100000-0000-4000-8000-000000000001');
create temporary table replay_calls (label text, call text);
insert into replay_calls values
  ('join_match, confirmed', $$select public.join_match('28000000-0000-4000-8000-000000000003',
    gen_random_uuid(), '28700000-0000-4000-8000-000000000001', repeat('d', 64), 1, 1,
    '28300000-0000-4000-8000-000000000005')$$),
  ('join_match, waitlist', $$select public.join_match('28000000-0000-4000-8000-000000000008',
    gen_random_uuid(), '28700000-0000-4000-8000-000000000002', repeat('d', 64), 1, 1,
    '28300000-0000-4000-8000-000000000005')$$),
  ('leave_match', $$select public.leave_match('28000000-0000-4000-8000-000000000009',
    gen_random_uuid(), '28700000-0000-4000-8000-000000000003', repeat('d', 64), 1, 1,
    '28300000-0000-4000-8000-000000000005')$$),
  ('set_match_payment', $$select public.set_match_payment('28000000-0000-4000-8000-000000000001',
    gen_random_uuid(), '28700000-0000-4000-8000-000000000004', repeat('d', 64), 1, 1,
    '28300000-0000-4000-8000-000000000005', '28100000-0000-4000-8000-000000000003', true)$$);
create temporary table replay_first (label text, answer jsonb);
insert into replay_first select 'join_match, confirmed', public.join_match(
  '28000000-0000-4000-8000-000000000003', gen_random_uuid(),
  '28700000-0000-4000-8000-000000000001', repeat('d', 64), 1, 1,
  '28300000-0000-4000-8000-000000000005');
insert into replay_first select 'join_match, waitlist', public.join_match(
  '28000000-0000-4000-8000-000000000008', gen_random_uuid(),
  '28700000-0000-4000-8000-000000000002', repeat('d', 64), 1, 1,
  '28300000-0000-4000-8000-000000000005');
select lives_ok($$select public.join_match('28000000-0000-4000-8000-000000000009',
    gen_random_uuid(), gen_random_uuid(), repeat('d', 64), 1, 1,
    '28300000-0000-4000-8000-000000000005')$$, 'Nove joins before leaving');
insert into replay_first select 'leave_match', public.leave_match(
  '28000000-0000-4000-8000-000000000009', gen_random_uuid(),
  '28700000-0000-4000-8000-000000000003', repeat('d', 64), 1, 1,
  '28300000-0000-4000-8000-000000000005');
insert into replay_first select 'set_match_payment', public.set_match_payment(
  '28000000-0000-4000-8000-000000000001', gen_random_uuid(),
  '28700000-0000-4000-8000-000000000004', repeat('d', 64), 1, 1,
  '28300000-0000-4000-8000-000000000005', '28100000-0000-4000-8000-000000000003', true);
select is((select array_agg(label || ':' || (answer -> 'outcome' ->> 'logical_result') order by label)
  from replay_first),
  array['join_match, confirmed:match_joined', 'join_match, waitlist:match_waitlisted',
    'leave_match:match_left', 'set_match_payment:payment_marked_paid'],
  'the four calls succeed before the cancellation');
-- Antes do cancelamento, a mesma chave reproduz o desfecho: o replay funciona.
select is((select public.join_match('28000000-0000-4000-8000-000000000003', gen_random_uuid(),
    '28700000-0000-4000-8000-000000000001', repeat('d', 64), 1, 1,
    '28300000-0000-4000-8000-000000000005') -> 'outcome'),
  (select answer -> 'outcome' from replay_first where label = 'join_match, confirmed'),
  'before the cancellation the same key replays the stored outcome');
select is((select pg_temp.cancel('28000000-0000-4000-8000-000000000001',
    '28300000-0000-4000-8000-000000000005') -> 'outcome' ->> 'logical_result'),
  'match_canceled', 'the owner cancels after the four calls');
create temporary table replay_before as
  select profile_id, status, paid, payment_marked_by, payment_marked_at, queue_seq
  from private.match_players where match_id = '28300000-0000-4000-8000-000000000005';
create temporary table replay_ledger as
  select request_id, state, outcome, updated_at from private.idempotency_records
  where request_id in ('28700000-0000-4000-8000-000000000001', '28700000-0000-4000-8000-000000000002',
    '28700000-0000-4000-8000-000000000003', '28700000-0000-4000-8000-000000000004');
select throws_ok(call, 'P0001', 'MATCH_CANCELED', 'replay after the cancellation: ' || label)
from replay_calls;
select is((select count(*)::integer from (
    select profile_id, status, paid, payment_marked_by, payment_marked_at, queue_seq
    from private.match_players where match_id = '28300000-0000-4000-8000-000000000005'
    except select * from replay_before) as changed), 0,
  'the refused replays change no line');
select is((select count(*)::integer from (
    select request_id, state, outcome, updated_at from private.idempotency_records
    where request_id in ('28700000-0000-4000-8000-000000000001',
      '28700000-0000-4000-8000-000000000002', '28700000-0000-4000-8000-000000000003',
      '28700000-0000-4000-8000-000000000004')
    except select * from replay_ledger) as changed), 0,
  'and keep the completed ledger records as they were');
select is((select count(*)::integer from replay_ledger where state = 'completed'), 4,
  'the four records stay completed');
-- Quem perdeu a autoridade continua no padrão da M2-D20: o desfecho, sem current.
update public.group_members set status = 'removed', removed_at = now()
where group_id = '28200000-0000-4000-8000-000000000001'
  and profile_id = '28100000-0000-4000-8000-000000000008';
select is((select public.join_match('28000000-0000-4000-8000-000000000008', gen_random_uuid(),
    '28700000-0000-4000-8000-000000000002', repeat('d', 64), 1, 1,
    '28300000-0000-4000-8000-000000000005')),
  jsonb_build_object('outcome', (select answer -> 'outcome' from replay_first
    where label = 'join_match, waitlist')),
  'a former member keeps the M2-D20 replay: the outcome only, nothing about the match');

select * from finish();
rollback;
