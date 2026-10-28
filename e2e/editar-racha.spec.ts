import { expect, test, type APIRequestContext, type Browser, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';

// Editar e cancelar racha (0028, item 10 do feedback): the owner edits through
// the create form filled in, the member reads the change; the cancellation
// asks in place, then the detail and the Agenda say "Cancelado" and presence
// closes. A player sees neither action, and a forced call through the Edge is
// refused.
const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-editar-racha-2026';
const prefix = `editar-racha-${Date.now()}-${process.pid}`;
const screenshotRoot = process.env['COLETE_EDITAR_SCREENSHOTS_DIR'];
const ZONE = 'America/Sao_Paulo';
type Actor = { authId: string; profileId: string; token: string; email: string; name: string };

test.use({ timezoneId: ZONE, colorScheme: 'dark' });

// The captures are taken at 390 px, the width of the approved preview.
async function shot(page: Page, project: string, file: string) {
  if (project !== 'mobile-chromium' || !screenshotRoot || !existsSync(screenshotRoot)) return;
  const size = page.viewportSize();
  await page.setViewportSize({ width: 390, height: size?.height ?? 844 });
  await page.screenshot({ path: path.join(screenshotRoot, file), fullPage: true });
  if (size) await page.setViewportSize(size);
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
  } satisfies Actor;
}

function post(
  request: APIRequestContext,
  actor: Actor,
  operation: string,
  data: Record<string, unknown>,
) {
  return request.post(`${env.functionsUrl}/groups/${operation}`, {
    data: { request_id: crypto.randomUUID(), ...data },
    headers: { Authorization: `Bearer ${actor.token}` },
  });
}

async function gateway(
  request: APIRequestContext,
  actor: Actor,
  operation: string,
  data: Record<string, unknown>,
) {
  const response = await post(request, actor, operation, data);
  expect(response.status(), `${operation}: ${await response.text()}`).toBe(200);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}

function config(start: Date, slots: number) {
  return {
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 90 * 60_000).toISOString(),
    timezone: ZONE,
    location_name: 'Arena da Lista',
    location_address: null,
    description: null,
    latitude: null,
    longitude: null,
    field_slots: slots,
    field_price: '12.50',
  };
}

async function setup(request: APIRequestContext, db: pg.Client, authIds: string[]) {
  const owner = await createActor(request, 'dona', authIds);
  const ana = await createActor(request, 'ana', authIds);
  const bia = await createActor(request, 'bia', authIds);
  const caio = await createActor(request, 'caio', authIds);
  const stranger = await createActor(request, 'fora', authIds);
  const created = await gateway(request, owner, 'create_group', { name: 'Racha Editável' });
  const groupId = (created['outcome'] as { group_id: string }).group_id;
  for (const member of [ana, bia, caio]) {
    await db.query(
      `insert into public.group_members(group_id, profile_id, role, status)
       values ($1, $2, 'player', 'active')`,
      [groupId, member.profileId],
    );
  }
  const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 2 * 86_400_000);
  const made = await gateway(request, owner, 'create_match', {
    group_id: groupId,
    config: config(start, 2),
  });
  const matchId = (made['outcome'] as { match_id: string }).match_id;
  // Two confirmed, one waiting.
  for (const member of [ana, bia, caio]) {
    await gateway(request, member, 'join_match', { match_id: matchId });
  }
  return { owner, ana, bia, caio, stranger, groupId, matchId, start };
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

