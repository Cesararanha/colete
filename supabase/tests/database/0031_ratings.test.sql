begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Tabelas privadas, sem RLS e sem privilégio
-- ---------------------------------------------------------------------------
create temporary table rating_tables (name text);
insert into rating_tables values ('ratings'), ('rating_history');
select has_table('private', name, 'private.' || name || ' exists') from rating_tables;
select ok((select not relrowsecurity and not relforcerowsecurity from pg_class
  where oid = ('private.' || name)::regclass),
  'private.' || name || ' has no RLS, by choice (docs/14 §5.2)') from rating_tables;
select ok((select count(*) from information_schema.table_privileges
    where table_schema = 'private' and table_name = name
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) = 0
  and (select count(*) from information_schema.column_privileges
    where table_schema = 'private' and table_name = name
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) = 0,
  'private.' || name || ' is born without any privilege') from rating_tables;
select ok(not exists (select 1 from information_schema.tables
    where table_schema = 'public' and table_name in ('ratings', 'rating_history')),
  'no rating table lives in public');
select col_is_pk('private', 'ratings', array['group_id', 'profile_id'], 'one current rating per member of a group');
select fk_ok('private', 'ratings', array['current_history_id', 'group_id', 'profile_id'],
  'private', 'rating_history', array['id', 'group_id', 'profile_id'],
  'the current rating points to a version of the same member and group');
select fk_ok('private', 'rating_history', 'changed_by', 'public', 'profiles', 'id',
  'who changed is a profile');
create temporary table rating_checks (tbl text, def text);
insert into rating_checks values
  ('ratings', 'CHECK (((stars >= 1) AND (stars <= 5)))'),
  ('rating_history', 'CHECK (((new_stars >= 1) AND (new_stars <= 5)))'),
  ('rating_history', 'CHECK (((old_stars >= 1) AND (old_stars <= 5)))'),
  ('rating_history', 'CHECK ((old_stars IS DISTINCT FROM new_stars))');
select ok(exists (select 1 from pg_constraint
    where conrelid = ('private.' || tbl)::regclass and pg_get_constraintdef(oid) = def),
  tbl || ': ' || def) from rating_checks;

-- ---------------------------------------------------------------------------
-- RPCs: assinatura estreita, ACL e modo
-- ---------------------------------------------------------------------------
create temporary table rating_rpc (signature text, mode text);
insert into rating_rpc values
  ('public.set_rating(uuid,uuid,uuid,text,integer,integer,uuid,uuid,integer)', 'v'),
  ('public.get_group_ratings(uuid,uuid,uuid)', 'v'),
  ('public.get_my_rating(uuid,uuid,uuid)', 's');
select ok(to_regprocedure(signature) is not null, signature || ' exists') from rating_rpc;
select ok(not has_function_privilege('public', signature, 'execute')
  and not has_function_privilege('anon', signature, 'execute')
  and not has_function_privilege('authenticated', signature, 'execute')
  and has_function_privilege('service_role', signature, 'execute'),
  'only the nominal service role executes ' || signature) from rating_rpc;
select ok((select prosecdef and provolatile = mode and proconfig = array['search_path=""']
  from pg_proc where oid = to_regprocedure(signature)),
  signature || ' is security definer with fixed search_path and mode ' || mode) from rating_rpc;
select ok((select pg_get_functiondef(oid) like '%from public.groups%where id = p_group_id and not private.is_group_deleted(id)%for no key update%'
    and pg_get_functiondef(oid) like '%from public.group_members as membership%not private.is_group_deleted(membership.group_id)%for no key update%'
  from pg_proc where oid = 'public.set_rating(uuid,uuid,uuid,text,integer,integer,uuid,uuid,integer)'::regprocedure),
  'set_rating decides a deleted group before locking its row or memberships (0029)');
create temporary table rating_helper (signature text);
insert into rating_helper values ('private.purge_ratings()'),
  ('private.check_idempotency_conclusion(private.idempotency_records)'),
  ('private.require_rating_matches_history()'), ('private.forbid_rating_history_update()');
