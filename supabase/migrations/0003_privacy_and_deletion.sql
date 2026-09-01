begin;

-- B2 slice 2: policy acceptance, session revocation, titular requests, data
-- exports and the account deletion saga.
-- Sources: docs/10-schema-db.md section 2 and the RLS table of section 11;
-- docs/13-contratos-funcoes.md sections 5.2 and 5.3;
-- docs/17-mapa-dados-lgpd.md section 2.
--
-- This slice creates tables, constraints, policies and guards only. The RPCs
-- accept_policies, request_data_export, revoke_current_session and
-- delete_account belong to the RPC slice, because every mutation must first win
-- a transactional idempotency key and idempotency_records arrives in slice 7.

-- ---------------------------------------------------------------------------
-- Policy acceptance
-- ---------------------------------------------------------------------------
-- The unique key is the whole idempotency of acceptance: re-accepting the same
-- document version is a no-op instead of a second record.

create table public.policy_acceptances (
  id            bigint generated always as identity primary key,
  profile_id    uuid not null references public.profiles,
  document_type text not null check (document_type in ('terms', 'privacy')),
  version       text not null,
  accepted_at   timestamptz not null default now(),
  source        text not null check (source in ('signup', 'reauth')),
  unique (profile_id, document_type, version)
);

comment on table public.policy_acceptances is
  'Evidence that a person accepted a given terms or privacy version.';

-- ---------------------------------------------------------------------------
-- Titular requests
-- ---------------------------------------------------------------------------

create table public.privacy_requests (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid references public.profiles,
  kind        text not null
              check (kind in ('access', 'correction', 'deletion', 'objection', 'information')),
  status      text not null default 'open'
              check (status in ('open', 'in_progress', 'resolved', 'denied')),
  response    text,
  opened_at   timestamptz not null default now(),
  resolved_at timestamptz
);

comment on table public.privacy_requests is
  'Data subject rights channel. profile_id stays nullable so a request can '
  'outlive or precede the profile it is about.';

-- ---------------------------------------------------------------------------
-- Session revocation
-- ---------------------------------------------------------------------------
-- Covers a deliberate logout. Losing every session at once is covered instead by
-- the deletion_pending account status, which no old JWT can talk past.
--
-- This table lives in private, and deliberately does NOT use row level security.
-- No client role reads it, so its protection is the absence of any grant plus the
-- absence of USAGE on the private schema. Putting it in public behind
-- force row level security with zero policies would look stricter and be weaker:
-- force applies to the table owner too, so a security definer function owned by a
-- role without BYPASSRLS would read zero rows, the exists() below would be false,
-- and a revoked session would be accepted as valid. A denylist has to be readable
-- by the code that enforces it, or failing closed becomes failing open.

create table private.revoked_auth_sessions (
  session_id uuid primary key,
  profile_id uuid not null references public.profiles,
  revoked_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > revoked_at)
);

comment on table private.revoked_auth_sessions is
  'Denylist of GoTrue session_id claims. Rows are dropped after the maximum JWT '
  'expiry, so the table stays bounded.';

-- ---------------------------------------------------------------------------
-- Account deletion saga
-- ---------------------------------------------------------------------------
-- The database, Auth and Storage do not share a transaction, so deletion is a
-- saga. auth_user_id deliberately carries NO foreign key: the row must survive
-- the Auth user it points at, and it is the only place that identifier lives
-- until step 4 finishes.

create table public.deletion_requests (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null unique references public.profiles,
  auth_user_id    uuid,
  status          text not null default 'requested'
                  check (status in ('requested', 'cleaning_storage', 'deleting_auth',
                                    'finalizing', 'completed', 'failed_retryable')),
  attempts        int not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  last_error_code text,
  requested_at    timestamptz not null default now(),
  auth_deleted_at timestamptz,
  completed_at    timestamptz,
  constraint deletion_requests_completion_check check (
       (status = 'completed' and completed_at is not null and auth_user_id is null)
    or (status <> 'completed' and completed_at is null and auth_user_id is not null)
  )
);

comment on table public.deletion_requests is
  'Account deletion saga state. Restricted to the worker; the titular sees only '
  'a minimal status projection.';

comment on column public.deletion_requests.auth_user_id is
  'Intentionally without a foreign key: the saga must outlive the Auth user.';

-- ---------------------------------------------------------------------------
-- Data exports
-- ---------------------------------------------------------------------------
-- The state machine is what makes the one-shot download representable: only the
-- ready row carries a path, and downloaded is either still holding the artifact
-- or already purged, never both and never neither.

