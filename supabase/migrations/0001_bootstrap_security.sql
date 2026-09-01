begin;

-- PostgreSQL 17 already provides gen_random_uuid(); M0-A needs no additional extension.
-- Domain tables intentionally start in migration 0002 or later.
create schema if not exists private;

comment on schema private is
  'Server-only helpers and implementation details. Never expose through the Data API.';

revoke all on schema private from public;
revoke all on schema private from anon, authenticated;
revoke create on schema public from public, anon, authenticated;

-- EXECUTE is granted to PUBLIC by PostgreSQL's global function defaults. A
-- schema-scoped REVOKE cannot override that global default, so remove it at
-- the role level before applying the narrower schema defaults below.
alter default privileges for role postgres
  revoke execute on functions from public;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

alter default privileges for role postgres in schema private
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema private
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema private
  revoke execute on functions from public, anon, authenticated;

create or replace function private.current_auth_user_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select auth.uid();
$function$;

comment on function private.current_auth_user_id() is
  'Returns the authenticated Supabase Auth identifier without granting client execution.';

revoke all on function private.current_auth_user_id() from public, anon, authenticated;

create or replace function private.require_authenticated()
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  authenticated_user_id uuid := auth.uid();
begin
  if authenticated_user_id is null then
    raise exception using
      errcode = '28000',
      message = 'UNAUTHENTICATED';
  end if;

  return authenticated_user_id;
end;
$function$;

comment on function private.require_authenticated() is
  'Foundational server-only authentication guard for future hardened RPC functions.';

revoke all on function private.require_authenticated() from public, anon, authenticated;

commit;