select ok(not has_function_privilege('service_role', signature, 'execute')
  and not has_function_privilege('authenticated', signature, 'execute'),
  signature || ' is not a gateway routine') from rating_helper;

-- ---------------------------------------------------------------------------
-- Livro de idempotência: desfecho sem estrelas e operações anteriores mantidas
-- ---------------------------------------------------------------------------
select lives_ok($$select private.validate_idempotency_outcome('set_rating',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"rating_set","profile_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  'set_rating outcome with IDs only is valid');
select lives_ok($$select private.validate_idempotency_outcome('set_rating',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"rating_unchanged","profile_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  'rating_unchanged is valid');
select throws_ok($$select private.validate_idempotency_outcome('set_rating',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"rating_set","profile_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f","stars":4}'::jsonb)$$,
  '22023', 'VALIDATION', 'the stars never enter the outcome');
select throws_ok($$select private.validate_idempotency_outcome('set_rating',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"role_set","profile_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  '22023', 'VALIDATION', 'set_rating has its own closed results');
select lives_ok($$select private.validate_idempotency_outcome('set_group_photo',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_photo_set"}'::jsonb)$$,
  'the chain still delegates the photo operations');
create temporary table earlier_ops (op text);
insert into earlier_ops values ('complete_profile'), ('delete_account'), ('approve_member'),
  ('set_role'), ('set_ratings_visibility'), ('create_group'), ('join_by_invite'),
  ('rename_group'), ('create_match'), ('join_match'), ('set_match_payment'),
  ('set_group_appearance'), ('update_match'), ('cancel_match'), ('delete_group'),
  ('begin_photo_upload'), ('remove_group_photo'), ('set_rating');
select ok(exists (select 1 from private.idempotency_operations where operation = op),
  'the operation registry keeps ' || op) from earlier_ops;
select ok((select count(distinct logical_result) = 4 from private.idempotency_operation_results where logical_result in ('rating_set', 'rating_unchanged', 'group_photo_unchanged', 'group_deleted')),
  'the result registry keeps the earlier results and has rating_set and rating_unchanged');
create temporary table idem_bodies (signature text);
insert into idem_bodies values
  ('private.acquire_group_idempotency(text,text,uuid,text,integer,integer)'),
  ('private.complete_group_idempotency(text,text,uuid,text,integer,integer,jsonb)'),
  ('private.enforce_idempotency_conclusion()');
-- D63.5 (0033): the helpers read the registry; the group ones only the group family
-- (rev92 P3-2: the assertion reads each body again, not just the registry rows).
select ok((select count(*) = 3 from private.idempotency_operations
    where operation in ('set_rating', 'remove_group_photo', 'delete_group')
      and family = 'group')
    and pg_get_functiondef(signature::regprocedure) like case
      when signature like '%enforce%' then '%perform private.check_idempotency_conclusion(%'
      else '%from private.idempotency_operations as operations%operations.family = ''group''%' end,
  signature || ' accepts set_rating and keeps the earlier operations') from idem_bodies;

-- ---------------------------------------------------------------------------
-- Atores e grupos
-- ---------------------------------------------------------------------------
create function pg_temp.auth(p_n text) returns uuid language sql immutable as $$
  select ('31000000-0000-4000-8000-0000000000' || p_n)::uuid;
$$;
create function pg_temp.pid(p_n text) returns uuid language sql immutable as $$
  select ('31100000-0000-4000-8000-0000000000' || p_n)::uuid;
$$;
create function pg_temp.gid(p_n text) returns uuid language sql immutable as $$
  select ('31200000-0000-4000-8000-0000000000' || p_n)::uuid;
$$;
-- 01 dona, 02 organizador, 03 jogador, 04 ex-organizador, 05 organizador
-- pendente, 06 estranho; 10–14 jogadores; 15 em exclusão de conta.
insert into auth.users (id, email)
select pg_temp.auth(n), 'rating31-' || n || '@example.invalid'
from unnest(array['01','02','03','04','05','06','10','11','12','13','14','15']) as n;
insert into public.profiles (id, auth_user_id, name, nickname, account_status)
select pg_temp.pid(n), pg_temp.auth(n), 'Pessoa ' || n, case when n = '10' then 'Dez' end, 'active'
from unnest(array['01','02','03','04','05','06','10','11','12','13','14','15']) as n;
insert into public.groups (id, name, owner_id) values
  (pg_temp.gid('01'), 'Grupo das Notas', pg_temp.pid('01')),
  (pg_temp.gid('02'), 'Grupo que será apagado', pg_temp.pid('01')),
  (pg_temp.gid('03'), 'Grupo para expurgo', pg_temp.pid('01'));
insert into public.group_members (group_id, profile_id, role, status, removed_at) values
  (pg_temp.gid('01'), pg_temp.pid('01'), 'player', 'active', null),
  (pg_temp.gid('01'), pg_temp.pid('02'), 'organizer', 'active', null),
  (pg_temp.gid('01'), pg_temp.pid('03'), 'player', 'active', null),
  (pg_temp.gid('01'), pg_temp.pid('04'), 'organizer', 'removed', now()),
  (pg_temp.gid('01'), pg_temp.pid('05'), 'organizer', 'pending', null),
  (pg_temp.gid('01'), pg_temp.pid('10'), 'player', 'active', null),
  (pg_temp.gid('01'), pg_temp.pid('11'), 'player', 'active', null),
  (pg_temp.gid('01'), pg_temp.pid('12'), 'player', 'active', null),
  (pg_temp.gid('01'), pg_temp.pid('13'), 'player', 'active', null),
  (pg_temp.gid('01'), pg_temp.pid('15'), 'player', 'active', null),
  (pg_temp.gid('02'), pg_temp.pid('01'), 'player', 'active', null),
  (pg_temp.gid('02'), pg_temp.pid('02'), 'organizer', 'active', null),
  (pg_temp.gid('02'), pg_temp.pid('10'), 'player', 'active', null);

create function pg_temp.rate(p_auth uuid, p_group uuid, p_target uuid, p_stars integer,
  p_request uuid default gen_random_uuid(), p_hmac text default repeat('a', 64)) returns jsonb
language sql as $$
  select public.set_rating(p_auth, '31900000-0000-4000-8000-000000000000', p_request,
    p_hmac, 1, 1, p_group, p_target, p_stars);
$$;
create function pg_temp.board(p_auth uuid, p_group uuid) returns jsonb language sql as $$
  select public.get_group_ratings(p_auth, '31900000-0000-4000-8000-000000000000', p_group);
$$;
create function pg_temp.mine(p_auth uuid, p_group uuid) returns jsonb language sql as $$
  select public.get_my_rating(p_auth, '31900000-0000-4000-8000-000000000000', p_group);
$$;
create function pg_temp.versions(p_group uuid, p_target uuid) returns text language sql as $$
  select coalesce(string_agg(coalesce(old_stars::text, '-') || '>' || new_stars || '@' || right(changed_by::text, 2),
    ',' order by id), '') from private.rating_history where group_id = p_group and profile_id = p_target;
$$;

-- ---------------------------------------------------------------------------
-- Permissões: só a organização avalia; os demais, a recusa padrão
-- ---------------------------------------------------------------------------
create temporary table rate_refusals (label text, auth_id uuid, group_id uuid, code text, message text);
insert into rate_refusals values
  ('player', pg_temp.auth('03'), pg_temp.gid('01'), '42501', 'NOT_ORGANIZER'),
  ('former organizer', pg_temp.auth('04'), pg_temp.gid('01'), '42501', 'NOT_MEMBER'),
  ('pending organizer', pg_temp.auth('05'), pg_temp.gid('01'), '42501', 'NOT_MEMBER'),
  ('stranger', pg_temp.auth('06'), pg_temp.gid('01'), '42501', 'NOT_MEMBER'),
  ('owner, unknown group', pg_temp.auth('01'), '31200000-0000-4000-8000-0000000000ff', 'P0002', 'NOT_FOUND');
select throws_ok(format($$select pg_temp.rate(%L, %L, pg_temp.pid('10'), 4)$$, auth_id, group_id),
  code, message, 'rating refused: ' || label) from rate_refusals;
select is((select count(*)::integer from private.ratings), 0, 'no refusal rates anyone');
select is((select count(*)::integer from private.idempotency_records where operation = 'set_rating'),
  0, 'no refusal leaves a ledger row behind');
select throws_ok($$select pg_temp.rate(null, pg_temp.gid('01'), pg_temp.pid('10'), 4)$$,
  '28000', 'UNAUTHENTICATED', 'no actor, no rating');
insert into private.revoked_auth_sessions (session_id, profile_id, expires_at) values
  ('31900000-0000-4000-8000-000000000009', pg_temp.pid('01'), now() + interval '1 hour');
select throws_ok($$select public.set_rating(pg_temp.auth('01'), '31900000-0000-4000-8000-000000000009',
    gen_random_uuid(), repeat('a', 64), 1, 1, pg_temp.gid('01'), pg_temp.pid('10'), 4)$$,
  '28000', 'UNAUTHENTICATED', 'a revoked session cannot rate');
select throws_ok($$select public.get_group_ratings(pg_temp.auth('01'),
    '31900000-0000-4000-8000-000000000009', pg_temp.gid('01'))$$,
  '28000', 'UNAUTHENTICATED', 'nor read the ratings');
update public.groups set suspended_at = now() where id = pg_temp.gid('01');
select throws_ok($$select pg_temp.rate(pg_temp.auth('01'), pg_temp.gid('01'), pg_temp.pid('10'), 4)$$,
  'P0001', 'GROUP_SUSPENDED', 'a suspended group refuses the rating');
update public.groups set suspended_at = null where id = pg_temp.gid('01');
create temporary table bad_stars (n integer, code text, message text);
insert into bad_stars values (0, '22023', 'STARS_RANGE'), (6, '22023', 'STARS_RANGE'),
  (-1, '22023', 'STARS_RANGE'), (null, '22023', 'VALIDATION');
select throws_ok(format($$select pg_temp.rate(null, pg_temp.gid('01'), pg_temp.pid('10'), %s)$$,
    coalesce(n::text, 'null')), code, message,
  coalesce(n::text, 'null') || ' stars is ' || message || ', before the actor') from bad_stars;
-- Alvo: só membro ativo com conta ativa.
update public.profiles set account_status = 'deletion_pending' where id = pg_temp.pid('15');
create temporary table target_refusals (label text, target uuid);
insert into target_refusals values ('former member', pg_temp.pid('04')),
  ('pending member', pg_temp.pid('05')), ('stranger', pg_temp.pid('06')),
  ('account in deletion', pg_temp.pid('15')), ('unknown profile', '31100000-0000-4000-8000-0000000000ff');
select throws_ok(format($$select pg_temp.rate(pg_temp.auth('02'), pg_temp.gid('01'), %L, 3)$$, target),
  'P0001', 'NOT_ACTIVE_MEMBER', 'target refused: ' || label) from target_refusals;

-- ---------------------------------------------------------------------------
-- Escala, histórico, sem mudança e autoavaliação
-- ---------------------------------------------------------------------------
select is((select pg_temp.rate(pg_temp.auth('01'), pg_temp.gid('01'), pg_temp.pid('10'), 4)),
  jsonb_build_object('outcome', jsonb_build_object('group_id', pg_temp.gid('01'),
    'logical_result', 'rating_set', 'profile_id', pg_temp.pid('10')),
    'current', jsonb_build_object('stars', 4)),
  'the owner rates a member: IDs-only outcome, the stars only in current');
select is(pg_temp.versions(pg_temp.gid('01'), pg_temp.pid('10')), '->4@01',
  'the first version has no old value and names the owner');
select is((select pg_temp.rate(pg_temp.auth('02'), pg_temp.gid('01'), pg_temp.pid('10'), 2)
    -> 'outcome' ->> 'logical_result'), 'rating_set', 'an organizer changes it');
select is(pg_temp.versions(pg_temp.gid('01'), pg_temp.pid('10')), '->4@01,4>2@02',
  'the change records from how much to how much, who and when');
select is((select stars::text || '/' || right(updated_by::text, 2) from private.ratings
  where group_id = pg_temp.gid('01') and profile_id = pg_temp.pid('10')), '2/02',
  'the current rating follows the last version');
select is((select pg_temp.rate(pg_temp.auth('01'), pg_temp.gid('01'), pg_temp.pid('10'), 2)
    -> 'outcome' ->> 'logical_result'), 'rating_unchanged', 'the same value again is unchanged');
select is(pg_temp.versions(pg_temp.gid('01'), pg_temp.pid('10')), '->4@01,4>2@02',
  'and writes no version');
select is((select right(updated_by::text, 2) from private.ratings
  where group_id = pg_temp.gid('01') and profile_id = pg_temp.pid('10')), '02',
  'nor changes who changed last');
select is((select pg_temp.rate(pg_temp.auth('02'), pg_temp.gid('01'), pg_temp.pid('02'), 5)
    -> 'outcome' ->> 'logical_result'), 'rating_set', 'an organizer rates themself');
select is(pg_temp.versions(pg_temp.gid('01'), pg_temp.pid('02')), '->5@02',
  'the self-rating stays in the history');
select is((select pg_temp.rate(pg_temp.auth('01'), pg_temp.gid('01'), pg_temp.pid('01'), 3)
    -> 'outcome' ->> 'logical_result'), 'rating_set', 'the owner rates themself');
select pg_temp.rate(pg_temp.auth('01'), pg_temp.gid('01'), pg_temp.pid('03'), 1);
select pg_temp.rate(pg_temp.auth('01'), pg_temp.gid('01'), pg_temp.pid('11'), 5);
select is((select count(*)::integer from private.idempotency_records
  where operation = 'set_rating' and resource_type = 'group'
    and resource_id = pg_temp.gid('01') and state = 'completed'), 7,
  'every rating is a completed ledger row whose resource is the group');
select ok(not exists (select 1 from private.idempotency_records
    where operation = 'set_rating' and outcome::text ~ 'stars'),
  'no ledger row carries the stars');

-- O histórico é append-only, e a nota atual é sempre a da versão apontada.
select throws_ok($$update private.rating_history set new_stars = 3
    where group_id = pg_temp.gid('01') and profile_id = pg_temp.pid('10')$$,
  '23514', 'RATING_HISTORY_APPEND_ONLY', 'a version is never rewritten');
select throws_ok($$update private.ratings set stars = 5
    where group_id = pg_temp.gid('01') and profile_id = pg_temp.pid('10')$$,
  '23514', 'RATING_HISTORY_MISMATCH', 'the current stars cannot drift from their version');
select throws_ok($$insert into private.ratings (group_id, profile_id, current_history_id, stars, updated_by)
    select pg_temp.gid('01'), pg_temp.pid('12'), id, new_stars, changed_by from private.rating_history
    where group_id = pg_temp.gid('01') and profile_id = pg_temp.pid('10') limit 1$$,
  '23514', 'RATING_HISTORY_MISMATCH', 'a current rating cannot point to another member''s version');

-- ---------------------------------------------------------------------------
-- Idempotência: replay, conflito, perda de autoridade
-- ---------------------------------------------------------------------------
select is((select pg_temp.rate(pg_temp.auth('02'), pg_temp.gid('01'), pg_temp.pid('12'), 3,
    '31700000-0000-4000-8000-000000000001', repeat('b', 64)) -> 'outcome' ->> 'logical_result'),
  'rating_set', 'a keyed rating');
select pg_temp.rate(pg_temp.auth('01'), pg_temp.gid('01'), pg_temp.pid('12'), 4);
select is((select pg_temp.rate(pg_temp.auth('02'), pg_temp.gid('01'), pg_temp.pid('12'), 3,
    '31700000-0000-4000-8000-000000000001', repeat('b', 64))),
  jsonb_build_object('outcome', jsonb_build_object('group_id', pg_temp.gid('01'),
    'logical_result', 'rating_set', 'profile_id', pg_temp.pid('12')),
    'current', jsonb_build_object('stars', 4)),
  'the replay returns the stored outcome and the current stars, read fresh');
select is(pg_temp.versions(pg_temp.gid('01'), pg_temp.pid('12')), '->3@02,3>4@01',
  'and writes nothing');
select throws_ok($$select pg_temp.rate(pg_temp.auth('02'), pg_temp.gid('01'), pg_temp.pid('12'), 5,
    '31700000-0000-4000-8000-000000000001', repeat('c', 64))$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'the same request_id with another input conflicts');
update public.group_members set role = 'player'
where group_id = pg_temp.gid('01') and profile_id = pg_temp.pid('02');
select is((select pg_temp.rate(pg_temp.auth('02'), pg_temp.gid('01'), pg_temp.pid('12'), 3,
    '31700000-0000-4000-8000-000000000001', repeat('b', 64))),
  jsonb_build_object('outcome', jsonb_build_object('group_id', pg_temp.gid('01'),
    'logical_result', 'rating_set', 'profile_id', pg_temp.pid('12'))),
  'a demoted organizer keeps the M2-D20 replay: the outcome only, no stars');
select throws_ok($$select pg_temp.rate(pg_temp.auth('02'), pg_temp.gid('01'), pg_temp.pid('12'), 2)$$,
  '42501', 'NOT_ORGANIZER', 'but a new rating is refused');
update public.group_members set role = 'organizer'
where group_id = pg_temp.gid('01') and profile_id = pg_temp.pid('02');

-- ---------------------------------------------------------------------------
-- Leitura: quem vê o quê
-- ---------------------------------------------------------------------------
select is((select jsonb_agg(jsonb_build_object('name', m ->> 'display_name', 'stars', m -> 'stars',
      'by', m -> 'changed_by_name') order by ord)
    from jsonb_array_elements(pg_temp.board(pg_temp.auth('02'), pg_temp.gid('01')) -> 'members')
      with ordinality as x(m, ord)),
  '[{"by": null, "name": "Pessoa 13", "stars": null}, {"by": "Pessoa 02", "name": "Dez", "stars": 2},
    {"by": "Pessoa 01", "name": "Pessoa 01", "stars": 3},
    {"by": "Pessoa 02", "name": "Pessoa 02", "stars": 5}, {"by": "Pessoa 01", "name": "Pessoa 03", "stars": 1},
    {"by": "Pessoa 01", "name": "Pessoa 11", "stars": 5}, {"by": "Pessoa 01", "name": "Pessoa 12", "stars": 4}]'::jsonb,
  'the organizer sees every active member, those without a rating first, with who changed last');
select is((select array_agg(distinct key order by key)
    from jsonb_array_elements(pg_temp.board(pg_temp.auth('01'), pg_temp.gid('01')) -> 'members') as m,
      jsonb_object_keys(m) as key),
  array['changed_at', 'changed_by_name', 'changed_by_removed', 'display_name', 'profile_id', 'stars'],
  'the organization sees who and when, never the history');
select is((select pg_temp.board(pg_temp.auth('01'), pg_temp.gid('01')) - 'members'),
  jsonb_build_object('group_id', pg_temp.gid('01'), 'visibility', 'private', 'can_rate', true,
    'own_stars', 3), 'the owner sees can_rate, the visibility and their own stars');
-- Jogador com notas privadas: só a própria.
select is((select pg_temp.board(pg_temp.auth('03'), pg_temp.gid('01'))),
  jsonb_build_object('group_id', pg_temp.gid('01'), 'visibility', 'private', 'can_rate', false,
    'own_stars', 1, 'members', null),
  'a player with private ratings sees only their own');
select is((pg_temp.board(pg_temp.auth('13'), pg_temp.gid('01')) -> 'own_stars'), 'null'::jsonb,
  'a member without a rating sees none of their own');
-- Visibilidade "membros": as notas atuais dos demais, sem autor nem instante.
update public.groups set ratings_visibility = 'members' where id = pg_temp.gid('01');
select is((select array_agg(distinct key order by key)
    from jsonb_array_elements(pg_temp.board(pg_temp.auth('03'), pg_temp.gid('01')) -> 'members') as m,
      jsonb_object_keys(m) as key),
  array['display_name', 'profile_id', 'stars'],
  'with "members", a player sees the current stars of the others, without who or when');
select is((select count(*)::integer
    from jsonb_array_elements(pg_temp.board(pg_temp.auth('03'), pg_temp.gid('01')) -> 'members')), 7,
  'every active member, the account in deletion left out');
update public.groups set ratings_visibility = 'private' where id = pg_temp.gid('01');
create temporary table read_refusals (label text, auth_id uuid, group_id uuid);
insert into read_refusals values
  ('former organizer', pg_temp.auth('04'), pg_temp.gid('01')),
  ('pending organizer', pg_temp.auth('05'), pg_temp.gid('01')),
  ('stranger', pg_temp.auth('06'), pg_temp.gid('01')),
  ('unknown group', pg_temp.auth('01'), '31200000-0000-4000-8000-0000000000ff');
select throws_ok(format($$select pg_temp.board(%L, %L)$$, auth_id, group_id), '42501', 'NOT_MEMBER',
  'ratings refused like get_group_members: ' || label) from read_refusals;
-- A própria nota, em qualquer visibilidade, também depois de sair.
select is((pg_temp.mine(pg_temp.auth('03'), pg_temp.gid('01')) - 'updated_at' - 'rating_history_id'),
  jsonb_build_object('group_id', pg_temp.gid('01'), 'stars', 1), 'get_my_rating returns the own stars');
select is(((pg_temp.mine(pg_temp.auth('03'), pg_temp.gid('01')) ->> 'rating_history_id')::bigint),
  (select current_history_id from private.ratings
   where group_id = pg_temp.gid('01') and profile_id = pg_temp.pid('03')),
  'and the version a dispute would point to');
update public.group_members set status = 'removed', removed_at = now()
where group_id = pg_temp.gid('01') and profile_id = pg_temp.pid('03');
select is((pg_temp.mine(pg_temp.auth('03'), pg_temp.gid('01')) ->> 'stars'), '1',
  'a member who left still sees their own rating during the retention');
select throws_ok($$select pg_temp.board(pg_temp.auth('03'), pg_temp.gid('01'))$$, '42501', 'NOT_MEMBER',
  'but no longer the group''s ratings');
select is(pg_temp.mine(pg_temp.auth(n), g) - 'group_id',
  jsonb_build_object('stars', null, 'rating_history_id', null, 'updated_at', null),
  'no rating of their own: ' || label)
from (values ('stranger', '06', pg_temp.gid('01')), ('unknown group', '01', '31200000-0000-4000-8000-0000000000ff'::uuid))
  as v(label, n, g);

-- ---------------------------------------------------------------------------
-- Grupo apagado: sem nota, sem leitura, replay recusado
-- ---------------------------------------------------------------------------
select pg_temp.rate(pg_temp.auth('02'), pg_temp.gid('02'), pg_temp.pid('10'), 4,
  '31700000-0000-4000-8000-000000000002', repeat('d', 64));
select public.delete_group(pg_temp.auth('01'), '31900000-0000-4000-8000-000000000000',
  gen_random_uuid(), repeat('a', 64), 1, 1, pg_temp.gid('02'));
select throws_ok($$select pg_temp.rate(pg_temp.auth('02'), pg_temp.gid('02'), pg_temp.pid('10'), 3)$$,
  'P0002', 'GROUP_DELETED', 'a deleted group refuses a new rating (the Edge answers NOT_FOUND)');
select throws_ok($$select pg_temp.rate(pg_temp.auth('02'), pg_temp.gid('02'), pg_temp.pid('10'), 4,
    '31700000-0000-4000-8000-000000000002', repeat('d', 64))$$,
  'P0002', 'GROUP_DELETED', 'and the replay of a rating made before the deletion');
select throws_ok($$select pg_temp.board(pg_temp.auth('02'), pg_temp.gid('02'))$$, '42501', 'NOT_MEMBER',
  'its ratings are not read');
select is((pg_temp.mine(pg_temp.auth('10'), pg_temp.gid('02')) ->> 'stars'), null,
  'and the own rating answers like an unknown group');

-- ---------------------------------------------------------------------------
-- Retenção: purge_ratings, 12 meses depois do fim da aplicação
-- ---------------------------------------------------------------------------
insert into public.group_members (group_id, profile_id, role, status, removed_at) values
  (pg_temp.gid('03'), pg_temp.pid('01'), 'player', 'active', null),
  (pg_temp.gid('03'), pg_temp.pid('10'), 'player', 'active', null),
  (pg_temp.gid('03'), pg_temp.pid('11'), 'player', 'active', null),
  (pg_temp.gid('03'), pg_temp.pid('12'), 'player', 'active', null),
  (pg_temp.gid('03'), pg_temp.pid('13'), 'player', 'active', null),
  (pg_temp.gid('03'), pg_temp.pid('14'), 'player', 'active', null);
select pg_temp.rate(pg_temp.auth('01'), pg_temp.gid('03'), pg_temp.pid(n), 3)
from unnest(array['10', '11', '12', '13', '14']) as n;
select pg_temp.rate(pg_temp.auth('01'), pg_temp.gid('03'), pg_temp.pid('10'), 4);
-- 10 saiu há 13 meses; 11 há 11 meses; 12 teve a membership expurgada; 13 e 14 ativos.
update public.group_members set status = 'removed', removed_at = now() - interval '13 months'
where group_id = pg_temp.gid('03') and profile_id = pg_temp.pid('10');
update public.group_members set status = 'removed', removed_at = now() - interval '11 months'
where group_id = pg_temp.gid('03') and profile_id = pg_temp.pid('11');
delete from public.group_members where group_id = pg_temp.gid('03') and profile_id = pg_temp.pid('12');
create temporary table purge_before as
  select (select count(*) from private.ratings where group_id = pg_temp.gid('01'))::integer as ratings_g1,
         (select count(*) from private.rating_history where group_id = pg_temp.gid('01'))::integer as history_g1;
select is(private.purge_ratings(), jsonb_build_object('scanned', 2, 'purged', 2),
  'the job finds the two ratings past their retention');
select is((select string_agg(right(profile_id::text, 2), ',' order by profile_id) from private.ratings
  where group_id = pg_temp.gid('03')), '11,13,14',
  'left 13 months ago and purged membership go; left 11 months ago and active stay');
select is((select string_agg(distinct right(profile_id::text, 2), ',') from private.rating_history
  where group_id = pg_temp.gid('03') and profile_id in (pg_temp.pid('10'), pg_temp.pid('12'))), null,
  'the history of the purged ratings goes with them, every version');
select is((select count(*)::integer from private.rating_history
  where group_id = pg_temp.gid('03') and profile_id = pg_temp.pid('11')), 1,
  'the kept rating keeps its history');
select is((select ratings_g1 || '/' || history_g1 from purge_before),
  (select (select count(*) from private.ratings where group_id = pg_temp.gid('01'))::text || '/'
    || (select count(*) from private.rating_history where group_id = pg_temp.gid('01'))::text),
  'the other group is untouched (its former member left today)');
-- Grupo encerrado há 13 meses: a nota de quem continuava ativo também sai.
update public.groups set archived_at = now() - interval '13 months' where id = pg_temp.gid('03');
select is((private.purge_ratings() ->> 'purged')::integer, 3,
  'a group closed 13 months ago loses every rating, active members included');
select is((select count(*)::integer from private.ratings where group_id = pg_temp.gid('03')), 0,
  'nothing of it stays');
select is((select policy || ':' || scanned || '/' || purged from private.retention_runs
  where policy = 'purge_ratings' order by id desc limit 1), 'purge_ratings:3/3',
  'each run is recorded in retention_runs');
select is(private.worker_job_slot('purge_ratings', '2026-10-20 05:00:00+00'::timestamptz),
  '2026-10-20 03:53:00+00'::timestamptz, 'the daily slot is the retention one, 03:53 UTC');
select is((select schedule from cron.job where jobname = 'colete_v1_purge_ratings'), '53 3 * * *',
  'the cron runs it daily');

select * from finish();
rollback;