test('Editar e cancelar: the owner edits, the member sees it; the cancel shows on the detail and the Agenda', async ({
  browser,
  page,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const { owner, ana, caio, matchId } = await setup(request, db, authIds);

    // The owner opens the detail: "Editar" at the top right, the form filled in.
    await login(page, owner);
    await page.goto(`/rachas/${matchId}`);
    await board(page, 2, 2);
    const title = (await page.getByRole('heading', { level: 1 }).textContent()) ?? '';
    await expect(page.getByTestId('match-edit')).toHaveAccessibleName('Editar racha');
    await expect(page.getByTestId('match-cancel')).toHaveText('Cancelar racha');
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '01-detalhe-dono.png');
    await page.getByTestId('match-edit').click();
    await expect(page).toHaveURL(new RegExp(`/editar-racha\\?matchId=${matchId}$`));
    await expect(page.getByRole('heading', { name: 'Editar racha', level: 1 })).toBeVisible();
    await expect(page.getByTestId('match-fixed-group')).toContainText('Racha Editável');
    await expect(page.getByTestId('match-locationName')).toHaveValue('Arena da Lista');
    await expect(page.getByTestId('match-slots')).toHaveValue('2');
    await expect(page.getByTestId('match-price')).toHaveValue('R$ 12,50');
    await expect(page.getByTestId('match-create-submit')).toHaveText('Salvar alterações');
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '02-editar-preenchido.png');

    // rev79 / BB-006: closing with a change asks first; keeping returns the
    // focus and the text, discarding leaves the match as it was.
    await page.getByTestId('match-locationName').fill('Arena Rascunho');
    await page.getByTestId('match-create-close').click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Descartar as alterações?' }),
    ).toBeFocused();
    await assertAccessible(page);
    await page.getByTestId('match-discard-keep').click();
    await expect(page.getByTestId('match-create-close')).toBeFocused();
    await expect(page.getByTestId('match-locationName')).toHaveValue('Arena Rascunho');
    await page.getByTestId('match-create-close').click();
    await page.getByTestId('match-discard-confirm').click();
    await expect(page).toHaveURL(new RegExp(`/rachas/${matchId}$`));
    await expect(page.getByTestId('match-fact-where')).toContainText('Arena da Lista');
    // Unchanged, "Fechar" closes at once.
    await page.getByTestId('match-edit').click();
    await expect(page.getByTestId('match-locationName')).toHaveValue('Arena da Lista');
    await page.getByTestId('match-create-close').click();
    await expect(page).toHaveURL(new RegExp(`/rachas/${matchId}$`));
    await page.getByTestId('match-edit').click();
    await expect(page.getByTestId('match-locationName')).toHaveValue('Arena da Lista');

    // Below the confirmed: refused on the field, with the count.
    await page.getByTestId('match-slots').fill('1');
    await page.getByTestId('match-create-submit').click();
    await expect(page.getByTestId('match-slots')).toBeFocused();
    await expect(page.getByTestId('match-slots')).toHaveAccessibleDescription(
      /Já há 2 confirmados/,
    );
    await shot(page, testInfo.project.name, '03-editar-vagas-abaixo.png');

    // More slots, another place and price: saved, and the waitlist moves up.
    await page.getByTestId('match-slots').fill('3');
    await page.getByTestId('match-locationName').fill('Arena Nova');
    await page.getByTestId('match-price').fill('1500');
    await expect(page.getByTestId('match-price')).toHaveValue('R$ 15,00');
    await page.getByTestId('match-create-submit').click();
    await expect(page).toHaveURL(new RegExp(`/rachas/${matchId}$`));
    await expect(page.getByTestId('match-fact-where')).toContainText('Arena Nova');
    await expect(page.getByTestId('match-fact-price')).toHaveText(/R\$\s15,00 por jogador$/);
    await board(page, 3, 3);
    const promoted = await db.query(
      `select status from private.match_players where match_id=$1 and profile_id=$2`,
      [matchId, caio.profileId],
    );
    expect(promoted.rows).toEqual([{ status: 'starter' }]);

    // The member reads the change on their own screen.
    const anaView = await open(browser, ana, matchId);
    contexts.push(anaView.context);
    await expect(anaView.page.getByTestId('match-fact-where')).toContainText('Arena Nova');
    await expect(anaView.page.getByTestId('match-fact-price')).toHaveText(
      /R\$\s15,00 por jogador$/,
    );
    await board(anaView.page, 3, 3);

    // Cancel: the confirmation opens in place and names the date; "Voltar" keeps it.
    await page.getByTestId('match-cancel').click();
    await expect(page.getByTestId('match-cancel-confirmation-heading')).toBeFocused();
    await expect(page.getByTestId('match-cancel-confirmation-heading')).toHaveText(
      `Cancelar racha de ${title}?`,
    );
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '04-cancelar-confirmacao.png');
    await page.getByTestId('match-cancel-keep').click();
    await expect(page.getByTestId('match-cancel-confirmation')).toHaveCount(0);
    await expect(page.getByTestId('match-cancel')).toBeFocused();
    await page.getByTestId('match-cancel').click();
    await page.getByTestId('match-cancel-confirm').click();
    await expect(page.getByTestId('match-cancel-result')).toHaveText('Racha cancelado.');
    await expect(page.getByTestId('match-viewer-chip')).toHaveText('Cancelado');
    await expect(page.getByTestId('match-board-summary')).toHaveCount(0);
    await expect(page.getByTestId('match-edit')).toHaveCount(0);
    await expect(page.getByTestId('match-cancel')).toHaveCount(0);
    // The marks stay, but nobody marks a canceled match.
    await expect(page.getByTestId('match-confirmed-0-mark')).toHaveCount(0);
    const stored = await db.query(
      `select canceled_by from private.matches where id=$1 and canceled_at is not null`,
      [matchId],
    );
    expect(stored.rows).toEqual([{ canceled_by: owner.profileId }]);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '05-cancelado-dono.png');

    // The member: "Cancelado", no "Desistir", the list kept; the Agenda says it too.
    await anaView.page.reload();
    await expect(anaView.page.getByTestId('match-viewer-chip')).toHaveText('Cancelado');
    await expect(anaView.page.getByTestId('match-leave')).toHaveCount(0);
    await expect(anaView.page.getByTestId('match-join')).toHaveCount(0);
    await expect(anaView.page.getByTestId('match-confirmed-0')).toContainText(ana.name);
    await shot(anaView.page, testInfo.project.name, '06-cancelado-membro.png');
    await anaView.page.goto('/rachas');
    const card = anaView.page.getByTestId('match-list-card');
    await expect(card.getByTestId('match-card-state')).toHaveText('Cancelado');
    await expect(card).toHaveAccessibleName(/Cancelado/);
    await expect(card).not.toHaveAccessibleName(/você vai jogar/);
    await assertAccessible(anaView.page);
    await shot(anaView.page, testInfo.project.name, '07-agenda-cancelado.png');
    // "Vou jogar" no longer lists it.
    await anaView.page.getByTestId('matches-filter-playing').click();
    await expect(anaView.page.getByTestId('match-list-card')).toHaveCount(0);
  } finally {
    for (const context of contexts) await context.close();
    await cleanActors(authIds, db);
    await db.end();
  }
});

