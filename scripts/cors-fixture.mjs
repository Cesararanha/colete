import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { harnessEmail, harnessEmailPattern, sweepMarkedAuthUsers } from './harness-guard.mjs';
import { localCorsEnvironment } from './local-edge-runtime.mjs';

const PREFIX = 'edge-cors-';
export async function corsFixture() {
  const env = localCorsEnvironment();
  const db = new pg.Client({
    connectionString: env.dbUrl,
    application_name: 'colete_cors_fixture',
  });
  await db.connect();
  const initialUsers = Number((await db.query('select count(*) as n from auth.users')).rows[0].n);
  if (initialUsers !== 0) {
    await db.end();
    throw new Error('CORS fixtures require auth.users=0 before execution');
  }
  const cleanup = async () => {
    const pattern = harnessEmailPattern(PREFIX);
    const profiles = `select id from public.profiles where auth_user_id in (select id from auth.users where email like $1 escape '\\')`;
    const groups = `select id from public.groups where owner_id in (${profiles})`;
    await db.query('begin');
    try {
      await db.query(
        `delete from private.idempotency_records where actor_id in (${profiles}) or actor_key in (select 'bootstrap:'||id::text from auth.users where email like $1 escape '\\')`,
        [pattern],
      );
      await db.query(`delete from private.invite_rate_limits where profile_id in (${profiles})`, [
        pattern,
      ]);
      await db.query(`delete from public.group_invites where group_id in (${groups})`, [pattern]);
      await db.query(`delete from public.group_members where group_id in (${groups})`, [pattern]);
      await db.query(`delete from public.groups where id in (${groups})`, [pattern]);
      await db.query(`delete from public.profiles where id in (${profiles})`, [pattern]);
      await db.query('commit');
    } catch (error) {
      try {
        await db.query('rollback');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'CORS fixture cleanup and rollback failed',
        );
      }
      throw error;
    }
    await sweepMarkedAuthUsers(db, PREFIX);
    assert.equal(
      Number((await db.query('select count(*) as n from auth.users')).rows[0].n),
      initialUsers,
    );
  };
  const actor = async (url) => {
    const email = harnessEmail(PREFIX, crypto.randomUUID());
    const password = 'colete-local-cors-fixture-password';
    const response = await fetch(`${env.apiUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: env.secretKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    assert.equal(response.status, 200, 'local Auth fixture creation');
    const user = await response.json();
    const signed = await fetch(`${env.apiUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: env.publishableKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(signed.status, 200, 'local Auth fixture sign-in');
    const { access_token: token } = await signed.json();
    const complete = await fetch(`${url}/identity/complete_profile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: crypto.randomUUID(), profile: { name: 'CORS fixture' } }),
    });
    assert.equal(complete.status, 200, 'real Edge profile fixture');
    const body = await complete.json();
    return { email, password, token, profileId: body.data.outcome.profile_id, userId: user.id };
  };
  return {
    env,
    db,
    actor,
    close: async () => {
      try {
        await cleanup();
      } finally {
        await db.end();
      }
    },
  };
}
