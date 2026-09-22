begin;

create extension if not exists pgtap with schema extensions;
select no_plan();

select has_table('private','data_exports','exports are private service state');
select hasnt_table('public','data_exports','the former public export table is gone');
select ok(not (select relrowsecurity from pg_class where oid='private.data_exports'::regclass),
  'the private service table does not rely on RLS');
select is((select count(*) from information_schema.role_table_grants
  where table_schema='private' and table_name='data_exports'
    and grantee in ('PUBLIC','anon','authenticated','service_role')),0::bigint,
  'no client or administrative role has a direct export-table grant');
select ok(has_function_privilege('authenticated','public.get_own_data_exports()','execute'),
  'authenticated can call the typed own-export projection');
select ok(not has_function_privilege('service_role','public.get_own_data_exports()','execute'),
  'the worker does not receive the titular projection');
select ok(has_function_privilege('service_role',
  'public.request_data_export(uuid,uuid,uuid,text,integer,integer)','execute'),
  'only the exclusive gateway role can call the mutation');
select ok(not has_function_privilege('authenticated',
  'public.request_data_export(uuid,uuid,uuid,text,integer,integer)','execute'),
  'authenticated cannot bypass the gateway');
select is((select public::text||':'||file_size_limit::text||':'||allowed_mime_types::text
  from storage.buckets where id='data-exports'),
  'false:52428800:{application/zip}','the export bucket is private with the exact limit and MIME');
select is((select count(*) from pg_policies where schemaname='storage'
  and tablename='objects' and (qual like '%data-exports%' or with_check like '%data-exports%')),
  0::bigint,'the export bucket has zero client policies');
select ok(not has_table_privilege('authenticated','private.data_exports','select'),
  'authenticated cannot obtain an internal path through the database');
select ok(not has_function_privilege('authenticated',
  'public.worker_get_data_export_build_target(uuid,uuid)','execute'),
  'authenticated cannot call the worker snapshot projection');

insert into private.external_effects(
 id,kind,resource_type,resource_id,dedupe_key,status,attempts,lease_token,lease_until)
values('13900000-0000-4000-8000-000000000020','delete_storage_object','profile_avatar',
 '13100000-0000-4000-8000-000000000020','storage-429-backoff-proof','leased',1,
 '13900000-0000-4000-8000-000000000021',clock_timestamp()+interval '10 minutes');
select lives_ok($$select public.worker_complete_external_effect(
 '13900000-0000-4000-8000-000000000020','13900000-0000-4000-8000-000000000021',
 'retryable_failure','STORAGE_UNAVAILABLE')$$,
 'the Storage 429 classification can enter the ordinary retry completion path');
select ok((select status='failed_retryable' and next_attempt_at>clock_timestamp()
  and completed_at is null and last_error_code='STORAGE_UNAVAILABLE'
 from private.external_effects where id='13900000-0000-4000-8000-000000000020'),
 'a rate-limited Storage effect receives future backoff instead of dead-letter');

insert into auth.users(id,email) values
 ('13000000-0000-4000-8000-000000000001','export-one@example.invalid'),
 ('13000000-0000-4000-8000-000000000002','export-two@example.invalid');
insert into public.profiles(id,auth_user_id,name) values
 ('13100000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','Export One'),
 ('13100000-0000-4000-8000-000000000002','13000000-0000-4000-8000-000000000002','Export Two');

create temporary table requested_export(response jsonb);
select lives_ok($$insert into requested_export select public.request_data_export(
  '13000000-0000-4000-8000-000000000001','13200000-0000-4000-8000-000000000001',
  '13300000-0000-4000-8000-000000000001',repeat('a',64),1,1)$$,
  'request_data_export commits the governed intent');
select is((select response->'outcome'->>'logical_result' from requested_export),
  'data_export_requested','the outcome stores the stable logical result');
select is((select array_agg(key order by key) from requested_export,
  lateral jsonb_object_keys(response->'outcome') key),
  array['export_id','logical_result']::text[],
  'the outcome contains only export_id and logical_result');
select is((select count(*) from public.privacy_requests where profile_id=
  '13100000-0000-4000-8000-000000000001' and kind='access'),1::bigint,
  'the privacy access request is created in the same transaction');
