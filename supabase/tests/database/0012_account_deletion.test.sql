begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ---------------------------------------------------------------------------
-- Closed service boundary and typed titular projection
-- ---------------------------------------------------------------------------

select has_table('private', 'deletion_requests', 'the saga is a private service table');
select hasnt_table('public', 'deletion_requests', 'no public deletion table remains');
select ok(
  not (select relrowsecurity from pg_class where oid = 'private.deletion_requests'::regclass),
  'the service table is protected by privileges rather than RLS'
);
select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'private' and table_name = 'deletion_requests'
     and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')),
  0::bigint,
  'no client or administrative role has direct table privileges'
);
select ok(
  has_function_privilege('authenticated', 'public.get_own_deletion_request()', 'execute'),
  'authenticated can execute the minimal own-row projection'
);
select ok(
  not has_function_privilege('service_role', 'public.get_own_deletion_request()', 'execute'),
  'the worker does not receive the titular projection'
);
select ok(
  has_function_privilege(
    'authenticated', 'private.current_privacy_profile_id()', 'execute'),
  'the privacy policy has the narrow definer helper privilege it needs'
);
select ok(
  not has_schema_privilege('authenticated', 'private', 'usage'),
  'the helper grant does not let authenticated enter the private schema'
);

-- ---------------------------------------------------------------------------
-- Initial transaction, idempotency and immediate authority loss
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('12000000-0000-4000-8000-000000000001', 'deletion-one@example.invalid'),
  ('12000000-0000-4000-8000-000000000002', 'deletion-two@example.invalid'),
  ('12000000-0000-4000-8000-000000000003', 'deletion-three@example.invalid'),
  ('12000000-0000-4000-8000-000000000004', 'deletion-four@example.invalid'),
  ('12000000-0000-4000-8000-000000000005', 'deletion-five@example.invalid');

insert into public.profiles (id, auth_user_id, name, account_status, photo_url) values
  ('12100000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', 'Deletion One', 'active', null),
  ('12100000-0000-4000-8000-000000000002',
   '12000000-0000-4000-8000-000000000002', 'Deletion Two', 'active', 'profiles/two.webp'),
  ('12100000-0000-4000-8000-000000000003',
   '12000000-0000-4000-8000-000000000003', 'Deletion Three', 'active', null),
  ('12100000-0000-4000-8000-000000000004',
   '12000000-0000-4000-8000-000000000004', 'Deletion Four', 'active', null),
  ('12100000-0000-4000-8000-000000000005',
   '12000000-0000-4000-8000-000000000005', 'Deletion Five', 'active', null);

insert into public.privacy_requests (id, profile_id, kind) values
  ('12200000-0000-4000-8000-000000000001',
   '12100000-0000-4000-8000-000000000001', 'access'),
  ('12200000-0000-4000-8000-000000000002',
   '12100000-0000-4000-8000-000000000002', 'access'),
  ('12200000-0000-4000-8000-000000000003',
   '12100000-0000-4000-8000-000000000003', 'access'),
  ('12200000-0000-4000-8000-000000000004',
   '12100000-0000-4000-8000-000000000004', 'access'),
  ('12200000-0000-4000-8000-000000000005',
   '12100000-0000-4000-8000-000000000005', 'access');

insert into public.data_exports
  (id, privacy_request_id, profile_id, status)
values
  ('12300000-0000-4000-8000-000000000001',
   '12200000-0000-4000-8000-000000000001',
   '12100000-0000-4000-8000-000000000001', 'building');

insert into public.data_exports
  (id, privacy_request_id, profile_id, status, storage_path, content_digest,
   ready_at, expires_at)
values
  ('12300000-0000-4000-8000-000000000004',
   '12200000-0000-4000-8000-000000000004',
   '12100000-0000-4000-8000-000000000004', 'ready',
   'exports/four.zip', repeat('4', 64), now(), now() + interval '1 hour'),
  ('12300000-0000-4000-8000-000000000005',
   '12200000-0000-4000-8000-000000000005',
   '12100000-0000-4000-8000-000000000005', 'ready',
   'exports/five.zip', repeat('5', 64), now(), now() + interval '1 hour');

