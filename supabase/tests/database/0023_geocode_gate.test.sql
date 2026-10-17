begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- Tabela: uma linha, sem texto, sem ator, sem privilégio
-- ---------------------------------------------------------------------------
select has_table('private', 'geocode_throttle', 'the shared clock lives in private');
select columns_are('private', 'geocode_throttle', array['id', 'last_slot_at']::name[],
  'the schedule keeps only the last reserved slot: no text, actor or result');
select is((select count(*)::integer from private.geocode_throttle), 1, 'exactly one row');
select throws_ok($$insert into private.geocode_throttle (id) values (false)$$,
  '23514', null, 'a second row cannot exist');
select is((select relrowsecurity from pg_class where oid = 'private.geocode_throttle'::regclass),
  false, 'private service table without RLS (docs/14 section 5.2)');

-- A 0024 trocou o portão por geocode_reserve (horários a 2 s); o teste do
-- portão novo está em 0024_geocode_reserve.test.sql.
select hasnt_function('public', 'geocode_gate', array['uuid', 'uuid', 'boolean'],
  'the 0023 gate is gone: a previous Edge fails closed instead of calling too fast');

-- Sonda negativa: nenhum papel cliente nem service_role toca a tabela.
set local role authenticated;
select throws_ok($$select * from private.geocode_throttle$$, '42501', null,
  'authenticated cannot read the clock');
reset role;
set local role service_role;
select throws_ok($$update private.geocode_throttle set last_slot_at = '-infinity'$$,
  '42501', null, 'service_role cannot move the schedule directly');
reset role;

select * from finish();
rollback;