select is((select count(*) from private.data_exports where profile_id=
  '13100000-0000-4000-8000-000000000001' and status='queued'),1::bigint,
  'one queued export is created');
select is((select count(*) from private.external_effects effect
  join private.data_exports export on export.id=effect.resource_id
  where export.profile_id='13100000-0000-4000-8000-000000000001'
    and effect.kind='build_data_export' and effect.next_attempt_at is null
    and effect.dedupe_key='build_data_export:'||export.id::text),1::bigint,
  'the build intent uses the stable key and remains first-class pending work');
select is((select outcome from private.idempotency_records where
  operation='request_data_export' and request_id='13300000-0000-4000-8000-000000000001'),
  (select response->'outcome' from requested_export),
  'the exact safe outcome is persisted');
select lives_ok($$select public.request_data_export(
  '13000000-0000-4000-8000-000000000001','13200000-0000-4000-8000-000000000001',
  '13300000-0000-4000-8000-000000000001',repeat('a',64),1,1)$$,
  'an identical replay returns the completed outcome');
select is((select count(*) from private.data_exports where profile_id=
  '13100000-0000-4000-8000-000000000001'),1::bigint,
  'replay does not create a second export');
select throws_ok($$select public.request_data_export(
  '13000000-0000-4000-8000-000000000001','13200000-0000-4000-8000-000000000001',
  '13300000-0000-4000-8000-000000000002',repeat('b',64),1,1)$$,
  'P0001','EXPORT_ALREADY_PENDING','a new intent cannot overlap an active export');

set local request.jwt.claims='{"sub":"13000000-0000-4000-8000-000000000001","session_id":"13200000-0000-4000-8000-000000000001"}';
set local role authenticated;
select is((select count(*) from public.get_own_data_exports()),1::bigint,
  'the non-BYPASSRLS titular reads its projection successfully');
select is((select count(*) from public.get_own_data_exports() where id=(select id from public.get_own_data_exports())),1::bigint,
  'the typed projection returns the caller own row');
select throws_ok('select * from private.data_exports','42501',null,
  'the same titular cannot read the private service table');
reset role;
set local request.jwt.claims='{"sub":"13000000-0000-4000-8000-000000000002","session_id":"13200000-0000-4000-8000-000000000002"}';
set local role authenticated;
select is((select count(*) from public.get_own_data_exports()),0::bigint,
  'another titular cannot see the export projection');
reset role;
reset request.jwt.claims;

insert into public.privacy_requests(id,profile_id,kind) values
 ('13400000-0000-4000-8000-000000000002','13100000-0000-4000-8000-000000000002','access');
insert into private.data_exports(id,privacy_request_id,profile_id,status,storage_path,
 content_digest,ready_at,expires_at)
values('13500000-0000-4000-8000-000000000002','13400000-0000-4000-8000-000000000002',
 '13100000-0000-4000-8000-000000000002','ready',
 'exports/13100000-0000-4000-8000-000000000002/13500000-0000-4000-8000-000000000002.zip',
 repeat('c',64),now()-interval '2 hours',now()-interval '1 hour');
select lives_ok('select private.expire_data_exports()',
  'the hourly reconciliation expires eligible exports');
select is((select status from private.data_exports where id=
 '13500000-0000-4000-8000-000000000002'),'cleanup_pending',
 'expired ready state becomes cleanup_pending until physical deletion is confirmed');
select is((select count(*) from private.external_effects where resource_id=
 '13500000-0000-4000-8000-000000000002' and
 dedupe_key='delete_data_export:13500000-0000-4000-8000-000000000002'),1::bigint,
 'expiration queues the stable purge intent without request scope');
select lives_ok('select private.expire_data_exports()',
  'reconciliation is repeatable');
select is((select count(*) from private.external_effects where resource_id=
 '13500000-0000-4000-8000-000000000002'),1::bigint,
 'reconciliation never duplicates the purge effect');
select is(private.worker_job_slot('expire_data_exports','2026-09-14 12:06:59+00'),
 '2026-09-14 11:07:00+00'::timestamptz,'the hourly slot is the latest minute 7 UTC');
select is((select schedule from cron.job where jobname='colete_v1_expire_data_exports'),
 '7 * * * *','the export expiry schedule is exact');

