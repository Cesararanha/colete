begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select has_function('public', 'rename_group',
  array['uuid','uuid','uuid','text','integer','integer','uuid','text']::name[],
  'rename_group has the narrow internal signature');
select ok(not has_function_privilege('public',
  'public.rename_group(uuid,uuid,uuid,text,integer,integer,uuid,text)', 'execute'),
  'public cannot execute rename_group');
select ok(not has_function_privilege('anon',
  'public.rename_group(uuid,uuid,uuid,text,integer,integer,uuid,text)', 'execute'),
  'anon cannot execute rename_group');
select ok(not has_function_privilege('authenticated',
  'public.rename_group(uuid,uuid,uuid,text,integer,integer,uuid,text)', 'execute'),
  'authenticated cannot execute rename_group');
select ok(has_function_privilege('service_role',
  'public.rename_group(uuid,uuid,uuid,text,integer,integer,uuid,text)', 'execute'),
  'only the nominal service role executes rename_group');
select ok(not has_table_privilege('service_role','public.groups','SELECT,INSERT,UPDATE,DELETE'),
  'service_role has no direct group DML or SELECT');
select is((select provolatile from pg_proc
  where oid='public.rename_group(uuid,uuid,uuid,text,integer,integer,uuid,text)'::regprocedure),
  'v'::"char", 'rename_group is volatile');
select ok((select prosecdef from pg_proc
  where oid='public.rename_group(uuid,uuid,uuid,text,integer,integer,uuid,text)'::regprocedure),
  'rename_group is security definer');
select ok((select pg_get_functiondef(oid) like '%private.normalize_group_name(p_name)%'
  from pg_proc where oid='public.rename_group(uuid,uuid,uuid,text,integer,integer,uuid,text)'::regprocedure),
  'rename_group calls the shared SQL name normalizer');
select ok((select pg_get_functiondef(oid) like '%private.normalize_group_name(p_name)%'
  from pg_proc where oid='public.create_group(uuid,uuid,uuid,text,integer,integer,text,uuid,smallint,text,text,text)'::regprocedure),
  'create_group calls that same SQL name normalizer');
select ok((select pg_get_functiondef(oid) like '%for no key update%'
  from pg_proc where oid='public.rename_group(uuid,uuid,uuid,text,integer,integer,uuid,text)'::regprocedure),
  'domain locks retain the M2-D13 mode');
select lives_ok($$select private.validate_idempotency_outcome('rename_group',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_renamed"}'::jsonb)$$,
  'the exact safe rename outcome is valid');
select throws_ok($$select private.validate_idempotency_outcome('rename_group',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"group_renamed","group_name":"private"}'::jsonb)$$,
  '22023','VALIDATION','name cannot be stored in the outcome');
select throws_ok($$select private.validate_idempotency_outcome('rename_group',
  '{"group_id":"01890f7e-e948-4c53-b13a-4a36e4b7d21e","logical_result":"wrong"}'::jsonb)$$,
  '22023','VALIDATION','the logical result is closed');
select throws_ok($$select private.validate_idempotency_outcome('rename_group',
  '{"group_id":"not-a-uuid","logical_result":"group_renamed"}'::jsonb)$$,
  '22023','VALIDATION','the resource ID is canonical');

select * from finish();
rollback;
