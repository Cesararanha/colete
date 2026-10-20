begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Tabelas privadas, sem RLS e sem privilégio
-- ---------------------------------------------------------------------------
create temporary table draw_tables (name text);
insert into draw_tables values ('match_draws'), ('match_draw_members');
select has_table('private', name, 'private.' || name || ' exists') from draw_tables;
select ok((select not relrowsecurity and not relforcerowsecurity from pg_class
  where oid = ('private.' || name)::regclass),
  'private.' || name || ' has no RLS, by choice (docs/14 §5.2)') from draw_tables;
select ok((select count(*) from information_schema.table_privileges
    where table_schema = 'private' and table_name = name
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) = 0
  and (select count(*) from information_schema.column_privileges
    where table_schema = 'private' and table_name = name
      and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) = 0,
  'private.' || name || ' is born without any privilege') from draw_tables;
select fk_ok('private', 'match_draws', 'match_id', 'private', 'matches', 'id',
  'a draw belongs to a match');
select fk_ok('private', 'match_draws', 'drawn_by', 'public', 'profiles', 'id',
  'who drew is a profile');
select fk_ok('private', 'match_draw_members', 'draw_id', 'private', 'match_draws', 'id',
  'a member belongs to a draw');
select fk_ok('private', 'match_draw_members', 'profile_id', 'public', 'profiles', 'id',
  'a member is a profile');
