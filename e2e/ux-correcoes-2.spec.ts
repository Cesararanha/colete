import { expect, test, type APIRequestContext, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';

// Correções da avaliação heurística (PR UX-2): each test reproduces the problem
// on the old code (it fails there) and proves the fix. Prints at 390 px when
// COLETE_UX2_PRINTS_DIR exists, named <ID>-<COLETE_UX2_PRINTS_PHASE>.png.
const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-ux-correcoes-2-2026';
const prefix = `ux2-${Date.now()}-${process.pid}`;
const printRoot = process.env['COLETE_UX2_PRINTS_DIR'];
const phase = process.env['COLETE_UX2_PRINTS_PHASE'] ?? 'depois';
const ZONE = 'America/Sao_Paulo';
type Actor = { authId: string; profileId: string; token: string; email: string; name: string };

test.use({ timezoneId: ZONE, colorScheme: 'dark' });

async function print(page: Page, project: string, id: string) {
  if (project !== 'mobile-chromium' || !printRoot || !existsSync(printRoot)) return;
  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(printRoot, `${id}-${phase}.png`) });
  if (size) await page.setViewportSize(size);
}

async function createActor(
  request: APIRequestContext,
  label: string,
  name: string,
  authIds: string[],
): Promise<Actor> {
  const email = `${prefix}-${label}@colete.test`;
  const { id } = await createVerifiedUser(request, env, { email, name, password });
  authIds.push(id);
  const signed = await request.post(`${env.apiUrl}/auth/v1/token?grant_type=password`, {
    data: { email, password },
    headers: { apikey: env.publishableKey },
  });
  expect(signed.status()).toBe(200);
  const session = (await signed.json()) as { access_token: string };
  const profiled = await request.post(`${env.functionsUrl}/identity/complete_profile`, {
    data: { request_id: crypto.randomUUID(), profile: { name, nickname: null, position: null } },
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  expect(profiled.status()).toBe(200);
  const profile = (await profiled.json()) as { data: { outcome: { profile_id: string } } };
  return {
    authId: id,
    profileId: profile.data.outcome.profile_id,
    token: session.access_token,
    email,
    name,
  };
}

async function login(page: Page, actor: Actor) {
  await page.goto('/entrar');
  await page.getByTestId('login-email').fill(actor.email);
  await page.getByTestId('login-password').fill(password);
  const response = handledObserver(
    page.waitForResponse(
      (item) =>
        new URL(item.url()).pathname === '/auth/v1/token' && item.request().method() === 'POST',
    ),
  );
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Grupos', level: 1 })).toBeVisible();
}

/** Holds the matching request until `release` is called, then lets it through. */
async function holdRequests(page: Page, pattern: RegExp) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(pattern, async (route) => {
    await gate;
    await route.continue();
  });
  return () => release();
}

async function cleanActors(authIds: string[], db: pg.Client) {
  if (authIds.length === 0) return;
  const profiles = await db.query(
    'select id from public.profiles where auth_user_id = any($1::uuid[])',
    [authIds],
  );
  const ids = profiles.rows.map((row: { id: string }) => row.id);
  const groups = 'select id from public.groups where owner_id = any($1::uuid[])';
  await db.query('begin');
  try {
    await db.query('delete from private.idempotency_records where actor_id = any($1::uuid[])', [
      ids,
    ]);
    await db.query(
      `delete from private.match_players where profile_id = any($1::uuid[]) or match_id in
         (select id from private.matches where group_id in (${groups}))`,
      [ids],
    );
    await db.query(`delete from private.matches where group_id in (${groups})`, [ids]);
    await db.query(`delete from public.group_invites where group_id in (${groups})`, [ids]);
    await db.query(`delete from public.group_members where group_id in (${groups})`, [ids]);
    await db.query('delete from public.groups where owner_id = any($1::uuid[])', [ids]);
    await db.query('delete from public.profiles where id = any($1::uuid[])', [ids]);
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
  for (const id of authIds) {
    const response = await fetch(`${env.apiUrl}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: env.secretKey, Authorization: `Bearer ${env.secretKey}` },
    });
    expect([200, 204, 404]).toContain(response.status);
  }
}

test('HX-014: typing while the profile saves keeps the new text in the open editor', async ({
  page,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const ana = await createActor(request, 'perfil', 'Ana Exemplo', authIds);
    await login(page, ana);
    await page.goto('/perfil');
    await page.getByTestId('edit-profile').click();
    await page.getByTestId('profile-name').fill('Ana Salva');
    const release = await holdRequests(page, /\/functions\/v1\/identity\/update_profile$/u);
    const saved = handledObserver(
      page.waitForResponse((item) => item.url().endsWith('/identity/update_profile')),
    );
    await page.getByTestId('save-profile').click();
    // The save is in flight: the person keeps typing.
    await page.getByTestId('profile-nickname').fill('Rascunho');
    release();
    expect((await saved).status()).toBe(200);
    await page.waitForTimeout(500);
    await print(page, testInfo.project.name, 'HX-014');
    // The editor stays open with what was typed after the press.
    await expect(page.getByTestId('profile-nickname')).toHaveValue('Rascunho');
    await expect(page.getByTestId('profile-name')).toHaveValue('Ana Salva');
    // Saving again sends the newer text and closes.
    await page.getByTestId('save-profile').click();
    await expect(page.getByTestId('profile-value-nickname')).toHaveText('Rascunho');
    await expect(page.getByTestId('profile-value-name')).toHaveText('Ana Salva');
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});
