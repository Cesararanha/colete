begin;

-- M1-A, slice 2: the operational tables the sagas, jobs and retention routines
-- need before any RPC can exist.
-- Sources: docs/10-schema-db.md sections 9 and 12; docs/13-contratos-funcoes.md
-- section 7; docs/17-mapa-dados-lgpd.md sections 3 and 4.
--
-- No worker, job or RPC is created here. This migration creates state and the
-- validator that closes the only JSON column it introduces. Every table lives in
-- private with no grants and no RLS, per docs/14-convencoes-app.md section 5.2:
-- no client role reads them, so the boundary is the absence of USAGE on the
-- schema plus the absence of any grant. The revocations of 0004 already cover
-- service_role through ALTER DEFAULT PRIVILEGES; this migration does not repeat
-- them, it proves in pgTAP that the new tables are born without privilege.

-- ---------------------------------------------------------------------------
-- External effects
-- ---------------------------------------------------------------------------
-- docs/10-schema-db.md section 9. Auth, Storage and export do not share the
-- database transaction, so an external effect is never executed inside the
-- idempotent promise: the mutation only inserts a row here, and a worker with
-- its own lease and reconciliation runs the saga. dedupe_key is what makes the
-- retry safe, so it is unique and mandatory.

create table private.external_effects (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in
                  ('delete_auth_user', 'delete_storage_object', 'build_data_export',
                   'delete_data_export', 'purge_proof_object')),
  resource_type   text not null check (resource_type ~ '^[a-z][a-z0-9_]{0,62}$'),
  resource_id     uuid not null,
  dedupe_key      text not null unique check (length(dedupe_key) between 1 and 200),
  status          text not null default 'pending'
                  check (status in ('pending', 'leased', 'succeeded', 'failed_retryable', 'dead')),
  attempts        int not null default 0 check (attempts >= 0),
  lease_until     timestamptz,
  next_attempt_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,62}$'),
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  check ((status in ('succeeded', 'dead')) = (completed_at is not null)),
  check (completed_at is null or completed_at >= created_at)
);

comment on table private.external_effects is
  'Outbox of effects that live outside the database transaction. The mutation inserts the intent; a worker executes the saga by dedupe_key.';
comment on column private.external_effects.dedupe_key is
  'Identity of the intent, not of the attempt. Retrying the same effect must reuse it so the saga stays idempotent.';
comment on column private.external_effects.last_error_code is
  'Normalized code only. Provider messages, paths, tokens and personal data never land here.';

create index external_effects_due_idx
  on private.external_effects (status, next_attempt_at);

-- ---------------------------------------------------------------------------
-- Job runs
-- ---------------------------------------------------------------------------
-- docs/10-schema-db.md section 9 and docs/13-contratos-funcoes.md section 7.
-- run_key is the idempotency of a run: cron:<job>:<slot> for a scheduled slot
-- and request:<uuid> for the human action of section 7.1.
--
-- match_id is deliberately nullable and deliberately carries NO foreign key:
-- public.matches does not exist yet. The migration that creates matches adds and
-- tests the FK. docs/10-schema-db.md section 9 states this as explicit
-- deployment ordering, not a permanent relaxation of integrity.