insert into private.external_effects
  (kind, resource_type, resource_id, dedupe_key, status, attempts,
   last_error_code, completed_at)
values
  ('delete_data_export', 'data_export',
   '12300000-0000-4000-8000-000000000004',
   'delete_data_export:12300000-0000-4000-8000-000000000004',
   'succeeded', 1, null, now()),
  ('delete_data_export', 'data_export',
   '12300000-0000-4000-8000-000000000005',
   'delete_data_export:12300000-0000-4000-8000-000000000005',
   'dead', 8, 'STORAGE_UNAVAILABLE', now());

create function pg_temp.complete_deletion_after_terminal_export_effect(
  p_auth_user_id uuid,
  p_profile_id uuid,
  p_export_id uuid,
  p_session_id uuid,
  p_idempotency_request_id uuid,
  p_input_hmac text
)
returns text
language plpgsql
set search_path = ''
as $probe$
declare
  v_response jsonb;
  v_request_id uuid;
  v_storage_effect jsonb;
  v_auth_effect jsonb;
  v_status text;
begin
  v_response := public.delete_account(
    p_auth_user_id, p_session_id, p_idempotency_request_id, p_input_hmac, 1, 1);
  v_request_id := (v_response -> 'outcome' ->> 'deletion_request_id')::uuid;

  v_storage_effect := public.worker_acquire_external_effect(
    array['delete_data_export']::text[]);
  if v_storage_effect is null then
    select status into v_status from private.deletion_requests where id = v_request_id;
    return format(
      'response=%s;acquired=false;final=%s',
      v_response -> 'current' ->> 'status', v_status);
  end if;
  if (v_storage_effect ->> 'resource_id')::uuid <> p_export_id
     or v_storage_effect ->> 'dedupe_key' <>
        'delete_data_export:' || p_export_id::text || ':' || v_request_id::text then
    return 'wrong_storage_effect';
  end if;

  perform public.worker_get_deletion_effect_target(
    (v_storage_effect ->> 'id')::uuid,
    (v_storage_effect ->> 'lease_token')::uuid);
  perform public.worker_confirm_deletion_effect(
    (v_storage_effect ->> 'id')::uuid,
    (v_storage_effect ->> 'lease_token')::uuid);
  perform public.worker_complete_external_effect(
    (v_storage_effect ->> 'id')::uuid,
    (v_storage_effect ->> 'lease_token')::uuid,
    'succeeded', null);

  v_auth_effect := public.worker_acquire_external_effect(
    array['delete_auth_user']::text[]);
  if v_auth_effect is null
     or (v_auth_effect ->> 'resource_id')::uuid <> v_request_id then
    return 'auth_not_acquired';
  end if;
  perform public.worker_get_deletion_effect_target(
    (v_auth_effect ->> 'id')::uuid,
    (v_auth_effect ->> 'lease_token')::uuid);
  delete from auth.users where id = p_auth_user_id;
  perform public.worker_confirm_deletion_effect(
    (v_auth_effect ->> 'id')::uuid,
    (v_auth_effect ->> 'lease_token')::uuid);
  perform public.finalize_deletion(v_request_id);
  perform public.worker_complete_external_effect(
    (v_auth_effect ->> 'id')::uuid,
    (v_auth_effect ->> 'lease_token')::uuid,
    'succeeded', null);

  select status into v_status from private.deletion_requests where id = v_request_id;
  return format(
    'response=%s;acquired=true;final=%s',
    v_response -> 'current' ->> 'status', v_status);
end;
$probe$;

select is(
  pg_temp.complete_deletion_after_terminal_export_effect(
    '12000000-0000-4000-8000-000000000004',
    '12100000-0000-4000-8000-000000000004',
    '12300000-0000-4000-8000-000000000004',
    '12400000-0000-4000-8000-000000000004',
    '12500000-0000-4000-8000-000000000004', repeat('e', 64)),
  'response=requested;acquired=true;final=completed',
  'a prior succeeded export effect cannot strand a new requested deletion saga'
);
select is(
  pg_temp.complete_deletion_after_terminal_export_effect(
    '12000000-0000-4000-8000-000000000005',
    '12100000-0000-4000-8000-000000000005',
    '12300000-0000-4000-8000-000000000005',
    '12400000-0000-4000-8000-000000000005',
    '12500000-0000-4000-8000-000000000005', repeat('f', 64)),
  'response=requested;acquired=true;final=completed',
  'a prior dead export effect cannot strand a new requested deletion saga'
);

