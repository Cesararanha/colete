begin;

-- M2, fatia 3: convites de grupo do piloto. Contratos: docs/25 §§2,5,8.1,
-- docs/13 §§0,5.0,8, docs/10 §3 e docs/17 §§2,4. Nenhuma chave HMAC
-- ou material completo de convite entra no Postgres.

-- A coluna foi declarada em docs/10 §3 para esta migration. O valor novo é
-- exclusivamente o digest de lookup calculado pela Edge; convites de fixture
-- anteriores podem conservá-la NULL até o expurgo.
alter table public.group_invites
  add column code_digest text unique;

alter table public.group_invites
  add constraint group_invites_code_digest_shape
  check (code_digest is null or code_digest ~ '^[0-9a-f]{64}$');

-- Limite de piloto. O harness pode trocar esse valor somente no banco local
-- para testar N+1; o caminho de produção é sempre esta mesma RPC.
insert into private.app_limits (limit_key, limit_value, unit, notes)
values ('invite_attempts_per_hour', 20, 'attempts',
        'Tentativas de preview e resgate somadas por perfil na janela móvel de 1 h.');

create table private.invite_rate_limits (
  attempt_id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id),
  attempted_at timestamptz not null default clock_timestamp(),
  result_class text not null default 'failure'
    check (result_class in ('failure', 'success'))
);

create index invite_rate_limits_profile_time_idx
  on private.invite_rate_limits (profile_id, attempted_at, attempt_id);
create index invite_rate_limits_time_idx
  on private.invite_rate_limits (attempted_at);

comment on table private.invite_rate_limits is
  'Orçamento transitório por perfil, fora de backup/export; sem token, código, MAC, IP ou motivo livre.';

-- Tabela privada de serviço: sem RLS e sem grants DML, conforme AGENTS §2.
-- O lock do perfil serializa admissões do mesmo titular; FOR NO KEY UPDATE é
-- compatível com o FOR KEY SHARE da FK da idempotência (M2-D13).
create function public.check_and_debit_invite_attempt(
  profile_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_limit bigint;
  v_now timestamptz;
  v_count bigint;
  v_attempt_id uuid;
  v_available_at timestamptz;
  v_retry_after integer;
begin
  v_actor_id := private.require_actor_context(
    p_actor_auth_user_id, p_actor_session_id);
  perform 1 from public.profiles where id = v_actor_id for no key update;
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);
  if profile_id is distinct from v_actor_id then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  select limit_value into v_limit from private.app_limits
  where limit_key = 'invite_attempts_per_hour';
  if v_limit is null or v_limit <= 0 then
    raise exception using errcode = 'P0001', message = 'RATE_LIMIT_UNAVAILABLE';
  end if;
  v_now := clock_timestamp();
  select count(*) into v_count from private.invite_rate_limits
  where invite_rate_limits.profile_id = v_actor_id
    and attempted_at > v_now - interval '1 hour';

  insert into private.invite_rate_limits (profile_id, attempted_at)
  values (v_actor_id, v_now)
  returning attempt_id into v_attempt_id;

  if v_count < v_limit then
    return jsonb_build_object('allowed', true, 'attempt_id', v_attempt_id,
      'retry_after', null, 'available_at', null);
  end if;

  -- A tentativa recusada também ocupa orçamento. Com N+1 linhas presentes,
  -- a primeira admissão nova exige que duas expirem; o índice da linha é
  -- count - limit, com OFFSET zero-based.
  select attempted_at + interval '1 hour' into v_available_at
  from private.invite_rate_limits
  where invite_rate_limits.profile_id = v_actor_id
    and attempted_at > v_now - interval '1 hour'
  order by attempted_at, attempt_id
  offset (v_count - v_limit + 1) limit 1;
  v_retry_after := greatest(0, ceil(extract(epoch from v_available_at - v_now))::integer);
  return jsonb_build_object('allowed', false, 'attempt_id', v_attempt_id,
    'retry_after', v_retry_after, 'available_at', v_available_at);
end;
$function$;

create function public.mark_invite_attempt_success(
  attempt_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_session_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_owner_id uuid;
begin
  v_actor_id := private.require_actor_context(
    p_actor_auth_user_id, p_actor_session_id);
  perform 1 from public.profiles where id = v_actor_id for no key update;
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);
  select profile_id into v_owner_id
  from private.invite_rate_limits where invite_rate_limits.attempt_id =
    mark_invite_attempt_success.attempt_id
  for no key update;
  if not found or v_owner_id is distinct from v_actor_id then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  update private.invite_rate_limits
  set result_class = 'success'
  where invite_rate_limits.attempt_id = mark_invite_attempt_success.attempt_id
    and result_class = 'failure';
end;
$function$;

