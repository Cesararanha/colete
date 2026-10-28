begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Tabela, sequência e restrições
-- ---------------------------------------------------------------------------
select has_table('private', 'match_players', 'match_players lives in private (docs/14 section 5.2)');
select hasnt_table('public', 'match_players', 'no client-facing copy of the table exists');
select columns_are('private', 'match_players', array['id', 'match_id', 'profile_id', 'status',
  'queue_seq', 'joined_at', 'status_changed_at', 'paid', 'payment_marked_by',
  'payment_marked_at']::name[], 'match_players has exactly the cut of docs/10 section 5');
select fk_ok('private', 'match_players', 'match_id', 'private', 'matches', 'id',
  'a registration belongs to a match');
select fk_ok('private', 'match_players', 'profile_id', 'public', 'profiles', 'id',
  'a registration belongs to a profile');
select fk_ok('private', 'match_players', 'payment_marked_by', 'public', 'profiles', 'id',
  'who marked the payment is a profile');
select col_not_null('private', 'match_players', 'queue_seq', 'every registration has a queue place');
select has_sequence('private', 'match_queue_seq', 'the queue sequence is private');
select ok(not exists (select 1 from pg_attribute
  where attrelid = 'private.match_players'::regclass and attname in ('amount', 'pix_key', 'proof_id')),
  'no amount, Pix or proof column exists');

-- ---------------------------------------------------------------------------
-- Isolamento: private, sem RLS, sem policy, sem privilégio (docs/14 §5.2)
-- ---------------------------------------------------------------------------
select ok((select not relrowsecurity and not relforcerowsecurity from pg_class
  where oid = 'private.match_players'::regclass),
  'match_players does not rely on RLS: the protection is schema and grants');
select is((select count(*)::integer from pg_policy
  where polrelid = 'private.match_players'::regclass), 0, 'match_players has no policy');
