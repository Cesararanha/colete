begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- Fronteira: a prévia é chamada só pela Edge (service_role) com o contexto do
-- autor; o corpo privado não tem grant; security definer com search_path ''.
select ok(has_function_privilege('service_role',
  'public.preview_group_by_code(uuid,uuid,text)','execute'),
  'service_role executa a prévia por código');
select ok(has_function_privilege('service_role',
  'public.preview_group_by_invite(uuid,uuid,uuid,smallint,text)','execute'),
  'service_role executa a prévia por link');
select ok(not has_function_privilege(role,
  'public.preview_group_by_code(uuid,uuid,text)','execute'),
  format('%s não executa a prévia por código', role))
from unnest(array['anon','authenticated']) as roles(role);
select ok(not has_function_privilege(role,
  'public.preview_group_by_invite(uuid,uuid,uuid,smallint,text)','execute'),
  format('%s não executa a prévia por link', role))
from unnest(array['anon','authenticated']) as roles(role);
select ok(not has_function_privilege(role,
  'private.preview_group_invite(uuid,uuid,uuid,smallint,text,text)','execute'),
  format('%s não executa o corpo privado', role))
from unnest(array['anon','authenticated','service_role']) as roles(role);
select ok(prosecdef and proconfig = array['search_path=""'],
  'corpo privado é security definer com search_path vazio')
from pg_proc where oid='private.preview_group_invite(uuid,uuid,uuid,smallint,text,text)'::regprocedure;
-- A prévia é só leitura: STABLE impede FOR UPDATE/SHARE no corpo, e nenhum
-- código, existente ou não, espera trava (prova com barreira no harness).
select is(provolatile,'s','corpo privado é STABLE, sem trava de linha')
from pg_proc where oid='private.preview_group_invite(uuid,uuid,uuid,smallint,text,text)'::regprocedure;
select ok(prosrc !~* 'for\s+(no\s+key\s+)?(update|share)|for\s+key\s+share',
  'corpo privado não contém cláusula de trava')
from pg_proc where oid='private.preview_group_invite(uuid,uuid,uuid,smallint,text,text)'::regprocedure;

-- Atores sintéticos: dono (com apelido), pendente, membro ativo, membro ativo
-- em exclusão (não conta), pessoa de fora e pessoa de fora no limite de grupos.
insert into auth.users(id,email) values
 ('26000000-0000-4000-8000-000000000001','invite-page-owner@example.invalid'),
 ('26000000-0000-4000-8000-000000000002','invite-page-pending@example.invalid'),
 ('26000000-0000-4000-8000-000000000003','invite-page-member@example.invalid'),
 ('26000000-0000-4000-8000-000000000004','invite-page-leaving@example.invalid'),
 ('26000000-0000-4000-8000-000000000005','invite-page-outsider@example.invalid'),
 ('26000000-0000-4000-8000-000000000006','invite-page-busy@example.invalid');
insert into public.profiles(id,auth_user_id,name,nickname,account_status) values
 ('26100000-0000-4000-8000-000000000001','26000000-0000-4000-8000-000000000001','Dono Sintético','Capitão','active'),
 ('26100000-0000-4000-8000-000000000002','26000000-0000-4000-8000-000000000002','Pendente',null,'active'),
 ('26100000-0000-4000-8000-000000000003','26000000-0000-4000-8000-000000000003','Membro',null,'active'),
 ('26100000-0000-4000-8000-000000000004','26000000-0000-4000-8000-000000000004','Saindo',null,'active'),
 ('26100000-0000-4000-8000-000000000005','26000000-0000-4000-8000-000000000005','De Fora',null,'active'),
 ('26100000-0000-4000-8000-000000000006','26000000-0000-4000-8000-000000000006','Ocupada',null,'active');

