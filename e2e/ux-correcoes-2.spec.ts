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

async function gateway(
  request: APIRequestContext,
  actor: Actor,
  operation: string,
  data: Record<string, unknown>,
) {
  const response = await request.post(`${env.functionsUrl}/groups/${operation}`, {
    data: { request_id: crypto.randomUUID(), ...data },
    headers: { Authorization: `Bearer ${actor.token}` },
  });
  expect(response.status(), `${operation}: ${await response.text()}`).toBe(200);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}

test('HX-002: while one payment saves, the row says so and the others wait with the reason', async ({
  page,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'dona', 'Ana Exemplo', authIds);
    const bruno = await createActor(request, 'bruno', 'Bruno Teste', authIds);
    const caio = await createActor(request, 'caio', 'Caio Demo', authIds);
    const created = await gateway(request, owner, 'create_group', { name: 'Racha de Quinta' });
    const groupId = (created['outcome'] as { group_id: string }).group_id;
    for (const member of [bruno, caio])
      await db.query(
        `insert into public.group_members(group_id, profile_id, role, status)
         values ($1, $2, 'player', 'active')`,
        [groupId, member.profileId],
      );
    const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 2 * 86_400_000);
    const made = await gateway(request, owner, 'create_match', {
      group_id: groupId,
      config: {
        starts_at: start.toISOString(),
        ends_at: new Date(start.getTime() + 90 * 60_000).toISOString(),
        timezone: ZONE,
        location_name: 'Arena Exemplo',
        location_address: null,
        description: null,
        latitude: null,
        longitude: null,
        field_slots: 10,
        field_price: '15.00',
      },
    });
    const matchId = (made['outcome'] as { match_id: string }).match_id;
    for (const member of [bruno, caio])
      await gateway(request, member, 'join_match', { match_id: matchId });

    await login(page, owner);
    await page.goto(`/rachas/${matchId}`);
    const first = page.getByTestId('match-confirmed-0-mark');
    const second = page.getByTestId('match-confirmed-1-mark');
    await expect(first).toHaveText('Marcar pago');
    await expect(second).toHaveText('Marcar pago');
    const release = await holdRequests(page, /\/functions\/v1\/groups\/set_match_payment$/u);
    const marked = handledObserver(
      page.waitForResponse((item) => item.url().endsWith('/groups/set_match_payment')),
    );
    await first.click();
    await second.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await print(page, testInfo.project.name, 'HX-002');
    // The press is in flight: this row says it is saving, the other waits and says why.
    await expect(first).toHaveText('Salvando…');
    await expect(second).toHaveAttribute('aria-disabled', 'true');
    await expect(second).toHaveAccessibleDescription(/Aguarde: salvando o pagamento de/u);
    release();
    expect((await marked).status()).toBe(200);
    await expect(page.getByTestId('match-confirmed-0-paid')).toHaveText('Pago');
    await expect(second).not.toHaveAttribute('aria-disabled', 'true');
    await second.click();
    await expect(page.getByTestId('match-confirmed-1-paid')).toHaveText('Pago');
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('UX-003: the recovery code step names the e-mail and offers resend, another e-mail and back', async ({
  page,
}, testInfo) => {
  // The local Auth sends at most two e-mails an hour: the recovery call is
  // answered here, and counted, so the test proves the screen uses it again.
  let recoverCalls = 0;
  await page.route(/\/auth\/v1\/recover/u, async (route) => {
    recoverCalls += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto('/esqueci-senha');
  await page.getByTestId('recovery-email').fill('pessoa@colete.test');
  await page.getByRole('button', { name: 'Enviar código de recuperação' }).click();
  await expect(page.getByLabel('Código de 6 dígitos')).toBeVisible();
  await page.waitForTimeout(300);
  await print(page, testInfo.project.name, 'UX-003');
  await expect(page.getByTestId('recovery-destination')).toHaveText(
    'Código enviado para pessoa@colete.test.',
  );
  await expect(page.getByRole('link', { name: 'Voltar para entrar' })).toBeVisible();
  await page.getByTestId('recovery-resend').click();
  await expect(page.getByTestId('recovery-resent')).toHaveText(
    'Um novo código foi enviado. Use apenas o mais recente.',
  );
  expect(recoverCalls).toBe(2);
  await page.getByTestId('recovery-other-email').click();
  await expect(page.getByTestId('recovery-email')).toBeVisible();
  await expect(page.getByLabel('Código de 6 dígitos')).toHaveCount(0);
});