update private.data_exports set status='ready',
 storage_path='exports/13100000-0000-4000-8000-000000000001/'||id::text||'.zip',
 content_digest=repeat('d',64),ready_at=now(),expires_at=now()+interval '1 hour'
where profile_id='13100000-0000-4000-8000-000000000001' and status='queued';
select lives_ok($$select public.consume_data_export(
 '13000000-0000-4000-8000-000000000001','13200000-0000-4000-8000-000000000001',
 (select id from private.data_exports where profile_id='13100000-0000-4000-8000-000000000001'))$$,
 'the first authorised caller wins the one-shot CAS');
select is((select status from private.data_exports where profile_id=
 '13100000-0000-4000-8000-000000000001'),'downloaded','the CAS commits before streaming');
select throws_ok($$select public.consume_data_export(
 '13000000-0000-4000-8000-000000000001','13200000-0000-4000-8000-000000000001',
 (select id from private.data_exports where profile_id='13100000-0000-4000-8000-000000000001'))$$,
 'P0001','EXPORT_EXPIRED','a second call cannot consume the same export');

insert into auth.users(id,email) values
 ('13000000-0000-4000-8000-000000000003','export-three@example.invalid');
insert into public.profiles(id,auth_user_id,name) values
 ('13100000-0000-4000-8000-000000000003','13000000-0000-4000-8000-000000000003','Export Three');
insert into public.privacy_requests(id,profile_id,kind) values
 ('13400000-0000-4000-8000-000000000003','13100000-0000-4000-8000-000000000003','access');
insert into private.data_exports(id,privacy_request_id,profile_id,status,storage_path,content_digest,ready_at,expires_at)
values('13500000-0000-4000-8000-000000000003','13400000-0000-4000-8000-000000000003',
 '13100000-0000-4000-8000-000000000003','ready',
 'exports/13100000-0000-4000-8000-000000000003/13500000-0000-4000-8000-000000000003.zip',
 repeat('e',64),now(),now()+interval '1 hour');
insert into private.revoked_auth_sessions(session_id,profile_id,expires_at)
values('13200000-0000-4000-8000-000000000003','13100000-0000-4000-8000-000000000003',
 now()+interval '1 day');
select throws_ok($$select public.consume_data_export(
 '13000000-0000-4000-8000-000000000003','13200000-0000-4000-8000-000000000003',
 '13500000-0000-4000-8000-000000000003')$$,
 '28000','UNAUTHENTICATED','a revoked session is refused before the CAS');
select is((select status||':'||(storage_path is not null)::text from private.data_exports
 where id='13500000-0000-4000-8000-000000000003'),'ready:true',
  'logout leaves the ready artifact intact');

insert into auth.users(id,email) values
 ('13000000-0000-4000-8000-000000000004','export-suspended@example.invalid'),
 ('13000000-0000-4000-8000-000000000005','export-banned@example.invalid'),
 ('13000000-0000-4000-8000-000000000006','export-deleting@example.invalid'),
 ('13000000-0000-4000-8000-000000000007','export-snapshot@example.invalid'),
 ('13000000-0000-4000-8000-000000000008','export-states@example.invalid');
insert into public.profiles(id,auth_user_id,name,account_status) values
 ('13100000-0000-4000-8000-000000000004','13000000-0000-4000-8000-000000000004','Suspended Export','suspended'),
 ('13100000-0000-4000-8000-000000000005','13000000-0000-4000-8000-000000000005','Banned Export','banned'),
 ('13100000-0000-4000-8000-000000000006','13000000-0000-4000-8000-000000000006','Deleting Export','deletion_pending'),
 ('13100000-0000-4000-8000-000000000007','13000000-0000-4000-8000-000000000007','Snapshot Export','active'),
 ('13100000-0000-4000-8000-000000000008','13000000-0000-4000-8000-000000000008','State Export','active');

select lives_ok($$select public.request_data_export(
 '13000000-0000-4000-8000-000000000004','13200000-0000-4000-8000-000000000004',
 '13300000-0000-4000-8000-000000000004',repeat('4',64),1,1)$$,
 'a suspended profile retains the privacy export request channel');
select lives_ok($$select public.request_data_export(
 '13000000-0000-4000-8000-000000000005','13200000-0000-4000-8000-000000000005',
 '13300000-0000-4000-8000-000000000005',repeat('5',64),1,1)$$,
 'a banned profile retains the privacy export request channel');