-- O mesmo vetor público sintético da 0017 (chave 00..1f, nonce 20..2f).
select lives_ok($$select public.create_group(
 '26000000-0000-4000-8000-000000000001','26400000-0000-4000-8000-000000000001',
 '26500000-0000-4000-8000-000000000001',repeat('a',64),1,1,'Racha da Página',
 '01890f7e-e948-7c53-b13a-4a36e4b7d21e',1::smallint,
 '202122232425262728292a2b2c2d2e2f',
 'b44d03c9a10a8a4e3b5696ead1bbe81471f3e9eaa2b05ab888161d1c6093c2b9',
 '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104')$$,
 'grupo da página nasce com o convite sintético');
create temporary table page_group as
select id from public.groups where owner_id='26100000-0000-4000-8000-000000000001';
insert into public.group_members(group_id,profile_id,role,status)
select id,'26100000-0000-4000-8000-000000000003'::uuid,'player','active' from page_group union all
select id,'26100000-0000-4000-8000-000000000004'::uuid,'player','active' from page_group;
select lives_ok($$select public.join_by_code(
 '26000000-0000-4000-8000-000000000002','26400000-0000-4000-8000-000000000002',
 '26500000-0000-4000-8000-000000000002',repeat('b',64),1,1,
 '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104')$$,
 'pedido pendente criado pelo resgate real');
update public.profiles set account_status='deletion_pending'
 where id='26100000-0000-4000-8000-000000000004';

create function pg_temp.by_code(p_actor text, p_digest text) returns jsonb
language sql as $function$
  select public.preview_group_by_code(('26000000-0000-4000-8000-00000000000'||p_actor)::uuid,
    ('26400000-0000-4000-8000-00000000000'||p_actor)::uuid, p_digest);
$function$;
create function pg_temp.by_link(p_actor text, p_digest text) returns jsonb
language sql as $function$
  select public.preview_group_by_invite(('26000000-0000-4000-8000-00000000000'||p_actor)::uuid,
    ('26400000-0000-4000-8000-00000000000'||p_actor)::uuid,
    '01890f7e-e948-7c53-b13a-4a36e4b7d21e', 1::smallint, p_digest);
$function$;
create temporary table vector(code_digest text, token_digest text);
insert into vector values (
 '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104',
 'b44d03c9a10a8a4e3b5696ead1bbe81471f3e9eaa2b05ab888161d1c6093c2b9');

-- Código válido: exatamente oito campos (ícone e cor pela 0027), sem id de
-- perfil, e-mail ou lista.
select is((select array_agg(key order by key) from jsonb_object_keys(
  pg_temp.by_code('5',(select code_digest from vector))) as key),
  array['group_color','group_icon','group_id','group_name','member_count','owner_name',
    'refusal','viewer_status'],
  'a prévia devolve só os oito campos da página');
select is(pg_temp.by_code('5',(select code_digest from vector)),
  jsonb_build_object('group_name','Racha da Página','member_count',2,
    'owner_name','Capitão','viewer_status',null,'group_id',null,'refusal',null,
    'group_icon','ball','group_color','blue'),
  'código válido: nome, membros ativos sem conta em exclusão e apelido do dono');
select is(pg_temp.by_link('5',(select token_digest from vector)),
  pg_temp.by_code('5',(select code_digest from vector)),
  'link válido devolve a mesma página do código');
select ok(pg_temp.by_code('5',(select code_digest from vector))::text
  !~ '26100000|26000000|example\.invalid|Pendente|Membro|Saindo',
  'a página não carrega ids, e-mails nem nomes de outros membros');