create temporary table initial_deletion_probe (response jsonb);
select lives_ok(
  $$insert into initial_deletion_probe
    select public.delete_account(
      '12000000-0000-4000-8000-000000000001',
      '12400000-0000-4000-8000-000000000001',
      '12500000-0000-4000-8000-000000000001',
      repeat('a', 64), 1, 1)$$,
  'the account deletion transaction completes'
);
select is(
  (select response -> 'current' ->> 'status' from initial_deletion_probe),
  'requested',
  'a deletion without a known Storage object remains requested until the worker runs'
);
select is(
  (select count(*) from private.external_effects
   where kind = 'delete_auth_user'
     and dedupe_key = 'delete_auth_user:' || (
       select id::text from private.deletion_requests
       where profile_id = '12100000-0000-4000-8000-000000000001'
     )),
  1::bigint,
  'a deletion without a known Storage object still queues one Auth deletion effect'
);
select is(
  (select account_status from public.profiles
   where id = '12100000-0000-4000-8000-000000000001'),
  'deletion_pending',
  'domain authority disappears in the request transaction'
);
select is(
  (select status from public.data_exports
   where id = '12300000-0000-4000-8000-000000000001'),
  'failed',
  'a build in flight is cancelled before it can publish ready'
);
select ok(
  exists (select 1 from private.revoked_auth_sessions
          where session_id = '12400000-0000-4000-8000-000000000001'),
  'the current session enters the denylist in the same transaction'
);
select is(
  (select state from private.idempotency_records
   where actor_key = 'profile:12100000-0000-4000-8000-000000000001'
     and operation = 'delete_account'
     and request_id = '12500000-0000-4000-8000-000000000001'),
  'completed',
  'the idempotency row moves from executing to completed'
);
select is(
  (select outcome from private.idempotency_records
   where actor_key = 'profile:12100000-0000-4000-8000-000000000001'
     and operation = 'delete_account'
     and request_id = '12500000-0000-4000-8000-000000000001'),
  jsonb_build_object(
    'deletion_request_id', (select id::text from private.deletion_requests
                            where profile_id = '12100000-0000-4000-8000-000000000001'),
    'logical_result', 'deletion_requested'),
  'the persisted outcome carries only the protocol and logical result'
);
select lives_ok(
  $$select public.delete_account(
      '12000000-0000-4000-8000-000000000001',
      '12400000-0000-4000-8000-000000000001',
      '12500000-0000-4000-8000-000000000001',
      repeat('a', 64), 1, 1)$$,
  'an identical replay returns the completed intent without repeating it'
);
select is(
  (select count(*) from private.deletion_requests
   where profile_id = '12100000-0000-4000-8000-000000000001'),
  1::bigint,
  'replay leaves exactly one saga'
);
select throws_ok(
  $$select public.delete_account(
      '12000000-0000-4000-8000-000000000001',
      '12400000-0000-4000-8000-000000000001',
      '12500000-0000-4000-8000-000000000001',
      repeat('b', 64), 1, 1)$$,
  'P0001', 'IDEMPOTENCY_CONFLICT',
  'the same request id with another HMAC conflicts'
);

set local request.jwt.claims =
  '{"sub":"12000000-0000-4000-8000-000000000001","session_id":"12400000-0000-4000-8000-000000000001"}';
set local role authenticated;
select is((select count(*) from public.profiles), 0::bigint,
  'an old JWT sees no profile row after deletion_pending commits');
select is((select count(*) from public.data_exports), 0::bigint,
  'an old JWT sees no export row after deletion_pending commits');
select is((select count(*) from public.policy_acceptances), 0::bigint,
  'an old JWT sees no policy-acceptance row after deletion_pending commits');
select is((select count(*) from public.privacy_requests), 1::bigint,
  'the privacy channel remains readable by the titular');
