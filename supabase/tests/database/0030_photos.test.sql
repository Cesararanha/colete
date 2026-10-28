begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Buckets privados, com tipo e tamanho no próprio Storage
-- ---------------------------------------------------------------------------
select results_eq(
  $$select id, public::text, file_size_limit::text, allowed_mime_types::text
    from storage.buckets where id in ('avatars', 'group-photos') order by id$$,
  $$values ('avatars'::text, 'false'::text, '1048576'::text, '{image/jpeg}'::text),
           ('group-photos', 'false', '1048576', '{image/jpeg}')$$,
  'both photo buckets are private, JPEG only, at most 1 MB');
select is(
  (select count(*) from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and (coalesce(qual, '') ~ '(avatars|group-photos)'
          or coalesce(with_check, '') ~ '(avatars|group-photos)')),
  0::bigint,
  'no client policy reads or writes a photo object');

-- ---------------------------------------------------------------------------
-- Tabela privada de serviço: sem RLS, sem privilégio de papel algum
-- ---------------------------------------------------------------------------
select ok((select not relrowsecurity and not relforcerowsecurity
  from pg_class where oid = 'private.photo_uploads'::regclass),
  'photo_uploads is a private service table without RLS, by decision (docs/14 §5.2)');
select ok(not has_table_privilege('anon', 'private.photo_uploads', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('authenticated', 'private.photo_uploads', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('service_role', 'private.photo_uploads', 'SELECT,INSERT,UPDATE,DELETE'),
  'no role reads or writes photo_uploads directly, service_role included');
select ok(not has_column_privilege('authenticated', 'public.groups', 'photo_url', 'SELECT'),
  'a member never reads the group photo locator');

-- ---------------------------------------------------------------------------
-- RPCs: assinatura estreita, ACL e modo
-- ---------------------------------------------------------------------------
create temporary table photo_routines (signature text, volatility "char");
insert into photo_routines values
  ('public.begin_photo_upload(uuid,uuid,uuid,text,integer,integer,text,uuid)', 'v'),
  ('public.set_profile_photo(uuid,uuid,uuid,text,integer,integer,uuid)', 'v'),
  ('public.remove_profile_photo(uuid,uuid,uuid,text,integer,integer)', 'v'),
  ('public.set_group_photo(uuid,uuid,uuid,text,integer,integer,uuid,uuid)', 'v'),
  ('public.remove_group_photo(uuid,uuid,uuid,text,integer,integer,uuid)', 'v'),
  ('public.get_photo_upload_target(uuid,uuid,uuid)', 's'),
  ('public.get_visible_photos(uuid,uuid,uuid[],uuid[],boolean)', 'v');
select ok(
  not has_function_privilege('public', signature, 'execute')
  and not has_function_privilege('anon', signature, 'execute')
  and not has_function_privilege('authenticated', signature, 'execute')
  and has_function_privilege('service_role', signature, 'execute'),
  signature || ': only the nominal service role executes it')
from photo_routines;
select ok((select prosecdef and provolatile = r.volatility and proconfig = array['search_path=""']
  from pg_proc where oid = r.signature::regprocedure),
  r.signature || ': security definer, expected volatility, fixed search_path')
from photo_routines r;
select ok(
  not has_function_privilege('service_role', 'private.retire_photo_object(text,uuid,uuid,text)', 'execute')
  and not has_function_privilege('service_role', 'private.reclaim_photo_uploads()', 'execute'),
  'the internal helpers are not reachable from the gateway key');

-- ---------------------------------------------------------------------------
-- Livro de idempotência: listas fechadas preservadas e desfechos só com IDs
-- ---------------------------------------------------------------------------
select ok((select count(*) = 6 from private.idempotency_operations where operation in ('delete_group', 'set_group_appearance', 'cancel_match', 'request_data_export', 'begin_photo_upload', 'remove_group_photo')),
  'every existing operation stays in the registry, and the five photo operations are in it');
select ok((select count(distinct logical_result) = 4 from private.idempotency_operation_results where logical_result in ('group_deleted', 'group_appearance_set', 'photo_upload_started', 'group_photo_unchanged')),
  'every existing outcome stays in the registry, and the photo outcomes are in it');
select lives_ok($$select private.validate_idempotency_outcome('begin_photo_upload',
  '{"upload_id":"30c00001-0000-4000-8000-000000000000","logical_result":"photo_upload_started"}'::jsonb)$$,
  'a session outcome holds only its ID');
select throws_ok($$select private.validate_idempotency_outcome('begin_photo_upload',
  '{"upload_id":"30c00001-0000-4000-8000-000000000000","logical_result":"photo_upload_started","path":"a/b.jpg"}'::jsonb)$$,
  '22023', 'VALIDATION', 'a path cannot be stored in the outcome');
select throws_ok($$select private.validate_idempotency_outcome('set_group_photo',
  '{"group_id":"30b00001-0000-4000-8000-000000000000","logical_result":"profile_photo_set"}'::jsonb)$$,
  '22023', 'VALIDATION', 'the logical result belongs to its operation');
select throws_ok($$select private.validate_idempotency_outcome('remove_profile_photo',
  '{"profile_id":"30A00001-0000-4000-8000-000000000000","logical_result":"profile_photo_removed"}'::jsonb)$$,
  '22023', 'VALIDATION', 'the profile ID is canonical lowercase');
select lives_ok($$select private.validate_idempotency_outcome('delete_group',
  '{"group_id":"30b00001-0000-4000-8000-000000000000","logical_result":"group_deleted"}'::jsonb)$$,
  'the chain still delegates delete_group (0029)');

-- ---------------------------------------------------------------------------
-- Atores
-- ---------------------------------------------------------------------------
-- Dona e organizadora do grupo vivo; jogador; pendente; estranha; ex-colega
-- que só divide um grupo apagado com o jogador.
insert into auth.users (id, email) values
  ('30000000-0000-4000-8000-000000000001', 'photo30-owner@example.invalid'),
  ('30000000-0000-4000-8000-000000000002', 'photo30-organizer@example.invalid'),
  ('30000000-0000-4000-8000-000000000003', 'photo30-player@example.invalid'),
  ('30000000-0000-4000-8000-000000000004', 'photo30-pending@example.invalid'),
  ('30000000-0000-4000-8000-000000000005', 'photo30-stranger@example.invalid'),
  ('30000000-0000-4000-8000-000000000006', 'photo30-former@example.invalid');
insert into public.profiles (id, auth_user_id, name, account_status) values
  ('30100000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'Dona', 'active'),
  ('30100000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', 'Org', 'active'),
  ('30100000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000003', 'Jogador', 'active'),
  ('30100000-0000-4000-8000-000000000004', '30000000-0000-4000-8000-000000000004', 'Pendente', 'active'),
  ('30100000-0000-4000-8000-000000000005', '30000000-0000-4000-8000-000000000005', 'Fora', 'active'),
  ('30100000-0000-4000-8000-000000000006', '30000000-0000-4000-8000-000000000006', 'Antiga', 'active');
insert into public.groups (id, name, owner_id) values
  ('30200000-0000-4000-8000-000000000001', 'Grupo Foto', '30100000-0000-4000-8000-000000000001'),
  ('30200000-0000-4000-8000-000000000002', 'Grupo Apagado', '30100000-0000-4000-8000-000000000006');
insert into public.group_members (group_id, profile_id, role, status) values
  ('30200000-0000-4000-8000-000000000001', '30100000-0000-4000-8000-000000000001', 'player', 'active'),
  ('30200000-0000-4000-8000-000000000001', '30100000-0000-4000-8000-000000000002', 'organizer', 'active'),
  ('30200000-0000-4000-8000-000000000001', '30100000-0000-4000-8000-000000000003', 'player', 'active'),
  ('30200000-0000-4000-8000-000000000001', '30100000-0000-4000-8000-000000000004', 'player', 'pending'),
  ('30200000-0000-4000-8000-000000000002', '30100000-0000-4000-8000-000000000006', 'player', 'active'),
  ('30200000-0000-4000-8000-000000000002', '30100000-0000-4000-8000-000000000003', 'player', 'active');
-- O grupo apagado da 0029: arquivado e com a linha do encerramento.
update public.groups set archived_at = now() where id = '30200000-0000-4000-8000-000000000002';
insert into private.group_deletions (group_id, deleted_by)
values ('30200000-0000-4000-8000-000000000002', '30100000-0000-4000-8000-000000000006');

-- ---------------------------------------------------------------------------
-- Sessão de envio: caminho decidido pelo banco
-- ---------------------------------------------------------------------------
select throws_ok($$select public.begin_photo_upload('30000000-0000-4000-8000-000000000003',
    gen_random_uuid(), gen_random_uuid(), repeat('a', 64), 1, 1, 'profile',
    '30200000-0000-4000-8000-000000000001')$$,
  '22023', 'VALIDATION', 'a profile photo takes no group');
select throws_ok($$select public.begin_photo_upload('30000000-0000-4000-8000-000000000003',
    gen_random_uuid(), gen_random_uuid(), repeat('a', 64), 1, 1, 'group', null)$$,
  '22023', 'VALIDATION', 'a group photo needs its group');
select throws_ok($$select public.begin_photo_upload('30000000-0000-4000-8000-000000000003',
    gen_random_uuid(), gen_random_uuid(), repeat('a', 64), 1, 1, 'avatar', null)$$,
  '22023', 'VALIDATION', 'the target is closed');
select throws_ok(format($$select public.begin_photo_upload(%L, gen_random_uuid(),
    gen_random_uuid(), repeat('a', 64), 1, 1, 'group', '30200000-0000-4000-8000-000000000001')$$,
    auth_id), code, message, 'group session refused: ' || label)
from (values
  ('organizer', '30000000-0000-4000-8000-000000000002'::uuid, '42501', 'OWNER_ONLY'),
  ('player', '30000000-0000-4000-8000-000000000003', '42501', 'OWNER_ONLY'),
  ('pending', '30000000-0000-4000-8000-000000000004', '42501', 'NOT_MEMBER'),
  ('stranger', '30000000-0000-4000-8000-000000000005', '42501', 'NOT_MEMBER')
) as refusal(label, auth_id, code, message);
select throws_ok($$select public.begin_photo_upload('30000000-0000-4000-8000-000000000006',
    gen_random_uuid(), gen_random_uuid(), repeat('a', 64), 1, 1, 'group',
    '30200000-0000-4000-8000-000000000002')$$,
  'P0002', 'GROUP_DELETED', 'a deleted group opens no session, not even for its owner');
select is((select count(*)::integer from private.photo_uploads), 0,
  'no refusal leaves a session behind');

create temporary table photo_answers (label text, answer jsonb);
insert into photo_answers select 'player begin', public.begin_photo_upload(
  '30000000-0000-4000-8000-000000000003', '30900000-0000-4000-8000-000000000003',
  '30800000-0000-4000-8000-000000000001', repeat('b', 64), 1, 1, 'profile', null);
select is((select answer -> 'current' ->> 'path' from photo_answers where label = 'player begin'),
  '30100000-0000-4000-8000-000000000003/'
    || (select answer -> 'outcome' ->> 'upload_id' from photo_answers where label = 'player begin')
    || '.jpg',
  'the path is <profile_id>/<upload_id>.jpg, decided by the database');
select is((select answer -> 'current' ->> 'bucket' from photo_answers where label = 'player begin'),
  'avatars', 'a profile session goes to the avatars bucket');
select is((select outcome from private.idempotency_records where operation = 'begin_photo_upload'),
  (select answer -> 'outcome' from photo_answers where label = 'player begin'),
  'the ledger keeps only the session ID and the logical result');
select is((select resource_type || ':' || resource_id::text from private.idempotency_records
  where operation = 'begin_photo_upload'),
  'photo_upload:' || (select answer -> 'outcome' ->> 'upload_id' from photo_answers where label = 'player begin'),
  'the resource of the session is the session');
select ok((select commit_before > now() and reclaim_after > commit_before
  and reclaim_after = created_at + interval '7500 seconds'
  from private.photo_uploads),
  'the session can be confirmed for 15 minutes and is reclaimed after 2 h 05');
insert into photo_answers select 'player begin replay', public.begin_photo_upload(
  '30000000-0000-4000-8000-000000000003', '30900000-0000-4000-8000-000000000003',
  '30800000-0000-4000-8000-000000000001', repeat('b', 64), 1, 1, 'profile', null);
select is((select answer -> 'current' ->> 'upload_id' from photo_answers where label = 'player begin replay'),
  (select answer -> 'outcome' ->> 'upload_id' from photo_answers where label = 'player begin'),
  'a replay returns the same open session and opens no other');
select is((select count(*)::integer from private.photo_uploads), 1, 'still one session');

-- ---------------------------------------------------------------------------
-- Troca da foto de perfil: só a própria sessão, e a antiga sai com o efeito
-- ---------------------------------------------------------------------------
create temporary table photo_ids as
  select (answer -> 'outcome' ->> 'upload_id')::uuid as upload_id,
         answer -> 'current' ->> 'path' as path
  from photo_answers where label = 'player begin';
select throws_ok(format($$select public.set_profile_photo('30000000-0000-4000-8000-000000000002',
    gen_random_uuid(), gen_random_uuid(), repeat('c', 64), 1, 1, %L)$$, upload_id),
  'P0002', 'NOT_FOUND', 'someone else''s session cannot become my photo')
from photo_ids;
update public.profiles set photo_url = '30100000-0000-4000-8000-000000000003/old.jpg'
where id = '30100000-0000-4000-8000-000000000003';
insert into photo_answers select 'player set', public.set_profile_photo(
  '30000000-0000-4000-8000-000000000003', '30900000-0000-4000-8000-000000000003',
  '30800000-0000-4000-8000-000000000002', repeat('d', 64), 1, 1, upload_id)
from photo_ids;
select is((select answer from photo_answers where label = 'player set'),
  '{"outcome":{"profile_id":"30100000-0000-4000-8000-000000000003","logical_result":"profile_photo_set"},"current":{"has_photo":true}}'::jsonb,
  'the swap answers with the profile and no path');
select is((select photo_url from public.profiles where id = '30100000-0000-4000-8000-000000000003'),
  (select path from photo_ids), 'the session''s object is now the photo');
select results_eq(
  $$select kind, profile_id, state, object_path from private.photo_uploads order by created_at$$,
  $$values ('profile_avatar'::text, '30100000-0000-4000-8000-000000000003'::uuid, 'retired'::text,
            '30100000-0000-4000-8000-000000000003/old.jpg'::text)$$,
  'the session is gone and the old photo is retired');
select is((select kind || ':' || resource_type || ':' || status from private.external_effects
  where resource_type = 'photo_upload'),
  'delete_storage_object:photo_upload:pending', 'the old object has a pending deletion');
select ok((select dedupe_key = 'delete_storage_object:photo_upload:' || resource_id::text
  and dedupe_key !~ 'jpg' from private.external_effects where resource_type = 'photo_upload'),
  'the deletion key carries the row ID, never the path');
insert into photo_answers select 'player set replay', public.set_profile_photo(
  '30000000-0000-4000-8000-000000000003', '30900000-0000-4000-8000-000000000003',
  '30800000-0000-4000-8000-000000000002', repeat('d', 64), 1, 1, upload_id)
from photo_ids;
select is((select answer -> 'outcome' from photo_answers where label = 'player set replay'),
  (select answer -> 'outcome' from photo_answers where label = 'player set'),
  'a replay returns the recorded outcome and swaps nothing again');
select is((select count(*)::integer from private.external_effects where resource_type = 'photo_upload'),
  1, 'the replay retired nothing more');
select throws_ok(format($$select public.set_profile_photo('30000000-0000-4000-8000-000000000003',
    gen_random_uuid(), gen_random_uuid(), repeat('e', 64), 1, 1, %L)$$, upload_id),
  'P0002', 'NOT_FOUND', 'a session already used cannot be used again')
from photo_ids;

-- Prazo: a sessão vencida não troca.
insert into photo_answers select 'late begin', public.begin_photo_upload(
  '30000000-0000-4000-8000-000000000002', gen_random_uuid(),
  '30800000-0000-4000-8000-000000000003', repeat('b', 64), 1, 1, 'profile', null);
update private.photo_uploads set commit_before = now() - interval '1 second',
  created_at = now() - interval '20 minutes'
where id = (select (answer -> 'outcome' ->> 'upload_id')::uuid from photo_answers
            where label = 'late begin');
select throws_ok(format($$select public.set_profile_photo('30000000-0000-4000-8000-000000000002',
    gen_random_uuid(), gen_random_uuid(), repeat('f', 64), 1, 1, %L)$$,
    answer -> 'outcome' ->> 'upload_id'),
  'P0002', 'NOT_FOUND', 'an expired session cannot become the photo')
from photo_answers where label = 'late begin';
select is(public.get_photo_upload_target('30000000-0000-4000-8000-000000000002', gen_random_uuid(),
    (select (answer -> 'outcome' ->> 'upload_id')::uuid from photo_answers where label = 'late begin')),
  null, 'the Edge gets no target for an expired session');

-- Teto de sessões abertas por pessoa.
select lives_ok(format($$select public.begin_photo_upload('30000000-0000-4000-8000-000000000005',
    gen_random_uuid(), %L, repeat('b', 64), 1, 1, 'profile', null)$$, gen_random_uuid()),
  'open session ' || n) from generate_series(1, 10) as n;
select throws_ok($$select public.begin_photo_upload('30000000-0000-4000-8000-000000000005',
    gen_random_uuid(), gen_random_uuid(), repeat('b', 64), 1, 1, 'profile', null)$$,
  'P0001', 'RATE_LIMITED', 'the eleventh open session is refused');

-- ---------------------------------------------------------------------------
-- Remover
-- ---------------------------------------------------------------------------
insert into photo_answers select 'owner remove none', public.remove_profile_photo(
  '30000000-0000-4000-8000-000000000001', gen_random_uuid(),
  '30800000-0000-4000-8000-000000000004', repeat('a', 64), 1, 1);
select is((select answer -> 'outcome' ->> 'logical_result' from photo_answers
  where label = 'owner remove none'), 'profile_photo_unchanged', 'removing no photo changes nothing');

-- ---------------------------------------------------------------------------
-- Foto do grupo: só o dono troca; organizador recusa
-- ---------------------------------------------------------------------------
insert into photo_answers select 'owner group begin', public.begin_photo_upload(
  '30000000-0000-4000-8000-000000000001', gen_random_uuid(),
  '30800000-0000-4000-8000-000000000005', repeat('b', 64), 1, 1, 'group',
  '30200000-0000-4000-8000-000000000001');
select is((select answer -> 'current' ->> 'path' from photo_answers where label = 'owner group begin'),
  '30200000-0000-4000-8000-000000000001/'
    || (select answer -> 'outcome' ->> 'upload_id' from photo_answers where label = 'owner group begin')
    || '.jpg',
  'a group photo goes to <group_id>/<upload_id>.jpg');
select throws_ok(format($$select public.set_group_photo('30000000-0000-4000-8000-000000000002',
    gen_random_uuid(), gen_random_uuid(), repeat('a', 64), 1, 1,
    '30200000-0000-4000-8000-000000000001', %L)$$, answer -> 'outcome' ->> 'upload_id'),
  '42501', 'OWNER_ONLY', 'the organizer cannot use the owner''s session')
from photo_answers where label = 'owner group begin';
insert into photo_answers select 'owner group set', public.set_group_photo(
  '30000000-0000-4000-8000-000000000001', gen_random_uuid(),
  '30800000-0000-4000-8000-000000000006', repeat('a', 64), 1, 1,
  '30200000-0000-4000-8000-000000000001', (answer -> 'outcome' ->> 'upload_id')::uuid)
from photo_answers where label = 'owner group begin';
select is((select answer -> 'outcome' ->> 'logical_result' from photo_answers
  where label = 'owner group set'), 'group_photo_set', 'the owner sets the group photo');
select is((select resource_type from private.idempotency_records where operation = 'set_group_photo'),
  'group', 'the resource of a group photo is the group');

-- ---------------------------------------------------------------------------
-- Quem vê
-- ---------------------------------------------------------------------------
-- A foto da Antiga existe, mas ela só divide com o jogador o grupo apagado.
update public.profiles set photo_url = '30100000-0000-4000-8000-000000000006/x.jpg'
where id = '30100000-0000-4000-8000-000000000006';
update public.profiles set photo_url = '30100000-0000-4000-8000-000000000005/y.jpg'
where id = '30100000-0000-4000-8000-000000000005';
update public.groups set photo_url = '30200000-0000-4000-8000-000000000002/z.jpg'
where id = '30200000-0000-4000-8000-000000000002';
create temporary table everyone (ids uuid[], groups uuid[]);
insert into everyone values (
  array['30100000-0000-4000-8000-000000000001', '30100000-0000-4000-8000-000000000003',
        '30100000-0000-4000-8000-000000000005', '30100000-0000-4000-8000-000000000006']::uuid[],
  array['30200000-0000-4000-8000-000000000001', '30200000-0000-4000-8000-000000000002']::uuid[]);
select results_eq(
  $$select kind, subject_id from public.get_visible_photos('30000000-0000-4000-8000-000000000002',
      gen_random_uuid(), (select ids from everyone), (select groups from everyone), false)$$,
  $$values ('group'::text, '30200000-0000-4000-8000-000000000001'::uuid),
           ('profile', '30100000-0000-4000-8000-000000000003'::uuid)$$,
  'a member sees the co-member''s photo and the live group''s, nobody else''s');
select results_eq(
  $$select kind, subject_id from public.get_visible_photos('30000000-0000-4000-8000-000000000003',
      gen_random_uuid(), (select ids from everyone), (select groups from everyone), false)$$,
  $$values ('group'::text, '30200000-0000-4000-8000-000000000001'::uuid),
           ('profile', '30100000-0000-4000-8000-000000000003'::uuid)$$,
  'the player sees their own photo; a deleted group shares nothing, not even its photo');
select results_eq(
  $$select kind, subject_id from public.get_visible_photos('30000000-0000-4000-8000-000000000003',
      gen_random_uuid(), array[]::uuid[], array[]::uuid[], true)$$,
  $$values ('self'::text, '30100000-0000-4000-8000-000000000003'::uuid)$$,
  'the own photo comes by the self flag, without the own ID in the request');
select is((select count(*)::integer from public.get_visible_photos(
    '30000000-0000-4000-8000-000000000001', gen_random_uuid(), array[]::uuid[], array[]::uuid[],
    true)), 0, 'the self flag without a photo returns nothing');
select is((select count(*)::integer from public.get_visible_photos(
    '30000000-0000-4000-8000-000000000005', gen_random_uuid(),
    array['30100000-0000-4000-8000-000000000003']::uuid[],
    array['30200000-0000-4000-8000-000000000001']::uuid[], false)), 0,
  'a stranger sees neither the player''s photo nor the group''s');
select is((select count(*)::integer from public.get_visible_photos(
    '30000000-0000-4000-8000-000000000004', gen_random_uuid(),
    array['30100000-0000-4000-8000-000000000003']::uuid[],
    array['30200000-0000-4000-8000-000000000001']::uuid[], false)), 0,
  'a pending member sees no member''s photo and no group photo');
select throws_ok($$select * from public.get_visible_photos('30000000-0000-4000-8000-000000000003',
    gen_random_uuid(), array_fill(gen_random_uuid(), array[101]), array[]::uuid[], false)$$,
  '22023', 'VALIDATION', 'at most 100 subjects of each kind');
update public.group_members set status = 'removed', removed_at = now()
where group_id = '30200000-0000-4000-8000-000000000001'
  and profile_id = '30100000-0000-4000-8000-000000000003';
select is((select count(*)::integer from public.get_visible_photos(
    '30000000-0000-4000-8000-000000000002', gen_random_uuid(),
    array['30100000-0000-4000-8000-000000000003']::uuid[], array[]::uuid[], false)), 0,
  'leaving the last shared group ends the right to see the photo');

-- ---------------------------------------------------------------------------
-- Fence de Storage da exclusão de conta e recolhimento de sessões
-- ---------------------------------------------------------------------------
insert into private.deletion_requests (id, profile_id, auth_user_id)
values ('30700000-0000-4000-8000-000000000003', '30100000-0000-4000-8000-000000000003',
        '30000000-0000-4000-8000-000000000003');
select ok(private.deletion_has_pending_storage('30700000-0000-4000-8000-000000000003'),
  'a retired photo with a pending deletion fences Auth');
update public.profiles set photo_url = null where id = '30100000-0000-4000-8000-000000000003';
update private.external_effects set status = 'dead', completed_at = now(), attempts = 5,
  last_error_code = 'STORAGE_UNAVAILABLE'
where resource_type = 'photo_upload';
select ok(not private.deletion_has_pending_storage('30700000-0000-4000-8000-000000000003'),
  'a dead deletion releases the fence as a durable operational failure');
select is((select has_operational_failure from private.deletion_requests
  where id = '30700000-0000-4000-8000-000000000003'), true,
  'the dead effect marks the saga with an operational failure');

-- Uma sessão aberta da pessoa também segura o Auth até ser recolhida.
insert into private.deletion_requests (id, profile_id, auth_user_id)
values ('30700000-0000-4000-8000-000000000005', '30100000-0000-4000-8000-000000000005',
        '30000000-0000-4000-8000-000000000005');
update public.profiles set photo_url = null where id = '30100000-0000-4000-8000-000000000005';
select ok(private.deletion_has_pending_storage('30700000-0000-4000-8000-000000000005'),
  'an open session fences Auth: its signed URL may still deliver an object');
update private.photo_uploads set created_at = now() - interval '3 hours',
  commit_before = now() - interval '165 minutes', reclaim_after = now() - interval '55 minutes'
where profile_id = '30100000-0000-4000-8000-000000000005';
select is((private.reclaim_photo_uploads() ->> 'reclaimed')::integer, 10,
  'the job reclaims every session past its reclaim instant');
select is((select count(*)::integer from private.photo_uploads
  where profile_id = '30100000-0000-4000-8000-000000000005' and state = 'retired'), 10,
  'each reclaimed session is retired');
select is((select count(*)::integer from private.external_effects e
  join private.photo_uploads u on u.id = e.resource_id
  where u.profile_id = '30100000-0000-4000-8000-000000000005'
    and e.kind = 'delete_storage_object' and e.status = 'pending'), 10,
  'and gets its deletion');
select is((select count(*)::integer from private.photo_uploads where state = 'pending'
  and profile_id = '30100000-0000-4000-8000-000000000003'), 0,
  'the reclaim touches nothing that is not due');
select is((select schedule from cron.job where jobname = 'colete_v1_reclaim_photo_uploads'),
  '*/5 * * * *', 'the reclaim runs every five minutes');

-- O alvo do worker só aponta para objeto retired e a confirmação apaga o caminho.
update private.external_effects
set status = 'leased', lease_token = '30600000-0000-4000-8000-000000000001',
    lease_until = clock_timestamp() + interval '1 minute', attempts = 1
where id = (select e.id from private.external_effects e
            join private.photo_uploads u on u.id = e.resource_id
            where u.profile_id = '30100000-0000-4000-8000-000000000005'
            order by e.id limit 1);
create temporary table leased as
  select e.id, e.resource_id from private.external_effects e
  where e.lease_token = '30600000-0000-4000-8000-000000000001';
select is(public.worker_get_deletion_effect_target(
    (select id from leased), '30600000-0000-4000-8000-000000000001'),
  jsonb_build_object('action', 'storage', 'bucket', 'avatars',
    'path', (select object_path from private.photo_uploads where id = (select resource_id from leased))),
  'the worker target is the retired object in its bucket');
select is((public.worker_confirm_deletion_effect(
    (select id from leased), '30600000-0000-4000-8000-000000000001') ->> 'status'),
  'cleaning_storage', 'confirming one of ten keeps the saga cleaning');
select results_eq(
  $$select state, object_path is null, deleted_at is not null from private.photo_uploads
    where id = (select resource_id from leased)$$,
  $$values ('deleted'::text, true, true)$$,
  'a confirmed deletion leaves no path behind');
select is(public.worker_get_deletion_effect_target(
    (select id from leased), '30600000-0000-4000-8000-000000000001'),
  '{"action":"none"}'::jsonb, 'a retry after the confirmation has nothing to delete');

-- ---------------------------------------------------------------------------
-- Storage: nenhum objeto de foto nasce sem sessão de envio aberta (P1 do #81)
-- ---------------------------------------------------------------------------
-- O Storage proíbe apagar linhas direto; o rollback do fim desfaz tudo.
select ok((select tgenabled = 'O' and not tgisinternal from pg_trigger
  where tgrelid = 'storage.objects'::regclass and tgname = 'objects_require_pending_photo_upload'),
  'storage.objects carries the pending-session trigger');
select ok((select prosecdef and proconfig = array['search_path=""']
  from pg_proc where oid = 'private.require_pending_photo_upload()'::regprocedure),
  'the trigger function is security definer with a fixed search_path');
select throws_ok($$insert into storage.objects (bucket_id, name)
    values ('avatars', '30100000-0000-4000-8000-000000000003/stale.jpg')$$,
  '42501', 'PHOTO_UPLOAD_NOT_PENDING', 'no session, no object: the stale URL recreates nothing');
insert into private.photo_uploads (id, kind, profile_id, object_path, commit_before, reclaim_after)
values ('30c00000-0000-4000-8000-0000000000aa', 'profile_avatar',
        '30100000-0000-4000-8000-000000000002', '30100000-0000-4000-8000-000000000002/open.jpg',
        now() + interval '15 minutes', now() + interval '2 hours');
select throws_ok($$insert into storage.objects (bucket_id, name)
    values ('group-photos', '30100000-0000-4000-8000-000000000002/open.jpg')$$,
  '42501', 'PHOTO_UPLOAD_NOT_PENDING', 'an avatar session does not open the group bucket');
select lives_ok($$insert into storage.objects (bucket_id, name)
    values ('avatars', '30100000-0000-4000-8000-000000000002/open.jpg')$$,
  'an open session accepts its own object');
insert into private.photo_uploads
  (id, kind, profile_id, object_path, created_at, commit_before, reclaim_after)
values ('30c00000-0000-4000-8000-0000000000ab', 'profile_avatar',
        '30100000-0000-4000-8000-000000000002', '30100000-0000-4000-8000-000000000002/late.jpg',
        now() - interval '3 hours', now() - interval '2 seconds', now() - interval '1 second');
select throws_ok($$insert into storage.objects (bucket_id, name)
    values ('avatars', '30100000-0000-4000-8000-000000000002/late.jpg')$$,
  '42501', 'PHOTO_UPLOAD_NOT_PENDING', 'a session past its reclaim instant accepts nothing');
select lives_ok($$insert into storage.objects (bucket_id, name)
    values ('data-exports', 'exports/x/fixture.zip')$$,
  'the other buckets are untouched');
select throws_ok($$update storage.objects set bucket_id = 'avatars'
    where bucket_id = 'data-exports' and name = 'exports/x/fixture.zip'$$,
  '42501', 'PHOTO_UPLOAD_NOT_PENDING', 'nothing moves into a photo bucket either');

-- ---------------------------------------------------------------------------
-- Exportação: a foto fica fora do snapshot
-- ---------------------------------------------------------------------------
select ok(pg_get_functiondef('public.worker_get_data_export_build_target(uuid,uuid)'::regprocedure)
  ~ $$'photo',case when v_profile.photo_url is null then null$$,
  'the build target carries the photo beside the snapshot, never inside it');

select * from finish();
rollback;