select is((select used_count from public.group_invites
  where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e'),1,
  'a prévia não consome uso (só o resgate pendente consumiu)');
select is((select count(*)::integer from public.group_members m join page_group g on g.id=m.group_id
  where m.profile_id='26100000-0000-4000-8000-000000000005'),0,
  'a prévia não cria membership nem pedido');
select is((select count(*)::integer from private.invite_rate_limits
  where profile_id='26100000-0000-4000-8000-000000000005'),0,
  'a prévia não debita sozinha: o débito é a RPC do limitador, antes dela');

-- 0027: o ícone e a cor são os do grupo, não o padrão fixo.
update public.groups set icon='flame', color='lilac' where id=(select id from page_group);
select is(pg_temp.by_code('5',(select code_digest from vector))->>'group_icon'
  || '/' || (pg_temp.by_link('5',(select token_digest from vector))->>'group_color'),
  'flame/lilac', 'a página mostra o ícone e a cor escolhidos pelo dono, por código e link');
update public.groups set icon='ball', color='blue' where id=(select id from page_group);

update public.profiles set nickname='   ' where id='26100000-0000-4000-8000-000000000001';
select is(pg_temp.by_code('5',(select code_digest from vector))->>'owner_name','Dono Sintético',
  'apelido em branco cai no nome, como em get_group_members');
update public.profiles set nickname='Capitão' where id='26100000-0000-4000-8000-000000000001';

-- Já membro e pendente: estado próprio; group_id só para quem já é membro.
select is(pg_temp.by_code('3',(select code_digest from vector))->>'viewer_status','active',
  'membro ativo vê o próprio estado');
select is(pg_temp.by_code('3',(select code_digest from vector))->>'group_id',
  (select id::text from page_group), 'membro ativo recebe o id para abrir o grupo');
select is(pg_temp.by_code('1',(select code_digest from vector))->>'viewer_status','active',
  'o dono também é membro ativo');
select is(pg_temp.by_code('2',(select code_digest from vector))->>'viewer_status','pending',
  'pedido pendente vê aguardando aprovação');
select ok(pg_temp.by_code('2',(select code_digest from vector))->'group_id' = 'null'::jsonb,
  'pendente não recebe o id do grupo');
select ok(pg_temp.by_link('2',(select token_digest from vector))->'group_id' = 'null'::jsonb,
  'pendente pelo link também não recebe o id');

-- Inválido, expirado, revogado e esgotado: a mesma resposta genérica, também
-- para membro e pendente (material inválido não consulta membership).
select throws_ok(format('select pg_temp.by_code(%L,%L)',actor,repeat('0',64)),
  '22023','CODE_INVALID',format('código inexistente é genérico (ator %s)',actor))
from unnest(array['2','3','5']) as actors(actor);
select throws_ok(format('select pg_temp.by_code(%L,%L)','5','not-hex'),
  '22023','CODE_INVALID','digest malformado é genérico');
select throws_ok(format('select pg_temp.by_link(%L,%L)','5',repeat('1',64)),
  '22023','CODE_INVALID','token com digest divergente é genérico');
update public.group_invites set expires_at=now()-interval '1 second'
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e';
select throws_ok(format('select pg_temp.by_code(%L,%L)',actor,(select code_digest from vector)),
  '22023','CODE_INVALID',format('código expirado é genérico (ator %s)',actor))
from unnest(array['2','3','5']) as actors(actor);
select throws_ok(format('select pg_temp.by_link(%L,%L)','5',(select token_digest from vector)),
  '22023','CODE_INVALID','link expirado é genérico');
update public.group_invites set expires_at=now()+interval '1 day', revoked_at=now()
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e';
select throws_ok(format('select pg_temp.by_code(%L,%L)',actor,(select code_digest from vector)),
  '22023','CODE_INVALID',format('código revogado é genérico (ator %s)',actor))
from unnest(array['2','3','5']) as actors(actor);
select throws_ok(format('select pg_temp.by_link(%L,%L)','5',(select token_digest from vector)),
  '22023','CODE_INVALID','link revogado é genérico');
update public.group_invites set revoked_at=null, used_count=max_uses
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e';
select throws_ok(format('select pg_temp.by_code(%L,%L)','5',(select code_digest from vector)),
  '22023','CODE_INVALID','convite esgotado é genérico');
update public.group_invites set used_count=1
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e';
-- O resgate conserva a M2-D42: só a prévia ficou genérica.
update public.group_invites set revoked_at=now()
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e';
select throws_ok($$select public.join_by_code(
 '26000000-0000-4000-8000-000000000005','26400000-0000-4000-8000-000000000005',
 '26500000-0000-4000-8000-000000000005',repeat('c',64),1,1,
 '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104')$$,
 'P0001','INVITE_REVOKED','o resgate mantém a causa própria da M2-D42');
update public.group_invites set revoked_at=null
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e';
select is(pg_temp.by_code('5',(select code_digest from vector))->>'group_name','Racha da Página',
  'restaurado o convite vivo, a página volta');

-- Recusas com código vivo: a página aparece com a recusa no lugar do botão.
update private.app_limits set limit_value=3 where limit_key='max_group_capacity';
select is(pg_temp.by_code('5',(select code_digest from vector))->>'refusal','GROUP_FULL',
  'grupo cheio volta como recusa da página');
select is(pg_temp.by_code('3',(select code_digest from vector))->'refusal','null'::jsonb,
  'membro ativo não recebe recusa de capacidade');
select is(pg_temp.by_code('2',(select code_digest from vector))->'refusal','null'::jsonb,
  'pendente não recebe recusa de capacidade');
update private.app_limits set limit_value=100 where limit_key='max_group_capacity';
select lives_ok($$select public.create_group(
 '26000000-0000-4000-8000-000000000006','26400000-0000-4000-8000-000000000006',
 '26500000-0000-4000-8000-000000000006',repeat('d',64),1,1,'Outro Racha',
 '01890f7e-e948-7c53-b13a-4a36e4b7d21f',1::smallint,
 '303132333435363738393a3b3c3d3e3f',repeat('e',64),repeat('f',64))$$,
 'a pessoa ocupada tem um grupo ativo');
update private.app_limits set limit_value=1 where limit_key='max_active_groups_per_profile';
select is(pg_temp.by_code('6',(select code_digest from vector))->>'refusal','GROUP_LIMIT',
  'cota pessoal volta como recusa da página');
select is(pg_temp.by_code('5',(select code_digest from vector))->'refusal','null'::jsonb,
  'quem está abaixo da cota não recebe recusa');
update private.app_limits set limit_value=5 where limit_key='max_active_groups_per_profile';

-- Arquivado continua erro, sem página.
update public.groups set archived_at=now() where id=(select id from page_group);
select throws_ok(format('select pg_temp.by_code(%L,%L)','5',(select code_digest from vector)),
  'P0001','GROUP_ARCHIVED','grupo arquivado não mostra página');
update public.groups set archived_at=null where id=(select id from page_group);

-- Limitador: a mesma RPC da 0017 que a Edge chama antes de toda prévia. Com
-- N=3, a quarta tentativa é recusada e ocupa orçamento; o código não importa.
update private.app_limits set limit_value=3 where limit_key='invite_attempts_per_hour';
create temporary table page_attempts as
select n, public.check_and_debit_invite_attempt(
 '26100000-0000-4000-8000-000000000005',
 '26000000-0000-4000-8000-000000000005',
 '26400000-0000-4000-8000-000000000005') as result
from generate_series(1,4) as n;
select is((select array_agg((result->>'allowed')::boolean order by n) from page_attempts),
  array[true,true,true,false], 'limitador admite N=3 prévias e recusa a quarta');
select ok((select (result->>'retry_after')::integer > 0 and result->>'available_at' is not null
  from page_attempts where n=4), 'a recusa informa quando tentar de novo');
select is((select count(*)::integer from private.invite_rate_limits
  where profile_id='26100000-0000-4000-8000-000000000005'),4,
  'a quarta tentativa também ocupa uma linha');
select is((select count(*)::integer from private.invite_rate_limits
  where profile_id<>'26100000-0000-4000-8000-000000000005'
    and profile_id::text like '26100000-%'),0,
  'o orçamento é por perfil: os outros atores não foram debitados');

select * from finish();
rollback;