insert into public.privacy_requests(id,profile_id,kind)
select '13400000-0000-4000-8000-000000000004','13100000-0000-4000-8000-000000000004','access'
where not exists(select 1 from private.data_exports where profile_id='13100000-0000-4000-8000-000000000004');
insert into public.privacy_requests(id,profile_id,kind)
select '13400000-0000-4000-8000-000000000005','13100000-0000-4000-8000-000000000005','access'
where not exists(select 1 from private.data_exports where profile_id='13100000-0000-4000-8000-000000000005');
insert into private.data_exports(id,privacy_request_id,profile_id)
select '13500000-0000-4000-8000-000000000004','13400000-0000-4000-8000-000000000004','13100000-0000-4000-8000-000000000004'
where not exists(select 1 from private.data_exports where profile_id='13100000-0000-4000-8000-000000000004');
insert into private.data_exports(id,privacy_request_id,profile_id)
select '13500000-0000-4000-8000-000000000005','13400000-0000-4000-8000-000000000005','13100000-0000-4000-8000-000000000005'
where not exists(select 1 from private.data_exports where profile_id='13100000-0000-4000-8000-000000000005');
update private.data_exports set status='ready',
 storage_path='exports/'||profile_id::text||'/'||id::text||'.zip',content_digest=repeat('f',64),
 ready_at=now(),expires_at=now()+interval '1 hour'
where profile_id in ('13100000-0000-4000-8000-000000000004','13100000-0000-4000-8000-000000000005');
select lives_ok($$select public.consume_data_export(
 '13000000-0000-4000-8000-000000000004','13200000-0000-4000-8000-000000000004',
 (select id from private.data_exports where profile_id='13100000-0000-4000-8000-000000000004'))$$,
 'a suspended profile retains the privacy export download channel');
select lives_ok($$select public.consume_data_export(
 '13000000-0000-4000-8000-000000000005','13200000-0000-4000-8000-000000000005',
 (select id from private.data_exports where profile_id='13100000-0000-4000-8000-000000000005'))$$,
 'a banned profile retains the privacy export download channel');
select throws_ok($$select public.request_data_export(
 '13000000-0000-4000-8000-000000000006','13200000-0000-4000-8000-000000000006',
 '13300000-0000-4000-8000-000000000006',repeat('6',64),1,1)$$,
 '42501','FORBIDDEN','deletion_pending does not regain the export request channel');
insert into public.privacy_requests(id,profile_id,kind) values
 ('13400000-0000-4000-8000-000000000006','13100000-0000-4000-8000-000000000006','access');
insert into private.data_exports(id,privacy_request_id,profile_id,status,storage_path,content_digest,ready_at,expires_at)
values('13500000-0000-4000-8000-000000000006','13400000-0000-4000-8000-000000000006',
 '13100000-0000-4000-8000-000000000006','ready',
 'exports/13100000-0000-4000-8000-000000000006/13500000-0000-4000-8000-000000000006.zip',
 repeat('6',64),now(),now()+interval '1 hour');
select throws_ok($$select public.consume_data_export(
 '13000000-0000-4000-8000-000000000006','13200000-0000-4000-8000-000000000006',
 '13500000-0000-4000-8000-000000000006')$$,
 '42501','FORBIDDEN','deletion_pending does not regain the export download channel');

insert into public.privacy_requests(id,profile_id,kind) values
 ('13400000-0000-4000-8000-000000000007','13100000-0000-4000-8000-000000000007','access'),
 ('13400000-0000-4000-8000-000000000008','13100000-0000-4000-8000-000000000008','access');
insert into private.data_exports(id,privacy_request_id,profile_id) values
 ('13500000-0000-4000-8000-000000000007','13400000-0000-4000-8000-000000000007','13100000-0000-4000-8000-000000000007'),
 ('13500000-0000-4000-8000-000000000008','13400000-0000-4000-8000-000000000008','13100000-0000-4000-8000-000000000008');
