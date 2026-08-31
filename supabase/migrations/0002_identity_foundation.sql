begin;

-- B2 slice 1: extensions, safe helpers and internal profiles.
-- Sources: docs/10-schema-db.md sections 1, 2 and 11; docs/16-roadmap.md section 3.

-- pgcrypto is preinstalled by the Supabase image, but the database must come up
-- from the migrations alone. Declaring it here makes the dependency explicit and
-- stays a no-op where the platform already provides it. It is required by the
-- idempotency HMAC of docs/13-contratos-funcoes.md section 0.1 and by the invite
-- MAC of section 5. Keys are never stored here: they travel as a call parameter
-- from the vault, per docs/14-convencoes-app.md section 5.
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Operational limits
-- ---------------------------------------------------------------------------
-- Closes the roadmap section 2 gate that required file, claim cooldown and
-- dispatcher retry limits to exist before the migration that uses them. Typed
-- columns on purpose: a jsonb value column would need an entry in the authorized
-- JSON keys table of docs/17-mapa-dados-lgpd.md section 3 and would weaken the
-- catalog scanner that must find every JSON column exactly once.

create table private.app_limits (
  limit_key   text primary key,
  limit_value bigint not null check (limit_value >= 0),
  unit        text not null check (unit in ('bytes', 'seconds', 'attempts')),
  notes       text not null,
  updated_at  timestamptz not null default now()
);

comment on table private.app_limits is
  'Operational calibration values. No personal data; classified in docs/17-mapa-dados-lgpd.md.';

create table private.allowed_proof_mime_types (
  mime_type text primary key check (mime_type ~ '^[a-z]+/[a-z0-9.+-]+$')
);

comment on table private.allowed_proof_mime_types is
  'Allowlist of proof upload media types, from docs/13-contratos-funcoes.md section 2.1.';

insert into private.app_limits (limit_key, limit_value, unit, notes) values
  ('proof_max_bytes', 10485760, 'bytes',
   'Largest accepted payment proof. Initial calibration, review during the pilot.'),
  ('claim_cooldown_seconds', 300, 'seconds',
   'Minimum interval before the same profile may claim an open slot again after '
   'releasing or losing one. Not the claim reservation window, which is held in '
   'slot_claims.expires_at. Initial calibration, review during the pilot.'),
  ('auth_session_max_lifetime_seconds', 7776000, 'seconds',
   'Maximum Auth session lifetime. Initial calibration, review during the pilot. '
   'Must change together with [auth.sessions].timebox in supabase/config.toml, never alone.'),
  ('notification_dispatch_max_attempts', 6, 'attempts',
   'Delivery attempts before a notification delivery moves to dead-letter and alerts.'),
  ('notification_dispatch_backoff_base_seconds', 60, 'seconds',
   'First retry delay for the notification dispatcher; grows exponentially.'),
  ('notification_dispatch_backoff_cap_seconds', 3600, 'seconds',
   'Upper bound of the notification dispatcher backoff.');

insert into private.allowed_proof_mime_types (mime_type) values
  ('image/jpeg'),
  ('image/png'),
  ('image/webp'),
  ('application/pdf');

alter table private.app_limits enable row level security;
alter table private.app_limits force row level security;
alter table private.allowed_proof_mime_types enable row level security;
alter table private.allowed_proof_mime_types force row level security;

revoke all on table private.app_limits from public, anon, authenticated;
revoke all on table private.allowed_proof_mime_types from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal identity
-- ---------------------------------------------------------------------------
-- docs/10-schema-db.md section 2. profiles.id is the internal identity and
-- outlives the Auth user: deleting Auth must not delete history (principle 6).

create table public.profiles (
  id                uuid primary key default gen_random_uuid(),
  auth_user_id      uuid unique references auth.users (id) on delete set null,
  name              text not null,
  nickname          text,
  photo_url         text,
  position          text check (position in
                     ('goalkeeper', 'defender', 'midfielder', 'forward')),
  dominant_foot     text check (dominant_foot in ('left', 'right', 'both')),
  shirt_number      int,
  account_status    text not null default 'active'
                    check (account_status in
                           ('active', 'suspended', 'banned', 'deletion_pending', 'deleted')),
  status_changed_at timestamptz,
  deidentified_at   timestamptz,
  created_at        timestamptz not null default now(),
  constraint profiles_lifecycle_check check (
       (account_status in ('active', 'suspended', 'banned')
        and auth_user_id is not null and deidentified_at is null)
    or (account_status = 'deletion_pending' and deidentified_at is null)
    or (account_status = 'deleted'
        and auth_user_id is null and deidentified_at is not null)
  )
);

comment on table public.profiles is
  'Internal identity. Survives Auth deletion so history keeps a stable subject.';

alter table public.profiles enable row level security;
alter table public.profiles force row level security;

revoke all on table public.profiles from public, anon, authenticated;

-- Read is own row only. Every other profile reaches a client through the
-- public_profiles projection of docs/10-schema-db.md section 11, which arrives
-- with the groups slice. There is deliberately no insert, update or delete
-- policy: writes go through RPC (principle 2).
grant select on table public.profiles to authenticated;

create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using (auth_user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Safe helpers
-- ---------------------------------------------------------------------------
-- All security invoker: none of them is reachable by a client role, and they are
-- the building blocks that future security definer RPCs compose. Nothing here
-- needs elevated rights of its own, so nothing here asks for them.

create or replace function private.current_session_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select nullif(auth.jwt() ->> 'session_id', '')::uuid;
$function$;

comment on function private.current_session_id() is
  'GoTrue session_id claim of the caller, used by the revocation denylist.';

revoke all on function private.current_session_id() from public, anon, authenticated;

create or replace function private.current_profile_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select profile.id
  from public.profiles as profile
  where profile.auth_user_id = auth.uid();
$function$;

comment on function private.current_profile_id() is
  'Resolves auth.uid() to the internal profiles.id. Null when there is no profile.';

revoke all on function private.current_profile_id() from public, anon, authenticated;

create or replace function private.require_profile_id()
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  resolved_profile_id uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;

  select profile.id
  into resolved_profile_id
  from public.profiles as profile
  where profile.auth_user_id = auth.uid();

  if resolved_profile_id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;

  return resolved_profile_id;
end;
$function$;

comment on function private.require_profile_id() is
  'Internal identity of the caller, refusing an unauthenticated or unlinked context.';

revoke all on function private.require_profile_id() from public, anon, authenticated;

create or replace function private.require_active_profile()
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  caller public.profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;

  select *
  into caller
  from public.profiles as profile
  where profile.auth_user_id = auth.uid();

  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;

  -- A pending or finished deletion loses every domain authority from the commit
  -- that set it, even while an old JWT is still inside its validity window.
  if caller.account_status in ('deletion_pending', 'deleted') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  -- Suspension and ban block mutation. They do not block the caller's own reads,
  -- export or appeal channels, which is why this guard is called by mutations
  -- and not by projections.
  if caller.account_status in ('suspended', 'banned') then
    raise exception using errcode = '42501', message = 'PROFILE_SUSPENDED';
  end if;

  return caller.id;
end;
$function$;

comment on function private.require_active_profile() is
  'Account-status half of the common guard. The revoked-session half arrives with '
  'the revocation denylist in the next slice.';

revoke all on function private.require_active_profile() from public, anon, authenticated;

commit;
