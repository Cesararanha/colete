begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select ok(not relrowsecurity and not relforcerowsecurity,
  'tabela privada do limitador nasce sem RLS, protegida por privilégios de schema')
from pg_class where oid='private.invite_rate_limits'::regclass;
select ok(not has_table_privilege('service_role','private.invite_rate_limits','SELECT,INSERT,UPDATE,DELETE'),
  'service_role não recebe DML direto no limitador');
select ok(not has_table_privilege('authenticated','private.invite_rate_limits','SELECT,INSERT,UPDATE,DELETE'),
  'authenticated não acessa a tabela privada');

-- VETOR PÚBLICO SINTÉTICO: chave 00..1f e nonce 20..2f. Nenhuma chave real.
-- A mesma expectativa literal está em invite-material.test.ts. HKDF-SHA-256
-- RFC 5869: extract com salt fixo, expand com info ASCII || 0x01, L=32.
create temporary table invite_vector as
with material as (
  select decode('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex') as key,
         decode('01890f7ee9487c53b13a4a36e4b7d21e', 'hex') as invite_id,
         decode('202122232425262728292a2b2c2d2e2f', 'hex') as nonce,
         decode('0001', 'hex') as version
), extracted as (
  select *, extensions.hmac(key, convert_to('colete/invite/hkdf-salt/v1', 'UTF8'), 'sha256') as prk
  from material
), keys as (
  select *,
    extensions.hmac(convert_to('colete/invite/link-mac/v1', 'UTF8') || decode('01', 'hex'), prk, 'sha256') as link_key,
    extensions.hmac(convert_to('colete/invite/code/v1', 'UTF8') || decode('01', 'hex'), prk, 'sha256') as code_key,
    extensions.hmac(convert_to('colete/invite/code-lookup/v1', 'UTF8') || decode('01', 'hex'), prk, 'sha256') as lookup_key
  from extracted
), derived as (
  select *,
    extensions.hmac(convert_to('colete/invite/v1', 'UTF8') || decode('00', 'hex') || invite_id || version || nonce,
                    link_key, 'sha256') as link_mac,
    extensions.hmac(invite_id || nonce, code_key, 'sha256') as code_mac,
    extensions.hmac(version || convert_to('BYKTT8DMAB', 'UTF8'), lookup_key, 'sha256') as code_digest
  from keys
)
select *, invite_id || version || nonce || link_mac as token_bytes from derived;

select is(encode(link_key, 'hex'),
  '84abf4310d2559fadc52b6b1f0e38415353bd5a7d317069462550c6cac6c8866',
  'HKDF fixa a subchave exclusiva do MAC do link') from invite_vector;
select is(encode(code_key, 'hex'),
  '83026c729f09186abedf1f71b40ad1d5602c9f0a6c08638af4315f6bf807e247',
  'HKDF fixa a subchave exclusiva do código') from invite_vector;
select is(encode(lookup_key, 'hex'),
  '7df0264ac6c0a087391bb62012c3aea7c915150e5489c742e1a396395a8b916e',
  'HKDF fixa a subchave exclusiva do lookup') from invite_vector;
select is(encode(link_mac, 'hex'),
  '0064883df2de47876508eb37b57d355aa34ffd0384def6869d70788ef917e0f2',
  'MAC do link fixa domínio, ordem de bytes e u16 big-endian') from invite_vector;
select is(encode(code_mac, 'hex'),
  '4fa39c9973425e37a2a43f87afb14d6c22269e1d4a1e5667849eadad1cfa1f9a',
  'HMAC do código fixa ID RFC 4122 e nonce') from invite_vector;
select is(encode(code_digest, 'hex'),
  '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104',
  'digest de lookup fixa versão u16 e código ASCII normalizado') from invite_vector;
select is(octet_length(token_bytes), 66,
  'o token tem exatamente 66 bytes binários') from invite_vector;
select is(encode(extensions.digest(token_bytes, 'sha256'), 'hex'),
  'b44d03c9a10a8a4e3b5696ead1bbe81471f3e9eaa2b05ab888161d1c6093c2b9',
  'token_digest é SHA-256 dos 66 bytes binários em hex minúsculo') from invite_vector;