create table public.data_exports (
  id                 uuid primary key default gen_random_uuid(),
  privacy_request_id uuid not null unique references public.privacy_requests,
  profile_id         uuid not null references public.profiles,
  status             text not null default 'queued'
                     check (status in ('queued', 'building', 'ready', 'downloaded',
                                       'cleanup_pending', 'expired', 'failed')),
  storage_path       text unique,
  content_digest     text,
  ready_at           timestamptz,
  expires_at         timestamptz,
  downloaded_at      timestamptz,
  purged_at          timestamptz,
  created_at         timestamptz not null default now(),
  constraint data_exports_state_check check (
       (status in ('queued', 'building') and storage_path is null and content_digest is null
        and ready_at is null and expires_at is null and downloaded_at is null
        and purged_at is null)
    or (status = 'ready' and storage_path is not null and content_digest is not null
        and ready_at is not null and expires_at is not null and downloaded_at is null
        and purged_at is null)
    or (status = 'downloaded' and ready_at is not null and expires_at is not null
        and downloaded_at is not null
        and ((storage_path is not null and content_digest is not null and purged_at is null)
          or (storage_path is null and content_digest is null and purged_at is not null)))
    or (status = 'cleanup_pending' and storage_path is not null
        and content_digest is not null and ready_at is not null and expires_at is not null
        and purged_at is null)
    or (status in ('expired', 'failed') and storage_path is null and content_digest is null
        and purged_at is not null)
  ),
  constraint data_exports_expiry_check check (
    expires_at is null or expires_at <= ready_at + interval '24 hours'
  )
);

comment on table public.data_exports is
  'ZIP export artifacts. The file is served by an authenticated stream; there is '
  'never a signed URL, and the path never reaches a client.';

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.policy_acceptances enable row level security;
alter table public.policy_acceptances force row level security;
alter table public.privacy_requests enable row level security;
alter table public.privacy_requests force row level security;
alter table public.deletion_requests enable row level security;
alter table public.deletion_requests force row level security;
alter table public.data_exports enable row level security;
alter table public.data_exports force row level security;

revoke all on table public.policy_acceptances from public, anon, authenticated;
revoke all on table public.privacy_requests from public, anon, authenticated;
revoke all on table private.revoked_auth_sessions from public, anon, authenticated;
revoke all on table public.deletion_requests from public, anon, authenticated;
revoke all on table public.data_exports from public, anon, authenticated;

-- Read is own row on the four tables the titular is entitled to see. There is no
-- write policy anywhere in this slice: every mutation goes through an RPC.
grant select on table public.policy_acceptances to authenticated;
grant select on table public.privacy_requests to authenticated;
grant select on table public.deletion_requests to authenticated;
grant select on table public.data_exports to authenticated;

-- private.revoked_auth_sessions gets no grant at all and is not in public. It is
-- a service table; the aggregate session state the titular is allowed to see
-- arrives as a projection with the RPC slice.

create policy policy_acceptances_select_own
  on public.policy_acceptances
  for select
  to authenticated
  using (
    profile_id = (
      select profile.id from public.profiles as profile
      where profile.auth_user_id = (select auth.uid())
    )
  );

create policy privacy_requests_select_own
  on public.privacy_requests
  for select
  to authenticated
  using (
    profile_id = (
      select profile.id from public.profiles as profile
      where profile.auth_user_id = (select auth.uid())
    )
  );

create policy deletion_requests_select_own
  on public.deletion_requests
  for select
  to authenticated
  using (
    profile_id = (
      select profile.id from public.profiles as profile
      where profile.auth_user_id = (select auth.uid())
    )
  );

create policy data_exports_select_own
  on public.data_exports
  for select
  to authenticated
  using (
    profile_id = (
      select profile.id from public.profiles as profile
      where profile.auth_user_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

create or replace function private.is_session_revoked()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  select case
    -- Fail closed. On a privileged path, a token that carries no session_id is a
    -- token whose revocation cannot be checked, and that is a denial.
    when private.current_session_id() is null then true
    else exists (
      select 1
      from private.revoked_auth_sessions as revoked
      where revoked.session_id = private.current_session_id()
    )
  end;
$function$;

comment on function private.is_session_revoked() is
  'True when the caller session is revoked or cannot be identified. Security '
  'invoker: every caller is a server-side path already running as the owner.';

revoke all on function private.is_session_revoked() from public, anon, authenticated;

create or replace function private.require_domain_authority()
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;

  -- A revoked session reports UNAUTHENTICATED rather than a new error code: the
  -- credential itself stopped being valid and the client has to sign in again.
  -- docs/13-contratos-funcoes.md section 8 is the single authority for error
  -- codes, and it has no code for this case.
  if private.is_session_revoked() then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;

  return private.require_active_profile();
end;
$function$;

comment on function private.require_domain_authority() is
  'The common guard every mutating RPC must pass: authenticated, session not '
  'revoked, account not suspended, banned, deletion_pending or deleted.';

revoke all on function private.require_domain_authority() from public, anon, authenticated;

commit;