select ok(exists (select 1 from pg_constraint
    where conrelid = 'private.match_draws'::regclass and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (match_id)'),
  'one draw per match: only the last one is kept');
select ok((select pg_get_constraintdef(oid) like '%ON DELETE CASCADE%' from pg_constraint
    where conrelid = 'private.match_draw_members'::regclass and contype = 'f'
      and confrelid = 'private.match_draws'::regclass),
  'replacing a draw takes its members with it');
select is((select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'private.match_draws'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%team_count%'),
  'CHECK (((team_count >= 2) AND (team_count <= 4)))', 'two, three or four teams');
select is((select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'private.match_draws'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%algorithm_version%'),
  'CHECK ((algorithm_version = ''snake-v1''::text))', 'the draw records its algorithm version');
select ok(not exists (select 1 from information_schema.columns
    where table_schema = 'private' and table_name in ('match_draws', 'match_draw_members')
      and column_name in ('seed', 'stars', 'rating', 'score')),
  'no seed and no stars are stored: the snake is deterministic and keeps only the rating version');
select ok((select pg_get_constraintdef(oid) like '%REFERENCES private.rating_history(id) ON DELETE SET NULL%'
    from pg_constraint where conrelid = 'private.match_draw_members'::regclass and contype = 'f'
      and confrelid = 'private.rating_history'::regclass),
  'each member keeps the rating version used, cleared when the retention purges it');

-- ---------------------------------------------------------------------------
-- RPCs: assinatura estreita, ACL e modo
-- ---------------------------------------------------------------------------
create temporary table draw_rpc (signature text, mode text);
insert into draw_rpc values
  ('public.draw_teams(uuid,uuid,uuid,text,integer,integer,uuid,integer,boolean)', 'v'),
  ('public.get_match_teams(uuid,uuid,uuid)', 's');
select ok(to_regprocedure(signature) is not null, signature || ' exists') from draw_rpc;
select ok(not has_function_privilege('public', signature, 'execute')
  and not has_function_privilege('anon', signature, 'execute')
  and not has_function_privilege('authenticated', signature, 'execute'),
  'no client role executes ' || signature) from draw_rpc;
select ok(has_function_privilege('service_role', signature, 'execute'),
  'only the nominal service role executes ' || signature) from draw_rpc;
select ok((select prosecdef and provolatile = mode and proconfig = array['search_path=""']
  from pg_proc where oid = to_regprocedure(signature)),
  signature || ' is security definer with fixed search_path and mode ' || mode) from draw_rpc;
select ok((select pg_get_functiondef(oid) like '%private.lock_match_context(%'
  from pg_proc where oid = 'public.draw_teams(uuid,uuid,uuid,text,integer,integer,uuid,integer,boolean)'::regprocedure),
  'draw_teams takes the match lock of join_match and leave_match');
select ok((select position('private.is_group_deleted(' in d) between 1 and position('private.lock_match_context(' in d)
    and position('v_canceled_at is not null' in d) between 1 and position('private.lock_match_context(' in d)
  from (select pg_get_functiondef('public.draw_teams(uuid,uuid,uuid,text,integer,integer,uuid,integer,boolean)'::regprocedure) as d) as f),
  'the deleted group and the canceled match are decided before the match lock');
create temporary table draw_helper (signature text);
insert into draw_helper values
  ('private.draw_match_teams(uuid,uuid,integer,uuid)'),
  ('private.validate_through_ratings_outcome(text,jsonb)');
select ok(not has_function_privilege('service_role', signature, 'execute')
  and not has_function_privilege('authenticated', signature, 'execute'),
  signature || ' is not a gateway routine') from draw_helper;

-- ---------------------------------------------------------------------------
-- Livro de idempotência: desfecho fechado e operações anteriores preservadas
-- ---------------------------------------------------------------------------
select lives_ok($$select private.validate_idempotency_outcome('draw_teams',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"teams_drawn","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  'draw_teams outcome with IDs only is valid');
select throws_ok($$select private.validate_idempotency_outcome('draw_teams',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"teams_drawn","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f","team_count":2}'::jsonb)$$,
  '22023', 'VALIDATION', 'the team count never enters the outcome');
select throws_ok($$select private.validate_idempotency_outcome('draw_teams',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_updated","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  '22023', 'VALIDATION', 'draw_teams has its own closed result');
select lives_ok($$select private.validate_idempotency_outcome('set_rating',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"rating_set","profile_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  'the chain still delegates set_rating');
select lives_ok($$select private.validate_idempotency_outcome('set_group_photo',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_photo_set"}'::jsonb)$$,
  'the chain still delegates the photo operations');
select lives_ok($$select private.validate_idempotency_outcome('cancel_match',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"match_canceled","match_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21f"}'::jsonb)$$,
  'and the match operations');
create temporary table earlier_ops (op text);
insert into earlier_ops values ('complete_profile'), ('delete_account'), ('approve_member'),
  ('leave_group'), ('create_group'), ('join_by_invite'), ('issue_group_invite'),
  ('rename_group'), ('create_match'), ('join_match'), ('leave_match'),
  ('set_match_payment'), ('set_group_appearance'), ('update_match'), ('cancel_match'),
  ('delete_group'), ('begin_photo_upload'), ('set_profile_photo'), ('remove_profile_photo'),
  ('set_group_photo'), ('remove_group_photo'), ('set_rating'), ('draw_teams');
select ok((select pg_get_constraintdef(oid) like '%''' || op || '''%'
  from pg_constraint where conname = 'idempotency_records_operation_check'),
  'the operation list keeps ' || op) from earlier_ops;
create temporary table earlier_results (result text);
insert into earlier_results values ('group_appearance_set'), ('match_updated'),
  ('match_cancel_unchanged'), ('group_deleted'), ('photo_upload_started'),
  ('group_photo_unchanged'), ('rating_set'), ('rating_unchanged'), ('teams_drawn');
select ok((select pg_get_constraintdef(oid) like '%''' || result || '''%'
  from pg_constraint where conname = 'idempotency_records_outcome_code_check'),
  'the outcome list keeps ' || result) from earlier_results;
create temporary table idem_bodies (signature text);
insert into idem_bodies values
  ('private.acquire_group_idempotency(text,text,uuid,text,integer,integer)'),
  ('private.complete_group_idempotency(text,text,uuid,text,integer,integer,jsonb)'),
  ('private.enforce_idempotency_conclusion()');
select ok((select pg_get_functiondef(oid) like '%''draw_teams''%'
    and pg_get_functiondef(oid) like '%''remove_group_photo''%'
    and pg_get_functiondef(oid) like '%''set_rating''%'
    and pg_get_functiondef(oid) like '%''delete_group''%'
    and pg_get_functiondef(oid) like '%''cancel_match''%'
  from pg_proc where oid = to_regprocedure(signature)),
  signature || ' accepts draw_teams and keeps the earlier operations') from idem_bodies;

-- ---------------------------------------------------------------------------
-- Atores, grupos, notas e rachas
-- ---------------------------------------------------------------------------
create function pg_temp.auth(p_n text) returns uuid language sql immutable as $$
  select ('32000000-0000-4000-8000-0000000000' || p_n)::uuid;
$$;
create function pg_temp.pid(p_n text) returns uuid language sql immutable as $$
  select ('32100000-0000-4000-8000-0000000000' || p_n)::uuid;
$$;
create function pg_temp.gid(p_n text) returns uuid language sql immutable as $$
  select ('32200000-0000-4000-8000-0000000000' || p_n)::uuid;
$$;
create function pg_temp.mid(p_n text) returns uuid language sql immutable as $$
  select ('32300000-0000-4000-8000-0000000000' || p_n)::uuid;
$$;
-- 01 dona, 02 organizador, 03 jogador, 04 ex-organizador, 05 organizador
-- pendente, 06 estranho; 10–29 jogadores; 40–52 jogadores dos vetores.
create temporary table everyone as
select n from unnest(array['01','02','03','04','05','06']) as n
union all select lpad(n::text, 2, '0') from generate_series(10, 29) as n
union all select n::text from generate_series(40, 52) as n;
insert into auth.users (id, email)
select pg_temp.auth(n), 'draw32-' || n || '@example.invalid' from everyone;
-- Posições só informativas (D9): 10–13 e 40, 43 dizem "goleiro" no perfil.
insert into public.profiles (id, auth_user_id, name, position, account_status)
select pg_temp.pid(n), pg_temp.auth(n), 'Pessoa ' || n,
  case when n in ('10', '11', '12', '13', '40', '43') then 'goalkeeper'
       when n between '14' and '17' then 'defender'
       when n between '18' and '21' then 'midfielder'
       when n between '22' and '25' then 'forward' end,
  'active'
from everyone;
insert into public.groups (id, name, owner_id) values
  (pg_temp.gid('01'), 'Grupo Sorteio', pg_temp.pid('01')),
  (pg_temp.gid('02'), 'Grupo Apagado', pg_temp.pid('01')),
  (pg_temp.gid('03'), 'Grupo dos Vetores', pg_temp.pid('01'));
insert into public.group_members (group_id, profile_id, role, status, removed_at) values
  (pg_temp.gid('01'), pg_temp.pid('01'), 'player', 'active', null),
  (pg_temp.gid('01'), pg_temp.pid('02'), 'organizer', 'active', null),
  (pg_temp.gid('01'), pg_temp.pid('03'), 'player', 'active', null),
  (pg_temp.gid('01'), pg_temp.pid('04'), 'organizer', 'removed', now()),
  (pg_temp.gid('01'), pg_temp.pid('05'), 'organizer', 'pending', null),
  (pg_temp.gid('02'), pg_temp.pid('01'), 'player', 'active', null),
  (pg_temp.gid('02'), pg_temp.pid('02'), 'organizer', 'active', null),
  (pg_temp.gid('03'), pg_temp.pid('01'), 'player', 'active', null),
  (pg_temp.gid('03'), pg_temp.pid('02'), 'organizer', 'active', null);
insert into public.group_members (group_id, profile_id, role, status)
select pg_temp.gid('01'), pg_temp.pid(lpad(n::text, 2, '0')), 'player', 'active'
from generate_series(10, 29) as n;
insert into public.group_members (group_id, profile_id, role, status)
select pg_temp.gid('02'), pg_temp.pid(lpad(n::text, 2, '0')), 'player', 'active'
from generate_series(10, 13) as n;
insert into public.group_members (group_id, profile_id, role, status)
select pg_temp.gid('03'), pg_temp.pid(n::text), 'player', 'active'
from generate_series(40, 52) as n;

-- Uma nota atual com a sua versão, como set_rating grava.
create function pg_temp.give(p_group uuid, p_n text, p_stars integer) returns void
language plpgsql as $$
declare v_id bigint; v_old smallint;
begin
  select stars into v_old from private.ratings where group_id = p_group and profile_id = pg_temp.pid(p_n);
  insert into private.rating_history (group_id, profile_id, old_stars, new_stars, changed_by, changed_at)
  values (p_group, pg_temp.pid(p_n), v_old, p_stars, pg_temp.pid('01'), now()) returning id into v_id;
  insert into private.ratings (group_id, profile_id, current_history_id, stars, updated_by, updated_at)
  values (p_group, pg_temp.pid(p_n), v_id, p_stars, pg_temp.pid('01'), now())
  on conflict (group_id, profile_id) do update set current_history_id = excluded.current_history_id,
    stars = excluded.stars, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end;
$$;
-- 10–29 do grupo 1: 5, 4, 3, 2, 1, 5, 4, ... ; 29 fica sem nota.
select pg_temp.give(pg_temp.gid('01'), lpad(n::text, 2, '0'), 5 - (n - 10) % 5)
from generate_series(10, 28) as n;
select pg_temp.give(pg_temp.gid('02'), lpad(n::text, 2, '0'), 3) from generate_series(10, 13) as n;
-- Vetores do grupo 3.
select pg_temp.give(pg_temp.gid('03'), v.n, v.stars) from (values
  ('40', 5), ('41', 4), ('42', 3), ('43', 2), ('44', 1), ('45', 5), ('46', 5), ('47', 4),
  ('48', 4), ('49', 3), ('50', 2), ('51', 1), ('52', 3)) as v(n, stars);

-- 01: 12 vagas, 10–21 confirmados, 28 na espera. 02: 16 vagas, 10–25.
-- 03: terminado. 04: para cancelar. 05: 5 vagas, 26–28. 06: 6 vagas, 14–17.
-- 07: no grupo que será apagado. 08: em andamento. 31–34: vetores dourados.
insert into private.matches (id, group_id, starts_at, ends_at, timezone, location_name,
  field_slots, field_price, created_by)
select pg_temp.mid(m.n), m.grp, date_trunc('minute', now()) + m.starts,
  date_trunc('minute', now()) + m.starts + interval '90 minutes', 'America/Sao_Paulo',
  'Arena ' || m.n, m.slots, 15, pg_temp.pid('01')
from (values
  ('01', pg_temp.gid('01'), interval '2 days', 12),
  ('02', pg_temp.gid('01'), interval '2 days', 16),
  ('03', pg_temp.gid('01'), interval '-3 hours', 12),
  ('04', pg_temp.gid('01'), interval '3 days', 12),
  ('05', pg_temp.gid('01'), interval '2 days', 5),
  ('06', pg_temp.gid('01'), interval '2 days', 6),
  ('07', pg_temp.gid('02'), interval '2 days', 6),
  ('08', pg_temp.gid('01'), interval '-30 minutes', 6),
  ('31', pg_temp.gid('03'), interval '2 days', 4),
  ('32', pg_temp.gid('03'), interval '2 days', 5),
  ('33', pg_temp.gid('03'), interval '2 days', 7),
  ('34', pg_temp.gid('03'), interval '2 days', 13)
) as m(n, grp, starts, slots);
create function pg_temp.enlist(p_match text, p_players text[], p_status text default 'starter')
returns void language sql as $$
  insert into private.match_players (match_id, profile_id, status, queue_seq)
  select pg_temp.mid(p_match), pg_temp.pid(p), p_status, nextval('private.match_queue_seq')
  from unnest(p_players) with ordinality as list(p, ord) order by ord;
$$;
select pg_temp.enlist('01', array['10','14','18','22','26','11','15','19','23','27','16','20']);
select pg_temp.enlist('01', array['28'], 'waitlist');
select pg_temp.enlist('02', array['10','11','12','13','14','15','16','17','18','19','20','21',
  '22','23','24','25']);
select pg_temp.enlist('03', array['10','11','14','15']);
select pg_temp.enlist('04', array['10','11','14','15']);
select pg_temp.enlist('05', array['26','27','28']);
select pg_temp.enlist('06', array['14','15','16','17']);
select pg_temp.enlist('07', array['10','11','12','13']);
select pg_temp.enlist('08', array['10','11','14','15']);
select pg_temp.enlist('31', array['43','41','40','42']);
select pg_temp.enlist('32', array['44','43','42','41','40']);
select pg_temp.enlist('33', array['51','50','49','48','47','46','45']);
select pg_temp.enlist('34', array['52','51','50','49','48','47','46','45','44','43','42','41','40']);

-- Chamadas como a Edge faz: transporte interno com HMAC de formato válido.
create function pg_temp.draw(p_auth uuid, p_match uuid, p_count integer,
  p_request uuid default gen_random_uuid(), p_hmac text default repeat('a', 64),
  p_confirm boolean default true) returns jsonb
language sql as $$
  select public.draw_teams(p_auth, '32900000-0000-4000-8000-000000000000', p_request,
    p_hmac, 1, 1, p_match, p_count, p_confirm);
$$;
create function pg_temp.teams(p_auth uuid, p_match uuid) returns jsonb language sql as $$
  select public.get_match_teams(p_auth, '32900000-0000-4000-8000-000000000000', p_match);
$$;
create function pg_temp.leave(p_n text, p_match uuid) returns jsonb language sql as $$
  select public.leave_match(pg_temp.auth(p_n), '32900000-0000-4000-8000-000000000000',
    gen_random_uuid(), repeat('a', 64), 1, 1, p_match);
$$;
create function pg_temp.join(p_n text, p_match uuid) returns jsonb language sql as $$
  select public.join_match(pg_temp.auth(p_n), '32900000-0000-4000-8000-000000000000',
    gen_random_uuid(), repeat('a', 64), 1, 1, p_match);
$$;
-- Os nomes de cada time, como a projeção os devolve.
create function pg_temp.names(p_teams jsonb) returns text language sql as $$
  select string_agg(team ->> 'team_number' || ':' || coalesce((select string_agg(
      player ->> 'name', ',' order by ord) from jsonb_array_elements(team -> 'players')
      with ordinality as p(player, ord)), ''), '|' order by (team ->> 'team_number')::int)
  from jsonb_array_elements(p_teams -> 'teams') as team;
$$;
create function pg_temp.unassigned(p_teams jsonb) returns text language sql as $$
  select coalesce(string_agg(entry ->> 'name', ',' order by ord), '')
  from jsonb_array_elements(p_teams -> 'unassigned') with ordinality as u(entry, ord);
$$;
-- O time de cada um no sorteio gravado: "40:1,41:2,...".
create function pg_temp.placement(p_match uuid) returns text language sql as $$
  select string_agg(right(member.profile_id::text, 2) || ':' || member.team_number, ','
    order by member.profile_id)
  from private.match_draw_members as member
  join private.match_draws as draw on draw.id = member.draw_id
  where draw.match_id = p_match;
$$;

-- As propriedades de um sorteio gravado, conferidas contra os confirmados e as
-- notas do racha, por um oráculo escrito à parte: devolve null quando todas
-- valem, ou a primeira que falhou.
create function pg_temp.draw_defect(p_match uuid, p_count integer) returns text
language plpgsql as $$
declare
  v_draw private.match_draws%rowtype;
  v_group uuid;
  v_n integer;
  v_expected text;
  v_actual text;
  v_sizes integer[];
  v_order uuid[];
  v_seq integer[] := '{}';
  v_pos integer := 0;
  v_dir integer := 1;
  v_fill integer[];
  v_cap integer[];
  v_t integer;
  i integer;
begin
  select * into v_draw from private.match_draws where match_id = p_match;
  if not found or (select count(*) from private.match_draws where match_id = p_match) <> 1 then
    return 'not exactly one draw';
  end if;
  if v_draw.team_count <> p_count or v_draw.algorithm_version <> 'snake-v1' then
    return 'team count or version';
  end if;
  select group_id into v_group from private.matches where id = p_match;
  if exists (select profile_id from private.match_players
             where match_id = p_match and status = 'starter'
             except select profile_id from private.match_draw_members where draw_id = v_draw.id)
     or exists (select profile_id from private.match_draw_members where draw_id = v_draw.id
             except select profile_id from private.match_players
             where match_id = p_match and status = 'starter') then
    return 'members differ from the confirmed';
  end if;
  if exists (select 1 from private.match_draw_members as member
      left join private.ratings as rating
        on rating.group_id = v_group and rating.profile_id = member.profile_id
      where member.draw_id = v_draw.id
        and member.rating_history_id is distinct from rating.current_history_id) then
    return 'the rating version used is not the current one';
  end if;
  select count(*) into v_n from private.match_draw_members where draw_id = v_draw.id;
  -- Picks na ordem (nota desc, UUID asc).
  select array_agg(member.profile_id order by member.pick) into v_actual
  from private.match_draw_members as member where member.draw_id = v_draw.id;
  select array_agg(member.profile_id order by rating.stars desc, member.profile_id) into v_order
  from private.match_draw_members as member
  join private.ratings as rating on rating.group_id = v_group and rating.profile_id = member.profile_id
  where member.draw_id = v_draw.id;
  if v_actual::text is distinct from v_order::text then
    return 'picks are not in (stars desc, uuid asc) order';
  end if;
  -- balanced_sizes, na ordem dos times.
  select array_agg(coalesce(size, 0) order by team) into v_sizes
  from generate_series(1, p_count) as team
  left join (select team_number, count(*)::integer as size from private.match_draw_members
             where draw_id = v_draw.id group by team_number) as counted on counted.team_number = team;
  select array_agg(case when t <= v_n % p_count then v_n / p_count + 1 else v_n / p_count end order by t)
  into v_cap from generate_series(1, p_count) as t;
  if v_sizes <> v_cap then
    return 'sizes ' || array_to_string(v_sizes, ',') || ' are not balanced_sizes';
  end if;
  -- Serpentina com extremos repetidos e time cheio pulado, simulada aqui.
  v_fill := array_fill(0, array[p_count]);
  for i in 1..v_n loop
    loop
      v_t := v_pos;
      if v_dir = 1 then
        if v_pos = p_count - 1 then v_dir := -1; else v_pos := v_pos + 1; end if;
      else
        if v_pos = 0 then v_dir := 1; else v_pos := v_pos - 1; end if;
      end if;
      exit when v_fill[v_t + 1] < v_cap[v_t + 1];
    end loop;
    v_fill[v_t + 1] := v_fill[v_t + 1] + 1;
    v_seq := v_seq || (v_t + 1);
  end loop;
  select array_agg(team_number::integer order by pick)::text into v_expected
  from private.match_draw_members where draw_id = v_draw.id;
  if v_expected <> v_seq::text then
    return 'teams by pick ' || v_expected || ' are not the snake ' || v_seq::text;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permissões: só quem cria racha sorteia; os demais, a recusa padrão
-- ---------------------------------------------------------------------------
create temporary table draw_refusals (label text, auth_id uuid, match_id uuid, code text, message text);
insert into draw_refusals values
  ('player', pg_temp.auth('03'), pg_temp.mid('01'), '42501', 'NOT_ORGANIZER'),
  ('confirmed player', pg_temp.auth('10'), pg_temp.mid('01'), '42501', 'NOT_ORGANIZER'),
  ('former organizer', pg_temp.auth('04'), pg_temp.mid('01'), 'P0002', 'NOT_FOUND'),
  ('pending organizer', pg_temp.auth('05'), pg_temp.mid('01'), 'P0002', 'NOT_FOUND'),
  ('stranger', pg_temp.auth('06'), pg_temp.mid('01'), 'P0002', 'NOT_FOUND'),
  ('owner, unknown match', pg_temp.auth('01'), '32300000-0000-4000-8000-0000000000ff', 'P0002', 'NOT_FOUND');
select throws_ok(format($$select pg_temp.draw(%L, %L, 2)$$, auth_id, match_id), code, message,
  'draw refused: ' || label)
from draw_refusals;
select is((select count(*)::integer from private.match_draws), 0, 'no refusal draws anything');
select is((select count(*)::integer from private.idempotency_records where operation = 'draw_teams'),
  0, 'no refusal leaves a ledger row behind');
select throws_ok($$select pg_temp.draw(null, pg_temp.mid('01'), 2)$$,
  '28000', 'UNAUTHENTICATED', 'no actor, no draw');
insert into private.revoked_auth_sessions (session_id, profile_id, expires_at) values
  ('32900000-0000-4000-8000-000000000009', pg_temp.pid('01'), now() + interval '1 hour');
select throws_ok($$select public.draw_teams(pg_temp.auth('01'),
    '32900000-0000-4000-8000-000000000009', gen_random_uuid(), repeat('a', 64), 1, 1,
    pg_temp.mid('01'), 2, false)$$, '28000', 'UNAUTHENTICATED', 'a revoked session cannot draw');
select throws_ok($$select public.get_match_teams(pg_temp.auth('01'),
    '32900000-0000-4000-8000-000000000009', pg_temp.mid('01'))$$,
  '28000', 'UNAUTHENTICATED', 'nor read the teams');
update public.groups set suspended_at = now() where id = pg_temp.gid('01');
select throws_ok($$select pg_temp.draw(pg_temp.auth('01'), pg_temp.mid('01'), 2)$$,
  'P0001', 'GROUP_SUSPENDED', 'a suspended group refuses the draw');
update public.groups set suspended_at = null where id = pg_temp.gid('01');
create temporary table bad_counts (n integer);
insert into bad_counts values (null), (0), (1), (5), (8);
select throws_ok(format($$select pg_temp.draw(null, pg_temp.mid('01'), %s)$$,
    coalesce(n::text, 'null')), '22023', 'VALIDATION',
  'team count ' || coalesce(n::text, 'null') || ' is VALIDATION, before the actor')
from bad_counts;
select throws_ok($$select pg_temp.draw(null, pg_temp.mid('01'), 2, gen_random_uuid(),
    repeat('a', 64), null)$$, '22023', 'VALIDATION',
  'a missing unequal-sizes confirmation is VALIDATION, before the actor');

-- ---------------------------------------------------------------------------
-- Mínimo de 2 por time, nota obrigatória e tamanhos diferentes confirmados
-- ---------------------------------------------------------------------------
select throws_ok($$select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('05'), 2)$$,
  'P0001', 'TEAM_SIZE_INVALID', 'three confirmed cannot make two teams');
select pg_temp.join('29', pg_temp.mid('05'));
select throws_ok($$select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('05'), 2)$$,
  'P0001', 'RATINGS_MISSING', 'a confirmed player without a rating blocks the draw, no default');
select is((select count(*)::integer from private.match_draws where match_id = pg_temp.mid('05')), 0,
  'and nothing is drawn');
select pg_temp.give(pg_temp.gid('01'), '29', 2);
select is((select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('05'), 2) -> 'outcome'),
  jsonb_build_object('group_id', pg_temp.gid('01'),
    'logical_result', 'teams_drawn', 'match_id', pg_temp.mid('05')),
  'once rated, four confirmed make two teams; the organizer gets the IDs-only outcome');
select is(pg_temp.draw_defect(pg_temp.mid('05'), 2), null, 'two teams of two, by the snake');
select throws_ok($$select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('05'), 3)$$,
  'P0001', 'TEAM_SIZE_INVALID', 'four confirmed cannot make three teams');
select is((select team_count from private.match_draws where match_id = pg_temp.mid('05')),
  2::smallint, 'the refused redraw keeps the current draw');
select throws_ok($$select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('32'), 2, gen_random_uuid(),
    repeat('a', 64), false)$$, 'P0001', 'UNEQUAL_TEAMS_CONFIRMATION_REQUIRED',
  'five confirmed in two teams need the unequal-sizes confirmation (docs/01 §5.7)');
select is((select team_count from private.match_draws where match_id = pg_temp.mid('32')), null,
  'without it nothing is drawn');
select is((select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('31'), 2, gen_random_uuid(),
    repeat('a', 64), false) -> 'outcome' ->> 'logical_result'), 'teams_drawn',
  'equal sizes need no confirmation');

-- ---------------------------------------------------------------------------
-- Vetores dourados da serpentina (D63-A; docs/04 §§2 e 6)
-- ---------------------------------------------------------------------------
-- 31: notas 5, 4, 3, 2 em dois times: 1º no A, 2º e 3º no B, 4º no A. Os
-- dois "goleiros" do perfil (40 e 43) caem no mesmo time: sem lista de
-- goleiros (D8), a posição não conta.
select is(pg_temp.placement(pg_temp.mid('31')), '40:1,41:2,42:2,43:1',
  'notes 5,4,3,2: A, B, B, A — the D63-A example');
select is((select count(*)::integer from private.match_draw_members as member
    join private.match_draws as draw on draw.id = member.draw_id
    where draw.match_id = pg_temp.mid('31') and member.team_number = 1
      and member.profile_id in (pg_temp.pid('40'), pg_temp.pid('43'))), 2,
  'the two profiles that say "goalkeeper" share a team: position never enters the draw (D8, D9)');
-- 32: cinco em dois times, confirmados: quem sobra vai para o Time A.
select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('32'), 2);
select is(pg_temp.placement(pg_temp.mid('32')), '40:1,41:2,42:2,43:1,44:1',
  'notes 5,4,3,2,1: A, B, B, A, A — the extra player goes to the first team');
-- 33: empates por UUID crescente; sete em três times, 3, 2 e 2.
select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('33'), 3);
select is(pg_temp.placement(pg_temp.mid('33')), '45:1,46:2,47:3,48:3,49:2,50:1,51:1',
  'ties ordered by UUID: 45 before 46, both with 5 stars; 3, 2 and 2');
-- 34: treze em quatro times, 4, 3, 3 e 3: a quarta volta pula os times cheios.
select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('34'), 4);
select is((select string_agg(team_number::text, '' order by pick) from private.match_draw_members as member
    join private.match_draws as draw on draw.id = member.draw_id where draw.match_id = pg_temp.mid('34')),
  '1234432112341', 'thirteen in four: the last pick skips the full teams back to A');
select is(pg_temp.placement(pg_temp.mid('34')),
  '40:1,41:4,42:2,43:2,44:4,45:2,46:3,47:4,48:3,49:1,50:3,51:1,52:1',
  'every player of the thirteen in its team');
select is(pg_temp.draw_defect(pg_temp.mid(n), k), null, 'vector ' || n || ' holds every property')
from (values ('31', 2), ('32', 2), ('33', 3), ('34', 4)) as v(n, k);

-- ---------------------------------------------------------------------------
-- Determinismo e propriedades em toda forma
-- ---------------------------------------------------------------------------
create temporary table draw_runs (label text, match_n text, team_count integer, defect text,
  placement text);
do $$
declare
  v_case record;
  v_run integer;
begin
  for v_case in select * from (values
      ('12 confirmed, 2 teams', '01', 2), ('12 confirmed, 3 teams', '01', 3),
      ('12 confirmed, 4 teams', '01', 4), ('16 confirmed, 4 teams', '02', 4),
      ('16 confirmed, 3 teams', '02', 3), ('16 confirmed, 2 teams', '02', 2),
      ('4 confirmed, in progress, 2 teams', '08', 2)) as c(label, match_n, team_count) loop
    for v_run in 1..3 loop
      perform pg_temp.draw(pg_temp.auth('02'), pg_temp.mid(v_case.match_n), v_case.team_count);
      insert into draw_runs values (v_case.label, v_case.match_n, v_case.team_count,
        pg_temp.draw_defect(pg_temp.mid(v_case.match_n), v_case.team_count),
        pg_temp.placement(pg_temp.mid(v_case.match_n)));
    end loop;
  end loop;
end;
$$;
select is((select string_agg(distinct defect, '; ') from draw_runs where label = c.label), null,
  c.label || ': the confirmed once, by (stars desc, uuid asc), balanced_sizes, dealt as the snake')
from (select distinct label from draw_runs) as c;
select is((select count(distinct placement)::integer from draw_runs where label = c.label), 1,
  c.label || ': three draws give the same teams — no seed, nothing random')
from (select distinct label from draw_runs) as c;

-- ---------------------------------------------------------------------------
-- Só o último sorteio vale
-- ---------------------------------------------------------------------------
select pg_temp.draw(pg_temp.auth('01'), pg_temp.mid('01'), 2);
create temporary table first_draw as
  select draw.id from private.match_draws as draw where draw.match_id = pg_temp.mid('01');
select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('01'), 3);
select is((select count(*)::integer from private.match_draws where match_id = pg_temp.mid('01')), 1,
  'drawing again keeps one draw for the match');
select ok(not exists (select 1 from private.match_draws where id = (select id from first_draw))
  and not exists (select 1 from private.match_draw_members where draw_id = (select id from first_draw)),
  'the earlier draw and its members are gone');
select is((select (pg_temp.teams(pg_temp.auth('03'), pg_temp.mid('01')) ->> 'team_count')::integer), 3,
  'every member reads the last draw: three teams');
select is((select count(*)::integer from private.idempotency_records
  where operation = 'draw_teams' and resource_type = 'group' and state = 'completed'
    and outcome_code = 'teams_drawn'),
  (select count(*)::integer from private.idempotency_records where operation = 'draw_teams'),
  'every draw is a completed ledger row whose resource is a group');

-- ---------------------------------------------------------------------------
-- Leitura: todo membro ativo vê os mesmos times; ninguém vê notas
-- ---------------------------------------------------------------------------
create temporary table readings (label text, auth_id uuid, answer jsonb);
insert into readings select 'owner', pg_temp.auth('01'), pg_temp.teams(pg_temp.auth('01'), pg_temp.mid('01'));
insert into readings select 'organizer', pg_temp.auth('02'), pg_temp.teams(pg_temp.auth('02'), pg_temp.mid('01'));
insert into readings select 'player out of the list', pg_temp.auth('03'), pg_temp.teams(pg_temp.auth('03'), pg_temp.mid('01'));
insert into readings select 'confirmed player', pg_temp.auth('10'), pg_temp.teams(pg_temp.auth('10'), pg_temp.mid('01'));
select is(pg_temp.names(answer), (select pg_temp.names(answer) from readings where label = 'owner'),
  label || ' sees the same teams, in the same order') from readings;
select is((answer ->> 'can_draw')::boolean, label in ('owner', 'organizer'),
  label || ': can_draw only for whoever may create matches') from readings;
select is((select array_agg(key order by key) from jsonb_object_keys(answer) as key),
  array['can_draw', 'match_id', 'stale', 'team_count', 'teams', 'unassigned'],
  label || ': the projection has no author, time, version or rating') from readings;
select is((select array_agg(distinct key order by key) from jsonb_array_elements(answer -> 'teams') as team,
    jsonb_array_elements(team -> 'players') as player, jsonb_object_keys(player) as key),
  array['account_removed', 'is_viewer', 'name', 'nickname', 'position', 'profile_id'],
  label || ': each player line has only the roster fields') from readings;
-- Dentro de cada time, por nome: a ordem da serpentina diria a ordem das notas.
select ok((select bool_and(ordered) from (
    select (select array_agg(player ->> 'name' order by ord) from jsonb_array_elements(team -> 'players')
        with ordinality as p(player, ord))
      = (select array_agg(player ->> 'name' order by lower(player ->> 'name'))
         from jsonb_array_elements(team -> 'players') as player) as ordered
    from jsonb_array_elements((select answer from readings where label = 'confirmed player') -> 'teams') as team) as t),
  'players come by name inside each team, never in the order of the ratings');
create temporary table read_refusals (label text, auth_id uuid, match_id uuid);
insert into read_refusals values
  ('former organizer', pg_temp.auth('04'), pg_temp.mid('01')),
  ('pending organizer', pg_temp.auth('05'), pg_temp.mid('01')),
  ('stranger', pg_temp.auth('06'), pg_temp.mid('01')),
  ('stranger, unknown match', pg_temp.auth('06'), '32300000-0000-4000-8000-0000000000ff'),
  ('owner, unknown match', pg_temp.auth('01'), '32300000-0000-4000-8000-0000000000ff');
select throws_ok(format($$select pg_temp.teams(%L, %L)$$, auth_id, match_id), 'P0002', 'NOT_FOUND',
  'reading refused like an unknown match: ' || label) from read_refusals;
select is((select pg_temp.teams(pg_temp.auth('01'), pg_temp.mid('06'))),
  jsonb_build_object('match_id', pg_temp.mid('06'), 'can_draw', true, 'team_count', null,
    'stale', false, 'teams', '[]'::jsonb, 'unassigned', '[]'::jsonb),
  'before any draw: no teams, and the organizer may draw');
update public.profiles set account_status = 'deletion_pending' where id = pg_temp.pid('11');
select is((select player from jsonb_array_elements(pg_temp.teams(pg_temp.auth('01'), pg_temp.mid('01')) -> 'teams') as team,
    jsonb_array_elements(team -> 'players') as player
    where (player ->> 'account_removed')::boolean),
  jsonb_build_object('profile_id', null, 'name', null, 'nickname', null, 'position', null,
    'account_removed', true, 'is_viewer', false),
  'an account in deletion shows in its team without identity, like the roster');
update public.profiles set account_status = 'active' where id = pg_temp.pid('11');

-- ---------------------------------------------------------------------------
-- Times desatualizados: confirmar, desistir, subir da espera e mudar nota
-- ---------------------------------------------------------------------------
select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('06'), 2);
select is((pg_temp.teams(pg_temp.auth('03'), pg_temp.mid('06')) ->> 'stale')::boolean, false,
  'a fresh draw is not stale');
-- Uma nota alterada depois do sorteio: a organização vê desatualizado; o
-- jogador não fica sabendo que uma nota mudou.
select pg_temp.give(pg_temp.gid('01'), '15', 1);
select is((pg_temp.teams(pg_temp.auth('02'), pg_temp.mid('06')) ->> 'stale')::boolean, true,
  'a rating changed after the draw makes it stale for the organization');
select is((pg_temp.teams(pg_temp.auth('03'), pg_temp.mid('06')) ->> 'stale')::boolean, false,
  'but not for a player: a rating change is never revealed');
select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('06'), 2);
select is((pg_temp.teams(pg_temp.auth('02'), pg_temp.mid('06')) ->> 'stale')::boolean, false,
  'drawing again uses the new rating');
select pg_temp.join('18', pg_temp.mid('06'));
select is((pg_temp.teams(pg_temp.auth('03'), pg_temp.mid('06')) ->> 'stale')::boolean, true,
  'a new confirmation makes the teams stale');
select is(pg_temp.unassigned(pg_temp.teams(pg_temp.auth('03'), pg_temp.mid('06'))), 'Pessoa 18',
  'the one who confirmed after the draw is without a team');
select pg_temp.leave('14', pg_temp.mid('06'));
select ok(pg_temp.names(pg_temp.teams(pg_temp.auth('03'), pg_temp.mid('06'))) not like '%Pessoa 14%'
  and (pg_temp.teams(pg_temp.auth('03'), pg_temp.mid('06')) ->> 'stale')::boolean,
  'whoever gave up leaves the teams, which stay stale');
-- 01 está lotado com 28 na espera: quem desiste dá a vaga a 28.
select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('01'), 2);
select pg_temp.leave('22', pg_temp.mid('01'));
select ok((pg_temp.teams(pg_temp.auth('03'), pg_temp.mid('01')) ->> 'stale')::boolean
  and pg_temp.unassigned(pg_temp.teams(pg_temp.auth('03'), pg_temp.mid('01'))) = 'Pessoa 28'
  and pg_temp.names(pg_temp.teams(pg_temp.auth('03'), pg_temp.mid('01'))) not like '%Pessoa 22%',
  'promoted from the waitlist: stale, the promoted without a team, the leaver gone');

-- ---------------------------------------------------------------------------
-- Idempotência: replay sem novo sorteio, conflito, perda de autoridade
-- ---------------------------------------------------------------------------
select is((select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('02'), 4,
    '32700000-0000-4000-8000-000000000001', repeat('b', 64)) -> 'outcome' ->> 'logical_result'),
  'teams_drawn', 'a keyed draw');
create temporary table keyed_draw as
  select id from private.match_draws where match_id = pg_temp.mid('02');
select is((select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('02'), 4,
    '32700000-0000-4000-8000-000000000001', repeat('b', 64))),
  jsonb_build_object('outcome', jsonb_build_object('group_id', pg_temp.gid('01'),
    'logical_result', 'teams_drawn', 'match_id', pg_temp.mid('02'))),
  'the same request_id replays the outcome only');
select is((select id from private.match_draws where match_id = pg_temp.mid('02')),
  (select id from keyed_draw), 'and does not draw again');
select throws_ok($$select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('02'), 3,
    '32700000-0000-4000-8000-000000000001', repeat('c', 64))$$,
  'P0001', 'IDEMPOTENCY_CONFLICT', 'the same request_id with another input conflicts');
update public.group_members set role = 'player'
where group_id = pg_temp.gid('01') and profile_id = pg_temp.pid('02');
select is((select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('02'), 4,
    '32700000-0000-4000-8000-000000000001', repeat('b', 64))),
  jsonb_build_object('outcome', jsonb_build_object('group_id', pg_temp.gid('01'),
    'logical_result', 'teams_drawn', 'match_id', pg_temp.mid('02'))),
  'a demoted organizer keeps the M2-D20 replay: the outcome only');
select throws_ok($$select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('02'), 4)$$,
  '42501', 'NOT_ORGANIZER', 'but a new draw is refused');
update public.group_members set role = 'organizer'
where group_id = pg_temp.gid('01') and profile_id = pg_temp.pid('02');

-- ---------------------------------------------------------------------------
-- Racha cancelado: sem times e sem sorteio, inclusive o replay
-- ---------------------------------------------------------------------------
select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('04'), 2,
  '32700000-0000-4000-8000-000000000004', repeat('d', 64));
select is((select jsonb_array_length(pg_temp.teams(pg_temp.auth('03'), pg_temp.mid('04')) -> 'teams')), 2,
  'before the cancellation the teams show');
select public.cancel_match(pg_temp.auth('01'), '32900000-0000-4000-8000-000000000000',
  gen_random_uuid(), repeat('a', 64), 1, 1, pg_temp.mid('04'));
select is(pg_temp.teams(pg_temp.auth(n), pg_temp.mid('04')),
  jsonb_build_object('match_id', pg_temp.mid('04'), 'can_draw', false, 'team_count', null,
    'stale', false, 'teams', '[]'::jsonb, 'unassigned', '[]'::jsonb),
  'canceled: no teams for ' || n)
from unnest(array['01', '03']) as n;
select throws_ok($$select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('04'), 2)$$,
  'P0001', 'MATCH_CANCELED', 'a canceled match refuses a new draw');
select throws_ok($$select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('04'), 2,
    '32700000-0000-4000-8000-000000000004', repeat('d', 64))$$,
  'P0001', 'MATCH_CANCELED', 'and the replay of a draw made before the cancellation');
select throws_ok($$select pg_temp.draw(pg_temp.auth('03'), pg_temp.mid('04'), 2)$$,
  '42501', 'NOT_ORGANIZER', 'a player still gets NOT_ORGANIZER on a canceled match');
select throws_ok(format($$select pg_temp.draw(%L, pg_temp.mid('04'), 2)$$, pg_temp.auth(n)),
  'P0002', 'NOT_FOUND', 'and ' || n || ' the NOT_FOUND of an unknown match')
from unnest(array['04', '06']) as n;

-- ---------------------------------------------------------------------------
-- Racha terminado: sem sorteio, inclusive o replay
-- ---------------------------------------------------------------------------
select throws_ok($$select pg_temp.draw(pg_temp.auth('01'), pg_temp.mid('03'), 2)$$,
  'P0001', 'MATCH_DONE', 'a finished match refuses the draw');
select is((pg_temp.teams(pg_temp.auth('01'), pg_temp.mid('03')) ->> 'can_draw')::boolean, false,
  'and does not offer it');
select pg_temp.draw(pg_temp.auth('01'), pg_temp.mid('08'), 2,
  '32700000-0000-4000-8000-000000000008', repeat('e', 64));
update private.matches set starts_at = now() - interval '3 hours', ends_at = now() - interval '1 minute'
where id = pg_temp.mid('08');
select throws_ok($$select pg_temp.draw(pg_temp.auth('01'), pg_temp.mid('08'), 2,
    '32700000-0000-4000-8000-000000000008', repeat('e', 64))$$,
  'P0001', 'MATCH_DONE', 'the replay of a draw made while it was in progress is refused once it ends');
select is((select jsonb_array_length(pg_temp.teams(pg_temp.auth('03'), pg_temp.mid('08')) -> 'teams')), 2,
  'the teams of a finished match stay visible as history');

-- ---------------------------------------------------------------------------
-- Grupo apagado: sem times e sem sorteio, inclusive o replay
-- ---------------------------------------------------------------------------
select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('07'), 2,
  '32700000-0000-4000-8000-000000000007', repeat('f', 64));
select public.delete_group(pg_temp.auth('01'), '32900000-0000-4000-8000-000000000000',
  gen_random_uuid(), repeat('a', 64), 1, 1, pg_temp.gid('02'));
select throws_ok($$select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('07'), 2)$$,
  'P0002', 'GROUP_DELETED', 'a deleted group refuses a new draw (the Edge answers NOT_FOUND)');
select throws_ok($$select pg_temp.draw(pg_temp.auth('02'), pg_temp.mid('07'), 2,
    '32700000-0000-4000-8000-000000000007', repeat('f', 64))$$,
  'P0002', 'GROUP_DELETED', 'and the replay of a draw made before the deletion');
select throws_ok(format($$select pg_temp.teams(%L, pg_temp.mid('07'))$$, pg_temp.auth(n)),
  'P0002', 'GROUP_DELETED', 'the teams of a deleted group are not read by ' || n)
from unnest(array['01', '02', '10']) as n;
select is((select state from private.idempotency_records
  where request_id = '32700000-0000-4000-8000-000000000007'), 'completed',
  'the refused replay keeps the completed ledger record');

-- ---------------------------------------------------------------------------
-- Retenção: o expurgo das notas apaga a versão usada, não o sorteio
-- ---------------------------------------------------------------------------
update public.group_members set status = 'removed', removed_at = now() - interval '13 months'
where group_id = pg_temp.gid('03') and profile_id = pg_temp.pid('44');
select private.purge_ratings();
select is((select rating_history_id from private.match_draw_members as member
    join private.match_draws as draw on draw.id = member.draw_id
    where draw.match_id = pg_temp.mid('32') and member.profile_id = pg_temp.pid('44')), null,
  'a purged rating leaves the drawn member without its version');
select is(pg_temp.placement(pg_temp.mid('32')), '40:1,41:2,42:2,43:1,44:1',
  'and the composition stays, without the rating');

select * from finish();
rollback;