select is((select count(*) from public.get_own_deletion_request()), 1::bigint,
  'the deletion-pending shell can still read its typed projection');
select is(
  (select completed_at from public.get_own_deletion_request()),
  null::timestamptz,
  'the in-progress projection exposes completed_at as null'
);
select throws_ok(
  'select * from private.deletion_requests', '42501', null,
  'the same non-BYPASSRLS role cannot select the private saga table'
);
select throws_ok(
  'select private.current_privacy_profile_id()', '42501', null,
  'the policy-only helper cannot be invoked directly without private schema usage'
);
reset role;

set local request.jwt.claims =
  '{"sub":"12000000-0000-4000-8000-000000000003","session_id":"12400000-0000-4000-8000-000000000003"}';
set local role authenticated;
select is((select count(*) from public.get_own_deletion_request()), 0::bigint,
  'another authenticated identity cannot see the saga projection');
reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- Storage priority and fenced reconciliation
-- ---------------------------------------------------------------------------

create temporary table storage_deletion_probe (response jsonb);
select lives_ok(
  $$insert into storage_deletion_probe
    select public.delete_account(
      '12000000-0000-4000-8000-000000000002',
      '12400000-0000-4000-8000-000000000002',
      '12500000-0000-4000-8000-000000000002',
      repeat('c', 64), 1, 1)$$,
  'known Storage state starts a second deletion saga'
);
select is(
  (select response -> 'current' ->> 'status' from storage_deletion_probe),
  'requested',
  'a deletion with known Storage also remains requested until the worker runs'
);
select is(
  (select count(*) from private.external_effects
   where dedupe_key =
     'delete_storage_object:profile_avatar:12100000-0000-4000-8000-000000000002'),
  1::bigint,
  'the known avatar creates one deduplicated purge intent'
);
select is(
  (select count(*) from private.external_effects
   where kind = 'delete_auth_user'
     and resource_id = (select id from private.deletion_requests
                        where profile_id = '12100000-0000-4000-8000-000000000002')),
  0::bigint,
  'Auth deletion is not queued while a known object remains'
);

create temporary table deletion_effect_probe as
select public.worker_acquire_external_effect(
  array['delete_storage_object']::text[]
) as effect;
select is(
  (select effect ->> 'kind' from deletion_effect_probe),
  'delete_storage_object',
  'the worker acquires the published Storage handler kind'
);
select lives_ok(
  format(
    $sql$select public.worker_complete_external_effect(%L, %L, 'retryable_failure', 'STORAGE_UNAVAILABLE')$sql$,
    (select effect ->> 'id' from deletion_effect_probe),
    (select effect ->> 'lease_token' from deletion_effect_probe)
  ),
  'a temporary Storage failure returns the effect to controlled backoff'
);
select is(
  (select status from private.deletion_requests
   where profile_id = '12100000-0000-4000-8000-000000000002'),
  'failed_retryable',
  'temporary provider failure preserves the saga with an explicit retry state'
);
update private.external_effects
set next_attempt_at = clock_timestamp() - interval '1 second'
where id = ((select effect ->> 'id' from deletion_effect_probe))::uuid;
update deletion_effect_probe
set effect = public.worker_acquire_external_effect(array['delete_storage_object']::text[]);
select is(
  (select public.worker_get_deletion_effect_target(
      (effect ->> 'id')::uuid, (effect ->> 'lease_token')::uuid) ->> 'action'
   from deletion_effect_probe),
  'storage',
  'a retry reconciles provider state before acting'
);
select is(
  (select status from private.deletion_requests
   where profile_id = '12100000-0000-4000-8000-000000000002'),
  'cleaning_storage',
  'the worker advances requested to cleaning_storage before handling the object'
);
select lives_ok(
  format(
    $sql$select public.worker_confirm_deletion_effect(%L, %L)$sql$,
    (select effect ->> 'id' from deletion_effect_probe),
    (select effect ->> 'lease_token' from deletion_effect_probe)
  ),
  'confirmed Storage absence advances the saga'
);
select lives_ok(
  format(
    $sql$select public.worker_complete_external_effect(%L, %L, 'succeeded', null)$sql$,
    (select effect ->> 'id' from deletion_effect_probe),
    (select effect ->> 'lease_token' from deletion_effect_probe)
  ),
  'the reconciled effect completes under the same fence'
);
select is(
  (select status from private.deletion_requests
   where profile_id = '12100000-0000-4000-8000-000000000002'),
  'deleting_auth',
  'the saga advances to Auth only after all known Storage paths are cleared'
);

