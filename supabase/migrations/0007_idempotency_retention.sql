begin;

-- M1-A, slice 4: physical retention of the idempotency ledger.
-- Sources: docs/10-schema-db.md sections 9, 9.1 and 12;
-- docs/13-contratos-funcoes.md section 0, rule 2, and section 7;
-- docs/17-mapa-dados-lgpd.md section 2 and section 4, item 4.
--
-- Two deadlines, one policy. At 30 days the replay payload is erased and the
-- row becomes payload_expired; the key and the HMAC survive as a tombstone
-- until 24 months, so a late retry still answers IDEMPOTENCY_EXPIRED instead of
-- executing a second time. Deleting the tombstone early would turn a replay
-- into a new mutation, which is the failure this whole ledger exists to prevent.
--
-- No cron, no scheduler and no job wrapper enters this migration. Writing
-- private.job_runs per execution belongs to the jobs slice; this migration
-- creates the purge and the evidence it leaves in private.retention_runs.

-- The access path of the 30-day phase. The 24-month phase already has
-- idempotency_records_record_expiry_idx from 0004.
create index idempotency_records_outcome_expiry_idx
  on private.idempotency_records (outcome_expires_at)
  where state = 'completed';

create or replace function private.purge_expired_idempotency_outcomes()
returns jsonb
language plpgsql
volatile
set search_path = ''
as $function$
declare
  v_started_at timestamptz := clock_timestamp();
  v_now timestamptz := now();
  v_due_outcomes bigint;
  v_due_records bigint;
  v_expired bigint;
  v_deleted bigint;
begin
  -- Server time decides validity, never a caller-supplied instant: a purge that
  -- accepted a "now" argument would be a way to erase a payload early.
  select count(*)
  into v_due_outcomes
  from private.idempotency_records as records
  where records.state = 'completed'
    and records.outcome_expires_at <= v_now;

  select count(*)
  into v_due_records
  from private.idempotency_records as records
  where records.record_expires_at <= v_now;

  -- Phase one runs first on purpose. A ledger that went unpurged for longer
  -- than 24 months holds rows due for both phases, and this order lets the same
  -- execution expire the payload and then drop the tombstone.
  update private.idempotency_records as records
  set state = 'payload_expired',
      outcome = null,
      payload_expired_at = v_now,
      updated_at = v_now
  where records.state = 'completed'
    and records.outcome_expires_at <= v_now;

  get diagnostics v_expired = row_count;

  delete from private.idempotency_records as records
  where records.record_expires_at <= v_now;

  get diagnostics v_deleted = row_count;

  -- docs/17-mapa-dados-lgpd.md section 4, item 7: the evidence records the
  -- policy, the window, counts and duration. It never names what it purged,
  -- because that would recreate the data the purge removed.
  insert into private.retention_runs
    (policy, window_start, window_end, scanned, purged, failed, started_at, finished_at)
  values (
    'purge_expired_idempotency_outcomes',
    v_now - interval '24 months',
    v_now,
    (v_due_outcomes + v_due_records)::int,
    (v_expired + v_deleted)::int,
    0,
    v_started_at,
    clock_timestamp()
  );

  return jsonb_build_object(
    'payload_expired', v_expired,
    'tombstones_deleted', v_deleted);
end;
$function$;

comment on function private.purge_expired_idempotency_outcomes() is
  'Erases replay payloads at 30 days and drops the payload-free tombstone at 24 months, in that order, and records the run in private.retention_runs. It takes no clock argument: server time is what decides.';

revoke all on function private.purge_expired_idempotency_outcomes()
  from public, anon, authenticated, service_role;

commit;
