begin;

create extension if not exists pgtap with schema extensions;

select plan(13);

select has_schema('private', 'private server schema exists');
select has_function(
  'private',
  'current_auth_user_id',
  array[]::name[],
  'current_auth_user_id helper exists'
);
select has_function(
  'private',
  'require_authenticated',
  array[]::name[],
  'require_authenticated helper exists'
);
select function_lang_is(
  'private',
  'current_auth_user_id',
  array[]::name[],
  'sql',
  'current_auth_user_id uses SQL'
);
select function_lang_is(
  'private',
  'require_authenticated',
  array[]::name[],
  'plpgsql',
  'require_authenticated uses PL/pgSQL'
);

select ok(
  not has_schema_privilege('anon', 'private', 'usage'),
  'anon cannot use the private schema'
);
select ok(
  not has_schema_privilege('authenticated', 'private', 'usage'),
  'authenticated cannot use the private schema'
);
select ok(
  not has_schema_privilege('anon', 'public', 'create'),
  'anon cannot create objects in public'
);
select ok(
  not has_schema_privilege('authenticated', 'public', 'create'),
  'authenticated cannot create objects in public'
);
select ok(
  not has_function_privilege('anon', 'private.current_auth_user_id()', 'execute'),
  'anon cannot execute the private identity helper'
);
select ok(
  not has_function_privilege('authenticated', 'private.require_authenticated()', 'execute'),
  'authenticated cannot execute the private guard directly'
);

select throws_ok(
  'select private.require_authenticated()',
  '28000',
  'UNAUTHENTICATED',
  'the server-side guard rejects a missing authentication context'
);

create function public.m0a_default_privilege_probe()
returns integer
language sql
set search_path = ''
as $function$
  select 1;
$function$;

select ok(
  not has_function_privilege('anon', 'public.m0a_default_privilege_probe()', 'execute'),
  'new public functions are not executable through default PUBLIC privileges'
);

select * from finish();

rollback;