create table private.job_runs (
  id            bigint generated always as identity primary key,
  run_key       text unique not null,
  job_name      text not null check (job_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  match_id      uuid,
  triggered_by  text not null check (triggered_by in ('cron', 'organizer', 'admin', 'system')),
  requested_by  uuid references public.profiles (id) on update restrict on delete restrict,
  scheduled_for timestamptz not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null check (status in ('running', 'succeeded', 'failed')),
  error_code    text check (error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,62}$'),
  summary       jsonb not null default
                '{"scanned":0,"changed":0,"skipped":0,"failed":0,"stale":0,"duration_ms":0}'::jsonb,
  check ((triggered_by in ('organizer', 'admin')) = (requested_by is not null)),
  -- The request half accepts any canonical lowercase UUID. Pinning the version
  -- and variant nibbles would reject a request_id the contract allows: docs/13
  -- section 0 lets the client generate it, and the UUID both normative
  -- documents use as their worked example is a v7.
  check (run_key ~ '^cron:[a-z][a-z0-9_]{0,62}:[0-9A-Za-z:_.+-]{1,64}$'
      or run_key ~ '^request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  check ((status = 'running') = (finished_at is null)),
  check (error_code is null or status = 'failed'),
  check (finished_at is null or finished_at >= started_at)
);

comment on table private.job_runs is
  'One row per job execution. run_key makes a repeated cron slot or a repeated human request a no-op instead of a second run.';
comment on column private.job_runs.match_id is
  'Nullable and without a foreign key on purpose: public.matches arrives in a later slice, which adds and tests the constraint.';
comment on column private.job_runs.summary is
  'Closed counter shape from docs/17-mapa-dados-lgpd.md section 3. Never a list of personal identifiers.';

create index job_runs_job_name_started_at_idx
  on private.job_runs (job_name, started_at desc);

-- ---------------------------------------------------------------------------
-- Retention runs
-- ---------------------------------------------------------------------------
-- docs/17-mapa-dados-lgpd.md section 4, item 7: each purge execution records
-- only the policy name, the window, counts, failures and duration. No identifier
-- of what was purged, because that would recreate the data the purge removed.

create table private.retention_runs (
  id           bigint generated always as identity primary key,
  policy       text not null check (policy ~ '^[a-z][a-z0-9_]{0,62}$'),
  window_start timestamptz not null,
  window_end   timestamptz not null,
  scanned      int not null check (scanned >= 0),
  purged       int not null check (purged >= 0),
  failed       int not null check (failed >= 0),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  check (window_start <= window_end),
  check (purged <= scanned),
  check (finished_at is null or finished_at >= started_at)
);

comment on table private.retention_runs is
  'Evidence that a retention policy ran over a window. Counts only; it never names the subjects it purged.';

-- ---------------------------------------------------------------------------
-- The only JSON column this slice introduces
-- ---------------------------------------------------------------------------
-- docs/17-mapa-dados-lgpd.md section 3: JSON is not an escape from the
-- inventory. Every json/jsonb column of the application schemas needs a
-- registered validator, and the pgTAP census of this slice fails when a new
-- column appears without one.

create or replace function private.validate_job_summary(p_summary jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_counter text;
  v_value jsonb;
  v_cursor text;
begin
  if p_summary is null
     or jsonb_typeof(p_summary) <> 'object'
     or octet_length(p_summary::text) > 1024 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  -- The six counters are mandatory; cursor is the only optional key. Anything
  -- else is an unknown key and is rejected before it can carry an identifier.
  if (select array_agg(key order by key) from jsonb_object_keys(p_summary) as key)
       is distinct from array['changed', 'duration_ms', 'failed', 'scanned',
                             'skipped', 'stale']::text[]
     and (select array_agg(key order by key) from jsonb_object_keys(p_summary) as key)
       is distinct from array['changed', 'cursor', 'duration_ms', 'failed', 'scanned',
                             'skipped', 'stale']::text[] then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  foreach v_counter in array
    array['scanned', 'changed', 'skipped', 'failed', 'stale', 'duration_ms']
  loop
    v_value := p_summary -> v_counter;

    -- jsonb_typeof reports 'number' for 1.5 and for 1e400 alike, so the shape is
    -- checked on the literal text: non-negative integers only, no float, no
    -- exponent, no sign.
    if jsonb_typeof(v_value) <> 'number'
       or (v_value #>> '{}') !~ '^(0|[1-9][0-9]{0,14})$' then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  end loop;

  if p_summary ? 'cursor' then
    if jsonb_typeof(p_summary -> 'cursor') <> 'string' then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;

    v_cursor := p_summary ->> 'cursor';
    if length(v_cursor) < 1 or length(v_cursor) > 200 then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  end if;
end;
$function$;

comment on function private.validate_job_summary(jsonb) is
  'Rejects every job summary outside the closed counter shape of docs/17-mapa-dados-lgpd.md section 3, including unknown keys and any list of identifiers.';

create or replace function private.enforce_job_summary()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  perform private.validate_job_summary(new.summary);
  return new;
end;
$function$;

create trigger job_runs_validate_summary
before insert or update of summary on private.job_runs
for each row
execute function private.enforce_job_summary();

revoke all on table private.external_effects from public, anon, authenticated, service_role;
revoke all on table private.job_runs from public, anon, authenticated, service_role;
revoke all on table private.retention_runs from public, anon, authenticated, service_role;

revoke all on function private.validate_job_summary(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.enforce_job_summary()
  from public, anon, authenticated, service_role;

commit;