select is(rtrim(translate(replace(encode(token_bytes, 'base64'), E'\n', ''), '+/', '-_'), '='),
  'AYkPfulIfFOxOko25LfSHgABICEiIyQlJicoKSorLC0uLwBkiD3y3keHZQjrN7V9NVqjT_0DhN72hp1weI75F-Dy',
  'base64url do token não tem padding') from invite_vector;

create function pg_temp.code50(p_mac bytea) returns text
language plpgsql immutable as $function$
declare
  v_alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  v_code text := '';
  v_index integer;
  v_bit integer;
begin
  for v_index in 0..9 loop
    v_bit := 0;
    for j in 0..4 loop
      v_bit := (v_bit << 1) | ((get_byte(p_mac, (v_index * 5 + j) / 8)
                  >> (7 - ((v_index * 5 + j) % 8))) & 1);
    end loop;
    v_code := v_code || substr(v_alphabet, v_bit + 1, 1);
  end loop;
  return v_code;
end;
$function$;
select is(pg_temp.code50(code_mac), 'BYKTT8DMAB',
  'primeiros 50 bits big-endian geram os dez símbolos literais') from invite_vector;

-- Cada item da denylist SQL tem sua própria asserção: remover qualquer um
-- deles da função faz exatamente a sua asserção reprovar.
select throws_ok(
  format('select private.normalize_group_name(%L)', 'X' || chr(cp) || 'Y'),
  '22023', 'VALIDATION', format('SQL recusa invisível U+%s', upper(to_hex(cp))))
from unnest(array[1564,8203,8206,8207,8234,8235,8236,8237,8238,
  8288,8289,8290,8291,8292,8294,8295,8296,8297,65279]) as forbidden(cp);
select is(private.normalize_group_name('X' || chr(8204) || 'Y' || chr(8205) || 'Z'),
  'X' || chr(8204) || 'Y' || chr(8205) || 'Z', 'SQL permite ZWNJ e ZWJ');
select is(private.normalize_group_name(' X' || chr(160) || 'Y' || chr(8232) || 'Z' || chr(12288) || ' '),
  'X Y Z', 'SQL colapsa Zs, Zl e Zp');
select throws_ok($$select private.normalize_group_name('A')$$,
  '22023', 'VALIDATION', 'SQL recusa um ponto de código');
select throws_ok($$select private.normalize_group_name(repeat('x',41))$$,
  '22023', 'VALIDATION', 'SQL recusa 41 pontos de código');


-- Fixtures puramente transacionais: os testes de commit, HTTP e concorrência
-- ficam no harness. Aqui as RPCs são exercidas sob seus contratos reais.
insert into auth.users(id,email) values
 ('17000000-0000-4000-8000-000000000001','invite-pgtap-owner@example.invalid'),
 ('17000000-0000-4000-8000-000000000002','invite-pgtap-joiner@example.invalid');
insert into public.profiles(id,auth_user_id,name,account_status) values
 ('17100000-0000-4000-8000-000000000001','17000000-0000-4000-8000-000000000001','Owner','active'),
 ('17100000-0000-4000-8000-000000000002','17000000-0000-4000-8000-000000000002','Joiner','active');
create temporary table invite_created as
select public.create_group(
 '17000000-0000-4000-8000-000000000001','17400000-0000-4000-8000-000000000001',
 '17500000-0000-4000-8000-000000000001',repeat('a',64),1,1,'  Racha　de　Teste  ',
 '01890f7e-e948-7c53-b13a-4a36e4b7d21e',1::smallint,
 '202122232425262728292a2b2c2d2e2f',
 'b44d03c9a10a8a4e3b5696ead1bbe81471f3e9eaa2b05ab888161d1c6093c2b9',
 '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104') as result;
select is(result->'outcome'->>'logical_result','group_created',
 'create_group conclui desfecho tipado') from invite_created;
select is(result->'current'->>'group_name','Racha de Teste',
 'nome criado é normalizado no banco') from invite_created;