select is((select count(*)::integer from information_schema.table_privileges
  where table_schema = 'private' and table_name = 'match_players'
    and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')), 0,
  'the table is born without any client or service privilege');
select is((select count(*)::integer from information_schema.column_privileges
  where table_schema = 'private' and table_name = 'match_players'
    and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')), 0,
  'no column privilege either');
select ok(not has_schema_privilege('authenticated', 'private', 'usage')
  and not has_schema_privilege('anon', 'private', 'usage'),
  'client roles cannot even reach the private schema');
select ok(not has_sequence_privilege('service_role', 'private.match_queue_seq', 'usage,select,update'),
  'service_role cannot draw queue places');
select ok(not has_sequence_privilege('authenticated', 'private.match_queue_seq', 'usage,select,update'),
  'authenticated cannot draw queue places');

-- ---------------------------------------------------------------------------
-- RPCs: assinatura estreita, ACL e modo
-- ---------------------------------------------------------------------------
create temporary table match_rpc (signature text, volatility "char");
insert into match_rpc values
  ('public.join_match(uuid,uuid,uuid,text,integer,integer,uuid)', 'v'),
  ('public.leave_match(uuid,uuid,uuid,text,integer,integer,uuid)', 'v'),
  ('public.set_match_payment(uuid,uuid,uuid,text,integer,integer,uuid,uuid,boolean)', 'v'),
  ('public.get_match_roster(uuid,uuid,uuid)', 's'),
  ('public.get_matches_occupancy(uuid,uuid)', 's');
select ok(to_regprocedure(signature) is not null, signature || ' exists') from match_rpc;
select ok(not has_function_privilege('public', signature, 'execute')
  and not has_function_privilege('anon', signature, 'execute')
  and not has_function_privilege('authenticated', signature, 'execute'),
  'no client role executes ' || signature) from match_rpc;
select ok(has_function_privilege('service_role', signature, 'execute'),
  'only the nominal service role executes ' || signature) from match_rpc;
select ok((select prosecdef and provolatile = volatility and proconfig @> array['search_path=""']
  from pg_proc where oid = to_regprocedure(signature)),
  signature || ' is security definer, fixed search_path, expected volatility') from match_rpc;

create temporary table match_helper (signature text);
insert into match_helper values
  ('private.lock_match_context(uuid,uuid,uuid,uuid)'),
  ('private.match_player_current(uuid,uuid)'),
  ('private.match_payment_summary(uuid)'),
  ('private.promote_match_waitlist(uuid)'),
  ('private.release_match_players_on_membership_exit()'),
  ('private.check_idempotency_conclusion(private.idempotency_records)');
select ok(not has_function_privilege('service_role', signature, 'execute')
  and not has_function_privilege('authenticated', signature, 'execute'),
  signature || ' is not a gateway routine') from match_helper;

select ok((select pg_get_functiondef(oid) like '%for no key update%'
  and pg_get_functiondef(oid) not like '%for update;%'
  from pg_proc where oid = 'private.lock_match_context(uuid,uuid,uuid,uuid)'::regprocedure),
  'match locks keep the M2-D13 mode');
select ok((select position('public.profiles' in def) < position('public.groups' in def)
  and position('public.groups' in def) < position('public.group_members' in def)
  and position('public.group_members' in def) < position('from private.matches where id = p_match_id for' in def)
  from (select pg_get_functiondef('private.lock_match_context(uuid,uuid,uuid,uuid)'::regprocedure)
    as def) as f),
  'lock order is profile, group, membership, match (docs/10 section 10)');

select is((select count(*)::integer from pg_trigger
  where tgrelid = 'public.group_members'::regclass
    and tgname = 'group_members_release_match_players' and not tgisinternal), 1,
  'membership exit trigger is installed');

-- ---------------------------------------------------------------------------
-- Livro de idempotência: desfecho fechado, só IDs
-- ---------------------------------------------------------------------------
select lives_ok($$select private.validate_idempotency_outcome('join_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_waitlisted","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  'join_match outcome with IDs only is valid');
select lives_ok($$select private.validate_idempotency_outcome('leave_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_leave_unchanged","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  'leave_match unchanged outcome is valid');
select lives_ok($$select private.validate_idempotency_outcome('set_match_payment',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"payment_marked_paid","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f","profile_id":"01890f7e-e948-4c53-b13a-4a36e4b7d210"}'::jsonb)$$,
  'set_match_payment outcome carries the target ID');
select throws_ok($$select private.validate_idempotency_outcome('join_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_joined","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f","waitlist_position":3}'::jsonb)$$,
  '22023', 'VALIDATION', 'a queue position cannot be stored in the outcome');
select throws_ok($$select private.validate_idempotency_outcome('set_match_payment',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"payment_marked_paid","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f","profile_id":"01890f7e-e948-4c53-b13a-4a36e4b7d210","amount":"25.00"}'::jsonb)$$,
  '22023', 'VALIDATION', 'an amount cannot be stored in the outcome');
select throws_ok($$select private.validate_idempotency_outcome('leave_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_joined","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  '22023', 'VALIDATION', 'each operation has its own closed results');
select lives_ok($$select private.validate_idempotency_outcome('create_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_created","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  'the chain still delegates create_match');
select ok((select count(*) = 3 from private.idempotency_operations where operation in ('join_match', 'leave_match', 'set_match_payment')), 'operation registry includes the new three');
select ok((select count(distinct logical_result) = 1 from private.idempotency_operation_results where logical_result in ('payment_unchanged')), 'result registry includes the new results');

select throws_ok($$select public.join_match('15000000-0000-4000-8000-000000000001',
  '15000000-0000-4000-8000-000000000001', '01890f7e-e948-4c53-b13a-4a36e4b7d21e',
  repeat('a', 64), 1, 1, null)$$, '22023', 'VALIDATION', 'join_match refuses a null match first');
select throws_ok($$select public.set_match_payment('15000000-0000-4000-8000-000000000001',
  '15000000-0000-4000-8000-000000000001', '01890f7e-e948-4c53-b13a-4a36e4b7d21e',
  repeat('a', 64), 1, 1, '01890f7e-e948-4c53-b13a-4a36e4b7d21e', null, true)$$,
  '22023', 'VALIDATION', 'set_match_payment refuses a null target first');

-- ---------------------------------------------------------------------------
-- Fixture: grupo, racha futuro de 2 vagas e racha já iniciado
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('22000000-0000-4000-8000-000000000001', 'mp-owner@example.invalid'),
  ('22000000-0000-4000-8000-000000000002', 'mp-a@example.invalid'),
  ('22000000-0000-4000-8000-000000000003', 'mp-b@example.invalid'),
  ('22000000-0000-4000-8000-000000000004', 'mp-c@example.invalid'),
  ('22000000-0000-4000-8000-000000000005', 'mp-d@example.invalid'),
  ('22000000-0000-4000-8000-000000000006', 'mp-stranger@example.invalid');
insert into public.profiles (id, auth_user_id, name, nickname, position, account_status) values
  ('22100000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'Dona', null, null, 'active'),
  ('22100000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000002', 'Ana', 'Aninha', 'forward', 'active'),
  ('22100000-0000-4000-8000-000000000003', '22000000-0000-4000-8000-000000000003', 'Bia', null, 'goalkeeper', 'active'),
  ('22100000-0000-4000-8000-000000000004', '22000000-0000-4000-8000-000000000004', 'Caio', null, null, 'active'),
  ('22100000-0000-4000-8000-000000000005', '22000000-0000-4000-8000-000000000005', 'Duda', 'Dudinha', 'defender', 'active'),
  ('22100000-0000-4000-8000-000000000006', '22000000-0000-4000-8000-000000000006', 'Estranho', null, null, 'active');
insert into public.groups (id, name, owner_id) values
  ('22200000-0000-4000-8000-000000000001', 'Grupo Lista', '22100000-0000-4000-8000-000000000001');
insert into public.group_members (group_id, profile_id, role, status) values
  ('22200000-0000-4000-8000-000000000001', '22100000-0000-4000-8000-000000000001', 'organizer', 'active'),
  ('22200000-0000-4000-8000-000000000001', '22100000-0000-4000-8000-000000000002', 'player', 'active'),
  ('22200000-0000-4000-8000-000000000001', '22100000-0000-4000-8000-000000000003', 'player', 'active'),
  ('22200000-0000-4000-8000-000000000001', '22100000-0000-4000-8000-000000000004', 'player', 'active'),
  ('22200000-0000-4000-8000-000000000001', '22100000-0000-4000-8000-000000000005', 'player', 'active');
insert into private.matches (id, group_id, starts_at, ends_at, timezone, location_name,
  field_slots, field_price, created_by) values
  ('22300000-0000-4000-8000-000000000001', '22200000-0000-4000-8000-000000000001',
   now() + interval '2 days', now() + interval '2 days 90 minutes', 'America/Sao_Paulo',
   'Arena', 2, 15, '22100000-0000-4000-8000-000000000001'),
  ('22300000-0000-4000-8000-000000000002', '22200000-0000-4000-8000-000000000001',
   now() - interval '30 minutes', now() + interval '60 minutes', 'America/Sao_Paulo',
   'Quadra', 3, 20, '22100000-0000-4000-8000-000000000001');
insert into private.match_players (match_id, profile_id, status, queue_seq) values
  ('22300000-0000-4000-8000-000000000001', '22100000-0000-4000-8000-000000000002', 'starter', nextval('private.match_queue_seq')),
  ('22300000-0000-4000-8000-000000000001', '22100000-0000-4000-8000-000000000003', 'starter', nextval('private.match_queue_seq')),
  ('22300000-0000-4000-8000-000000000001', '22100000-0000-4000-8000-000000000004', 'waitlist', nextval('private.match_queue_seq')),
  ('22300000-0000-4000-8000-000000000002', '22100000-0000-4000-8000-000000000002', 'starter', nextval('private.match_queue_seq')),
  ('22300000-0000-4000-8000-000000000002', '22100000-0000-4000-8000-000000000005', 'starter', nextval('private.match_queue_seq'));

select throws_ok($$update private.match_players set status = 'left', paid = true,
  payment_marked_by = '22100000-0000-4000-8000-000000000001', payment_marked_at = now()
  where profile_id = '22100000-0000-4000-8000-000000000002'
    and match_id = '22300000-0000-4000-8000-000000000001'$$,
  '23514', null, 'a paid registration cannot be left');
select throws_ok($$update private.match_players set paid = true
  where profile_id = '22100000-0000-4000-8000-000000000002'
    and match_id = '22300000-0000-4000-8000-000000000001'$$,
  '23514', null, 'paid always records who marked it');

-- ---------------------------------------------------------------------------
-- Projeção: organização vê pagamentos; jogador só o próprio; estranho nada
-- ---------------------------------------------------------------------------
create temporary table roster_owner as select public.get_match_roster(
  '22000000-0000-4000-8000-000000000001', gen_random_uuid(),
  '22300000-0000-4000-8000-000000000001') as r;
select is((select jsonb_path_query_array(r, '$.confirmed[*].name') from roster_owner),
  '["Ana", "Bia"]'::jsonb, 'confirmed in queue order with names');
select is((select r -> 'confirmed' -> 0 ->> 'nickname' from roster_owner), 'Aninha',
  'the nickname travels');
select is((select r -> 'confirmed' -> 0 ->> 'position' from roster_owner), 'forward',
  'the position travels');
select is((select jsonb_path_query_array(r, '$.waitlist[*].name') from roster_owner),
  '["Caio"]'::jsonb, 'waitlist in queue order');
select is((select jsonb_path_query_array(r, '$.confirmed[*].paid') from roster_owner),
  '[false, false]'::jsonb, 'the organisation sees each payment');
select is((select r -> 'payment_summary' from roster_owner),
  '{"paid_count": 0, "confirmed_count": 2, "total": "0.00"}'::jsonb,
  'summary: nobody paid yet');
select is((select (r -> 'viewer' ->> 'can_manage')::boolean from roster_owner), true,
  'owner manages');

create temporary table roster_player as select public.get_match_roster(
  '22000000-0000-4000-8000-000000000004', gen_random_uuid(),
  '22300000-0000-4000-8000-000000000001') as r;
select is((select r -> 'payment_summary' from roster_player), 'null'::jsonb,
  'a player gets no payment summary');
select is((select jsonb_path_query_array(r, '$.confirmed[*].paid') from roster_player),
  '[null, null]'::jsonb, 'a player sees nobody else''s payment');
select is((select r -> 'viewer' from roster_player),
  '{"paid": null, "status": "waitlist", "can_manage": false, "waitlist_position": 1}'::jsonb,
  'a waiting player sees only the own place');
-- Revisão do #71, P1-2: fora do grupo, ID existente e inexistente dão o
-- mesmo NOT_FOUND; sessão revogada dá UNAUTHENTICATED nos dois.
select throws_ok($$select public.get_match_roster('22000000-0000-4000-8000-000000000006',
  gen_random_uuid(), '22300000-0000-4000-8000-000000000001')$$, 'P0002', 'NOT_FOUND',
  'a stranger reads no roster of an existing match');
select throws_ok($$select public.get_match_roster('22000000-0000-4000-8000-000000000006',
  gen_random_uuid(), '22300000-0000-4000-8000-0000000000ff')$$, 'P0002', 'NOT_FOUND',
  'and gets the same answer for an unknown match');
select throws_ok($$select private.match_actor_authority('22200000-0000-4000-8000-000000000001',
  '22100000-0000-4000-8000-000000000006')$$, 'P0002', 'NOT_FOUND',
  'the authority helper answers NOT_FOUND to a non-member, never NOT_MEMBER');
select is(private.match_actor_authority('22200000-0000-4000-8000-000000000001',
  '22100000-0000-4000-8000-000000000001'), 'owner', 'the owner derives from groups.owner_id');
insert into private.revoked_auth_sessions (session_id, profile_id, expires_at) values
  ('22400000-0000-4000-8000-000000000001', '22100000-0000-4000-8000-000000000006',
   now() + interval '1 hour');
select throws_ok($$select private.lock_match_context('22100000-0000-4000-8000-000000000006',
  '22000000-0000-4000-8000-000000000006', '22400000-0000-4000-8000-000000000001',
  '22300000-0000-4000-8000-0000000000ff')$$, '28000', 'UNAUTHENTICATED',
  'a revoked session is refused before the match is looked up, even for an unknown ID');
select throws_ok($$select private.lock_match_context('22100000-0000-4000-8000-000000000006',
  '22000000-0000-4000-8000-000000000006', '22400000-0000-4000-8000-000000000001',
  '22300000-0000-4000-8000-000000000001')$$, '28000', 'UNAUTHENTICATED',
  'and for an existing one');
select is(private.lock_match_context('22100000-0000-4000-8000-000000000006',
  '22000000-0000-4000-8000-000000000006', gen_random_uuid(),
  '22300000-0000-4000-8000-0000000000ff'), null,
  'a live session gets null for an unknown match, left to the caller as NOT_FOUND');

update private.match_players set paid = true,
  payment_marked_by = '22100000-0000-4000-8000-000000000001', payment_marked_at = now()
where match_id = '22300000-0000-4000-8000-000000000001'
  and profile_id = '22100000-0000-4000-8000-000000000003';
select is(private.match_payment_summary('22300000-0000-4000-8000-000000000001'),
  '{"paid_count": 1, "confirmed_count": 2, "total": "15.00"}'::jsonb,
  'total is paid count times field_price, nothing typed');
select is((select public.get_match_roster('22000000-0000-4000-8000-000000000003',
  gen_random_uuid(), '22300000-0000-4000-8000-000000000001') -> 'viewer' -> 'paid'),
  'true'::jsonb, 'a confirmed player sees the own payment');

-- ---------------------------------------------------------------------------
-- Conta excluída: ocupa a vaga, sem nome, apelido, posição ou ID
-- ---------------------------------------------------------------------------
-- Mesma desidentificação de finalize_deletion (0012).
update public.profiles set account_status = 'deleted', name = 'Deleted 00ff00ff00ff',
  nickname = null, photo_url = null, position = null, dominant_foot = null,
  shirt_number = null, auth_user_id = null, status_changed_at = now(), deidentified_at = now()
where id = '22100000-0000-4000-8000-000000000005';
create temporary table roster_started as select public.get_match_roster(
  '22000000-0000-4000-8000-000000000001', gen_random_uuid(),
  '22300000-0000-4000-8000-000000000002') as r;
select is((select (r ->> 'confirmed_count')::integer from roster_started), 2,
  'the deleted account still counts as occupied');
select is((select r -> 'confirmed' -> 1 from roster_started),
  '{"name": null, "paid": false, "nickname": null, "position": null, "is_viewer": false, "profile_id": null, "account_removed": true}'::jsonb,
  'the deleted account shows no identity');
select ok((select r::text not like '%Deleted%' and r::text not like '%Duda%'
  and r::text not like '%22100000-0000-4000-8000-000000000005%' from roster_started),
  'neither the pseudonym nor the old name nor the ID leaks');
select is((select (r ->> 'started')::boolean from roster_started), true,
  'the roster says the match started');

-- ---------------------------------------------------------------------------
-- Saída do grupo: libera racha futuro, promove a espera, preserva o iniciado
-- ---------------------------------------------------------------------------
update public.group_members set status = 'removed', removed_at = now()
where group_id = '22200000-0000-4000-8000-000000000001'
  and profile_id = '22100000-0000-4000-8000-000000000002';
select is((select status from private.match_players
  where match_id = '22300000-0000-4000-8000-000000000001'
    and profile_id = '22100000-0000-4000-8000-000000000002'), 'removed',
  'leaving the group releases the future registration');
select is((select status from private.match_players
  where match_id = '22300000-0000-4000-8000-000000000001'
    and profile_id = '22100000-0000-4000-8000-000000000004'), 'starter',
  'the first of the waitlist is promoted in the same transaction');
select is((select status from private.match_players
  where match_id = '22300000-0000-4000-8000-000000000002'
    and profile_id = '22100000-0000-4000-8000-000000000002'), 'starter',
  'a started match keeps its roster as history');
select is((select array_agg(confirmed_count || '/' || waitlist_count || '/' || viewer_status
  order by match_id) from public.get_matches_occupancy(
    '22000000-0000-4000-8000-000000000004', gen_random_uuid())),
  array['2/0/starter', '2/0/out'], 'occupancy per unfinished match, with the viewer state');

update private.match_players set paid = false,
  payment_marked_by = '22100000-0000-4000-8000-000000000001', payment_marked_at = now()
where match_id = '22300000-0000-4000-8000-000000000001'
  and profile_id = '22100000-0000-4000-8000-000000000003';
update private.match_players set paid = true,
  payment_marked_by = '22100000-0000-4000-8000-000000000001', payment_marked_at = now()
where match_id = '22300000-0000-4000-8000-000000000001'
  and profile_id = '22100000-0000-4000-8000-000000000003';
update public.group_members set status = 'removed', removed_at = now()
where group_id = '22200000-0000-4000-8000-000000000001'
  and profile_id = '22100000-0000-4000-8000-000000000003';
select is((select status || ':' || paid from private.match_players
  where match_id = '22300000-0000-4000-8000-000000000001'
    and profile_id = '22100000-0000-4000-8000-000000000003'), 'removed:true',
  'a paid registration released by group exit keeps the payment fact');

-- Contraprova: sem o trigger, a saída do grupo deixa um confirmado sem
-- membership; a asserção acima cairia.
-- Os triggers diferidos de group_members precisam disparar antes do ALTER.
set constraints all immediate;
alter table public.group_members disable trigger group_members_release_match_players;
update public.group_members set status = 'removed', removed_at = now()
where group_id = '22200000-0000-4000-8000-000000000001'
  and profile_id = '22100000-0000-4000-8000-000000000004';
select isnt((select status from private.match_players
  where match_id = '22300000-0000-4000-8000-000000000001'
    and profile_id = '22100000-0000-4000-8000-000000000004'), 'removed',
  'without the trigger the exit leaves a ghost starter: the probe is not vacuous');
alter table public.group_members enable trigger group_members_release_match_players;

-- ---------------------------------------------------------------------------
-- Sonda negativa: nenhum papel lê ou escreve a tabela diretamente
-- ---------------------------------------------------------------------------
select ok(not (select rolbypassrls from pg_roles where rolname = 'authenticated'),
  'client probe has no BYPASSRLS');
set local role authenticated;
set local request.jwt.claims = '{"sub":"22000000-0000-4000-8000-000000000001"}';
select throws_ok($$select id from private.match_players$$, '42501', null,
  'the owner cannot read registrations directly');
select throws_ok($$insert into private.match_players (match_id, profile_id, status, queue_seq)
  values ('22300000-0000-4000-8000-000000000001', '22100000-0000-4000-8000-000000000001', 'starter', 1)$$,
  '42501', null, 'a client cannot register directly');
reset role;
set local role anon;
select throws_ok($$select id from private.match_players$$, '42501', null, 'anon reads nothing');
reset role;
set local role service_role;
select throws_ok($$select id from private.match_players$$, '42501', null,
  'service_role has no direct read');
select throws_ok($$update private.match_players set paid = true$$, '42501', null,
  'service_role has no direct write');
select throws_ok($$select nextval('private.match_queue_seq')$$, '42501', null,
  'service_role cannot draw a queue place');
reset role;

-- Contraprova: um grant direto faz a sonda ler, e a asserção exata cai.
grant usage on schema private to service_role;
grant select on private.match_players to service_role;
set local role service_role;
select lives_ok($$select id from private.match_players$$,
  'with a direct grant the probe reads: the denial above is not vacuous');
reset role;
revoke select on private.match_players from service_role;
revoke usage on schema private from service_role;

-- ---------------------------------------------------------------------------
-- Descrição do racha (decisão humana de 16/10/2026)
-- ---------------------------------------------------------------------------
select col_type_is('private', 'matches', 'description', 'text', 'the description is plain text');
select col_is_null('private', 'matches', 'description', 'the description is optional');
select throws_ok($$update private.matches set description = repeat('x', 501)
  where id = '22300000-0000-4000-8000-000000000001'$$,
  '23514', null, 'the table refuses 501 code points');
select throws_ok($$update private.matches set description = ''
  where id = '22300000-0000-4000-8000-000000000001'$$,
  '23514', null, 'the table refuses the empty string: null is the only spelling');
select lives_ok($$update private.matches set description = repeat('é', 500)
  where id = '22300000-0000-4000-8000-000000000001'$$, '500 code points fit');

-- Os mesmos casos de match-description.test.ts (formulário e Edge).
create temporary table description_cases (label text, input text, expected text);
insert into description_cases values
  ('empty is null', '', null),
  ('plain', 'Traga colete', 'Traga colete'),
  ('spaces collapse and trim', '  Traga   colete  ', 'Traga colete'),
  ('CRLF and spaces around it', E'Linha 1 \r\n  Linha 2', E'Linha 1\nLinha 2'),
  ('at most one blank line', E'Um\n\n\n\nDois', E'Um\n\nDois'),
  ('line separator', E'Um Dois', E'Um\nDois'),
  ('NFC and ideographic space', E'Café　bar', 'Café bar'),
  ('500 code points', repeat('x', 500), repeat('x', 500)),
  ('500 after trimming', '  ' || repeat('é', 500) || '  ', repeat('é', 500)),
  ('markup stays text', '<b>sem HTML</b> https://exemplo.test', '<b>sem HTML</b> https://exemplo.test');
select is(private.normalize_match_description(input), expected, 'description normalised: ' || label)
from description_cases;
select is(private.normalize_match_description(null), null, 'null stays null');

create temporary table description_refusals (label text, input text);
insert into description_refusals values
  ('spaces only', '   '),
  ('blank lines only', E'\n \n'),
  ('tab', E'Tab\taqui'),
  ('zero width space', E'Zero​width'),
  ('bidi override', E'Bidi‮override'),
  ('501 code points', repeat('x', 501));
select throws_ok(format('select private.normalize_match_description(%L)', input),
  '22023', 'VALIDATION', 'description refused: ' || label)
from description_refusals;

-- create_match: a décima chave é obrigatória e passa pela mesma regra. O
-- ator inexistente separa os casos: config válido chega até NOT_FOUND; config
-- inválido para antes, em VALIDATION.
create temporary table description_configs (label text, config jsonb, code text);
insert into description_configs values
  ('null description passes the shape',
   '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","location_name":"Arena","location_address":null,"description":null,"latitude":null,"longitude":null,"field_slots":14,"field_price":"25.00"}',
   'NOT_FOUND'),
  ('text description passes the shape',
   '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","location_name":"Arena","location_address":null,"description":"Leve água","latitude":null,"longitude":null,"field_slots":14,"field_price":"25.00"}',
   'NOT_FOUND'),
  ('the 0021 nine keys, without description',
   '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","location_name":"Arena","location_address":null,"latitude":null,"longitude":null,"field_slots":14,"field_price":"25.00"}',
   'VALIDATION'),
  ('empty string description',
   '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","location_name":"Arena","location_address":null,"description":"","latitude":null,"longitude":null,"field_slots":14,"field_price":"25.00"}',
   'VALIDATION'),
  ('spaces only description',
   '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","location_name":"Arena","location_address":null,"description":"   ","latitude":null,"longitude":null,"field_slots":14,"field_price":"25.00"}',
   'VALIDATION'),
  ('numeric description',
   '{"starts_at":"2030-01-01T22:00:00.000Z","ends_at":"2030-01-01T23:30:00.000Z","timezone":"America/Sao_Paulo","location_name":"Arena","location_address":null,"description":12,"latitude":null,"longitude":null,"field_slots":14,"field_price":"25.00"}',
   'VALIDATION');
insert into description_configs
select '501 code points description',
  jsonb_set(config, '{description}', to_jsonb(repeat('x', 501))), 'VALIDATION'
from description_configs where label = 'null description passes the shape';
select throws_ok(format($$select public.create_match(
    '15000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001',
    '01890f7e-e948-4c53-b13a-4a36e4b7d21e', repeat('a', 64), 1, 1,
    '01890f7e-e948-4c53-b13a-4a36e4b7d21e', %L::jsonb)$$, config),
  case when code = 'NOT_FOUND' then 'P0002' else '22023' end, code,
  'create_match description: ' || label)
from description_configs;

-- Leitura: get_match projeta a descrição; list_my_matches não.
update private.matches set description = E'Traga colete\nescuro'
  where id = '22300000-0000-4000-8000-000000000001';
select is((select description from public.get_match('22000000-0000-4000-8000-000000000001',
  gen_random_uuid(), '22300000-0000-4000-8000-000000000001')), E'Traga colete\nescuro',
  'get_match projects the description');
select is((select description from public.get_match('22000000-0000-4000-8000-000000000001',
  gen_random_uuid(), '22300000-0000-4000-8000-000000000002')), null,
  'get_match projects null when there is none');
select ok(pg_get_function_result('public.list_my_matches(uuid,uuid)'::regprocedure)
  not like '%description%', 'list_my_matches leaves the description out');
select ok(not has_function_privilege('authenticated',
  'public.get_match(uuid,uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.get_match(uuid,uuid,uuid)', 'execute'),
  'the recreated get_match keeps the service_role-only privilege');
select ok(not has_function_privilege('service_role',
  'private.normalize_match_description(text)', 'execute'),
  'the description normaliser is internal');

select * from finish();
rollback;