insert into private.external_effects(id,kind,resource_type,resource_id,dedupe_key,status,attempts,lease_token,lease_until)
values('13900000-0000-4000-8000-000000000007','build_data_export','data_export',
 '13500000-0000-4000-8000-000000000007','build_data_export:13500000-0000-4000-8000-000000000007',
 'leased',1,'13900000-0000-4000-8000-000000000008',clock_timestamp()+interval '1 hour');
create temporary table build_snapshots(snapshot jsonb);
insert into build_snapshots select public.worker_get_data_export_build_target(
 '13900000-0000-4000-8000-000000000007','13900000-0000-4000-8000-000000000008');
insert into build_snapshots select public.worker_get_data_export_build_target(
 '13900000-0000-4000-8000-000000000007','13900000-0000-4000-8000-000000000008');
select is((select count(distinct snapshot->'snapshot'->>'snapshot_at') from build_snapshots),1::bigint,
 'retries of the same build reuse one persisted snapshot instant');
select ok((select to_jsonb(export) ? 'snapshot_at' and to_jsonb(export)->'snapshot_at' <> 'null'::jsonb
 from private.data_exports export where id='13500000-0000-4000-8000-000000000007'),
 'the first build attempt persists its snapshot instant on the export');
select ok(not exists(select 1 from build_snapshots,
 lateral jsonb_array_elements(snapshot->'snapshot'->'privacy_requests') request
 where request ? 'id'),'privacy request ids stay outside the closed export allowlist');
update private.external_effects
set status='dead',attempts=8,lease_token=null,lease_until=null,
    last_error_code='STORAGE_UNAVAILABLE',completed_at=clock_timestamp()
where id='13900000-0000-4000-8000-000000000007';
select is((select status from private.data_exports
 where id='13500000-0000-4000-8000-000000000007'),'failed',
 'a terminal build makes the export failure visible and releases the active slot');
select lives_ok($$select public.request_data_export(
 '13000000-0000-4000-8000-000000000007','13200000-0000-4000-8000-000000000007',
 '13300000-0000-4000-8000-000000000015',repeat('f',64),1,1)$$,
 'the titular can request a replacement after a terminal build');
select is((select count(*) from private.data_exports
 where profile_id='13100000-0000-4000-8000-000000000007'),2::bigint,
 'the failed export remains in history beside the new queued request');

select throws_ok($$select public.request_data_export(
 '13000000-0000-4000-8000-000000000008','13200000-0000-4000-8000-000000000008',
 '13300000-0000-4000-8000-000000000008',repeat('8',64),1,1)$$,
 'P0001','EXPORT_ALREADY_PENDING','queued is an active export state');
update private.data_exports set status='building' where id='13500000-0000-4000-8000-000000000008';
select throws_ok($$select public.request_data_export(
 '13000000-0000-4000-8000-000000000008','13200000-0000-4000-8000-000000000008',
 '13300000-0000-4000-8000-000000000009',repeat('9',64),1,1)$$,
 'P0001','EXPORT_ALREADY_PENDING','building is an active export state');
update private.data_exports set status='ready',storage_path='exports/13100000-0000-4000-8000-000000000008/13500000-0000-4000-8000-000000000008.zip',
 content_digest=repeat('8',64),ready_at=now(),expires_at=now()+interval '1 hour'
where id='13500000-0000-4000-8000-000000000008';
select throws_ok($$select public.request_data_export(
 '13000000-0000-4000-8000-000000000008','13200000-0000-4000-8000-000000000008',
 '13300000-0000-4000-8000-000000000010',repeat('a',64),1,1)$$,
 'P0001','EXPORT_ALREADY_PENDING','ready is an active export state');
update private.data_exports set status='downloaded',downloaded_at=now()
where id='13500000-0000-4000-8000-000000000008';
select throws_ok($$select public.request_data_export(
 '13000000-0000-4000-8000-000000000008','13200000-0000-4000-8000-000000000008',
 '13300000-0000-4000-8000-000000000011',repeat('b',64),1,1)$$,
 'P0001','EXPORT_ALREADY_PENDING','downloaded with a path is an active export state');
update private.data_exports set status='cleanup_pending',downloaded_at=null
where id='13500000-0000-4000-8000-000000000008';
select throws_ok($$select public.request_data_export(
 '13000000-0000-4000-8000-000000000008','13200000-0000-4000-8000-000000000008',
 '13300000-0000-4000-8000-000000000012',repeat('c',64),1,1)$$,
 'P0001','EXPORT_ALREADY_PENDING','cleanup_pending is an active export state');

