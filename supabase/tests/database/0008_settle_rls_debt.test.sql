begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ---------------------------------------------------------------------------
-- The two tables no longer carry RLS
-- ---------------------------------------------------------------------------

select ok(
  not (select relrowsecurity from pg_class where oid = 'private.app_limits'::regclass),
  'app_limits no longer has RLS enabled'
);
select ok(
  not (select relforcerowsecurity from pg_class where oid = 'private.app_limits'::regclass),
  'app_limits no longer forces RLS on its owner'
);
select ok(
  not (select relrowsecurity from pg_class
       where oid = 'private.allowed_proof_mime_types'::regclass),
  'allowed_proof_mime_types no longer has RLS enabled'
);
select ok(
  not (select relforcerowsecurity from pg_class
       where oid = 'private.allowed_proof_mime_types'::regclass),
  'allowed_proof_mime_types no longer forces RLS on its owner'
);
select is(
  (select count(*) from pg_policies
   where schemaname = 'private'
     and tablename in ('app_limits', 'allowed_proof_mime_types')),
  0::bigint,
  'removing RLS did not smuggle in a policy to replace it'
);

-- ---------------------------------------------------------------------------
-- Nothing else was touched
-- ---------------------------------------------------------------------------
-- docs/14-convencoes-app.md section 5.2: public + enable/force + policy is for
-- tables with an authorised direct reader. Those five keep exactly what they
-- had, and no private table has RLS any more.

select set_eq(
  $$select n.nspname || '.' || c.relname
      from pg_class as c
      join pg_namespace as n on n.oid = c.relnamespace
     where n.nspname in ('public', 'private')
       and c.relkind in ('r', 'p')
       and c.relrowsecurity$$,
  $$select * from (values
      ('public.profiles'::text),
      ('public.policy_acceptances'),
      ('public.privacy_requests'),
      ('public.deletion_requests'),
      ('public.data_exports')) as still_protected(name)$$,
  'RLS still covers exactly the public tables that have an authorised reader'
);
select is(
  (select count(*) from pg_class as c
   join pg_namespace as n on n.oid = c.relnamespace
   where n.nspname = 'private' and c.relkind in ('r', 'p') and c.relrowsecurity),
  0::bigint,
  'no table in the private schema relies on RLS'
);

-- ---------------------------------------------------------------------------
-- What actually protects them
-- ---------------------------------------------------------------------------

select ok(
  not has_schema_privilege('anon', 'private', 'usage'),
  'anon has no USAGE on the private schema'
);
select ok(
  not has_schema_privilege('authenticated', 'private', 'usage'),
  'authenticated has no USAGE on the private schema'
);
select ok(
  not has_schema_privilege('service_role', 'private', 'usage'),
  'service_role has no USAGE on the private schema'
);
select is(
  (select count(*)
   from information_schema.role_table_grants
   where table_schema = 'private'
     and table_name in ('app_limits', 'allowed_proof_mime_types')
     and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')),
  0::bigint,
  'the revocations of 0002 and 0004 still leave no grant on either table'
);

set local role anon;
select throws_ok(
  'select * from private.app_limits',
  '42501', null, 'anon still cannot reach app_limits'
);
select throws_ok(
  'select * from private.allowed_proof_mime_types',
  '42501', null, 'anon still cannot reach allowed_proof_mime_types'
);
reset role;

set local role authenticated;
select throws_ok(
  'select * from private.app_limits',
  '42501', null, 'authenticated still cannot reach app_limits'
);
reset role;

set local role service_role;
select throws_ok(
  'select * from private.app_limits',
  '42501', null, 'service_role still cannot reach app_limits'
);
select throws_ok(
  'select * from private.allowed_proof_mime_types',
  '42501', null, 'service_role still cannot reach allowed_proof_mime_types'
);
reset role;

-- ---------------------------------------------------------------------------
-- The two barriers, isolated one at a time
-- ---------------------------------------------------------------------------
-- Asserting a denial proves nothing about which barrier produced it. These
-- grants are handed out and taken back inside this transaction, one layer at a
-- time, so each denial is attributed to the privilege that actually caused it.

set local role anon;
select throws_ok(
  'select * from private.app_limits',
  '42501', null, 'with neither privilege, the schema is what denies'
);
reset role;

grant usage on schema private to anon;
set local role anon;
select throws_ok(
  'select * from private.app_limits',
  '42501', null, 'with USAGE but no table grant, the table privilege is what denies'
);
reset role;

grant select on table private.app_limits to anon;
set local role anon;
select isnt_empty(
  $$select 1 from private.app_limits$$,
  'with both privileges the rows are readable, so grants were the whole barrier'
);
-- The value, not just a row count: the harm this migration removes is a limit
-- that reads as absent instead of as itself. Under force RLS with no policy the
-- query below returned null.
select is(
  (select limit_value from private.app_limits where limit_key = 'proof_max_bytes'),
  10485760::bigint,
  'and a granted reader sees the real value of a limit, not a null'
);
reset role;

revoke select on table private.app_limits from anon;
revoke usage on schema private from anon;
set local role anon;
select throws_ok(
  'select * from private.app_limits',
  '42501', null, 'taking the grants back restores the denial'
);
reset role;

-- The same experiment before this migration returned zero rows at the step
-- above instead of seven: with force row level security and no policy, a reader
-- holding every privilege still saw nothing. For a table read as configuration
-- that is not protection, it is a limit silently reading as absent. Removing
-- RLS is what makes a granted reader see the real value.
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.profiles'::regclass),
  'force RLS stays where it belongs: a public table with a real policy'
);
select isnt_empty(
  $$select 1 from pg_policies
     where schemaname = 'public' and tablename = 'profiles'$$,
  'and that table has the policy that makes forcing RLS meaningful'
);

select * from finish();

rollback;