revoke all on function public.check_and_debit_invite_attempt(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.mark_invite_attempt_success(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.check_and_debit_invite_attempt(uuid, uuid, uuid)
  to service_role;
grant execute on function public.mark_invite_attempt_success(uuid, uuid, uuid)
  to service_role;

create function private.purge_invite_rate_limits()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_started_at timestamptz := clock_timestamp();
  v_now timestamptz := clock_timestamp();
  v_scanned bigint;
  v_purged bigint;
begin
  select count(*) into v_scanned from private.invite_rate_limits
  where attempted_at <= v_now - interval '1 hour';
  with expired as (
    select attempt_id from private.invite_rate_limits
    where attempted_at <= v_now - interval '1 hour'
    order by attempted_at, attempt_id
    for update skip locked
  )
  delete from private.invite_rate_limits as limits
  using expired where limits.attempt_id = expired.attempt_id;
  get diagnostics v_purged = row_count;
  insert into private.retention_runs
    (policy, window_start, window_end, scanned, purged, failed, started_at, finished_at)
  values ('purge_invite_rate_limits', v_now - interval '1 hour', v_now,
          v_scanned::integer, v_purged::integer, 0, v_started_at, clock_timestamp());
  return jsonb_build_object('scanned', v_scanned, 'purged', v_purged);
end;
$function$;

revoke all on function private.purge_invite_rate_limits()
  from public, anon, authenticated, service_role;


-- Expurgo por minuto, inclusive quando o perfil não produz nova tentativa.
create or replace function private.worker_job_slot(p_job_name text, p_now timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_now_utc timestamp := p_now at time zone 'UTC';
  v_slot timestamptz;
begin
  if p_job_name in ('process_external_effects', 'purge_invite_rate_limits') then
    return date_trunc('minute', v_now_utc) at time zone 'UTC';
  elsif p_job_name = 'health_check_jobs' then
    return (
      date_trunc('hour', v_now_utc)
      + make_interval(mins => (extract(minute from v_now_utc)::integer / 5) * 5)
    ) at time zone 'UTC';
  elsif p_job_name = 'purge_expired_revoked_sessions' then
    v_slot := (date_trunc('hour', v_now_utc) at time zone 'UTC')
      + interval '17 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 hour' end;
  elsif p_job_name = 'purge_expired_idempotency_outcomes' then
    v_slot := (date_trunc('day', v_now_utc) at time zone 'UTC')
      + interval '3 hours 23 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 day' end;
  elsif p_job_name = 'purge_completed_deletion_requests' then
    v_slot := (date_trunc('day', v_now_utc) at time zone 'UTC')
      + interval '3 hours 43 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 day' end;
  elsif p_job_name = 'expire_data_exports' then
    v_slot := (date_trunc('hour', v_now_utc) at time zone 'UTC')
      + interval '7 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 hour' end;
  elsif p_job_name in ('purge_removed_memberships', 'purge_terminal_group_invites') then
    v_slot := (date_trunc('day', v_now_utc) at time zone 'UTC')
      + interval '3 hours 53 minutes';
    return case when v_slot <= p_now then v_slot else v_slot - interval '1 day' end;
  end if;

  raise exception using errcode = '22023', message = 'VALIDATION';
end;
$function$;

create or replace function public.worker_execute_database_job(p_run_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_run private.job_runs%rowtype; v_result jsonb; v_scanned bigint; v_failed bigint; v_stale bigint;
begin
  if p_run_id is null then raise exception using errcode='22023',message='VALIDATION'; end if;
  select run.* into v_run from private.job_runs run where run.id=p_run_id for no key update;
  if not found or v_run.status<>'running' then raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
  if v_run.job_name='purge_expired_revoked_sessions' then
    v_result:=private.purge_expired_revoked_sessions();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_expired_idempotency_outcomes' then
    v_result:=private.purge_expired_idempotency_outcomes(); v_scanned:=(v_result->>'payload_expired')::bigint+(v_result->>'tombstones_deleted')::bigint;
    return jsonb_build_object('scanned',v_scanned,'changed',v_scanned,'skipped',0,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_completed_deletion_requests' then
    v_result:=private.purge_completed_deletion_requests();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='expire_data_exports' then
    v_result:=private.expire_data_exports();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'changed')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'changed')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_invite_rate_limits' then
    v_result:=private.purge_invite_rate_limits();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_terminal_group_invites' then
    v_result:=private.purge_terminal_group_invites();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='purge_removed_memberships' then
    v_result:=private.purge_removed_memberships();
    return jsonb_build_object('scanned',(v_result->>'scanned')::bigint,'changed',(v_result->>'purged')::bigint,'skipped',(v_result->>'scanned')::bigint-(v_result->>'purged')::bigint,'failed',0,'stale',0,'duration_ms',0);
  elsif v_run.job_name='health_check_jobs' then
    select count(*),count(*) filter(where run.status='failed'),count(*) filter(where run.error_code='RUN_ABANDONED') into v_scanned,v_failed,v_stale
    from private.job_runs run where run.id<>p_run_id and run.started_at>=now()-interval '24 hours';
    return jsonb_build_object('scanned',v_scanned,'changed',0,'skipped',v_scanned-v_failed,'failed',v_failed,'stale',v_stale,'duration_ms',0);
  end if;
  raise exception using errcode='22023',message='VALIDATION';
end;
$function$;

revoke all on function private.worker_job_slot(text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.worker_execute_database_job(bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.worker_execute_database_job(bigint) to service_role;


select cron.schedule('colete_v1_purge_invite_rate_limits', '* * * * *',
  $$select private.invoke_worker_cron('purge_invite_rate_limits');$$);
select cron.schedule('colete_v1_purge_terminal_group_invites', '53 3 * * *',
  $$select private.invoke_worker_cron('purge_terminal_group_invites');$$);


-- As allowlists crescem por migration append-only; os desfechos persistidos
-- carregam apenas IDs estáveis e logical_result.
alter table private.idempotency_records
  drop constraint idempotency_records_operation_check,
  drop constraint idempotency_records_outcome_code_check;
alter table private.idempotency_records
  add constraint idempotency_records_operation_check check (operation in (
    'complete_profile', 'update_profile', 'accept_policies',
    'revoke_current_session', 'delete_account', 'request_data_export',
    'approve_member', 'remove_member', 'set_role', 'set_monthly',
    'set_ratings_visibility', 'transfer_ownership', 'leave_group',
    'create_group', 'join_by_code', 'join_by_invite',
    'revoke_group_invite', 'regenerate_group_invite', 'issue_group_invite'
  )),
  add constraint idempotency_records_outcome_code_check check (
    outcome_code is null or outcome_code in (
      'profile_created', 'profile_updated', 'policies_accepted',
      'session_revoked', 'deletion_requested', 'data_export_requested',
      'member_approved', 'member_refused', 'member_removed', 'role_set',
      'monthly_set', 'ratings_visibility_set', 'ownership_transferred',
      'group_left', 'group_created', 'membership_requested',
      'membership_reentry_requested', 'membership_request_unchanged',
      'membership_already_active', 'invite_revoked',
      'invite_revocation_unchanged', 'invite_regenerated', 'invite_issued'
    )
  );

alter function private.validate_idempotency_outcome(text, jsonb)
  rename to validate_through_group_membership_outcome;

create function private.validate_idempotency_outcome(p_operation text, p_outcome jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_keys text[] := array['group_id', 'invite_id', 'logical_result'];
  v_results text[];
  v_id_key text;
  v_id uuid;
begin
  if p_operation not in (
    'create_group', 'join_by_code', 'join_by_invite',
    'revoke_group_invite', 'regenerate_group_invite', 'issue_group_invite') then
    perform private.validate_through_group_membership_outcome(p_operation, p_outcome);
    return;
  end if;
  v_results := case p_operation
    when 'create_group' then array['group_created']
    when 'join_by_code' then array['membership_requested', 'membership_reentry_requested',
       'membership_request_unchanged', 'membership_already_active']
    when 'join_by_invite' then array['membership_requested', 'membership_reentry_requested',
       'membership_request_unchanged', 'membership_already_active']
    when 'revoke_group_invite' then array['invite_revoked', 'invite_revocation_unchanged']
    when 'regenerate_group_invite' then array['invite_regenerated']
    else array['invite_issued'] end;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
     or (select array_agg(key order by key) from jsonb_object_keys(p_outcome) as key)
          is distinct from v_keys
     or jsonb_typeof(p_outcome -> 'logical_result') <> 'string'
     or not (p_outcome ->> 'logical_result' = any(v_results)) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  foreach v_id_key in array array['group_id', 'invite_id'] loop
    if jsonb_typeof(p_outcome -> v_id_key) <> 'string'
       or p_outcome ->> v_id_key
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
    begin
      v_id := (p_outcome ->> v_id_key)::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end;
    if p_outcome ->> v_id_key <> v_id::text then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
  end loop;
end;
$function$;

revoke all on function private.validate_through_group_membership_outcome(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.validate_idempotency_outcome(text, jsonb)
  from public, anon, authenticated, service_role;
create or replace function private.acquire_group_idempotency(
  p_actor_key text,
  p_operation text,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer
)
returns table (
  acquired boolean,
  record_state text,
  outcome_code text,
  resource_type text,
  resource_id uuid,
  outcome jsonb
)
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_inserted boolean := false;
  v_wait_timeout_ms bigint;
  v_previous_lock_timeout text;
  v_record private.idempotency_records%rowtype;
begin
  if current_setting('transaction_isolation') <> 'read committed'
     or p_actor_key is null or p_operation is null or p_request_id is null
     or p_input_hmac is null
     or p_operation not in ('approve_member', 'remove_member', 'set_role', 'set_monthly',
                            'set_ratings_visibility', 'transfer_ownership', 'leave_group',
                            'create_group', 'join_by_code', 'join_by_invite',
                            'revoke_group_invite', 'regenerate_group_invite', 'issue_group_invite')
     or p_canonical_version is distinct from 1
     or p_hash_key_version is null or p_hash_key_version not between 1 and 32767
     or p_input_hmac !~ '^[0-9a-f]{64}$'
     or p_actor_key
        !~ '^profile:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  begin
    v_actor_id := substring(p_actor_key from 9)::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end;

  if p_actor_key <> 'profile:' || v_actor_id::text
     or not exists (select 1 from public.profiles where id = v_actor_id) then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  select limit_value into v_wait_timeout_ms
  from private.app_limits where limit_key = 'idempotency_wait_timeout_ms';
  if v_wait_timeout_ms is null or v_wait_timeout_ms <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;

  v_previous_lock_timeout := current_setting('lock_timeout');
  begin
    perform set_config('lock_timeout', v_wait_timeout_ms::text || 'ms', true);
    insert into private.idempotency_records (
      actor_key, actor_id, operation, request_id, request_hash,
      canonical_version, hash_key_version
    ) values (
      p_actor_key, v_actor_id, p_operation, p_request_id, p_input_hmac,
      p_canonical_version::smallint, p_hash_key_version::smallint
    )
    on conflict (actor_key, operation, request_id) do nothing
    returning true into v_inserted;
    perform set_config('lock_timeout', v_previous_lock_timeout, true);
  exception when lock_not_available then
    perform set_config('lock_timeout', v_previous_lock_timeout, true);
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_WAIT_TIMEOUT';
  end;

  if v_inserted then
    return query select true, 'executing_uncommitted'::text, null::text,
      null::text, null::uuid, null::jsonb;
    return;
  end if;

  select records.* into strict v_record
  from private.idempotency_records as records
  where records.actor_key = p_actor_key
    and records.operation = p_operation
    and records.request_id = p_request_id;

  if v_record.request_hash <> p_input_hmac
     or v_record.canonical_version <> p_canonical_version
     or v_record.hash_key_version <> p_hash_key_version then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
  end if;
  if v_record.state = 'payload_expired' then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_EXPIRED';
  elsif v_record.state = 'executing_uncommitted' then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_WAIT_TIMEOUT';
  end if;

  return query select false, v_record.state, v_record.outcome_code,
    v_record.resource_type, v_record.resource_id, v_record.outcome;
end;
$function$;

create or replace function private.complete_group_idempotency(
  p_actor_key text,
  p_operation text,
  p_request_id uuid,
  p_input_hmac text,
  p_canonical_version integer,
  p_hash_key_version integer,
  p_outcome jsonb
)
returns void
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_actor_id uuid;
begin
  if p_operation is null
     or p_operation not in ('approve_member', 'remove_member', 'set_role', 'set_monthly',
                            'set_ratings_visibility', 'transfer_ownership', 'leave_group',
                            'create_group', 'join_by_code', 'join_by_invite',
                            'revoke_group_invite', 'regenerate_group_invite', 'issue_group_invite') then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  perform private.validate_idempotency_outcome(p_operation, p_outcome);
  begin
    v_actor_id := substring(p_actor_key from 9)::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end;

  update private.idempotency_records as records
  set state = 'completed',
      outcome_code = p_outcome ->> 'logical_result',
      resource_type = 'group',
      resource_id = (p_outcome ->> 'group_id')::uuid,
      outcome = p_outcome,
      updated_at = now(),
      completed_at = now()
  where records.actor_key = p_actor_key
    and records.actor_id = v_actor_id
    and records.operation = p_operation
    and records.request_id = p_request_id
    and records.request_hash = p_input_hmac
    and records.canonical_version = p_canonical_version
    and records.hash_key_version = p_hash_key_version
    and records.state = 'executing_uncommitted';

  if not found then
    raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_CONFLICT';
  end if;
end;
$function$;

revoke all on function private.acquire_group_idempotency(text, text, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function private.complete_group_idempotency(text, text, uuid, text, integer, integer, jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.enforce_idempotency_conclusion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare v_record private.idempotency_records%rowtype;
begin
  if tg_op='DELETE' then
    if old.state='executing_uncommitted' then raise exception using errcode='23514',message='IDEMPOTENCY_INCOMPLETE'; end if;
    return null;
  end if;
  if tg_op='INSERT' and new.state<>'executing_uncommitted' then
    raise exception using errcode='23514',message='IDEMPOTENCY_TRANSITION_INVALID';
  end if;
  if tg_op='UPDATE' and not ((old.state='executing_uncommitted' and new.state='completed')
      or (old.state='completed' and new.state='payload_expired')) then
    raise exception using errcode='23514',message='IDEMPOTENCY_TRANSITION_INVALID';
  end if;
  select records.* into v_record from private.idempotency_records records
  where records.actor_key=new.actor_key and records.operation=new.operation
    and records.request_id=new.request_id;
  if found and v_record.state='executing_uncommitted' then
    raise exception using errcode='23514',message='IDEMPOTENCY_INCOMPLETE';
  end if;
  if found and v_record.state='completed' then
    perform private.validate_idempotency_outcome(v_record.operation,v_record.outcome);
    if v_record.outcome_code <> v_record.outcome ->> 'logical_result'
       or (v_record.operation='complete_profile' and (v_record.resource_type<>'profile'
         or v_record.resource_id<>v_record.actor_id or v_record.resource_id<>(v_record.outcome->>'profile_id')::uuid))
       or (v_record.operation in ('update_profile','accept_policies') and (v_record.resource_type is not null or v_record.resource_id is not null))
       or (v_record.operation='revoke_current_session' and (v_record.resource_type<>'auth_session' or v_record.resource_id<>(v_record.outcome->>'session_id')::uuid))
       or (v_record.operation='delete_account' and (v_record.resource_type<>'deletion_request' or v_record.resource_id<>(v_record.outcome->>'deletion_request_id')::uuid))
       or (v_record.operation='request_data_export' and (v_record.resource_type<>'data_export' or v_record.resource_id<>(v_record.outcome->>'export_id')::uuid))
       or (v_record.operation in ('approve_member','remove_member','set_role','set_monthly',
                                  'set_ratings_visibility','transfer_ownership','leave_group',
                                  'create_group','join_by_code','join_by_invite',
                                  'revoke_group_invite','regenerate_group_invite','issue_group_invite')
           and (v_record.resource_type is distinct from 'group'
                or v_record.resource_id is distinct from (v_record.outcome->>'group_id')::uuid)) then
      raise exception using errcode='23514',message='IDEMPOTENCY_OUTCOME_INVALID';
    end if;
  end if;
  return null;
end;
$function$;

revoke all on function private.enforce_idempotency_conclusion()
  from public, anon, authenticated, service_role;



-- Uma regra para criar e, na 0018, renomear: NFC, Zs/Zl/Zp reduzidos a
-- espaço, trim/colapso, 2–40 pontos de código e controles fechados.
create function private.normalize_group_name(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_name text;
  v_result text := '';
  v_character text;
  v_code integer;
  v_index integer;
begin
  if p_name is null then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  v_name := normalize(p_name, NFC);
  for v_index in 1..char_length(v_name) loop
    v_character := substr(v_name, v_index, 1);
    v_code := ascii(v_character);
    if v_code between 0 and 31 or v_code between 127 and 159
       or v_code in (1564, 8203, 8206, 8207, 8234, 8235, 8236, 8237, 8238,
                     8288, 8289, 8290, 8291, 8292, 8294, 8295, 8296, 8297, 65279) then
      raise exception using errcode = '22023', message = 'VALIDATION';
    end if;
    if v_code in (32, 160, 5760, 8239, 8287, 12288, 8232, 8233)
       or v_code between 8192 and 8202 then
      v_result := v_result || ' ';
    else
      v_result := v_result || v_character;
    end if;
  end loop;
  v_result := btrim(regexp_replace(v_result, ' +', ' ', 'g'));
  if char_length(v_result) not between 2 and 40 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  return v_result;
end;
$function$;

revoke all on function private.normalize_group_name(text)
  from public, anon, authenticated, service_role;

-- A Edge entrega somente ID, versão, nonce público e digests. A validação
-- estrutural da RPC não transforma esses campos em segredo nem aceita código.
create function private.require_invite_material(
  p_invite_id uuid, p_token_version smallint, p_nonce_hex text,
  p_token_digest text, p_code_digest text
)
returns void
language plpgsql
immutable
set search_path = ''
as $function$
begin
  if p_invite_id is null or p_token_version is distinct from 1
     or p_nonce_hex is null or p_token_digest is null or p_code_digest is null
     or p_nonce_hex !~ '^[0-9a-f]{32}$'
     or p_token_digest !~ '^[0-9a-f]{64}$'
     or p_code_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
end;
$function$;

revoke all on function private.require_invite_material(uuid, smallint, text, text, text)
  from public, anon, authenticated, service_role;


-- Criação: o convite inicial nasce no mesmo commit do grupo e da membership.
-- O token e o código completos nunca são parâmetros da RPC.
create function public.create_group(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_request_id uuid,
  p_input_hmac text, p_canonical_version integer, p_hash_key_version integer,
  p_name text, p_invite_id uuid, p_token_version smallint,
  p_nonce_hex text, p_token_digest text, p_code_digest text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_actor_key text;
  v_acquired record;
  v_group_id uuid;
  v_invite_id uuid;
  v_name text;
  v_count bigint;
  v_limit bigint;
  v_outcome jsonb;
  v_authority text;
begin
  perform private.require_internal_transport(
    p_request_id, p_input_hmac, p_canonical_version, p_hash_key_version);
  v_name := private.normalize_group_name(p_name);
  if p_actor_auth_user_id is null or p_actor_session_id is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  select id into v_actor_id from public.profiles
  where auth_user_id = p_actor_auth_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_actor_key := 'profile:' || v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key, 'create_group', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version);

  perform 1 from public.profiles where id = v_actor_id for no key update;
  if not v_acquired.acquired then
    v_group_id := (v_acquired.outcome ->> 'group_id')::uuid;
    v_invite_id := (v_acquired.outcome ->> 'invite_id')::uuid;
    perform 1 from public.groups where id = v_group_id for no key update;
    perform 1 from public.group_members
      where group_id = v_group_id and profile_id = v_actor_id for no key update;
    perform 1 from public.group_invites where id = v_invite_id for no key update;
  end if;
  perform private.require_group_actor_after_locks(
    v_actor_id, p_actor_auth_user_id, p_actor_session_id);
  if not v_acquired.acquired then
    begin
      v_authority := private.group_actor_authority(v_group_id, v_actor_id);
      perform private.require_group_not_suspended(v_group_id);
    exception when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
      if sqlerrm in ('NOT_FOUND', 'GROUP_ARCHIVED', 'NOT_MEMBER',
                     'GROUP_SUSPENDED') then
        return jsonb_build_object('outcome', v_acquired.outcome);
      end if;
      raise;
    end;
    return jsonb_build_object('outcome', v_acquired.outcome,
      'current', jsonb_build_object('group_id', v_group_id,
        'group_name', (select name from public.groups where id = v_group_id)));
  end if;

  perform private.require_invite_material(p_invite_id, p_token_version,
    p_nonce_hex, p_token_digest, p_code_digest);
  select limit_value into v_limit from private.app_limits
  where limit_key = 'max_active_groups_per_profile';
  if v_limit is null or v_limit <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION';
  end if;
  select count(*) into v_count from public.group_members as membership
  join public.groups as grp on grp.id = membership.group_id
  where membership.profile_id = v_actor_id
    and membership.status = 'active' and grp.archived_at is null;
  if v_count >= v_limit then
    raise exception using errcode = 'P0001', message = 'GROUP_LIMIT';
  end if;

  insert into public.groups (name, owner_id) values (v_name, v_actor_id)
  returning id into v_group_id;
  insert into public.group_members (group_id, profile_id, role, status)
  values (v_group_id, v_actor_id, 'organizer', 'active');
  insert into public.group_invites
    (id, group_id, token_version, public_nonce, token_digest, code_digest,
     created_by, expires_at)
  values (p_invite_id, v_group_id, p_token_version, decode(p_nonce_hex, 'hex'),
          p_token_digest, p_code_digest, v_actor_id, now() + interval '30 days');
  v_outcome := jsonb_build_object('group_id', v_group_id::text,
    'invite_id', p_invite_id::text, 'logical_result', 'group_created');
  perform private.complete_group_idempotency(
    v_actor_key, 'create_group', p_request_id, p_input_hmac,
    p_canonical_version, p_hash_key_version, v_outcome);
  return jsonb_build_object('outcome', v_outcome,
    'current', jsonb_build_object('group_id', v_group_id, 'group_name', v_name));
end;
$function$;

revoke all on function public.create_group(
  uuid, uuid, uuid, text, integer, integer, text, uuid, smallint, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_group(
  uuid, uuid, uuid, text, integer, integer, text, uuid, smallint, text, text, text)
  to service_role;

-- Estado terminal, em ordem de precedência M2-D42. Chamado somente após
-- travar a linha do convite. Não contém material sensível na exceção.
create function private.require_live_group_invite(p_invite_id uuid)
returns void language plpgsql stable set search_path = '' as $function$
declare v_invite public.group_invites%rowtype;
begin
  select * into v_invite from public.group_invites where id = p_invite_id;
  if not found then raise exception using errcode='22023', message='CODE_INVALID'; end if;
  if v_invite.revoked_at is not null then
    raise exception using errcode='P0001', message='INVITE_REVOKED';
  elsif v_invite.expires_at <= now() then
    raise exception using errcode='P0001', message='INVITE_EXPIRED';
  elsif v_invite.used_count >= v_invite.max_uses then
    raise exception using errcode='P0001', message='INVITE_USED';
  end if;
end;
$function$;
revoke all on function private.require_live_group_invite(uuid)
  from public, anon, authenticated, service_role;

-- Lookup não é autoridade. Preview e resgate repetem a comparação do digest
-- sob a trava da linha antes de expor o nome ou alterar membership.
create function private.preview_group_invite(
  p_actor_auth_user_id uuid, p_actor_session_id uuid,
  p_invite_id uuid, p_token_version smallint, p_token_digest text,
  p_code_digest text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_actor_id uuid;
  v_invite public.group_invites%rowtype;
  v_group public.groups%rowtype;
  v_membership public.group_members%rowtype;
  v_limit bigint;
  v_capacity bigint;
  v_count bigint;
begin
  v_actor_id := private.require_actor_context(p_actor_auth_user_id, p_actor_session_id);
  if p_code_digest is not null then
    if p_code_digest !~ '^[0-9a-f]{64}$' then
      raise exception using errcode='22023', message='CODE_INVALID';
    end if;
    select * into v_invite from public.group_invites
    where code_digest = p_code_digest and token_version = 1;
  else
    if p_invite_id is null or p_token_version is distinct from 1
       or p_token_digest is null or p_token_digest !~ '^[0-9a-f]{64}$' then
      raise exception using errcode='22023', message='CODE_INVALID';
    end if;
    select * into v_invite from public.group_invites where id=p_invite_id;
  end if;
  if not found then raise exception using errcode='22023', message='CODE_INVALID'; end if;
  perform 1 from public.profiles where id=v_actor_id for no key update;
  select * into v_group from public.groups where id=v_invite.group_id for no key update;
  select * into v_membership from public.group_members
    where group_id=v_invite.group_id and profile_id=v_actor_id for no key update;
  select * into v_invite from public.group_invites where id=v_invite.id for no key update;
  perform private.require_group_actor_after_locks(v_actor_id,p_actor_auth_user_id,p_actor_session_id);
  if (p_code_digest is not null and v_invite.code_digest is distinct from p_code_digest)
     or (p_code_digest is null and (v_invite.token_version is distinct from p_token_version
         or v_invite.token_digest is distinct from p_token_digest)) then
    raise exception using errcode='22023', message='CODE_INVALID';
  end if;
  perform private.require_live_group_invite(v_invite.id);
  if v_group.archived_at is not null then
    raise exception using errcode='P0001', message='GROUP_ARCHIVED';
  elsif v_group.suspended_at is not null then
    raise exception using errcode='P0001', message='GROUP_SUSPENDED';
  end if;
  if v_membership.status is distinct from 'pending'
     and v_membership.status is distinct from 'active' then
    select count(*) into v_count from public.group_members
    where group_id=v_group.id and status in ('pending','active');
    select limit_value into v_capacity from private.app_limits
      where limit_key='max_group_capacity';
    if v_capacity is null or v_capacity<=0 then
      raise exception using errcode='22023',message='VALIDATION';
    end if;
    if v_count >= v_capacity then raise exception using errcode='P0001', message='GROUP_FULL'; end if;
    select limit_value into v_limit from private.app_limits
    where limit_key='max_active_groups_per_profile';
    select count(*) into v_count from public.group_members m
      join public.groups g on g.id=m.group_id
      where m.profile_id=v_actor_id and m.status='active' and g.archived_at is null;
    if v_limit is null or v_count >= v_limit then
      raise exception using errcode='P0001', message='GROUP_LIMIT';
    end if;
  end if;
  return jsonb_build_object('group_name',v_group.name);
end;
$function$;
revoke all on function private.preview_group_invite(uuid,uuid,uuid,smallint,text,text)
  from public, anon, authenticated, service_role;

create function public.preview_group_by_code(
  p_actor_auth_user_id uuid, p_actor_session_id uuid, p_code_digest text
) returns jsonb language sql volatile security definer set search_path = '' as $function$
  select private.preview_group_invite(p_actor_auth_user_id,p_actor_session_id,
    null::uuid,null::smallint,null::text,p_code_digest);
$function$;
create function public.preview_group_by_invite(
  p_actor_auth_user_id uuid, p_actor_session_id uuid,
  p_invite_id uuid, p_token_version smallint, p_token_digest text
) returns jsonb language sql volatile security definer set search_path = '' as $function$
  select private.preview_group_invite(p_actor_auth_user_id,p_actor_session_id,
    p_invite_id,p_token_version,p_token_digest,null::text);
$function$;
revoke all on function public.preview_group_by_code(uuid,uuid,text)
  from public,anon,authenticated,service_role;
revoke all on function public.preview_group_by_invite(uuid,uuid,uuid,smallint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.preview_group_by_code(uuid,uuid,text) to service_role;
grant execute on function public.preview_group_by_invite(uuid,uuid,uuid,smallint,text) to service_role;

create function public.get_my_pending_group_requests(
  p_actor_auth_user_id uuid, p_actor_session_id uuid
) returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare v_actor_id uuid; v_result jsonb;
begin
  v_actor_id:=private.require_actor_context(p_actor_auth_user_id,p_actor_session_id);
  perform 1 from public.profiles where id=v_actor_id for no key update;
  perform private.require_group_actor_after_locks(v_actor_id,p_actor_auth_user_id,p_actor_session_id);
  select coalesce(jsonb_agg(jsonb_build_object('group_id',m.group_id,
    'group_name',g.name,'status','pending') order by m.last_requested_at desc,m.group_id),'[]'::jsonb)
  into v_result from public.group_members m join public.groups g on g.id=m.group_id
  where m.profile_id=v_actor_id and m.status='pending' and g.archived_at is null;
  return v_result;
end;
$function$;
revoke all on function public.get_my_pending_group_requests(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.get_my_pending_group_requests(uuid,uuid) to service_role;

-- O mesmo algoritmo transacional serve código e link. O envelope já foi
-- autenticado pela Edge; os bytes secretos nunca entram nesta chamada.
create function private.join_group_invite(
  p_operation text, p_actor_auth_user_id uuid, p_actor_session_id uuid,
  p_request_id uuid, p_input_hmac text, p_canonical_version integer,
  p_hash_key_version integer, p_invite_id uuid, p_token_version smallint,
  p_token_digest text, p_code_digest text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_actor_id uuid; v_actor_key text; v_acquired record;
  v_invite public.group_invites%rowtype; v_group public.groups%rowtype;
  v_member public.group_members%rowtype; v_group_id uuid; v_invite_id uuid;
  v_count bigint; v_limit bigint; v_capacity bigint; v_result text; v_outcome jsonb;
begin
  perform private.require_internal_transport(p_request_id,p_input_hmac,
    p_canonical_version,p_hash_key_version);
  v_actor_id:=private.require_actor_context(p_actor_auth_user_id,p_actor_session_id);
  v_actor_key:='profile:'||v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key,p_operation,p_request_id,p_input_hmac,p_canonical_version,p_hash_key_version);
  if v_acquired.acquired then
    if p_operation='join_by_code' then
      if p_code_digest is null or p_code_digest !~ '^[0-9a-f]{64}$' then
        raise exception using errcode='22023',message='CODE_INVALID';
      end if;
      select * into v_invite from public.group_invites
      where code_digest=p_code_digest and token_version=1;
    else
      if p_invite_id is null or p_token_version is distinct from 1
         or p_token_digest is null or p_token_digest !~ '^[0-9a-f]{64}$' then
        raise exception using errcode='22023',message='CODE_INVALID';
      end if;
      select * into v_invite from public.group_invites where id=p_invite_id;
    end if;
    if not found then raise exception using errcode='22023',message='CODE_INVALID'; end if;
    v_group_id:=v_invite.group_id; v_invite_id:=v_invite.id;
  else
    v_group_id:=(v_acquired.outcome->>'group_id')::uuid;
    v_invite_id:=(v_acquired.outcome->>'invite_id')::uuid;
  end if;
  perform 1 from public.profiles where id=v_actor_id for no key update;
  select * into v_group from public.groups where id=v_group_id for no key update;
  select * into v_member from public.group_members where group_id=v_group_id
    and profile_id=v_actor_id for no key update;
  select * into v_invite from public.group_invites where id=v_invite_id for no key update;
  perform private.require_group_actor_after_locks(v_actor_id,p_actor_auth_user_id,p_actor_session_id);
  if not v_acquired.acquired then
    if v_member.status in ('pending','active') and v_group.archived_at is null then
      return jsonb_build_object('outcome',v_acquired.outcome || jsonb_build_object(
        'reentry',(v_acquired.outcome->>'logical_result')='membership_reentry_requested'),
        'current',jsonb_build_object('group_id',v_group_id,'group_name',v_group.name,
          'status',v_member.status));
    end if;
    return jsonb_build_object('outcome',v_acquired.outcome || jsonb_build_object(
      'reentry',(v_acquired.outcome->>'logical_result')='membership_reentry_requested'));
  end if;
  if (p_operation='join_by_code' and (v_invite.code_digest is distinct from p_code_digest
      or v_invite.token_version<>1))
     or (p_operation='join_by_invite' and (v_invite.token_version is distinct from p_token_version
       or v_invite.token_digest is distinct from p_token_digest)) then
    raise exception using errcode='22023',message='CODE_INVALID';
  end if;
  perform private.require_live_group_invite(v_invite_id);
  if v_group.archived_at is not null then
    raise exception using errcode='P0001',message='GROUP_ARCHIVED';
  elsif v_group.suspended_at is not null then
    raise exception using errcode='P0001',message='GROUP_SUSPENDED';
  end if;
  if v_member.status='active' then
    v_result:='membership_already_active';
  elsif v_member.status='pending' then
    v_result:='membership_request_unchanged';
  else
    select count(*) into v_count from public.group_members
    where group_id=v_group_id and status in ('pending','active');
    select limit_value into v_capacity from private.app_limits
      where limit_key='max_group_capacity';
    if v_capacity is null or v_capacity<=0 then
      raise exception using errcode='22023',message='VALIDATION';
    end if;
    if v_count>=v_capacity then raise exception using errcode='P0001',message='GROUP_FULL'; end if;
    select limit_value into v_limit from private.app_limits
    where limit_key='max_active_groups_per_profile';
    select count(*) into v_count from public.group_members m
      join public.groups g on g.id=m.group_id
      where m.profile_id=v_actor_id and m.status='active' and g.archived_at is null;
    if v_limit is null or v_count>=v_limit then
      raise exception using errcode='P0001',message='GROUP_LIMIT';
    end if;
    update public.group_invites set used_count=used_count+1
      where id=v_invite_id and used_count<max_uses;
    if not found then raise exception using errcode='P0001',message='INVITE_USED'; end if;
    if v_member.group_id is null then
      insert into public.group_members(group_id,profile_id,role,status)
      values(v_group_id,v_actor_id,'player','pending');
      v_result:='membership_requested';
    else
      update public.group_members set status='pending',role='player',is_monthly=false,
        removed_at=null,removal_count=removal_count+1,last_requested_at=now()
      where group_id=v_group_id and profile_id=v_actor_id and status='removed';
      if not found then raise exception using errcode='P0001',message='CONCURRENT_CHANGE'; end if;
      v_result:='membership_reentry_requested';
    end if;
  end if;
  v_outcome:=jsonb_build_object('group_id',v_group_id,'invite_id',v_invite_id,
    'logical_result',v_result);
  perform private.complete_group_idempotency(v_actor_key,p_operation,p_request_id,
    p_input_hmac,p_canonical_version,p_hash_key_version,v_outcome);
  return jsonb_build_object('outcome',v_outcome || jsonb_build_object(
    'reentry',v_result='membership_reentry_requested'),
    'current',jsonb_build_object('group_id',v_group_id,'group_name',v_group.name,
      'status',case when v_member.status='active' then 'active' else 'pending' end));
end;
$function$;
revoke all on function private.join_group_invite(text,uuid,uuid,uuid,text,integer,integer,uuid,smallint,text,text)
  from public,anon,authenticated,service_role;

create function public.join_by_code(
  p_actor_auth_user_id uuid,p_actor_session_id uuid,p_request_id uuid,
  p_input_hmac text,p_canonical_version integer,p_hash_key_version integer,
  p_code_digest text
) returns jsonb language sql volatile security definer set search_path = '' as $function$
  select private.join_group_invite('join_by_code',p_actor_auth_user_id,p_actor_session_id,
    p_request_id,p_input_hmac,p_canonical_version,p_hash_key_version,
    null::uuid,null::smallint,null::text,p_code_digest);
$function$;
create function public.join_by_invite(
  p_actor_auth_user_id uuid,p_actor_session_id uuid,p_request_id uuid,
  p_input_hmac text,p_canonical_version integer,p_hash_key_version integer,
  p_invite_id uuid,p_token_version smallint,p_token_digest text
) returns jsonb language sql volatile security definer set search_path = '' as $function$
  select private.join_group_invite('join_by_invite',p_actor_auth_user_id,p_actor_session_id,
    p_request_id,p_input_hmac,p_canonical_version,p_hash_key_version,
    p_invite_id,p_token_version,p_token_digest,null::text);
$function$;
revoke all on function public.join_by_code(uuid,uuid,uuid,text,integer,integer,text)
  from public,anon,authenticated,service_role;
revoke all on function public.join_by_invite(uuid,uuid,uuid,text,integer,integer,uuid,smallint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.join_by_code(uuid,uuid,uuid,text,integer,integer,text) to service_role;
grant execute on function public.join_by_invite(uuid,uuid,uuid,text,integer,integer,uuid,smallint,text) to service_role;

-- Esta projeção é interna à Edge. Ela reconstitui o material em memória e
-- confere ambos os digests antes de emitir código e link ao titular autorizado.
create function public.get_invite_share_link(
  p_actor_auth_user_id uuid,p_actor_session_id uuid,p_invite_id uuid
) returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare v_actor_id uuid; v_group_id uuid; v_invite public.group_invites%rowtype; v_authority text;
begin
  v_actor_id:=private.require_actor_context(p_actor_auth_user_id,p_actor_session_id);
  select group_id into v_group_id from public.group_invites where id=p_invite_id;
  if not found then raise exception using errcode='P0002',message='NOT_FOUND'; end if;
  perform 1 from public.profiles where id=v_actor_id for no key update;
  perform 1 from public.groups where id=v_group_id for no key update;
  perform 1 from public.group_members where group_id=v_group_id
    and profile_id=v_actor_id for no key update;
  select * into v_invite from public.group_invites where id=p_invite_id for no key update;
  perform private.require_group_actor_after_locks(v_actor_id,p_actor_auth_user_id,p_actor_session_id);
  v_authority:=private.group_actor_authority(v_group_id,v_actor_id);
  if v_authority not in ('owner','organizer') then
    raise exception using errcode='42501',message='NOT_ORGANIZER';
  end if;
  perform private.require_group_not_suspended(v_group_id);
  perform private.require_live_group_invite(p_invite_id);
  if v_invite.token_version<>1 or v_invite.code_digest is null then
    raise exception using errcode='P0001',message='CONCURRENT_CHANGE';
  end if;
  return jsonb_build_object('invite_id',v_invite.id,'token_version',v_invite.token_version,
    'nonce_hex',encode(v_invite.public_nonce,'hex'),
    'token_digest',v_invite.token_digest,'code_digest',v_invite.code_digest,
    'expires_at',v_invite.expires_at,
    'remaining_uses',v_invite.max_uses-v_invite.used_count);
end;
$function$;
revoke all on function public.get_invite_share_link(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.get_invite_share_link(uuid,uuid,uuid) to service_role;

create function private.mutate_group_invite(
  p_operation text,p_actor_auth_user_id uuid,p_actor_session_id uuid,
  p_request_id uuid,p_input_hmac text,p_canonical_version integer,
  p_hash_key_version integer,p_group_id uuid,p_invite_id uuid,
  p_new_invite_id uuid,p_token_version smallint,p_nonce_hex text,
  p_token_digest text,p_code_digest text
) returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare
  v_actor_id uuid; v_actor_key text; v_acquired record; v_group_id uuid;
  v_invite_id uuid; v_invite public.group_invites%rowtype;
  v_group public.groups%rowtype; v_authority text; v_outcome jsonb;
  v_result text; v_current jsonb;
begin
  perform private.require_internal_transport(p_request_id,p_input_hmac,
    p_canonical_version,p_hash_key_version);
  v_actor_id:=private.require_actor_context(p_actor_auth_user_id,p_actor_session_id);
  v_actor_key:='profile:'||v_actor_id::text;
  select * into v_acquired from private.acquire_group_idempotency(
    v_actor_key,p_operation,p_request_id,p_input_hmac,p_canonical_version,p_hash_key_version);
  if not v_acquired.acquired then
    v_group_id:=(v_acquired.outcome->>'group_id')::uuid;
    v_invite_id:=(v_acquired.outcome->>'invite_id')::uuid;
  elsif p_operation='issue_group_invite' then
    v_group_id:=p_group_id;
    if v_group_id is null then raise exception using errcode='22023',message='VALIDATION'; end if;
  else
    v_invite_id:=p_invite_id;
    select group_id into v_group_id from public.group_invites where id=v_invite_id;
    if not found then raise exception using errcode='P0002',message='NOT_FOUND'; end if;
  end if;
  perform 1 from public.profiles where id=v_actor_id for no key update;
  select * into v_group from public.groups where id=v_group_id for no key update;
  if not found then raise exception using errcode='P0002',message='NOT_FOUND'; end if;
  perform 1 from public.group_members where group_id=v_group_id
    and profile_id=v_actor_id for no key update;
  if p_operation='issue_group_invite' then
    -- O grupo é o lock-pai. O predicado de convite vivo é recontado aqui,
    -- inclusive se todas as linhas terminais já tiverem sido expurgadas.
    perform 1 from public.group_invites where group_id=v_group_id
      order by id for no key update;
  else
    if p_operation='regenerate_group_invite' then
      select * into v_invite from public.group_invites where id=v_invite_id for update;
    else
      select * into v_invite from public.group_invites where id=v_invite_id for no key update;
    end if;
  end if;
  perform private.require_group_actor_after_locks(v_actor_id,p_actor_auth_user_id,p_actor_session_id);
  if not v_acquired.acquired then
    begin
      v_authority:=private.group_actor_authority(v_group_id,v_actor_id);
      perform private.require_group_not_suspended(v_group_id);
      if v_authority not in ('owner','organizer') then
        raise exception using errcode='42501',message='NOT_ORGANIZER';
      end if;
    exception when sqlstate '42501' or sqlstate 'P0001' or sqlstate 'P0002' then
      if sqlerrm in ('NOT_FOUND','NOT_MEMBER','NOT_ORGANIZER','GROUP_ARCHIVED','GROUP_SUSPENDED') then
        return jsonb_build_object('outcome',v_acquired.outcome);
      end if;
      raise;
    end;
    select * into v_invite from public.group_invites where id=v_invite_id;
    if not found then return jsonb_build_object('outcome',v_acquired.outcome); end if;
    v_current:=case when p_operation='revoke_group_invite' then
      jsonb_build_object('invite_id',v_invite_id,'revoked_at',v_invite.revoked_at)
      when p_operation='regenerate_group_invite' then
      jsonb_build_object('invite_id',v_invite_id,'expires_at',v_invite.expires_at,
        'remaining_uses',v_invite.max_uses-v_invite.used_count)
      else jsonb_build_object('invite_id',v_invite_id,'expires_at',v_invite.expires_at,
        'max_uses',v_invite.max_uses,'remaining_uses',v_invite.max_uses-v_invite.used_count) end;
    return jsonb_build_object('outcome',v_acquired.outcome,'current',v_current);
  end if;
  v_authority:=private.group_actor_authority(v_group_id,v_actor_id);
  if v_authority not in ('owner','organizer') then
    raise exception using errcode='42501',message='NOT_ORGANIZER';
  end if;
  perform private.require_group_not_suspended(v_group_id);
  if p_operation='revoke_group_invite' then
    if v_invite.revoked_at is null and v_invite.expires_at>now()
       and v_invite.used_count<v_invite.max_uses then
      update public.group_invites set revoked_at=now() where id=v_invite_id;
      v_result:='invite_revoked';
      select revoked_at into v_invite.revoked_at from public.group_invites where id=v_invite_id;
    else
      v_result:='invite_revocation_unchanged';
    end if;
    v_current:=jsonb_build_object('invite_id',v_invite_id,'revoked_at',v_invite.revoked_at);
  elsif p_operation='regenerate_group_invite' then
    perform private.require_live_group_invite(v_invite_id);
    perform private.require_invite_material(v_invite_id,p_token_version,
      p_nonce_hex,p_token_digest,p_code_digest);
    update public.group_invites set public_nonce=decode(p_nonce_hex,'hex'),
      token_digest=p_token_digest,code_digest=p_code_digest where id=v_invite_id;
    v_result:='invite_regenerated';
    v_current:=jsonb_build_object('invite_id',v_invite_id,'expires_at',v_invite.expires_at,
      'remaining_uses',v_invite.max_uses-v_invite.used_count);
  elsif p_operation='issue_group_invite' then
    if exists (select 1 from public.group_invites where group_id=v_group_id
      and revoked_at is null and expires_at>now() and used_count<max_uses) then
      raise exception using errcode='P0001',message='INVITE_ALREADY_ACTIVE';
    end if;
    perform private.require_invite_material(p_new_invite_id,p_token_version,
      p_nonce_hex,p_token_digest,p_code_digest);
    insert into public.group_invites(id,group_id,token_version,public_nonce,
      token_digest,code_digest,created_by,expires_at)
    values(p_new_invite_id,v_group_id,p_token_version,decode(p_nonce_hex,'hex'),
      p_token_digest,p_code_digest,v_actor_id,now()+interval '30 days');
    v_invite_id:=p_new_invite_id;
    select * into v_invite from public.group_invites where id=v_invite_id;
    v_result:='invite_issued';
    v_current:=jsonb_build_object('invite_id',v_invite_id,'expires_at',v_invite.expires_at,
      'max_uses',v_invite.max_uses,'remaining_uses',v_invite.max_uses);
  else
    raise exception using errcode='22023',message='VALIDATION';
  end if;
  v_outcome:=jsonb_build_object('group_id',v_group_id,'invite_id',v_invite_id,
    'logical_result',v_result);
  perform private.complete_group_idempotency(v_actor_key,p_operation,p_request_id,
    p_input_hmac,p_canonical_version,p_hash_key_version,v_outcome);
  return jsonb_build_object('outcome',v_outcome,'current',v_current);
end;
$function$;
revoke all on function private.mutate_group_invite(text,uuid,uuid,uuid,text,integer,integer,uuid,uuid,uuid,smallint,text,text,text)
  from public,anon,authenticated,service_role;

create function public.revoke_group_invite(
  p_actor_auth_user_id uuid,p_actor_session_id uuid,p_request_id uuid,
  p_input_hmac text,p_canonical_version integer,p_hash_key_version integer,
  p_invite_id uuid
) returns jsonb language sql volatile security definer set search_path = '' as $function$
  select private.mutate_group_invite('revoke_group_invite',p_actor_auth_user_id,
    p_actor_session_id,p_request_id,p_input_hmac,p_canonical_version,
    p_hash_key_version,null::uuid,p_invite_id,null::uuid,null::smallint,
    null::text,null::text,null::text);
$function$;
create function public.regenerate_group_invite(
  p_actor_auth_user_id uuid,p_actor_session_id uuid,p_request_id uuid,
  p_input_hmac text,p_canonical_version integer,p_hash_key_version integer,
  p_invite_id uuid,p_token_version smallint,p_nonce_hex text,
  p_token_digest text,p_code_digest text
) returns jsonb language sql volatile security definer set search_path = '' as $function$
  select private.mutate_group_invite('regenerate_group_invite',p_actor_auth_user_id,
    p_actor_session_id,p_request_id,p_input_hmac,p_canonical_version,
    p_hash_key_version,null::uuid,p_invite_id,null::uuid,p_token_version,
    p_nonce_hex,p_token_digest,p_code_digest);
$function$;
create function public.issue_group_invite(
  p_actor_auth_user_id uuid,p_actor_session_id uuid,p_request_id uuid,
  p_input_hmac text,p_canonical_version integer,p_hash_key_version integer,
  p_group_id uuid,p_new_invite_id uuid,p_token_version smallint,p_nonce_hex text,
  p_token_digest text,p_code_digest text
) returns jsonb language sql volatile security definer set search_path = '' as $function$
  select private.mutate_group_invite('issue_group_invite',p_actor_auth_user_id,
    p_actor_session_id,p_request_id,p_input_hmac,p_canonical_version,
    p_hash_key_version,p_group_id,null::uuid,p_new_invite_id,p_token_version,
    p_nonce_hex,p_token_digest,p_code_digest);
$function$;
revoke all on function public.revoke_group_invite(uuid,uuid,uuid,text,integer,integer,uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.regenerate_group_invite(uuid,uuid,uuid,text,integer,integer,uuid,smallint,text,text,text)
  from public,anon,authenticated,service_role;
revoke all on function public.issue_group_invite(uuid,uuid,uuid,text,integer,integer,uuid,uuid,smallint,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.revoke_group_invite(uuid,uuid,uuid,text,integer,integer,uuid) to service_role;
grant execute on function public.regenerate_group_invite(uuid,uuid,uuid,text,integer,integer,uuid,smallint,text,text,text) to service_role;
grant execute on function public.issue_group_invite(uuid,uuid,uuid,text,integer,integer,uuid,uuid,smallint,text,text,text) to service_role;

-- Retenção: o convite terminal sai em até 30 dias + próximo slot diário. Uma
-- linha viva nunca é candidata; SKIP LOCKED evita esperar uma RPC de domínio.
create function private.purge_terminal_group_invites()
returns jsonb language plpgsql volatile security definer set search_path = '' as $function$
declare v_now timestamptz:=clock_timestamp(); v_scanned bigint; v_purged bigint;
begin
  select count(*) into v_scanned from public.group_invites
  where (revoked_at is not null and revoked_at<=v_now-interval '30 days')
     or (expires_at<=v_now-interval '30 days');
  with expired as (
    select id from public.group_invites
    where (revoked_at is not null and revoked_at<=v_now-interval '30 days')
       or (expires_at<=v_now-interval '30 days')
    order by id for update skip locked
  ) delete from public.group_invites i using expired e where i.id=e.id;
  get diagnostics v_purged=row_count;
  insert into private.retention_runs(policy,window_start,window_end,scanned,purged,failed,started_at,finished_at)
  values('purge_terminal_group_invites',v_now-interval '30 days',v_now,
    v_scanned::integer,v_purged::integer,0,v_now,clock_timestamp());
  return jsonb_build_object('scanned',v_scanned,'purged',v_purged);
end;
$function$;
revoke all on function private.purge_terminal_group_invites()
  from public,anon,authenticated,service_role;

commit;
