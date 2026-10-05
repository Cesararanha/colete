import assert from 'node:assert/strict';
import pg from 'pg';
import { assertDistinctConnections, track } from './lock-barrier.mjs';

// Sonda explícita aprovada pelo planejador em 05/10/2026. Isola a trava
// inventariada; não inventa um segundo recurso nem atribui deadlock a ela.
// O catálogo liga cada sonda ao modo real da função, e os testes pgTAP
// comparam o corpo inteiro para preservar ordem, efeitos e privilégios.
const probes = [
  ['private.reconcile_deletion_request(uuid)', 'deletion_requests', 13],
  ['public.consume_data_export(uuid,uuid,uuid)', 'data_exports', 21],
  ['public.enqueue_data_export_purge(uuid)', 'data_exports', 9],
  ['public.finalize_deletion(uuid)', 'deletion_requests', 19],
  ['public.worker_acquire_external_effect(text[])', 'external_effects', 67],
  ['public.worker_complete_external_effect(uuid,uuid,text,text)', 'external_effects', 26],
  ['public.worker_finish_job(bigint,text,jsonb,text)', 'job_runs', 24],
  ['public.worker_publish_data_export(uuid,uuid,text,text)', 'external_effects', 9],
];

async function observeWait(observer, competitor, pid, blocker) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    assert.equal(competitor.state.done, false, 'second probe finished before its wait');
    const { rows } = await observer.query(
      `select wait_event_type, pg_blocking_pids(pid) as blockers,
              exists(select 1 from pg_locks where pid=$1 and not granted) as waiting
         from pg_stat_activity where pid=$1`,
      [pid],
    );
    if (
      rows[0]?.wait_event_type === 'Lock' &&
      rows[0].waiting &&
      rows[0].blockers.includes(blocker)
    )
      return;
    assert.ok(Date.now() < deadline, 'lock wait was not observed');
    // Each awaited catalogue query yields to the other connections. No sleep.
  }
}

export async function proveCleanupLocks(connectionString, observer) {
  const first = new pg.Client({
    connectionString,
    application_name: 'colete_export_cleanup_first',
  });
  const second = new pg.Client({
    connectionString,
    application_name: 'colete_export_cleanup_second',
  });
  await first.connect();
  await second.connect();
  const ids = await assertDistinctConnections(
    { first, second, observer },
    'Faxina B explicit probes',
  );
  const profile = crypto.randomUUID();
  const privacy = crypto.randomUUID();
  const rows = {};
  let pending;
  try {
    await observer.query(
      "insert into public.profiles(id,name,account_status,deidentified_at) values($1,'Deleted probe','deleted',now())",
      [profile],
    );
    await observer.query(
      "insert into public.privacy_requests(id,profile_id,kind) values($1,$2,'access')",
      [privacy, profile],
    );
    rows.deletion_requests = (
      await observer.query(
        'insert into private.deletion_requests(profile_id,auth_user_id) values($1,$2) returning id',
        [profile, crypto.randomUUID()],
      )
    ).rows[0].id;
    rows.data_exports = (
      await observer.query(
        'insert into private.data_exports(privacy_request_id,profile_id) values($1,$2) returning id',
        [privacy, profile],
      )
    ).rows[0].id;
    rows.external_effects = (
      await observer.query(
        "insert into private.external_effects(kind,resource_type,resource_id,dedupe_key,status,attempts,lease_token,lease_until) values('delete_storage_object','profile_avatar',$1,$2,'leased',1,gen_random_uuid(),now()+interval '1 hour') returning id",
        [profile, `cleanup-probe:${profile}`],
      )
    ).rows[0].id;
    rows.job_runs = (
      await observer.query(
        "insert into private.job_runs(run_key,job_name,triggered_by,scheduled_for,status) values($1,'cleanup_probe','system',now(),'running') returning id",
        [`request:${crypto.randomUUID()}`],
      )
    ).rows[0].id;
    for (const [signature, table, line] of probes) {
      const source = (
        await observer.query('select pg_get_functiondef($1::regprocedure) as source', [signature])
      ).rows[0].source;
      const lockLine = source.split('\n')[line - 1];
      assert.match(lockLine, /for no key update/i, `${signature}: inventoried line changed`);
      const skip = /skip locked/i.test(lockLine);
      const inbound = (
        await observer.query(
          "select count(*)::integer as n from pg_constraint where contype='f' and confrelid=$1::regclass",
          [`private.${table}`],
        )
      ).rows[0].n;
      assert.equal(inbound, 0, `${signature}: a new incoming FK requires a compatibility proof`);
      const column = table === 'external_effects' ? 'attempts::text' : 'status';
      const select = `select ${column} as state from private.${table} where id=$1 for no key update${skip ? ' skip locked' : ''}`;
      await first.query('begin isolation level read committed');
      const before = (await first.query(select, [rows[table]])).rows[0].state;
      const next =
        table === 'deletion_requests'
          ? before === 'requested'
            ? 'cleaning_storage'
            : 'deleting_auth'
          : table === 'data_exports'
            ? before === 'queued'
              ? 'building'
              : 'queued'
            : table === 'external_effects'
              ? String(Number(before) + 1)
              : 'succeeded';
      await first.query(
        `update private.${table} set ${table === 'external_effects' ? 'attempts' : 'status'}=$2${table === 'job_runs' ? ',finished_at=clock_timestamp()' : ''} where id=$1`,
        [rows[table], next],
      );
      await second.query('begin isolation level read committed');
      assert.equal(
        (
          await second.query(`select ${column} as state from private.${table} where id=$1`, [
            rows[table],
          ])
        ).rows[0].state,
        before,
        'uncommitted state leaked',
      );
      pending = track(second.query(select, [rows[table]]));
      if (skip) {
        const result = await pending.settled;
        assert.equal(result.status, 'fulfilled');
        assert.equal(result.value.rowCount, 0, 'SKIP LOCKED did not skip the held row');
        await first.query('commit');
        assert.equal((await second.query(select, [rows[table]])).rows[0].state, next);
      } else {
        await observeWait(observer, pending, ids.second, ids.first);
        await first.query('commit');
        const result = await pending.settled;
        assert.equal(result.status, 'fulfilled', `${signature}: second probe failed`);
        assert.equal(result.value.rows[0].state, next, 'second probe did not see committed state');
      }
      await second.query('commit');
      pending = undefined;
      console.log(
        `ok - cleanup lock ${signature}: ${skip ? 'SKIP LOCKED skips' : 'wait observed in pg_locks/pg_stat_activity'}; committed state visible; sem FK de entrada`,
      );
    }
  } finally {
    await first.query('rollback');
    if (pending) await pending.settled;
    await second.query('rollback');
    await first.end();
    await second.end();
    for (const table of ['external_effects', 'job_runs', 'data_exports', 'deletion_requests']) {
      if (rows[table])
        await observer.query(`delete from private.${table} where id=$1`, [rows[table]]);
    }
    await observer.query('delete from public.privacy_requests where id=$1', [privacy]);
    await observer.query('delete from public.profiles where id=$1', [profile]);
  }
}
