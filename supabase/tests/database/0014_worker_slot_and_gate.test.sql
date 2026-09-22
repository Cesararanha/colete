begin;

create extension if not exists pgtap with schema extensions;
select no_plan();

-- ---------------------------------------------------------------------------
-- One UTC slot implementation, independent of the caller TimeZone
-- ---------------------------------------------------------------------------

select is(
  (select provolatile from pg_proc
   where oid = 'private.worker_job_slot(text,timestamptz)'::regprocedure),
  's'::"char",
  'the canonical slot resolver is stable rather than falsely immutable'
);
select hasnt_function(
  'private', 'account_deletion_job_slot', array['text', 'timestamptz']::name[],
  'the deletion slice no longer carries a second slot implementation'
);
select hasnt_function(
  'private', 'data_export_job_slot', array['text', 'timestamptz']::name[],
  'the export slice no longer carries a second slot implementation'
);
select ok(
  pg_get_functiondef('public.worker_begin_job(text)'::regprocedure)
    !~ '(account_deletion|data_export)_job_slot',
  'job acquisition routes every published job through the canonical resolver'
);
select ok(
  pg_get_functiondef('private.invoke_worker_cron(text)'::regprocedure)
    !~ '(account_deletion|data_export)_job_slot',
  'cron validation routes every published job through the canonical resolver'
);

set local timezone = 'Asia/Kathmandu';

select is(
  private.worker_job_slot(
    'process_external_effects', '2026-09-07 12:14:59+00'),
  '2026-09-07 12:14:00+00'::timestamptz,
  'the every-minute slot is UTC under Asia/Kathmandu'
);
select is(
  private.worker_job_slot('health_check_jobs', '2026-09-07 12:14:59+00'),
  '2026-09-07 12:10:00+00'::timestamptz,
  'the five-minute slot is UTC under Asia/Kathmandu'
);
select is(
  private.worker_job_slot(
    'purge_expired_revoked_sessions', '2026-09-07 12:16:59+00'),
  '2026-09-07 11:17:00+00'::timestamptz,
  'the minute-17 hourly slot is UTC under Asia/Kathmandu'
);
select is(
  private.worker_job_slot(
    'purge_expired_idempotency_outcomes', '2026-09-07 02:00:00+00'),
  '2026-09-06 03:23:00+00'::timestamptz,
  'the 03:23 daily slot is UTC under Asia/Kathmandu'
);
select is(
  private.worker_job_slot(
    'purge_completed_deletion_requests', '2026-09-09 03:42:59+00'),
  '2026-09-08 03:43:00+00'::timestamptz,
  'the 03:43 daily slot is UTC under Asia/Kathmandu'
);
select is(
  private.worker_job_slot('expire_data_exports', '2026-09-14 12:06:59+00'),
  '2026-09-14 11:07:00+00'::timestamptz,
  'the minute-7 hourly slot is UTC under Asia/Kathmandu'
);
select throws_ok(
  $$select private.worker_job_slot('unknown_job', clock_timestamp())$$,
  '22023', 'VALIDATION', 'the unified resolver keeps the job enum closed'
);

-- ---------------------------------------------------------------------------
-- Completed saga still closes an Auth effect whose lease expired afterwards
-- ---------------------------------------------------------------------------

insert into auth.users (id, email)
values ('14000000-0000-4000-8000-000000000001', 'lease-after-finalize@example.invalid');
insert into public.profiles (id, auth_user_id, name)
values (
  '14100000-0000-4000-8000-000000000001',
  '14000000-0000-4000-8000-000000000001',
  'Lease After Finalize'
);

create temporary table completed_auth_lease as
with deletion as (
  select public.delete_account(
    '14000000-0000-4000-8000-000000000001',
    '14200000-0000-4000-8000-000000000001',
    '14300000-0000-4000-8000-000000000001',
    repeat('a', 64), 1, 1
  ) as response
), acquired as (
  select public.worker_acquire_external_effect(
    array['delete_auth_user']::text[]
  ) as effect
  from deletion
)
select effect from acquired;

select is(
  public.worker_get_deletion_effect_target(
    (effect ->> 'id')::uuid,
    (effect ->> 'lease_token')::uuid
  ) ->> 'action',
  'auth',
  'the no-Storage saga first acquires the Auth provider action'
)
from completed_auth_lease;

delete from auth.users
where id = '14000000-0000-4000-8000-000000000001';

select lives_ok(
  format(
    'select public.worker_confirm_deletion_effect(%L, %L)',
    effect ->> 'id', effect ->> 'lease_token'
  ),
  'confirmed Auth absence advances the saga to finalizing'
)
from completed_auth_lease;

select lives_ok(
  $$select public.finalize_deletion(
      (select id from private.deletion_requests
       where profile_id = '14100000-0000-4000-8000-000000000001'))$$,
  'finalization commits completed before generic effect completion'
);

update private.external_effects
set lease_until = clock_timestamp() - interval '1 second'
where id = (select (effect ->> 'id')::uuid from completed_auth_lease);

create temporary table reacquired_completed_auth as
select public.worker_acquire_external_effect(
  array['delete_auth_user']::text[]
) as effect;

select ok(
  (select effect is not null from reacquired_completed_auth),
  'a lease expired after completed is reacquired instead of stranded retryable'
);
select is(
  public.worker_get_deletion_effect_target(
    (effect ->> 'id')::uuid,
    (effect ->> 'lease_token')::uuid
  ) ->> 'action',
  'none',
  'reconciliation sees completed and performs no second Auth delete'
)
from reacquired_completed_auth;
select lives_ok(
  format(
    'select public.worker_complete_external_effect(%L, %L, ''succeeded'', null)',
    effect ->> 'id', effect ->> 'lease_token'
  ),
  'the reconciled Auth effect reaches terminal success'
)
from reacquired_completed_auth;
select is(
  (select status from private.external_effects
   where id = (select (effect ->> 'id')::uuid from reacquired_completed_auth)),
  'succeeded',
  'the completed saga leaves no non-terminal Auth effect behind'
);
select is(
  (select status from private.deletion_requests
   where profile_id = '14100000-0000-4000-8000-000000000001'),
  'completed',
  'queue hygiene does not change the already completed titular state'
);

select * from finish();

rollback;
