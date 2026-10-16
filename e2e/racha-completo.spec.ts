import { expect, test, type APIRequestContext, type Browser, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';

const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-racha-completo-2026';
const prefix = `racha-completo-${Date.now()}-${process.pid}`;
const screenshotRoot = process.env['COLETE_RACHAS_SCREENSHOTS_DIR'];
const ZONE = 'America/Sao_Paulo';
type Actor = { authId: string; profileId: string; token: string; email: string; name: string };

test.use({ timezoneId: ZONE, colorScheme: 'dark' });

async function shot(page: Page, project: string, file: string) {
  if (project !== 'mobile-chromium' || !screenshotRoot || !existsSync(screenshotRoot)) return;
  await page.screenshot({ path: path.join(screenshotRoot, file), fullPage: true });
}

async function createActor(
  request: APIRequestContext,
  label: string,
  authIds: string[],
  position: string | null = null,
) {
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
    data: {
      request_id: crypto.randomUUID(),
      profile: { name, nickname: `${label}zinho`, position },
    },
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

async function createMatch(request: APIRequestContext, owner: Actor, groupId: string) {
  const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 2 * 86_400_000);
  const created = await gateway(request, owner, 'create_match', {
    group_id: groupId,
    config: {
      starts_at: start.toISOString(),
      ends_at: new Date(start.getTime() + 90 * 60_000).toISOString(),
      timezone: ZONE,
      location_name: 'Arena da Lista',
      location_address: null,
      description: null,
      latitude: null,
      longitude: null,
      field_slots: 2,
      field_price: '12.50',
    },
  });
  return (created['outcome'] as { match_id: string }).match_id;
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
  const context = await browser.newContext({ timezoneId: ZONE, colorScheme: 'dark' });
  const page = await context.newPage();
  await login(page, actor);
  await page.goto(`/rachas/${matchId}`);
  await expect(page.getByTestId('match-presence')).toBeVisible();
  return { context, page };
}

function board(page: Page, confirmed: number, slots: number) {
  return expect(page.getByTestId('match-scoreboard')).toHaveAttribute(
    'aria-label',
    `${confirmed} de ${slots} vagas confirmadas`,
  );
}

test('Racha completo: presence, waitlist, promotion and payment through the real stack', async ({
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
    const ana = await createActor(request, 'ana', authIds, 'forward');
    const bia = await createActor(request, 'bia', authIds, 'goalkeeper');
    const caio = await createActor(request, 'caio', authIds);
    const created = await gateway(request, owner, 'create_group', { name: 'Racha da Lista' });
    const groupId = (created['outcome'] as { group_id: string }).group_id;
    for (const member of [ana, bia, caio]) {
      await db.query(
        `insert into public.group_members(group_id, profile_id, role, status)
         values ($1, $2, 'player', 'active')`,
        [groupId, member.profileId],
      );
    }
    const matchId = await createMatch(request, owner, groupId);

    // Ana: the list shows the real occupancy; "Vou jogar" confirms her.
    await login(page, ana);
    await page.goto('/rachas');
    await expect(page.getByTestId('match-list-occupancy')).toHaveText('0/2');
    await page.getByTestId('match-list-card').click();
    await expect(page.getByTestId('match-viewer-status')).toHaveText(
      'Você ainda não confirmou presença.',
    );
    await board(page, 0, 2);
    await page.getByTestId('match-join').click();
    await expect(page.getByTestId('match-presence-result')).toHaveText(
      'Presença confirmada. Você está entre os confirmados.',
    );
    await board(page, 1, 2);
    await expect(page.getByTestId('match-confirmed-0')).toContainText(ana.name);
    await expect(page.getByTestId('match-confirmed-0')).toContainText('anazinho · Atacante · você');
    await expect(page.getByTestId('match-leave')).toBeVisible();
    await expect(page.getByTestId('match-payments')).toHaveCount(0);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '06-racha-confirmado.png');

    // Bia fills the last slot; Caio, through the screen, lands on the waitlist.
    await gateway(request, bia, 'join_match', { match_id: matchId });
    const caioView = await open(browser, caio, matchId);
    contexts.push(caioView.context);
    await board(caioView.page, 2, 2);
    await caioView.page.getByTestId('match-join').click();
    await expect(caioView.page.getByTestId('match-presence-result')).toHaveText(
      'O racha está lotado. Você entrou na lista de espera, na posição 1.',
    );
    await expect(caioView.page.getByTestId('match-viewer-status')).toHaveText(
      'Você está na lista de espera, na posição 1.',
    );
    await expect(caioView.page.getByTestId('match-waitlist-0')).toContainText(caio.name);
    await expect(caioView.page.getByTestId('match-confirmed-1')).toContainText('Goleiro');
    await assertAccessible(caioView.page);
    await shot(caioView.page, testInfo.project.name, '07-racha-espera.png');

    // Ana gives up after a confirmation step; Caio is promoted in the same commit.
    await page.reload();
    // Cancelling first: nothing changes and focus returns to "Desistir".
    await page.getByTestId('match-leave').click();
    await expect(page.getByTestId('match-leave-confirmation-heading')).toBeFocused();
    await page.getByTestId('match-leave-cancel').click();
    await expect(page.getByTestId('match-leave-confirmation')).toHaveCount(0);
    await expect(page.getByTestId('match-leave')).toBeFocused();
    await page.getByTestId('match-leave').click();
    await expect(page.getByTestId('match-leave-confirmation')).toContainText(
      'Sua vaga passa na hora para o primeiro da lista de espera.',
    );
    await page.getByTestId('match-leave-confirm').click();
    await expect(page.getByTestId('match-presence-result')).toHaveText('Você desistiu do racha.');
    await expect(page.getByTestId('match-join')).toBeVisible();
    const promoted = await db.query(
      `select p.status from private.match_players p where p.match_id = $1 and p.profile_id = $2`,
      [matchId, caio.profileId],
    );
    expect(promoted.rows).toEqual([{ status: 'starter' }]);
    await caioView.page.reload();
    await expect(caioView.page.getByTestId('match-viewer-status')).toHaveText(
      'Você está confirmado neste racha.',
    );

    // Ana returns: the slot is gone, she goes to the end of the waitlist.
    await page.getByTestId('match-join').click();
    await expect(page.getByTestId('match-presence-result')).toHaveText(
      'O racha está lotado. Você entrou na lista de espera, na posição 1.',
    );

    // The owner marks Bia as paid; the summary is computed, nothing typed.
    const ownerView = await open(browser, owner, matchId);
    contexts.push(ownerView.context);
    await expect(ownerView.page.getByTestId('match-payment-summary')).toHaveText(
      'Pagos 0 de 2 · R$ 0,00',
    );
    await ownerView.page.getByRole('button', { name: `Marcar ${bia.name} como pago` }).click();
    await expect(ownerView.page.getByTestId('match-payment-result')).toHaveText(
      `${bia.name}: pago.`,
    );
    await expect(ownerView.page.getByTestId('match-payment-summary')).toHaveText(
      'Pagos 1 de 2 · R$ 12,50',
    );
    await expect(ownerView.page.getByTestId('match-confirmed-0-paid')).toHaveText('Pago');
    await expect(ownerView.page.getByTestId('match-confirmed-1-paid')).toHaveText('Não pago');
    const mark = await db.query(
      `select paid, payment_marked_by from private.match_players
        where match_id = $1 and profile_id = $2`,
      [matchId, bia.profileId],
    );
    expect(mark.rows).toEqual([{ paid: true, payment_marked_by: owner.profileId }]);
    await assertAccessible(ownerView.page);
    await shot(ownerView.page, testInfo.project.name, '08-racha-pagamentos.png');

    // Bia sees only her own status, and cannot give up while marked paid.
    const biaView = await open(browser, bia, matchId);
    contexts.push(biaView.context);
    await expect(biaView.page.getByTestId('match-own-payment')).toHaveText('Seu pagamento: pago.');
    await expect(biaView.page.getByTestId('match-payments')).toHaveCount(0);
    await expect(biaView.page.getByTestId('match-confirmed-1-paid')).toHaveCount(0);
    await biaView.page.getByTestId('match-leave').click();
    await biaView.page.getByTestId('match-leave-confirm').click();
    await expect(biaView.page.getByTestId('match-presence-error')).toHaveText(
      'Seu pagamento está marcado como pago. Peça à organização para desmarcar antes de desistir.',
    );

    // The list shows occupancy, the waitlist and the viewer's own place.
    await page.goto('/rachas');
    await expect(page.getByTestId('match-list-occupancy')).toHaveText('2/2');
    await expect(page.getByTestId('match-card-waitlist')).toHaveText('1 na espera');
    await expect(page.getByTestId('match-list-card')).toHaveAccessibleName(
      /2 de 2 vagas confirmadas, 1 na espera, você está na espera$/,
    );
    await expect(page.getByTestId('match-list-viewer')).toHaveText('Você está na espera');
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '09-lista-ocupacao.png');
  } finally {
    for (const context of contexts) await context.close();
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('Racha completo: clear refusals once the match started or the membership ended', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'dono', authIds);
    const davi = await createActor(request, 'davi', authIds);
    const created = await gateway(request, owner, 'create_group', { name: 'Racha Fechado' });
    const groupId = (created['outcome'] as { group_id: string }).group_id;
    await db.query(
      `insert into public.group_members(group_id, profile_id, role, status)
       values ($1, $2, 'player', 'active')`,
      [groupId, davi.profileId],
    );
    const matchId = await createMatch(request, owner, groupId);
    await login(page, davi);
    await page.goto(`/rachas/${matchId}`);
    await expect(page.getByTestId('match-join')).toBeVisible();

    // The match starts while the screen is open: the press is refused clearly.
    await db.query(
      `update private.matches set starts_at = now() - interval '1 minute' where id=$1`,
      [matchId],
    );
    await page.getByTestId('match-join').click();
    await expect(page.getByTestId('match-presence-error')).toHaveText(
      'O racha já começou. Não é mais possível confirmar presença nem desistir.',
    );
    await expect(page.getByTestId('match-viewer-status')).toHaveText(
      'O racha já começou. A lista não muda mais.',
    );
    await expect(page.getByTestId('match-join')).toHaveCount(0);

    // A second match; the membership ends while the screen is open.
    const second = await createMatch(request, owner, groupId);
    await page.goto(`/rachas/${second}`);
    await expect(page.getByTestId('match-join')).toBeVisible();
    await db.query(
      `update public.group_members set status = 'removed', removed_at = now()
        where group_id = $1 and profile_id = $2`,
      [groupId, davi.profileId],
    );
    await page.getByTestId('match-join').click();
    await expect(page.getByTestId('match-presence-error')).toHaveText(
      'Este racha não está disponível para você: só membros ativos do grupo participam. Volte à lista de rachas.',
    );
    const registrations = await db.query(
      'select count(*)::integer as n from private.match_players where profile_id = $1',
      [davi.profileId],
    );
    expect(registrations.rows[0].n).toBe(0);
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});
