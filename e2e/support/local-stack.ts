import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import type pg from 'pg';

import { localWorkerCronSecret } from '../../scripts/local-worker-test-config.mjs';

const repositoryRoot = process.cwd();
const supabaseBinary = path.join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
);

export type LocalEnvironment = {
  apiUrl: string;
  dbUrl: string;
  functionsUrl: string;
  mailUrl: string;
  publishableKey: string;
  secretKey: string;
};

export function localEnvironment(): LocalEnvironment {
  const raw = execFileSync(supabaseBinary, ['status', '-o', 'env'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const read = (name: string) => {
    const value = raw.match(new RegExp(`^${name}="([^"]+)"$`, 'm'))?.[1];
    if (value === undefined) throw new Error(`supabase status did not expose ${name}`);
    return value;
  };
  return {
    apiUrl: read('API_URL'),
    dbUrl: read('DB_URL'),
    functionsUrl: read('FUNCTIONS_URL'),
    mailUrl: read('MAILPIT_URL'),
    publishableKey: read('PUBLISHABLE_KEY'),
    secretKey: read('SECRET_KEY'),
  };
}

function adminHeaders(env: LocalEnvironment) {
  return {
    apikey: env.secretKey,
    Authorization: `Bearer ${env.secretKey}`,
    'content-type': 'application/json',
  };
}

/** A confirmed Auth user without a profile, created through the admin API. */
export async function createVerifiedUser(
  request: APIRequestContext,
  env: LocalEnvironment,
  user: { email: string; name: string; password: string },
): Promise<{ id: string }> {
  const created = await request.post(`${env.apiUrl}/auth/v1/admin/users`, {
    data: {
      email: user.email,
      email_confirm: true,
      password: user.password,
      user_metadata: { name: user.name },
    },
    headers: adminHeaders(env),
  });
  expect(created.ok()).toBe(true);
  const payload = (await created.json()) as { id: string };
  return { id: payload.id };
}

export async function deleteAuthUser(
  request: APIRequestContext,
  env: LocalEnvironment,
  id: string,
) {
  const removed = await request.delete(`${env.apiUrl}/auth/v1/admin/users/${id}`, {
    headers: adminHeaders(env),
  });
  expect(removed.ok() || removed.status() === 404).toBe(true);
}

export async function removeStorageObject(
  request: APIRequestContext,
  env: LocalEnvironment,
  bucket: string,
  objectPath: string,
) {
  await request.delete(`${env.apiUrl}/storage/v1/object/${bucket}`, {
    data: { prefixes: [objectPath] },
    headers: adminHeaders(env),
  });
}

/**
 * Wakes the real scheduled worker through its Edge Function. The cron slot of
 * process_external_effects is one run per minute, so the previous slot row is
 * removed first: a test cannot wait a minute between saga steps.
 */
export async function runWorker(
  request: APIRequestContext,
  env: LocalEnvironment,
  db: pg.Client,
  job = 'process_external_effects',
): Promise<'noop' | 'succeeded' | 'failed'> {
  await db.query('delete from private.job_runs where job_name = $1', [job]);
  const response = await request.post(`${env.functionsUrl}/worker/${job}`, {
    headers: { Authorization: `Bearer ${localWorkerCronSecret()}` },
  });
  const body = (await response.json()) as { data?: { status?: string } };
  const status = body.data?.status;
  if (status !== 'noop' && status !== 'succeeded' && status !== 'failed') {
    throw new Error(`worker answered ${response.status()} without a status`);
  }
  return status;
}

export async function assertAccessible(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);

  const targets = page.locator(
    'a:visible, button:visible, input:visible, [role="button"]:visible, [role="link"]:visible, [role="checkbox"]:visible',
  );
  expect(await targets.count()).toBeGreaterThan(0);
  for (let index = 0; index < (await targets.count()); index += 1) {
    const box = await targets.nth(index).boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  }

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

/**
 * Replaces the app's stored session with one whose `amr` timestamps are older
 * than the 300 s window: the authentication claims are backdated in Auth and a
 * refreshed token is written where supabase-js keeps the session. No password
 * is involved; the session stays the same session.
 */
export async function ageAuthentication(
  page: Page,
  db: pg.Client,
  env: LocalEnvironment,
  email: string,
) {
  await db.query(
    `update auth.mfa_amr_claims as claim
        set created_at = now() - interval '10 minutes',
            updated_at = now() - interval '10 minutes'
      where claim.session_id in (
        select session.id
          from auth.sessions as session
          join auth.users as users on users.id = session.user_id
         where lower(users.email) = lower($1))`,
    [email],
  );
  await page.evaluate(
    async ({ authUrl, key }) => {
      let storageKey: string | null = null;
      let stored: Record<string, unknown> | null = null;
      for (let index = 0; index < localStorage.length; index += 1) {
        const candidate = localStorage.key(index);
        const raw = candidate === null ? null : localStorage.getItem(candidate);
        if (raw === null) continue;
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (typeof parsed.refresh_token === 'string') {
            storageKey = candidate;
            stored = parsed;
          }
        } catch {
          // Unrelated browser state.
        }
      }
      if (storageKey === null || stored === null) throw new Error('no stored session');
      const response = await fetch(`${authUrl}/auth/v1/token?grant_type=refresh_token`, {
        body: JSON.stringify({ refresh_token: stored.refresh_token }),
        headers: { apikey: key, 'content-type': 'application/json' },
        method: 'POST',
      });
      if (!response.ok) throw new Error(`refresh failed with ${response.status}`);
      localStorage.setItem(storageKey, JSON.stringify(await response.json()));
    },
    { authUrl: env.apiUrl, key: env.publishableKey },
  );
  await page.reload();
}
