// Pix manual do piloto (docs/13 section 1.3.2): the organisation registers the
// match's Pix on the screen, an unpaid confirmed player copies the BR Code and
// sees the QR, a payment locks replacement, and a paid player sees no Pix.
import { expect, test, type APIRequestContext, type Browser, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { crc16 } from '../src/features/matches/pix-brcode';
import { beginCleanup } from './support/cleanup';
import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';

const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-pix-manual-2026';
const prefix = `pix-manual-${Date.now()}-${process.pid}`;
const screenshotRoot = process.env['COLETE_PIX_SCREENSHOTS_DIR'];
const ZONE = 'America/Sao_Paulo';
type Actor = { authId: string; profileId: string; token: string; email: string; name: string };

test.use({ timezoneId: ZONE });

async function shot(page: Page, project: string, file: string) {
  if (!screenshotRoot || !existsSync(screenshotRoot)) return;
  await page.screenshot({ path: path.join(screenshotRoot, `${project}-${file}`), fullPage: true });
}

async function createActor(request: APIRequestContext, label: string, authIds: string[]) {
  const email = `${prefix}-${label}@colete.test`;
  const name = `Pessoa ${label}`;
  const { id } = await createVerifiedUser(request, env, { email, name, password });
  authIds.push(id);
  const signed = await request.post(`${env.apiUrl}/auth/v1/token?grant_type=password`, {
    data: { email, password },
    headers: { apikey: env.publishableKey },
  });
  expect(signed.status()).toBe(200);
  const session = (await signed.json()) as { access_token: string };
  const profiled = await request.post(`${env.functionsUrl}/identity/complete_profile`, {
    data: { request_id: crypto.randomUUID(), profile: { name } },
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
  } satisfies Actor;
}

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

async function open(browser: Browser, actor: Actor, matchId: string) {
  const context = await browser.newContext({ timezoneId: ZONE });
  const page = await context.newPage();
  await login(page, actor);
  await page.goto(`/rachas/${matchId}`);
  await expect(page.getByTestId('match-presence')).toBeVisible();
  return { context, page };
}

// Nothing of the open key may stay in the browser: storage or URL.
async function assertNoKeyInBrowser(page: Page, label: string) {
  const kept = await page.evaluate(() =>
    [
      window.location.href,
      ...Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key)}`),
      ...Object.keys(sessionStorage).map((key) => `${key}=${sessionStorage.getItem(key)}`),
    ].join('\n'),
  );
  for (const form of ['52998224725', '529.982.247-25', 'dona.racha']) {
    expect(kept.toLowerCase(), `${label}: ${form}`).not.toContain(form);
  }
}

async function cleanActors(authIds: string[], db: pg.Client) {
  if (authIds.length === 0) return;
  const profiles = await db.query(
    'select id from public.profiles where auth_user_id = any($1::uuid[])',
    [authIds],
  );
  const ids = profiles.rows.map((row: { id: string }) => row.id);
  const groups = 'select id from public.groups where owner_id = any($1::uuid[])';
  await beginCleanup(db, ids);
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

test('Pix manual: cadastro, copia-e-cola, QR e trava por pagamento', async ({
  browser,
  page,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const owner = await createActor(request, 'dona', authIds);
    const ana = await createActor(request, 'ana', authIds);
    const bia = await createActor(request, 'bia', authIds);
    const created = await gateway(request, owner, 'create_group', { name: 'Racha do Pix' });
    const groupId = (created['outcome'] as { group_id: string }).group_id;
    for (const member of [ana, bia]) {
      await db.query(
        `insert into public.group_members(group_id, profile_id, role, status)
         values ($1, $2, 'player', 'active')`,
        [groupId, member.profileId],
      );
    }
    const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 2 * 86_400_000);
    const match = await gateway(request, owner, 'create_match', {
      group_id: groupId,
      config: {
        starts_at: start.toISOString(),
        ends_at: new Date(start.getTime() + 90 * 60_000).toISOString(),
        timezone: ZONE,
        location_name: 'Arena do Pix',
        location_address: null,
        description: null,
        latitude: null,
        longitude: null,
        field_slots: 4,
        field_price: '12.50',
      },
    });
    const matchId = (match['outcome'] as { match_id: string }).match_id;
    await gateway(request, ana, 'join_match', { match_id: matchId });
    await gateway(request, bia, 'join_match', { match_id: matchId });

    // Ana, before any Pix: the instruction of slice 1.1.
    const anaView = await open(browser, ana, matchId);
    contexts.push(anaView.context);
    await expect(anaView.page.getByTestId('match-pay-notice-title')).toContainText(
      'Pague ao organizador',
    );
    await expect(anaView.page.getByTestId('match-pix-payment')).toHaveCount(0);

    // The owner registers the Pix on the screen; the Edge normalises it.
    await login(page, owner);
    await page.goto(`/rachas/${matchId}`);
    await expect(page.getByTestId('match-pix-none')).toBeVisible();
    await page.getByTestId('match-pix-open').click();
    await page.getByTestId('match-pix-type-cpf').click();
    await page.getByTestId('match-pix-key-input').fill('529.982.247-26');
    await page.getByTestId('match-pix-name-input').fill('Dona do Racha');
    await page.getByTestId('match-pix-city-input').fill('São Paulo');
    await page.getByTestId('match-pix-save').click();
    await expect(page.getByTestId('match-pix-form')).toContainText(
      'Confira a chave: ela não vale para o tipo escolhido.',
    );
    // The open form: type group, fields with hints and a field error.
    await assertAccessible(page);
    await page.getByTestId('match-pix-key-input').fill('529.982.247-25');
    await page.getByTestId('match-pix-save').click();
    await expect(page.getByTestId('match-pix-result')).toHaveText('Pix salvo.');
    await expect(page.getByTestId('match-pix-current')).toContainText('CPF: 52998224725');
    await expect(page.getByTestId('match-pix-current')).toContainText(
      'Recebedor: DONA DO RACHA, SAO PAULO',
    );
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'pix-organizacao.png');

    // Ana: amount, the name to check, copy first and the QR.
    await anaView.page.reload();
    await expect(anaView.page.getByTestId('match-pix-pay-title')).toHaveText(
      'Pague R$ 12,50 por Pix',
    );
    await expect(anaView.page.getByTestId('match-pix-check-name')).toHaveText(
      'Antes de pagar, confira no banco se o recebedor é DONA DO RACHA.',
    );
    await expect(anaView.page.getByTestId('match-pix-set-by')).toContainText(
      `Pix cadastrado por ${owner.name}.`,
    );
    await expect(anaView.page.getByTestId('match-pix-changed')).toHaveCount(0);
    await expect(anaView.page.getByTestId('match-pix-qr')).toBeVisible();
    await anaView.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await anaView.page.getByTestId('match-pix-copy').click();
    await expect(anaView.page.getByTestId('match-pix-copy-result')).toHaveText(
      'Código Pix copiado. Cole no app do seu banco.',
    );
    const copied = await anaView.page.evaluate(() => navigator.clipboard.readText());
    expect(copied.startsWith('000201')).toBe(true);
    expect(copied).toContain('br.gov.bcb.pix011152998224725');
    expect(copied).toContain('540512.50');
    expect(copied).toContain('5913DONA DO RACHA6009SAO PAULO');
    expect(copied.slice(-8, -4)).toBe('6304');
    expect(copied.slice(-4)).toBe(crc16(copied.slice(0, -4)));
    await assertNoKeyInBrowser(anaView.page, 'player');
    await assertNoKeyInBrowser(page, 'organizer');
    await assertAccessible(anaView.page);
    await shot(anaView.page, testInfo.project.name, 'pix-jogador.png');

    // Replacing before any payment is free; the player is told it changed.
    await page.getByTestId('match-pix-open').click();
    await page.getByTestId('match-pix-type-email').click();
    await page.getByTestId('match-pix-key-input').fill('Dona.Racha@Example.com');
    await page.getByTestId('match-pix-save').click();
    await expect(page.getByTestId('match-pix-result')).toHaveText('Pix salvo.');
    await anaView.page.reload();
    await expect(anaView.page.getByTestId('match-pix-changed')).toContainText('Pix alterado às');
    await expect(anaView.page.getByTestId('match-pix-key')).toHaveText(
      'Chave E-mail: dona.racha@example.com',
    );

    // Removing before any payment: confirmation, then the player is back to
    // the generic instruction; registering again continues the flow.
    await page.getByTestId('match-pix-remove').click();
    await expect(page.getByTestId('match-pix-remove-confirmation')).toBeVisible();
    await assertAccessible(page);
    await page.getByTestId('match-pix-remove-confirm').click();
    await expect(page.getByTestId('match-pix-result')).toHaveText('Pix removido.');
    await expect(page.getByTestId('match-pix-none')).toBeVisible();
    await anaView.page.reload();
    await expect(anaView.page.getByTestId('match-pay-notice-title')).toContainText(
      'Pague ao organizador',
    );
    await expect(anaView.page.getByTestId('match-pix-payment')).toHaveCount(0);
    await page.getByTestId('match-pix-open').click();
    await page.getByTestId('match-pix-type-email').click();
    await page.getByTestId('match-pix-key-input').fill('Dona.Racha@Example.com');
    await page.getByTestId('match-pix-name-input').fill('Dona do Racha');
    await page.getByTestId('match-pix-city-input').fill('São Paulo');
    await page.getByTestId('match-pix-save').click();
    await expect(page.getByTestId('match-pix-result')).toHaveText('Pix salvo.');

    // A payment locks it: the screen says why, and the server refuses.
    await gateway(request, owner, 'set_match_payment', {
      match_id: matchId,
      profile_id: bia.profileId,
      paid: true,
    });
    await page.reload();
    await expect(page.getByTestId('match-pix-locked')).toBeVisible();
    await page.getByTestId('match-pix-open').click();
    await page.getByTestId('match-pix-type-cpf').click();
    await page.getByTestId('match-pix-key-input').fill('529.982.247-25');
    await page.getByTestId('match-pix-save').click();
    await expect(page.getByTestId('match-pix-error')).toContainText(
      'O Pix não pode mudar: este racha já tem pagamento marcado ou devolução pendente',
    );
    await page.getByTestId('match-pix-back').click();
    await page.getByTestId('match-pix-remove').click();
    await page.getByTestId('match-pix-remove-confirm').click();
    await expect(page.getByTestId('match-pix-error')).toContainText('O Pix não pode mudar');
    await expect(page.getByTestId('match-pix-current')).toContainText(
      'E-mail: dona.racha@example.com',
    );

    // Bia, paid, sees her mark and no Pix.
    const biaView = await open(browser, bia, matchId);
    contexts.push(biaView.context);
    await expect(biaView.page.getByTestId('match-pay-notice-title')).toHaveText(
      'Pagamento marcado pela organização.',
    );
    await expect(biaView.page.getByTestId('match-pix-payment')).toHaveCount(0);
  } finally {
    for (const context of contexts) await context.close();
    await cleanActors(authIds, db);
    await db.end();
  }
});