-- ---------------------------------------------------------------------------
-- Finalization guards and irreversible deidentification
-- ---------------------------------------------------------------------------

select throws_ok(
  format($sql$select public.finalize_deletion(%L)$sql$,
    (select id from private.deletion_requests
     where profile_id = '12100000-0000-4000-8000-000000000001')),
  'P0001', 'CONCURRENT_CHANGE',
  'finalize refuses while Auth still exists'
);
update private.deletion_requests set status = 'finalizing'
where profile_id = '12100000-0000-4000-8000-000000000001';
select throws_ok(
  format($sql$select public.finalize_deletion(%L)$sql$,
    (select id from private.deletion_requests
     where profile_id = '12100000-0000-4000-8000-000000000001')),
  'P0001', 'CONCURRENT_CHANGE',
  'finalize still refuses a finalizing saga while Auth exists'
);
delete from auth.users where id = '12000000-0000-4000-8000-000000000001';
update public.profiles set photo_url = 'profiles/late-object.webp'
where id = '12100000-0000-4000-8000-000000000001';
select throws_ok(
  format($sql$select public.finalize_deletion(%L)$sql$,
    (select id from private.deletion_requests
     where profile_id = '12100000-0000-4000-8000-000000000001')),
  'P0001', 'CONCURRENT_CHANGE',
  'finalize refuses while a known object remains'
);
update public.profiles set photo_url = null
where id = '12100000-0000-4000-8000-000000000001';
select lives_ok(
  format($sql$select public.finalize_deletion(%L)$sql$,
    (select id from private.deletion_requests
     where profile_id = '12100000-0000-4000-8000-000000000001')),
  'finalize succeeds only after Auth and known objects are absent'
);
select is(
  (select account_status from public.profiles
   where id = '12100000-0000-4000-8000-000000000001'),
  'deleted',
  'the profile reaches deleted'
);
select ok(
  (select auth_user_id is null and nickname is null and photo_url is null
          and position is null and dominant_foot is null and shirt_number is null
          and deidentified_at is not null
   from public.profiles where id = '12100000-0000-4000-8000-000000000001'),
  'finalization clears every specified personal field and records deidentification'
);
select ok(
  (select name ~ '^Deleted [0-9a-f]{32}$'
   from public.profiles where id = '12100000-0000-4000-8000-000000000001'),
  'the retained label is random and non-reversible'
);
select ok(
  (select status = 'completed' and auth_user_id is null and last_error_code is null
          and completed_at is not null
   from private.deletion_requests
   where profile_id = '12100000-0000-4000-8000-000000000001'),
  'the completed saga redacts its Auth identifier and operational error'
);

-- ---------------------------------------------------------------------------
-- Negative dump census, extension guard, jobs and retention
-- ---------------------------------------------------------------------------

insert into private.external_effects (kind, resource_type, resource_id, dedupe_key)
values ('delete_auth_user', 'deletion_request',
        '12600000-0000-4000-8000-000000000099',
        '12000000-0000-4000-8000-000000000001');
select is(
  (select count(*) from private.external_effects
   where dedupe_key ~* '(auth_user_id|session|path|token|example[.]invalid)'),
  0::bigint,
  'the former label-only census misses a raw fixture Auth UUID'
);
select is(
  (select count(*) from private.external_effects
   where dedupe_key ~* '(auth_user_id|session|path|token|example[.]invalid|12000000-0000-4000-8000-000000000001|12400000-0000-4000-8000-000000000001)'),
  1::bigint,
  'the value-aware census detects the same raw fixture Auth UUID'
);
delete from private.external_effects
where resource_id = '12600000-0000-4000-8000-000000000099';

