import type pg from 'pg';

/** Begin fixture deletion only after every profile and owned group is ours. */
export async function beginCleanup(db: pg.Client, profileIds: string[]) {
  // get_group_ratings (0031) and get_group_members lock profile, then group.
  // Deleting groups first can hold the group while waiting for their profile:
  // 40P01. Mutations can also hold one profile and need another via an FK.
  // Take ALL profiles, then ALL groups, ordered by id, with NOWAIT: if busy,
  // roll back every lock before retrying. Idempotency records must be deleted
  // only AFTER these locks, or an in-flight mutation can commit a new record
  // between their deletion and the profile lock (23503 on profile deletion).
  // Only contention (55P03) is retried. A deadlock or any other error fails.
  const deadline = Date.now() + 15_000;
  for (;;) {
    await db.query('begin');
    try {
      await db.query(
        'select 1 from public.profiles where id = any($1::uuid[]) order by id for update nowait',
        [profileIds],
      );
      await db.query(
        'select 1 from public.groups where owner_id = any($1::uuid[]) order by id for update nowait',
        [profileIds],
      );
      return;
    } catch (error) {
      await db.query('rollback');
      if ((error as { code?: string }).code !== '55P03' || Date.now() > deadline) throw error;
      await new Promise((done) => setTimeout(done, 50));
    }
  }
}