// UX-001: the create form asks before discarding too, like the edit (BB-006);
// an empty form closes at once. At the audit's widths: 390 and 1280.
test('Criar racha: closing with a field filled in asks first; empty, it closes at once', async ({
  page,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'cria', authIds);
    const created = await gateway(request, owner, 'create_group', { name: 'Racha Novo' });
    const groupId = (created['outcome'] as { group_id: string }).group_id;
    if (testInfo.project.name === 'mobile-chromium')
      await page.setViewportSize({ width: 390, height: 844 });
    await login(page, owner);
    const groupPage = new RegExp(`/grupos/${groupId}$`);

    // Empty: "Fechar" closes at once.
    await page.goto(`/grupos/${groupId}`);
    await page.getByTestId('group-create-match').click();
    await expect(page.getByRole('heading', { name: 'Criar racha', level: 1 })).toBeVisible();
    await page.getByTestId('match-create-close').click();
    await expect(page).toHaveURL(groupPage);

    // Filled in: it asks; keeping returns the focus and the text.
    await page.getByTestId('group-create-match').click();
    await page.getByTestId('match-locationName').fill('Arena Rascunho');
    await page.getByTestId('match-create-close').click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Descartar as alterações?' }),
    ).toBeFocused();
    await assertAccessible(page);
    await page.getByTestId('match-discard-keep').click();
    await expect(page.getByTestId('match-create-close')).toBeFocused();
    await expect(page.getByTestId('match-locationName')).toHaveValue('Arena Rascunho');

    // Discarding closes, and nothing was written.
    await page.getByTestId('match-create-close').click();
    await page.getByTestId('match-discard-confirm').click();
    await expect(page).toHaveURL(groupPage);
    await expect(page.getByTestId('match-create-close')).toHaveCount(0);
    const matches = await db.query(
      'select count(*)::int as n from private.matches where group_id=$1',
      [groupId],
    );
    expect(matches.rows).toEqual([{ n: 0 }]);
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('Editar e cancelar: a player sees neither, and a forced call through the Edge is refused', async ({
  page,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const { ana, stranger, matchId, start } = await setup(request, db, authIds);
    await login(page, ana);
    await page.goto(`/rachas/${matchId}`);
    await expect(page.getByTestId('match-leave')).toBeVisible();
    await expect(page.getByTestId('match-edit')).toHaveCount(0);
    await expect(page.getByTestId('match-cancel')).toHaveCount(0);
    await shot(page, testInfo.project.name, '08-detalhe-jogador.png');

    // The edit URL typed by hand opens a refusal, not the form.
    await page.goto(`/editar-racha?matchId=${matchId}`);
    await expect(page.getByText('Não dá para editar este racha')).toBeVisible();
    await expect(
      page.getByText('Só o dono ou um organizador ativo do grupo edita ou cancela o racha.'),
    ).toBeVisible();
    await expect(page.getByTestId('create-match-card')).toHaveCount(0);

    // Forced calls through the Edge: player 403; outside the group 404, as for an unknown ID.
    const body = { match_id: matchId, config: { ...config(start, 9) } };
    for (const [operation, data] of [
      ['update_match', body],
      ['cancel_match', { match_id: matchId }],
    ] as const) {
      const forced = await post(request, ana, operation, data);
      expect(forced.status()).toBe(403);
      expect(((await forced.json()) as { error: { code: string } }).error.code).toBe(
        'NOT_ORGANIZER',
      );
      const outside = await post(request, stranger, operation, data);
      const unknown = await post(request, stranger, operation, {
        ...data,
        match_id: crypto.randomUUID(),
      });
      expect([outside.status(), unknown.status()]).toEqual([404, 404]);
      const codes = [outside, unknown].map(async (answer) => {
        const json = (await answer.json()) as { error: { code: string; message: string } };
        return `${json.error.code}:${json.error.message}`;
      });
      const [one, two] = await Promise.all(codes);
      expect(one).toBe(two);
    }
    const untouched = await db.query(
      `select field_slots, canceled_at from private.matches where id=$1`,
      [matchId],
    );
    expect(untouched.rows).toEqual([{ field_slots: 2, canceled_at: null }]);
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});

// HX-005: a phone in another zone edits the match in the match's zone. The
// owner's phone is in Manaus (UTC-4), the match in São Paulo (UTC-3): the form
// shows and saves São Paulo times, says which zone they are in, and the match
// keeps its zone.
test('Fuso do racha: a phone in Manaus edits a match in São Paulo and keeps its times', async ({
  browser,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const owner = await createActor(request, 'fuso', authIds);
    const created = await gateway(request, owner, 'create_group', { name: 'Racha no Fuso' });
    const groupId = (created['outcome'] as { group_id: string }).group_id;
    // 19:00 in São Paulo, three days from now on São Paulo's calendar.
    const [day, month, year] = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      timeZone: ZONE,
      year: 'numeric',
    })
      .format(new Date(Date.now() + 3 * 86_400_000))
      .split('/');
    const date = `${year}-${month}-${day}`;
    const made = await gateway(request, owner, 'create_match', {
      group_id: groupId,
      config: config(new Date(`${date}T19:00:00-03:00`), 10),
    });
    const matchId = (made['outcome'] as { match_id: string }).match_id;

    const context = await browser.newContext({
      timezoneId: 'America/Manaus',
      colorScheme: 'dark',
    });
    contexts.push(context);
    const page = await context.newPage();
    await login(page, owner);
    await page.goto(`/rachas/${matchId}`);
    await expect(page.getByTestId('match-fact-when')).toContainText('19:00–20:30');
    await expect(page.getByTestId('match-fact-zone')).toHaveText(
      'Horário do racha: Horário Padrão de Brasília (GMT-3)',
    );
    await shot(page, testInfo.project.name, '09-detalhe-fuso-manaus.png');

    await page.getByTestId('match-edit').click();
    await expect(page.getByTestId('match-date')).toHaveValue(`${day}/${month}/${year}`);
    await expect(page.getByTestId('match-startTime')).toHaveValue('19:00');
    await expect(page.getByTestId('match-endTime')).toHaveValue('20:30');
    // Shown once, above the date, and read with the date, the start and the end
    // (rev88 P3-2).
    await expect(page.getByTestId('match-zone')).toHaveText(
      'Horário do racha: Horário Padrão de Brasília (GMT-3)',
    );
    for (const id of ['match-date', 'match-startTime', 'match-endTime']) {
      await expect(page.getByTestId(id)).toHaveAccessibleDescription(
        /Horário do racha: Horário Padrão de Brasília \(GMT-3\)/,
      );
    }
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '10-editar-fuso-manaus.png');

    await page.getByTestId('match-startTime').fill('2000');
    await page.getByTestId('match-endTime').fill('2130');
    await page.getByTestId('match-create-submit').click();
    await expect(page).toHaveURL(new RegExp(`/rachas/${matchId}$`));
    await expect(page.getByTestId('match-fact-when')).toContainText('20:00–21:30');

    const stored = await db.query(
      'select starts_at, ends_at, timezone from private.matches where id = $1',
      [matchId],
    );
    expect(stored.rows[0]).toEqual({
      starts_at: new Date(`${date}T20:00:00-03:00`),
      ends_at: new Date(`${date}T21:30:00-03:00`),
      timezone: ZONE,
    });

    // On a phone in the match's own zone, nothing says the zone.
    const home = await open(browser, owner, matchId);
    contexts.push(home.context);
    await expect(home.page.getByTestId('match-fact-when')).toContainText('20:00–21:30');
    await expect(home.page.getByTestId('match-fact-zone')).toHaveCount(0);
  } finally {
    for (const context of contexts) await context.close();
    await cleanActors(authIds, db);
    await db.end();
  }
});