select is((select count(*)::integer from public.group_invites
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e'),1,
 'convite inicial nasce na mesma transação');
select is((select max_uses from public.group_invites
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e'),100,
 'convite inicial tem cem usos');
select is((select token_digest from public.group_invites
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e'),
 'b44d03c9a10a8a4e3b5696ead1bbe81471f3e9eaa2b05ab888161d1c6093c2b9',
 'o banco guarda apenas o SHA-256 do token');
select is((public.preview_group_by_code(
 '17000000-0000-4000-8000-000000000002','17400000-0000-4000-8000-000000000002',
 '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104')->>'group_name'),
 'Racha de Teste','preview de código retorna só o nome');
select is((select used_count from public.group_invites
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e'),0,
 'preview não consome uso');
create temporary table invite_joined as
select public.join_by_code(
 '17000000-0000-4000-8000-000000000002','17400000-0000-4000-8000-000000000002',
 '17500000-0000-4000-8000-000000000002',repeat('b',64),1,1,
 '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104') as result;
select is(result->'outcome'->>'logical_result','membership_requested',
 'resgate por código cria pedido pendente') from invite_joined;
select is(result->'current'->>'status','pending',
 'resgate projeta apenas estado próprio pendente') from invite_joined;
select is((select used_count from public.group_invites
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e'),1,
 'resgate novo consome exatamente um uso');
select is((select count(*)::integer from public.group_members
 where profile_id='17100000-0000-4000-8000-000000000002' and status='pending'),1,
 'resgate novo cria uma membership pendente');
select is((public.join_by_code(
 '17000000-0000-4000-8000-000000000002','17400000-0000-4000-8000-000000000002',
 '17500000-0000-4000-8000-000000000002',repeat('b',64),1,1,
 '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104')
 ->'outcome'->>'logical_result'),'membership_requested',
 'replay conserva desfecho e não cria outra intenção');
select is((select used_count from public.group_invites
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e'),1,
 'replay não consome outro uso');
select is((public.get_my_pending_group_requests(
 '17000000-0000-4000-8000-000000000002','17400000-0000-4000-8000-000000000002')->0->>'group_name'),
 'Racha de Teste','pedido próprio pendente recebe o nome atual');
select is((public.get_invite_share_link(
 '17000000-0000-4000-8000-000000000001','17400000-0000-4000-8000-000000000001',
 '01890f7e-e948-7c53-b13a-4a36e4b7d21e')->>'nonce_hex'),
 '202122232425262728292a2b2c2d2e2f',
 'material interno de share fica disponível somente para autoridade');
select throws_ok($$select public.get_invite_share_link(
 '17000000-0000-4000-8000-000000000002','17400000-0000-4000-8000-000000000002',
 '01890f7e-e948-7c53-b13a-4a36e4b7d21e')$$,
 '42501','NOT_MEMBER','pendente não recebe material de share');


-- O perfil divergente é recusado antes de debitar; a prova consulta a linha,
-- além da exceção, para impedir um teste que também passaria com débito.
select throws_ok($$select public.check_and_debit_invite_attempt(
 '17100000-0000-4000-8000-000000000001',
 '17000000-0000-4000-8000-000000000002',
 '17400000-0000-4000-8000-000000000002')$$,
 '42501','FORBIDDEN','contexto de perfil divergente é recusado');
select is((select count(*)::integer from private.invite_rate_limits
 where profile_id='17100000-0000-4000-8000-000000000002'),0,
 'perfil divergente não debita a tentativa');
update private.app_limits set limit_value=2 where limit_key='invite_attempts_per_hour';
create temporary table rate_attempts as
select public.check_and_debit_invite_attempt(
 '17100000-0000-4000-8000-000000000002',
 '17000000-0000-4000-8000-000000000002',
 '17400000-0000-4000-8000-000000000002') as result
from generate_series(1,3);
select is((select count(*)::integer from rate_attempts where (result->>'allowed')::boolean),2,
 'N=2 admissões passam na configuração local explícita');
select is((select count(*)::integer from rate_attempts where not (result->>'allowed')::boolean),1,
 'tentativa N+1 é recusada');
select is((select count(*)::integer from private.invite_rate_limits
 where profile_id='17100000-0000-4000-8000-000000000002'),3,
 'N+1 também ocupa uma linha no orçamento');
select is((select result->>'allowed' from (
 select public.check_and_debit_invite_attempt(
 '17100000-0000-4000-8000-000000000002',
 '17000000-0000-4000-8000-000000000002',
 '17400000-0000-4000-8000-000000000002') as result) x),
 'false','tentativa após N+1 segue recusada');
select lives_ok($$select public.mark_invite_attempt_success(
 (select attempt_id from private.invite_rate_limits
  where profile_id='17100000-0000-4000-8000-000000000002'
  order by attempted_at,attempt_id limit 1),
 '17000000-0000-4000-8000-000000000002',
 '17400000-0000-4000-8000-000000000002')$$,
 'marcação de sucesso não altera o débito');
select is((select count(*)::integer from private.invite_rate_limits
 where profile_id='17100000-0000-4000-8000-000000000002' and result_class='success'),1,
 'marcação de sucesso é consultável para taxa manual');
select is((select count(*)::integer from private.invite_rate_limits
 where profile_id='17100000-0000-4000-8000-000000000002' and result_class='failure'),3,
 'quota recusada e tentativas não marcadas conservam failure');
select lives_ok($$select public.mark_invite_attempt_success(
 (select attempt_id from private.invite_rate_limits
  where profile_id='17100000-0000-4000-8000-000000000002'
    and result_class='success' limit 1),
 '17000000-0000-4000-8000-000000000002',
 '17400000-0000-4000-8000-000000000002')$$,
 'replay da marcação de sucesso não falha');
select is((select count(*)::integer from private.invite_rate_limits
 where profile_id='17100000-0000-4000-8000-000000000002' and result_class='success'),1,
 'replay da marcação não altera outra linha');
select throws_ok($$select public.mark_invite_attempt_success(
 (select attempt_id from private.invite_rate_limits
  where profile_id='17100000-0000-4000-8000-000000000002' limit 1),
 '17000000-0000-4000-8000-000000000001',
 '17400000-0000-4000-8000-000000000001')$$,
 '42501','FORBIDDEN','outro perfil não marca a tentativa');


-- M2-D42: cada causa terminal mantém seu erro mesmo quando o titular já
-- está pending. A ordem é inexistente, revogado, expirado, esgotado.
select throws_ok($$select public.preview_group_by_code(
 '17000000-0000-4000-8000-000000000002',
 '17400000-0000-4000-8000-000000000002',repeat('0',64))$$,
 '22023','CODE_INVALID','código inexistente não confirma convite');
update public.group_invites set expires_at=now()-interval '1 day'
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e';
select throws_ok($$select public.preview_group_by_code(
 '17000000-0000-4000-8000-000000000002',
 '17400000-0000-4000-8000-000000000002',
 '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104')$$,
 'P0001','INVITE_EXPIRED','preview distingue convite expirado');
select throws_ok($$select public.join_by_code(
 '17000000-0000-4000-8000-000000000002','17400000-0000-4000-8000-000000000002',
 '17500000-0000-4000-8000-000000000003',repeat('c',64),1,1,
 '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104')$$,
 'P0001','INVITE_EXPIRED','resgate pendente ainda recusa material expirado');
update public.group_invites set expires_at=now()+interval '1 day',used_count=max_uses
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e';
select throws_ok($$select public.preview_group_by_code(
 '17000000-0000-4000-8000-000000000002',
 '17400000-0000-4000-8000-000000000002',
 '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104')$$,
 'P0001','INVITE_USED','preview distingue convite esgotado');
select throws_ok($$select public.join_by_code(
 '17000000-0000-4000-8000-000000000002','17400000-0000-4000-8000-000000000002',
 '17500000-0000-4000-8000-000000000004',repeat('d',64),1,1,
 '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104')$$,
 'P0001','INVITE_USED','resgate pendente ainda recusa convite esgotado');
update public.group_invites set revoked_at=now()
 where id='01890f7e-e948-7c53-b13a-4a36e4b7d21e';
select throws_ok($$select public.preview_group_by_code(
 '17000000-0000-4000-8000-000000000002',
 '17400000-0000-4000-8000-000000000002',
 '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104')$$,
 'P0001','INVITE_REVOKED','revogação prevalece sobre expiração e esgotamento');
select throws_ok($$select public.join_by_code(
 '17000000-0000-4000-8000-000000000002','17400000-0000-4000-8000-000000000002',
 '17500000-0000-4000-8000-000000000005',repeat('e',64),1,1,
 '3f74864231a4de1049f1ed9ddbbb7afa998bd6ddd924799939003cc801633104')$$,
 'P0001','INVITE_REVOKED','resgate distingue revogação antes das outras causas');

select * from finish();
rollback;
