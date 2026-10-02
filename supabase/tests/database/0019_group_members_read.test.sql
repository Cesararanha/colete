begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select has_function('public','get_group_members',array['uuid','uuid','uuid']::name[],'narrow member read signature');
select is((select pg_get_function_result('public.get_group_members(uuid,uuid,uuid)'::regprocedure)),
 'TABLE(profile_id uuid, display_name text, role text, status text)','exact four-field typed projection');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc
 where oid='public.get_group_members(uuid,uuid,uuid)'::regprocedure),'fixed search_path and definer');
select ok(not has_function_privilege('public','public.get_group_members(uuid,uuid,uuid)','execute'),'public cannot invoke internal read');
select ok(not has_function_privilege('anon','public.get_group_members(uuid,uuid,uuid)','execute'),'anon cannot invoke internal read');
select ok(not has_function_privilege('authenticated','public.get_group_members(uuid,uuid,uuid)','execute'),'client cannot spoof actor');
select ok(has_function_privilege('service_role','public.get_group_members(uuid,uuid,uuid)','execute'),'Edge has nominal execute');
select ok(not has_table_privilege('service_role','public.profiles','SELECT,INSERT,UPDATE,DELETE'),'service role receives no direct profile access');
select is((select count(*)::integer from pg_policy where polrelid='public.profiles'::regclass),1,'exactly one profile policy');
select is((select polname::text from pg_policy where polrelid='public.profiles'::regclass),'profiles_select_own','own policy preserved');
select is((select pg_get_expr(polqual,polrelid) from pg_policy where polrelid='public.profiles'::regclass),
 $$((auth_user_id = ( SELECT auth.uid() AS uid)) AND (account_status <> ALL (ARRAY['deletion_pending'::text, 'deleted'::text])))$$,'own-only predicate unchanged');
select is((select polcmd::text from pg_policy where polrelid='public.profiles'::regclass),'r','profile policy only SELECT');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.profiles'::regclass),'profile RLS remains enabled and forced');
select ok(not has_table_privilege('anon','public.profiles','SELECT'),'anon still cannot read profiles');
select ok(not (select rolbypassrls from pg_roles where rolname='authenticated'),'client probe has no BYPASSRLS');
-- Catalog contraproof: broadening the predicate invalidates the exact assertion.
alter policy profiles_select_own on public.profiles using (true);
select isnt((select pg_get_expr(polqual,polrelid) from pg_policy where polrelid='public.profiles'::regclass),
 $$((auth_user_id = ( SELECT auth.uid() AS uid)) AND (account_status <> ALL (ARRAY['deletion_pending'::text, 'deleted'::text])))$$,'widened profile policy fails baseline');
select * from finish();
rollback;