-- One shared predicate must keep Auth fenced after an avatar purge when an
-- interrupted pathless build still has non-terminal work.
insert into auth.users(id,email) values
 ('13000000-0000-4000-8000-000000000010','export-build-fence@example.invalid');
insert into public.profiles(id,auth_user_id,name,photo_url) values
 ('13100000-0000-4000-8000-000000000010','13000000-0000-4000-8000-000000000010',
  'Build Fence','avatars/13100000-0000-4000-8000-000000000010/avatar.png');
insert into public.privacy_requests(id,profile_id,kind) values
 ('13400000-0000-4000-8000-000000000010','13100000-0000-4000-8000-000000000010','access');
insert into private.data_exports(id,privacy_request_id,profile_id,status) values
 ('13500000-0000-4000-8000-000000000010','13400000-0000-4000-8000-000000000010',
  '13100000-0000-4000-8000-000000000010','building');
insert into private.external_effects(
 id,kind,resource_type,resource_id,dedupe_key,status,attempts,next_attempt_at,last_error_code)
values('13900000-0000-4000-8000-000000000010','build_data_export','data_export',
 '13500000-0000-4000-8000-000000000010',
 'build_data_export:13500000-0000-4000-8000-000000000010',
 'failed_retryable',1,clock_timestamp()+interval '1 minute','STORAGE_UNAVAILABLE');
select lives_ok($$select public.delete_account(
 '13000000-0000-4000-8000-000000000010','13200000-0000-4000-8000-000000000010',
 '13300000-0000-4000-8000-000000000014',repeat('e',64),1,1)$$,
 'the interrupted-build fixture starts deletion');
update public.profiles set photo_url=null
where id='13100000-0000-4000-8000-000000000010';
select is(private.reconcile_deletion_request((select id from private.deletion_requests
 where profile_id='13100000-0000-4000-8000-000000000010')),
 'cleaning_storage','a pathless retryable build keeps the saga in Storage after avatar purge');
select is(public.worker_acquire_external_effect(array['delete_auth_user']::text[]),null::jsonb,
 'the shared Storage predicate prevents Auth acquisition for the same build');
update private.external_effects
set status='dead',attempts=8,next_attempt_at=null,last_error_code='STORAGE_UNAVAILABLE',
    completed_at=clock_timestamp()
where id='13900000-0000-4000-8000-000000000010';
select is((select count(*) from private.external_effects
 where kind='delete_data_export'
   and resource_id='13500000-0000-4000-8000-000000000010'
   and dedupe_key='delete_data_export:13500000-0000-4000-8000-000000000010'
   and status='pending'),1::bigint,
 'a terminal build becomes one stable deterministic purge attempt');

-- A dead Storage purge is terminal and cannot make progress by retry. It
-- therefore releases the Auth phase while keeping the normalized operational
-- failure visible instead of stranding the saga in cleaning_storage.
insert into auth.users(id,email) values
 ('13000000-0000-4000-8000-000000000009','export-dead@example.invalid');
insert into public.profiles(id,auth_user_id,name) values
 ('13100000-0000-4000-8000-000000000009','13000000-0000-4000-8000-000000000009','Dead Purge');
insert into public.privacy_requests(id,profile_id,kind) values
 ('13400000-0000-4000-8000-000000000009','13100000-0000-4000-8000-000000000009','access');
insert into private.data_exports(
 id,privacy_request_id,profile_id,status,storage_path,content_digest,ready_at,expires_at)
values
 ('13500000-0000-4000-8000-000000000009','13400000-0000-4000-8000-000000000009',
  '13100000-0000-4000-8000-000000000009','ready',
  'exports/13100000-0000-4000-8000-000000000009/13500000-0000-4000-8000-000000000009.zip',
  repeat('9',64),now(),now()+interval '1 hour');
select lives_ok($$select public.delete_account(
 '13000000-0000-4000-8000-000000000009','13200000-0000-4000-8000-000000000009',
 '13300000-0000-4000-8000-000000000013',repeat('d',64),1,1)$$,
 'the dead-purge fixture starts with a known export path');