select is(
  (select count(*) from private.idempotency_records
   where operation = 'delete_account'
     and outcome::text ~* '(auth_user|session|path|token|deletion-one|example[.]invalid|12000000-0000-4000-8000-000000000001|12400000-0000-4000-8000-000000000001)'),
  0::bigint,
  'idempotency outcomes contain no Auth ID, session, path, token or PII'
);
select is(
  (select count(*) from private.external_effects
   where kind in ('delete_auth_user', 'delete_storage_object', 'delete_data_export')
     and (dedupe_key ~* '(auth_user_id|session|path|token|example[.]invalid|12000000-0000-4000-8000-000000000001|12400000-0000-4000-8000-000000000001)'
          or last_error_code ~* '(auth_user_id|session|path|token|example[.]invalid|12000000-0000-4000-8000-000000000001|12400000-0000-4000-8000-000000000001)')),
  0::bigint,
  'effect rows and errors contain no credential, path or personal payload'
);
select is(
  (select count(*) from private.job_runs
   where summary::text ~* '(auth_user|session|path|token|example[.]invalid|12000000-0000-4000-8000-000000000001|12400000-0000-4000-8000-000000000001)'
      or error_code ~* '(auth_user|session|path|token|example[.]invalid|12000000-0000-4000-8000-000000000001|12400000-0000-4000-8000-000000000001)'),
  0::bigint,
  'job observability contains only counters and normalized errors'
);
select is(
  private.account_deletion_job_slot(
    'purge_completed_deletion_requests', '2026-09-09 03:42:59+00'),
  '2026-09-08 03:43:00+00'::timestamptz,
  'the daily retention slot is UTC and chooses the preceding slot before 03:43'
);
select is(
  private.account_deletion_job_slot(
    'purge_completed_deletion_requests', '2026-09-09 03:43:00+00'),
  '2026-09-09 03:43:00+00'::timestamptz,
  'the daily retention slot includes the exact boundary'
);

update private.deletion_requests
set completed_at = now() - interval '91 days'
where profile_id = '12100000-0000-4000-8000-000000000001';
create temporary table deletion_job_probe as
select public.worker_begin_job('purge_completed_deletion_requests') as begun;
select is(
  (select begun ->> 'acquired' from deletion_job_probe),
  'true',
  'the daily deletion-retention slot creates one job run'
);
select is(
  (select public.worker_execute_database_job((begun ->> 'run_id')::bigint) ->> 'changed'
   from deletion_job_probe),
  '1',
  'the scheduled job purges a completed identifiable saga after 90 days'
);
select is(
  (select count(*) from private.deletion_requests
   where profile_id = '12100000-0000-4000-8000-000000000001'),
  0::bigint,
  'the expired identifiable saga row is gone'
);
select is(
  (select purged from private.retention_runs
   where policy = 'purge_completed_deletion_requests'
   order by id desc limit 1),
  1,
  'retention observability records only the purge count'
);

create or replace function private.require_financial_deletion_substitute(p_profile_id uuid)
returns void language plpgsql stable set search_path = '' as $blocked$
begin
  raise exception using errcode = 'P0001', message = 'FINANCIAL_SUBSTITUTE_REQUIRED';
end;
$blocked$;
select throws_ok(
  $$select public.delete_account(
      '12000000-0000-4000-8000-000000000003',
      '12400000-0000-4000-8000-000000000003',
      '12500000-0000-4000-8000-000000000003',
      repeat('d', 64), 1, 1)$$,
  'P0001', 'FINANCIAL_SUBSTITUTE_REQUIRED',
  'the financial-substitute extension point blocks the transaction atomically'
);
select is(
  (select count(*) from private.deletion_requests
   where profile_id = '12100000-0000-4000-8000-000000000003'),
  0::bigint,
  'a blocked deletion leaves no saga residue'
);
select is(
  (select count(*) from private.idempotency_records
   where actor_key = 'profile:12100000-0000-4000-8000-000000000003'
     and operation = 'delete_account'),
  0::bigint,
  'a blocked deletion rolls back the executing idempotency row too'
);
select is(
  (select account_status from public.profiles
   where id = '12100000-0000-4000-8000-000000000003'),
  'active',
  'a blocked deletion preserves domain authority'
);

select * from finish();

rollback;
