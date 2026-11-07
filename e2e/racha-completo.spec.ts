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

async function readRefunds(page: Page) {
  // The panel mounts only after this read: an absence asserted before it proves nothing.
  const read = page.waitForResponse((item) => item.url().endsWith('/get_match_refunds'));
  await page.reload();
  expect((await read).status()).toBe(200);
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}

async function shot(page: Page, project: string, file: string) {
  if (
    (project !== 'mobile-chromium' && !file.startsWith('devolucao-')) ||
    !screenshotRoot ||
    !existsSync(screenshotRoot)
  )
    return;
  await page.screenshot({
    path: path.join(screenshotRoot, file.startsWith('devolucao-') ? `${project}-${file}` : file),
    fullPage: true,
  });
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
    // Out of the list: the board's chip counts the open slots (prévia aprovada).
    await expect(page.getByTestId('match-viewer-chip')).toHaveText('2 vagas abertas');
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
    await expect(caioView.page.getByTestId('match-viewer-chip')).toHaveText('1º na espera');
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
    await expect(caioView.page.getByTestId('match-viewer-chip')).toHaveText('Você vai');

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
    await expect(ownerView.page.getByTestId('match-confirmed-1-paid')).toHaveText('Não pagou');
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
    // A player sees the payment only on their own line.
    await expect(biaView.page.getByTestId('match-own-payment')).toHaveText('Pago');
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
    await expect(page.getByTestId('match-list-card')).toContainText('Lotado 2/2');
    await expect(page.getByTestId('match-list-card')).toHaveAccessibleName(
      /2 de 2 vagas confirmadas, 1 na espera, você está na espera$/,
    );
    await expect(page.getByTestId('match-card-state')).toHaveText('Na espera');
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

// Fatia 1.1 (D63-G; decisões humanas de 28/10/2026, P11 e P12): who is
// confirmed and not paid sees «Pague ao organizador» with the owner and the
// organizers, owner first, and the price; nobody else does. Once marked, the
// player sees the mark; a canceled match drops the instruction, and a match
// that already started keeps it (the debt stays).
test('Pagamento: the instruction goes only to who is confirmed and not paid', async ({
  browser,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    // The owner comes after the organizer in the alphabet, so "owner first" is
    // proved, not a by-product of sorting by name (rev91 P2-2).
    const owner = await createActor(request, 'pag-zeca', authIds);
    const organizer = await createActor(request, 'pag-bruno', authIds);
    const ana = await createActor(request, 'pag-ana', authIds);
    const bia = await createActor(request, 'pag-bia', authIds);
    const caio = await createActor(request, 'pag-caio', authIds);
    const created = await gateway(request, owner, 'create_group', { name: 'Racha Pago' });
    const groupId = (created['outcome'] as { group_id: string }).group_id;
    for (const [member, role] of [
      [organizer, 'organizer'],
      [ana, 'player'],
      [bia, 'player'],
      [caio, 'player'],
    ] as const) {
      await db.query(
        `insert into public.group_members(group_id, profile_id, role, status)
         values ($1, $2, $3, 'active')`,
        [groupId, member.profileId, role],
      );
    }
    const matchId = await createMatch(request, owner, groupId);
    // Four slots: Ana, Bia, the owner and the organizer are confirmed, Caio waits.
    // The owner and the organizer play too, so "nothing on the organisation's own
    // line" is proved on a confirmed line (rev91 P2-1).
    await db.query('update private.matches set field_slots = 4 where id = $1', [matchId]);
    for (const member of [ana, bia, owner, organizer, caio]) {
      await gateway(request, member, 'join_match', { match_id: matchId });
    }
    // The names as the group reads them: the owner first, then the organizer.
    const read = await request.post(`${env.functionsUrl}/groups/get_group_members`, {
      data: { group_id: groupId },
      headers: { Authorization: `Bearer ${ana.token}` },
    });
    expect(read.status()).toBe(200);
    const members = (
      (await read.json()) as { data: { profile_id: string; display_name: string }[] }
    ).data;
    const nameOf = (actor: Actor) =>
      members.find((member) => member.profile_id === actor.profileId)!.display_name;
    const instruction = `Pague ao organizador: ${nameOf(owner)} ou ${nameOf(organizer)}.`;
    expect(nameOf(organizer).localeCompare(nameOf(owner))).toBeLessThan(0);

    // Ana, confirmed and not paid: the instruction and the price.
    const anaView = await open(browser, ana, matchId);
    contexts.push(anaView.context);
    await expect(anaView.page.getByTestId('match-pay-notice-title')).toHaveText(instruction);
    await expect(anaView.page.getByTestId('match-pay-notice-note')).toContainText(
      'R$ 12,50 por jogador',
    );
    await assertAccessible(anaView.page);
    await anaView.page.getByTestId('match-pay-notice').scrollIntoViewIfNeeded();
    await shot(anaView.page, testInfo.project.name, 'pagamento-01-instrucao.png');

    // Caio waits: nothing. The owner and the organizer, confirmed: nothing on their
    // own line, and none of the three reads who collects (rev91 P2-1 and P3-2).
    for (const actor of [caio, owner, organizer]) {
      const context = await browser.newContext({ timezoneId: ZONE, colorScheme: 'dark' });
      contexts.push(context);
      const page = await context.newPage();
      let memberReads = 0;
      page.on('request', (item) => {
        if (new URL(item.url()).pathname.endsWith('/groups/get_group_members')) memberReads += 1;
      });
      await login(page, actor);
      await page.goto(`/rachas/${matchId}`);
      await expect(page.getByTestId('match-presence')).toBeVisible();
      await expect(page.getByTestId('match-confirmed')).toBeVisible();
      await expect(page.getByTestId('match-pay-notice')).toHaveCount(0);
      expect(memberReads, `${actor.name} read who collects`).toBe(0);
    }
    // The owner, who plays, sees the organisation's summary instead.
    const ownerView = await open(browser, owner, matchId);
    contexts.push(ownerView.context);
    await expect(ownerView.page.getByTestId('match-payment-summary')).toBeVisible();
    await readRefunds(ownerView.page);
    await expect(ownerView.page.getByTestId('match-refunds')).toHaveCount(0);

    // The organizer leaves the organisation while Ana's detail is open: "Atualizar"
    // reads who collects again, and the instruction no longer names them (rev91 P2-3).
    await gateway(request, owner, 'remove_member', {
      group_id: groupId,
      profile_id: organizer.profileId,
      reason: 'Saiu da organização',
    });
    await anaView.page.getByTestId('match-refresh-button').click();
    const onlyOwner = `Pague ao organizador: ${nameOf(owner)}.`;
    await expect(anaView.page.getByTestId('match-pay-notice-title')).toHaveText(onlyOwner);

    // Marked paid: Ana sees the mark instead of the instruction.
    await gateway(request, owner, 'set_match_payment', {
      match_id: matchId,
      profile_id: ana.profileId,
      paid: true,
    });
    await anaView.page.reload();
    await expect(anaView.page.getByTestId('match-pay-notice-title')).toHaveText(
      'Pagamento marcado pela organização.',
    );
    await anaView.page.getByTestId('match-pay-notice').scrollIntoViewIfNeeded();
    await shot(anaView.page, testInfo.project.name, 'pagamento-02-pago.png');

    // Canceled: Bia, who did not pay, no longer sees the instruction; Ana sees her refund obligation.
    const biaView = await open(browser, bia, matchId);
    contexts.push(biaView.context);
    await expect(biaView.page.getByTestId('match-pay-notice-title')).toHaveText(onlyOwner);
    await gateway(request, owner, 'cancel_match', { match_id: matchId });
    await biaView.page.reload();
    await expect(biaView.page.getByTestId('match-confirmed')).toBeVisible();
    await expect(biaView.page.getByTestId('match-pay-notice')).toHaveCount(0);
    await anaView.page.reload();
    await expect(anaView.page.getByTestId(/^match-own-refund-/)).toContainText('A devolver');

    // 1.3: organization reads obligations; player sees only their own. UI stays current.
    await ownerView.page.reload();
    const refundId = (
      await db.query(
        `select r.id from private.match_refunds r join private.match_players p on p.id=r.match_player_id where p.match_id=$1 and p.profile_id=$2`,
        [matchId, ana.profileId],
      )
    ).rows[0].id as string;
    await expect(ownerView.page.getByTestId('match-refunds-total')).toContainText('12,50');
    await expect(ownerView.page.getByTestId('match-payment-summary')).toHaveCount(0);
    if (testInfo.project.name === 'mobile-chromium')
      await ownerView.page.setViewportSize({ width: 390, height: 844 });
    else await ownerView.page.setViewportSize({ width: 1280, height: 800 });
    await ownerView.page.getByTestId(`refund-${refundId}`).click();
    await expect(ownerView.page.getByTestId('refund-confirmation-heading')).toBeFocused();
    await expect(ownerView.page.getByTestId('refund-date')).toHaveAccessibleDescription(
      /Brasília.*GMT-3/,
    );
    await assertAccessible(ownerView.page);
    await shot(ownerView.page, testInfo.project.name, 'devolucao-01-a-devolver.png');
    await ownerView.page.getByTestId('refund-confirm').click();
    await expect(ownerView.page.getByTestId(`refund-status-${refundId}`)).toHaveText('Devolvido');
    await expect(ownerView.page.getByTestId(`refund-${refundId}`)).toBeFocused();
    await anaView.page.getByTestId('match-refresh-button').click();
    await expect(anaView.page.getByTestId(`match-own-refund-${refundId}`)).toContainText(
      'Devolvido, confira no banco',
    );
    await shot(ownerView.page, testInfo.project.name, 'devolucao-02-devolvido.png');
    await ownerView.page.getByTestId(`refund-${refundId}`).click();
    await ownerView.page.getByTestId('refund-confirm').click();
    // The status reads the same before and after a correction: wait for its answer.
    await expect(ownerView.page.getByTestId('refund-confirmation')).toHaveCount(0);
    await expect(ownerView.page.getByTestId(`refund-status-${refundId}`)).toHaveText('Devolvido');
    await expect(ownerView.page.getByTestId(`refund-${refundId}`)).toBeFocused();
    await ownerView.page.getByTestId(`canceled-payment-${bia.profileId}`).click();
    await ownerView.page.getByTestId('refund-confirm').click();
    await expect(ownerView.page.getByTestId('match-refunds-total')).toContainText('12,50');
    await expect(ownerView.page.getByTestId(`canceled-payment-${bia.profileId}`)).toHaveCount(0);
    const lateRefundId = (
      await db.query(
        'select r.id from private.match_refunds r join private.match_players p on p.id=r.match_player_id where p.match_id=$1 and p.profile_id=$2',
        [matchId, bia.profileId],
      )
    ).rows[0].id as string;
    await expect(ownerView.page.getByTestId(`refund-${lateRefundId}`)).toBeFocused();
    await biaView.page.getByTestId('match-refresh-button').click();
    await expect(biaView.page.getByTestId(/^match-own-refund-/)).toContainText('A devolver');
    await expect(biaView.page.getByTestId('match-refunds')).toHaveCount(0);

    // P3-9: a returned player sees both historical obligations and the current
    // instruction, each with a unique ID (including more than one refund).
    const returned = await createMatch(request, owner, groupId);
    for (let payment = 0; payment < 2; payment += 1) {
      await gateway(request, ana, 'join_match', { match_id: returned });
      await gateway(request, owner, 'set_match_payment', {
        match_id: returned,
        profile_id: ana.profileId,
        paid: true,
      });
      await gateway(request, ana, 'leave_group', { group_id: groupId });
      await db.query(
        "update public.group_members set status='active',removed_at=null where group_id=$1 and profile_id=$2",
        [groupId, ana.profileId],
      );
    }
    await gateway(request, ana, 'join_match', { match_id: returned });
    await anaView.page.goto(`/rachas/${returned}`);
    await expect(anaView.page.getByTestId('match-pay-notice-title')).toHaveText(onlyOwner);
    const historical = (
      await db.query(
        'select r.id from private.match_refunds r join private.match_players p on p.id=r.match_player_id where p.match_id=$1',
        [returned],
      )
    ).rows;
    expect(historical).toHaveLength(2);
    await expect(anaView.page.getByTestId(/^match-own-refund-/)).toHaveCount(2);
    for (const row of historical) {
      await expect(anaView.page.getByTestId(`match-own-refund-${row.id}`)).toContainText(
        'A devolver',
      );
      await expect(anaView.page.getByTestId(`match-own-refund-${row.id}`)).toContainText('12,50');
    }

    // A match that already started keeps the instruction for who still owes.
    const started = await createMatch(request, owner, groupId);
    await gateway(request, bia, 'join_match', { match_id: started });
    await db.query(
      `update private.matches
         set starts_at = now() - interval '10 minutes', ends_at = now() + interval '80 minutes'
       where id = $1`,
      [started],
    );
    await biaView.page.goto(`/rachas/${started}`);
    await expect(biaView.page.getByTestId('match-pay-notice-title')).toHaveText(onlyOwner);

    // A match that already ended keeps it too (rev91 P3-1).
    const ended = await createMatch(request, owner, groupId);
    await gateway(request, bia, 'join_match', { match_id: ended });
    await db.query(
      `update private.matches
         set starts_at = now() - interval '3 hours', ends_at = now() - interval '90 minutes'
       where id = $1`,
      [ended],
    );
    await biaView.page.goto(`/rachas/${ended}`);
    await expect(biaView.page.getByTestId('match-pay-notice-title')).toHaveText(onlyOwner);
  } finally {
    for (const context of contexts) await context.close();
    await cleanActors(authIds, db);
    await db.end();
  }
});

// rev96 P2-1/P3-7: the two clocks diverge from the database in both directions.
for (const offset of [-120_000, 120_000]) {
  test(`Devolução: campo vazio usa o relógio do servidor (aparelho ${offset})`, async ({
    browser,
    request,
  }) => {
    const db = new Client({ connectionString: env.dbUrl });
    await db.connect();
    const authIds: string[] = [];
    let context: { close: () => Promise<void> } | undefined;
    try {
      const owner = await createActor(request, `clock-owner-${offset}`, authIds);
      const player = await createActor(request, `clock-player-${offset}`, authIds);
      const created = await gateway(request, owner, 'create_group', {
        name: 'Devolução e relógio',
      });
      const groupId = (created['outcome'] as { group_id: string }).group_id;
      await db.query(
        "insert into public.group_members(group_id,profile_id,role,status) values($1,$2,'player','active')",
        [groupId, player.profileId],
      );
      const matchId = await createMatch(request, owner, groupId);
      await gateway(request, player, 'join_match', { match_id: matchId });
      const opened = await open(browser, owner, matchId);
      context = opened.context;
      const page = opened.page;
      await expect(page.getByTestId('match-confirmed')).toBeVisible();
      await readRefunds(page);
      await expect(page.getByTestId('match-refunds')).toHaveCount(0);
      await page.getByTestId('match-cancel').click();
      await expect(page.getByTestId('match-cancel-confirmation-heading')).toBeFocused();
      await expect(page.getByTestId('match-cancel-refunds-total')).toHaveCount(0);
      await page.getByTestId('match-cancel-keep').click();
      await gateway(request, owner, 'set_match_payment', {
        match_id: matchId,
        profile_id: player.profileId,
        paid: true,
      });
      await page.getByTestId('match-refresh-button').click();
      await page.getByTestId('match-cancel').click();
      await expect(page.getByTestId('match-cancel-refunds-total')).toContainText('12,50');
      const canceled = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith('/groups/cancel_match'),
      );
      await page.getByTestId('match-cancel-confirm').click();
      expect((await canceled).status()).toBe(200);
      const refund = (
        await db.query(
          'select r.id from private.match_refunds r join private.match_players p on p.id=r.match_player_id where p.match_id=$1',
          [matchId],
        )
      ).rows[0].id as string;
      await expect(page.getByTestId(`refund-${refund}`)).toBeVisible();
      await page.clock.install({ time: new Date(Date.now() + offset) });
      for (const [operation, field] of [
        ['mark_refunded', 'refunded_at'],
        ['correct_refund', 'corrected_at'],
      ] as const) {
        await page.getByTestId(`refund-${refund}`).click();
        await expect(page.getByTestId('refund-confirmation-heading')).toBeFocused();
        await expect(page.getByTestId('refund-date')).toHaveValue('');
        const answer = page.waitForResponse((response) =>
          new URL(response.url()).pathname.endsWith(`/groups/${operation}`),
        );
        const before = (await db.query('select clock_timestamp() as t')).rows[0].t as Date;
        await page.getByTestId('refund-confirm').click();
        const response = await answer;
        expect(response.status()).toBe(200);
        expect(response.request().postDataJSON()).not.toHaveProperty(field);
        await expect(page.getByTestId('refund-confirmation')).toHaveCount(0);
        await expect(page.getByTestId(`refund-${refund}`)).toBeFocused();
        await expect(page.getByTestId(`refund-status-${refund}`)).toHaveText('Devolvido');
        const stored = (
          await db.query(
            'select refunded_at,created_at,clock_timestamp() as now from private.match_refunds where id=$1',
            [refund],
          )
        ).rows[0];
        expect(stored.refunded_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(stored.refunded_at.getTime()).toBeGreaterThanOrEqual(stored.created_at.getTime());
        expect(stored.refunded_at.getTime()).toBeLessThanOrEqual(stored.now.getTime());
      }
      if (offset > 0) {
        // This typed date passes the device clock but is in the server's future.
        // VALIDATION must stay visible as a date error and never auto-retry.
        await page.getByTestId(`refund-${refund}`).click();
        const future = new Intl.DateTimeFormat('en-GB', {
          timeZone: ZONE,
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })
          .format(new Date(Date.now() + 90_000))
          .replace(',', '');
        await page.getByTestId('refund-date').fill(future);
        let corrections = 0;
        page.on('request', (item) => {
          if (new URL(item.url()).pathname.endsWith('/groups/correct_refund')) corrections += 1;
        });
        const refused = page.waitForResponse((response) =>
          new URL(response.url()).pathname.endsWith('/groups/correct_refund'),
        );
        await page.getByTestId('refund-confirm').click();
        expect((await refused).status()).toBe(422);
        await expect(page.getByTestId('match-refund-error')).toContainText(
          'Informe uma data válida, entre a obrigação e agora.',
        );
        await expect(page.getByTestId('refund-confirmation')).toBeVisible();
        await page.clock.runFor(2_000);
        expect(corrections).toBe(1);
      }
    } finally {
      await context?.close();
      await cleanActors(authIds, db);
      await db.end();
    }
  });
}

test('Organização: adiciona sem furar fila e remove pago com confirmação e times desatualizados', async ({
  page,
  browser,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  const contexts: { close: () => Promise<void> }[] = [];
  let groupId: string | undefined;
  try {
    const owner = await createActor(request, 'manual-dona', authIds);
    const organizer = await createActor(request, 'manual-org', authIds);
    const people: Actor[] = [];
    for (const label of [
      'manual-ana',
      'manual-bia',
      'manual-caio',
      'manual-dani',
      'manual-eli',
      'manual-pendente',
    ]) {
      people.push(await createActor(request, label, authIds));
    }
    const [ana, bia, caio, dani, eli, pending] = people as [
      Actor,
      Actor,
      Actor,
      Actor,
      Actor,
      Actor,
    ];
    groupId = (
      (await gateway(request, owner, 'create_group', { name: 'Racha manual' }))['outcome'] as {
        group_id: string;
      }
    ).group_id;
    for (const member of [organizer, ...people]) {
      await db.query(
        `insert into public.group_members(group_id,profile_id,role,status) values($1,$2,$3,$4)`,
        [
          groupId,
          member.profileId,
          member === organizer ? 'organizer' : 'player',
          member === pending ? 'pending' : 'active',
        ],
      );
    }
    const matchId = await createMatch(request, owner, groupId);
    await db.query('update private.matches set field_slots=4 where id=$1', [matchId]);
    await login(page, owner);
    await page.goto(`/rachas/${matchId}`);
    await page.getByTestId('match-add-player').click();
    await expect(page.getByTestId('match-add-picker-heading')).toBeFocused();
    await expect(page.getByTestId(`match-add-${ana.profileId}`)).toBeVisible();
    await expect(page.getByTestId(`match-add-${pending.profileId}`)).toHaveCount(0);
    await page.getByTestId(`match-add-${ana.profileId}`).click();
    await expect(page.getByTestId('match-add-result')).toHaveText('Jogador confirmado no racha.');
    await expect(page.getByTestId('match-add-player')).toBeFocused();
    for (const actor of [bia, caio, dani])
      await gateway(request, actor, 'join_match', { match_id: matchId });
    for (const actor of [ana, bia, caio, dani])
      await gateway(request, owner, 'set_rating', {
        group_id: groupId,
        profile_id: actor.profileId,
        stars: 3,
      });
    await gateway(request, owner, 'draw_teams', {
      match_id: matchId,
      team_count: 2,
      confirm_unequal_sizes: false,
    });
    await gateway(request, owner, 'set_match_payment', {
      match_id: matchId,
      profile_id: ana.profileId,
      paid: true,
    });
    await page.reload();
    await board(page, 4, 4);
    // A published draw permits adding, but a full list sends Eli to the end.
    await page.getByTestId('match-add-player').click();
    await expect(page.getByTestId(`match-add-${ana.profileId}`)).toHaveCount(0);
    await page.getByTestId(`match-add-${eli.profileId}`).click();
    await expect(page.getByTestId('match-add-result')).toHaveText(
      'Jogador adicionado ao fim da espera.',
    );
    await expect(page.getByTestId('match-waitlist-0')).toContainText('manual-elizinho');
    // Owner and organizer share the controls. Cancel restores focus without removing.
    const orgView = await open(browser, organizer, matchId);
    contexts.push(orgView.context);
    await orgView.page.setViewportSize({ width: 390, height: 844 });
    const removeId = `match-remove-${ana.profileId}`;
    await orgView.page.getByTestId(removeId).click();
    await expect(orgView.page.getByTestId(`${removeId}-confirmation-heading`)).toBeFocused();
    await expect(orgView.page.getByTestId(`${removeId}-confirmation`)).toContainText(
      'os times ficam desatualizados',
    );
    await expect(orgView.page.getByTestId(`${removeId}-confirmation`)).toContainText(
      'O pagamento ficará a devolver.',
    );
    await orgView.page.getByTestId(`${removeId}-cancel`).click();
    await expect(orgView.page.getByTestId(removeId)).toBeFocused();
    await expect(orgView.page.getByTestId('match-confirmed-0')).toContainText('manual-anazinho');
    await orgView.page.getByTestId(removeId).click();
    await orgView.page.getByTestId(`${removeId}-confirm`).click();
    await expect(orgView.page.getByTestId(removeId)).toHaveCount(0);
    await expect(orgView.page.getByTestId('match-refresh-button')).toBeFocused();
    await expect(orgView.page.getByTestId('match-confirmed')).toContainText('manual-elizinho');
    await expect(orgView.page.getByTestId('match-refunds')).toContainText('manual-anazinho');
    await expect(orgView.page.getByTestId('match-refunds')).toContainText('A devolver');
    await expect(orgView.page.getByText('Times desatualizados', { exact: false })).toBeVisible();
    await assertAccessible(orgView.page);
    expect(
      await orgView.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    // Removed member returns alone, unpaid, behind an existing waitlist member.
    await gateway(request, bia, 'leave_match', { match_id: matchId });
    await gateway(request, owner, 'add_player', { match_id: matchId, profile_id: owner.profileId });
    await gateway(request, owner, 'add_player', {
      match_id: matchId,
      profile_id: organizer.profileId,
    });
    const anaView = await open(browser, ana, matchId);
    contexts.push(anaView.context);
    await expect(anaView.page.getByTestId('match-add-player')).toHaveCount(0);
    await expect(anaView.page.locator('[data-testid^="match-remove-"]')).toHaveCount(0);
    await anaView.page.getByTestId('match-join').click();
    await expect(anaView.page.getByTestId('match-viewer-chip')).toHaveText('2º na espera');
    const stored = await db.query(
      'select paid from private.match_players where match_id=$1 and profile_id=$2',
      [matchId, ana.profileId],
    );
    expect(stored.rows[0].paid).toBe(false);
    // Unpaid removal from waitlist creates no extra financial obligation.
    await orgView.page.getByTestId('match-refresh-button').click();
    const waitingId = `match-remove-${organizer.profileId}`;
    // The organizer's own row directs to Desistir; owner removes that waitlist row.
    await page.getByTestId('match-refresh-button').click();
    await page.getByTestId(waitingId).click();
    await page.getByTestId(`${waitingId}-confirm`).click();
    await expect(page.getByTestId(waitingId)).toHaveCount(0);
    expect(
      (
        await db.query(
          `select count(*)::int n from private.match_refunds r join private.match_players p on p.id=r.match_player_id where p.match_id=$1`,
          [matchId],
        )
      ).rows[0].n,
    ).toBe(1);
  } finally {
    for (const context of contexts) await context.close();
    if (groupId) {
      await db.query(
        'delete from private.match_draws where match_id in (select id from private.matches where group_id=$1)',
        [groupId],
      );
      await db.query('delete from private.ratings where group_id=$1', [groupId]);
      await db.query('delete from private.rating_history where group_id=$1', [groupId]);
    }
    await cleanActors(authIds, db);
    await db.end();
  }
});