select is((select status from private.deletion_requests
 where profile_id='13100000-0000-4000-8000-000000000009'),
 'cleaning_storage','a pending known-path purge keeps the saga in Storage');
select is(
  public.worker_acquire_external_effect(array['delete_auth_user']::text[]),
  null::jsonb,'Auth is not acquirable while the known-path purge is non-terminal');
update private.external_effects
set status='dead',attempts=8,last_error_code='STORAGE_UNAVAILABLE',completed_at=now()
where kind='delete_data_export'
  and resource_id='13500000-0000-4000-8000-000000000009'
  and dedupe_key like '%:13500000-0000-4000-8000-000000000009:%';
select is(
  (select status from private.deletion_requests
   where profile_id='13100000-0000-4000-8000-000000000009'),
  'deleting_auth','a dead purge releases the saga instead of stranding it silently');
select ok(
  (private.deletion_request_projection('13100000-0000-4000-8000-000000000009')
    ->>'has_operational_failure')::boolean,
  'the saga exposes an operational failure while advancing past a dead purge');
select is((select status||':'||(storage_path is not null)::text||':'||(purged_at is null)::text
 from private.data_exports where id='13500000-0000-4000-8000-000000000009'),
 'failed:true:true','dead purge keeps the known path private and never fabricates purged_at');
select is(
  (select count(*) from private.external_effects
   where kind='delete_auth_user' and resource_id=(
     select id from private.deletion_requests
     where profile_id='13100000-0000-4000-8000-000000000009') and status='pending'),
  1::bigint,'dead purge advancement publishes exactly one Auth effect');

set local request.jwt.claims='{"sub":"13000000-0000-4000-8000-000000000009","session_id":"13200000-0000-4000-8000-000000000009"}';
set local role authenticated;
select ok((select has_operational_failure from public.get_own_deletion_request()),
 'the titular sees the durable boolean without an internal error code');
reset role;
reset request.jwt.claims;

delete from auth.users where id='13000000-0000-4000-8000-000000000009';
create temporary table dead_purge_auth_effect(effect jsonb);
insert into dead_purge_auth_effect
select public.worker_acquire_external_effect(array['delete_auth_user']::text[]);
select lives_ok($$select public.worker_confirm_deletion_effect(
 (select (effect->>'id')::uuid from dead_purge_auth_effect),
 (select (effect->>'lease_token')::uuid from dead_purge_auth_effect))$$,
 'Auth absence advances the failed-purge saga to finalizing');
select lives_ok($$select public.finalize_deletion((select id from private.deletion_requests
 where profile_id='13100000-0000-4000-8000-000000000009'))$$,
 'a terminal Storage failure does not strand finalization');
select lives_ok($$select public.worker_complete_external_effect(
 (select (effect->>'id')::uuid from dead_purge_auth_effect),
 (select (effect->>'lease_token')::uuid from dead_purge_auth_effect),
 'succeeded',null)$$,'the Auth effect can close after finalization');
select ok((select status='completed' and auth_user_id is null and last_error_code is null
  and has_operational_failure
 from private.deletion_requests where profile_id='13100000-0000-4000-8000-000000000009'),
 'completion redacts Auth/error text while preserving the durable failure marker');
select is((select array_agg(key order by key)
 from jsonb_object_keys(private.deletion_request_projection(
   '13100000-0000-4000-8000-000000000009')) key),
 array['completed_at','has_operational_failure','id','requested_at','status']::text[],
 'the completed projection still contains exactly five non-sensitive fields');
select ok((private.deletion_request_projection('13100000-0000-4000-8000-000000000009')
 ->>'has_operational_failure')::boolean,
 'the completed projection keeps the failure signal true after error redaction');
select is((select purged_at from private.data_exports
 where id='13500000-0000-4000-8000-000000000009'),null::timestamptz,
 'completion still does not claim the dead Storage purge succeeded');
select ok(not exists(select 1 from private.external_effects
 where last_error_code is not null and last_error_code ~* '(exports/|token|@|example[.]invalid)'),
 'external effect codes contain no path, token or e-mail');
select ok(not exists(select 1 from private.job_runs
 where coalesce(summary::text,'') ~* '(exports/|token|@|example[.]invalid)'),
 'job summaries contain no path, token or e-mail');

select * from finish();
rollback;
