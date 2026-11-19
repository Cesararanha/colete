import { beginCleanup } from './support/cleanup';
import { expect, test, type APIRequestContext, type Browser, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { focusRingClipped, tabTo } from './support/layout';
import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';

// PR H (decisão do César, 18/10/2026): the owner picks the group's icon and
// colour on "Ícone do grupo"; every member sees the choice in the list, the
// detail, the Agenda and the match; the organizer has no way to it, and a
// forced call through the Edge is refused.

const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-icone-grupo-2026';
const prefix = `icone-grupo-${Date.now()}-${process.pid}`;
const screenshotRoot = process.env['COLETE_ICONE_SCREENSHOTS_DIR'];
const ZONE = 'America/Sao_Paulo';
type Actor = { authId: string; profileId: string; token: string; email: string; name: string };

test.use({ timezoneId: ZONE, colorScheme: 'dark' });

/** The prévia is 390 wide: captures resize to it, then restore the project viewport. */
async function shot(page: Page, project: string, file: string) {
  if (project !== 'mobile-chromium' || !screenshotRoot || !existsSync(screenshotRoot)) return;
  const previous = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  // The Criar racha modal has no authenticated main: it keeps the 844 frame.
  const height = Math.max(
    0,
    ...(await page
      .locator('[data-testid="authenticated-main"]:visible')
      .evaluateAll((elements) => elements.map((element) => element.scrollHeight))),
  );
  await page.setViewportSize({ width: 390, height: Math.max(844, height + 180) });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(screenshotRoot, file), scale: 'css' });
  await page.setViewportSize(previous);
}

async function createActor(request: APIRequestContext, label: string, name: string, ids: string[]) {
  const email = `${prefix}-${label}@colete.test`;
  const { id } = await createVerifiedUser(request, env, { email, name, password });
  ids.push(id);
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
  const outcome = (await profiled.json()) as { data: { outcome: { profile_id: string } } };
  return {
    authId: id,
    profileId: outcome.data.outcome.profile_id,
    token: session.access_token,
    email,
    name,
  } satisfies Actor;
}

async function call(
  request: APIRequestContext,
  actor: Actor,
  operation: string,
  data: Record<string, unknown>,
) {
  const read = operation === 'get_invite_share_link';
  const response = await request.post(`${env.functionsUrl}/groups/${operation}`, {
    data: read ? data : { request_id: crypto.randomUUID(), ...data },
    headers: { Authorization: `Bearer ${actor.token}` },
  });
  return { status: response.status(), body: (await response.json()) as Record<string, any> };
}

async function gateway(
  request: APIRequestContext,
  actor: Actor,
  operation: string,
  data: Record<string, unknown>,
) {
  const result = await call(request, actor, operation, data);
  expect(result.status, `${operation}: ${JSON.stringify(result.body)}`).toBe(200);
  return result.body['data'] as Record<string, unknown>;
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
    await db.query('delete from private.invite_rate_limits where profile_id = any($1::uuid[])', [
      ids,
    ]);
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

async function pageFor(browser: Browser, actor: Actor, like: Page) {
  const context = await browser.newContext({
    baseURL: 'http://127.0.0.1:4173',
    colorScheme: 'dark',
    locale: 'pt-BR',
    timezoneId: ZONE,
    viewport: like.viewportSize(),
  });
  const page = await context.newPage();
  await login(page, actor);
  return page;
}

/** The decorative icon is drawn with its keys: the test reads what the member sees. */
function icon(scope: ReturnType<Page['getByTestId']>, iconKey: string, color: string) {
  return scope.locator(`[data-group-icon="${iconKey}"][data-group-color="${color}"]`);
}

test('the owner picks the icon and colour; every member sees it; nobody else can', async ({
  page,
  request,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'owner', 'Ana Dona', authIds);
    const organizer = await createActor(request, 'organizer', 'Bia Org', authIds);
    const player = await createActor(request, 'player', 'Caio Jogador', authIds);
    const visitor = await createActor(request, 'visitor', 'Duda Visitante', authIds);
    const created = await gateway(request, owner, 'create_group', { name: 'Racha de Quinta' });
    const { group_id: groupId, invite_id: inviteId } = created['outcome'] as {
      group_id: string;
      invite_id: string;
    };
    const share = await gateway(request, owner, 'get_invite_share_link', { invite_id: inviteId });
    for (const actor of [organizer, player]) {
      await gateway(request, actor, 'join_by_code', { code: share['code'] });
      await gateway(request, owner, 'approve_member', {
        group_id: groupId,
        profile_id: actor.profileId,
        approve: true,
      });
    }
    await gateway(request, owner, 'set_role', {
      group_id: groupId,
      profile_id: organizer.profileId,
      role: 'organizer',
    });
    const start = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 2 * 86_400_000);
    const match = await gateway(request, owner, 'create_match', {
      group_id: groupId,
      config: {
        starts_at: start.toISOString(),
        ends_at: new Date(start.getTime() + 90 * 60_000).toISOString(),
        timezone: ZONE,
        location_name: 'Arena Pajuçara',
        location_address: null,
        description: null,
        latitude: null,
        longitude: null,
        field_slots: 14,
        field_price: '15.00',
      },
    });
    const matchId = (match['outcome'] as { match_id: string }).match_id;

    // A new group is the blue ball, in the database and on the owner's list.
    const before = await db.query('select icon, color from public.groups where id = $1', [groupId]);
    expect(before.rows[0]).toEqual({ icon: 'ball', color: 'blue' });

    // Forced calls through the Edge: organizer and player get the standard
    // refusal, a value outside the list is refused before the key is spent.
    for (const actor of [organizer, player]) {
      const refused = await call(request, actor, 'set_group_appearance', {
        group_id: groupId,
        icon: 'trophy',
        color: 'green',
      });
      expect(refused.status).toBe(403);
      expect(refused.body['error']['code']).toBe('OWNER_ONLY');
    }
    const invalid = await call(request, owner, 'set_group_appearance', {
      group_id: groupId,
      icon: 'Bola',
      color: 'blue',
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body['error']['code']).toBe('VALIDATION');
    const unauthenticated = await request.post(`${env.functionsUrl}/groups/set_group_appearance`, {
      data: { request_id: crypto.randomUUID(), group_id: groupId, icon: 'trophy', color: 'green' },
    });
    expect(unauthenticated.status()).toBe(401);
    const untouched = await db.query('select icon, color from public.groups where id = $1', [
      groupId,
    ]);
    expect(untouched.rows[0]).toEqual({ icon: 'ball', color: 'blue' });

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      if (!error.message.includes('Minified React error #418')) pageErrors.push(error.message);
    });

    // The organizer reaches Configurações but sees no "Ícone do grupo"; by
    // address the screen says who may choose and offers nothing.
    const organizerPage = await pageFor(browser, organizer, page);
    await organizerPage.goto(`/grupos/${groupId}/configuracoes`);
    await expect(organizerPage.getByTestId('group-settings-card')).toBeVisible();
    await expect(organizerPage.getByTestId('settings-role')).toHaveText('Organizador');
    await expect(organizerPage.getByTestId('settings-appearance-link')).toHaveCount(0);
    await expect(organizerPage.getByRole('link', { name: 'Ícone do grupo' })).toHaveCount(0);
    await organizerPage.goto(`/grupos/${groupId}/icone`);
    await expect(organizerPage.getByTestId('appearance-owner-only')).toHaveText(
      'Só o dono escolhe o ícone e a cor do grupo.',
    );
    await expect(organizerPage.getByTestId('appearance-save')).toHaveCount(0);
    await expect(organizerPage.getByRole('button', { name: 'Chama' })).toHaveCount(0);

    // The owner: list → group → Configurar → Ícone do grupo.
    await login(page, owner);
    const listCard = page.getByTestId('group-list-card');
    await expect(icon(listCard, 'ball', 'blue')).toHaveCount(1);
    await listCard.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Racha de Quinta' })).toBeVisible();
    await page.getByRole('button', { name: 'Configurar' }).click();
    const link = page.getByRole('link', { name: 'Ícone do grupo' });
    await expect(link).toBeVisible();
    // UX-002 (WCAG 2.4.7): the keyboard ring of the row shows whole; the card
    // around it used to cut it off on every side.
    await tabTo(page, link);
    expect(await focusRingClipped(page)).toEqual([]);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/grupos/${groupId}/icone$`, 'u'));
    await expect(page.getByRole('heading', { level: 1, name: 'Ícone do grupo' })).toBeVisible();
    await expect(page.getByTestId('appearance-back')).toHaveAccessibleName(
      'Voltar para Configurações',
    );
    const icons = page.getByTestId('appearance-icons').getByRole('button');
    await expect(icons).toHaveCount(8);
    for (const [index, name] of [
      'Bola',
      'Gol',
      'Campo',
      'Apito',
      'Camisa',
      'Troféu',
      'Raio',
      'Chama',
    ].entries())
      await expect(icons.nth(index)).toHaveAccessibleName(name);
    const swatches = page.getByTestId('appearance-colors').getByRole('button');
    await expect(swatches).toHaveCount(6);
    for (const [index, name] of ['Azul', 'Verde', 'Laranja', 'Rosa', 'Lilás', 'Areia'].entries())
      await expect(swatches.nth(index)).toHaveAccessibleName(name);
    await expect(page.getByRole('button', { name: 'Bola' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Azul' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Chama' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // UX-014 (WCAG 1.4.1): the chosen icon carries a check, not only its colour,
    // and only the chosen one does.
    const checks = page.getByTestId('appearance-icons').getByTestId(/^appearance-icon-.+-check$/u);
    await expect(checks).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: 'Bola' }).getByTestId('appearance-icon-ball-check'),
    ).toBeVisible();
    await expect(page.getByTestId('appearance-preview')).toContainText('Racha de Quinta');
    await expect(page.getByTestId('appearance-preview')).toContainText('3 membros');
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'icone-antes.png');

    // rev77 / BB-028: with a mouse, hovering an option or the button changes how
    // it looks, unlike the selection (fill and border of the chosen option).
    if (testInfo.project.name === 'wide-chromium') {
      const look = (name: string) =>
        page.getByRole('button', { name, exact: true }).evaluate((element) => {
          const style = getComputedStyle(element);
          return `${style.backgroundColor}|${style.borderColor}|${style.opacity}`;
        });
      for (const name of ['Chama', 'Rosa', 'Salvar ícone do grupo']) {
        await page.mouse.move(0, 0);
        const before = await look(name);
        await page.getByRole('button', { name, exact: true }).hover();
        await expect.poll(() => look(name)).not.toBe(before);
      }
      await page.mouse.move(0, 0);
    }
    await page.getByRole('button', { name: 'Chama' }).click();
    await page.getByRole('button', { name: 'Lilás' }).click();
    await expect(page.getByRole('button', { name: 'Chama' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Bola' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(checks).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: 'Chama' }).getByTestId('appearance-icon-flame-check'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lilás' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Azul' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // The card previews the choice before it is saved; nothing is written yet.
    await expect(icon(page.getByTestId('appearance-preview'), 'flame', 'lilac')).toHaveCount(1);
    const unsaved = await db.query('select icon, color from public.groups where id = $1', [
      groupId,
    ]);
    expect(unsaved.rows[0]).toEqual({ icon: 'ball', color: 'blue' });
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'icone-escolha.png');

    const saved = handledObserver(
      page.waitForResponse((item) => item.url().endsWith('/groups/set_group_appearance')),
    );
    await page.getByRole('button', { name: 'Salvar ícone do grupo', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByTestId('appearance-result')).toHaveText(
      'Ícone e cor salvos. Todos os membros já veem a nova escolha.',
    );
    const after = await db.query('select icon, color from public.groups where id = $1', [groupId]);
    expect(after.rows[0]).toEqual({ icon: 'flame', color: 'lilac' });
    await page.getByTestId('appearance-back').click();
    await page.getByTestId('settings-back').click();
    await expect(icon(page.getByTestId('group-detail-card'), 'flame', 'lilac')).toHaveCount(1);
    await page.getByTestId('group-back').click();
    await expect(icon(page.getByTestId('group-list-card'), 'flame', 'lilac')).toHaveCount(1);
    await shot(page, testInfo.project.name, 'grupos-lista.png');

    // The player sees the choice everywhere the group is drawn.
    const playerPage = await pageFor(browser, player, page);
    await expect(icon(playerPage.getByTestId('group-list-card'), 'flame', 'lilac')).toHaveCount(1);
    await playerPage.getByTestId('group-list-card').click();
    await expect(icon(playerPage.getByTestId('group-detail-card'), 'flame', 'lilac')).toHaveCount(
      1,
    );
    await shot(playerPage, testInfo.project.name, 'grupo-jogador.png');
    await playerPage
      .getByRole('navigation', { name: 'Navegação principal' })
      .getByRole('link', {
        name: 'Agenda',
      })
      .click();
    // The group screen stays mounted in the Grupos tab: count the Agenda's own cards.
    const card = playerPage
      .getByTestId('authenticated-main')
      .filter({ has: playerPage.getByRole('heading', { level: 1, name: 'Agenda' }) })
      .getByTestId('match-list-card');
    await expect(card).toHaveCount(1);
    await expect(icon(card, 'flame', 'lilac')).toHaveCount(1);
    await assertAccessible(playerPage);
    await shot(playerPage, testInfo.project.name, 'agenda-jogador.png');
    await playerPage.goto(`/rachas/${matchId}`);
    await expect(icon(playerPage.getByTestId('match-fact-group'), 'flame', 'lilac')).toHaveCount(1);

    // Someone with the code sees the chosen icon on the invitation page (0026 + 0027).
    const visitorPage = await pageFor(browser, visitor, page);
    await visitorPage.goto('/join');
    await visitorPage.getByTestId('group-code').fill(String(share['code']));
    const preview = handledObserver(
      visitorPage.waitForResponse((item) => item.url().endsWith('/groups/preview_group_by_code')),
    );
    await visitorPage.getByTestId('preview-code').click();
    const previewBody = (await (await preview).json()) as { data: Record<string, unknown> };
    expect(previewBody.data).toMatchObject({ group_icon: 'flame', group_color: 'lilac' });
    const header = visitorPage.getByTestId('invite-page-header');
    await expect(header).toContainText('Racha de Quinta');
    await expect(icon(header, 'flame', 'lilac')).toHaveCount(1);
    await shot(visitorPage, testInfo.project.name, 'convite-icone.png');

    // The organizer, after the change: list, and Criar racha from the group.
    await organizerPage.goto('/grupos');
    await expect(icon(organizerPage.getByTestId('group-list-card'), 'flame', 'lilac')).toHaveCount(
      1,
    );
    await organizerPage.getByTestId('group-list-card').click();
    await organizerPage.getByTestId('group-create-match').click();
    const fixed = organizerPage.getByTestId('match-fixed-group');
    await expect(fixed).toContainText('Racha de Quinta');
    await expect(icon(fixed, 'flame', 'lilac')).toHaveCount(1);
    await shot(organizerPage, testInfo.project.name, 'criar-racha-fixo.png');

    // rev77 / BB-017: a choice made while a save is on its way is kept as the
    // new draft, not wiped by the end of the earlier save.
    await page.goto(`/grupos/${groupId}/icone`);
    await page.getByRole('button', { name: 'Troféu' }).click();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/groups/set_group_appearance', async (route) => {
      await held;
      await route.continue();
    });
    const slow = handledObserver(
      page.waitForResponse((item) => item.url().endsWith('/groups/set_group_appearance')),
    );
    await page.getByRole('button', { name: 'Salvar ícone do grupo', exact: true }).click();
    await page.getByRole('button', { name: 'Raio' }).click();
    await expect(page.getByRole('button', { name: 'Raio' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The first save ends with a fresh read of the group's members; only after
    // it, and a rendered frame, is the screen's answer to that save settled.
    const reread = handledObserver(
      page.waitForResponse((item) => item.url().endsWith('/groups/get_group_members')),
    );
    release();
    expect((await slow).status()).toBe(200);
    expect((await reread).status()).toBe(200);
    await page.unroute('**/groups/set_group_appearance');
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await expect(page.getByText('Carregando com segurança…', { exact: true })).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await db.query('select icon from public.groups where id = $1', [groupId])).rows[0].icon,
      )
      .toBe('trophy');
    await expect(page.getByRole('button', { name: 'Raio' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Troféu' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(page.getByTestId('appearance-result')).toHaveText('');
    await page.getByRole('button', { name: 'Salvar ícone do grupo', exact: true }).click();
    await expect(page.getByTestId('appearance-result')).toHaveText(
      'Ícone e cor salvos. Todos os membros já veem a nova escolha.',
    );
    const last = await db.query('select icon, color from public.groups where id = $1', [groupId]);
    expect(last.rows[0]).toEqual({ icon: 'bolt', color: 'lilac' });

    expect(pageErrors).toEqual([]);
    await organizerPage.context().close();
    await playerPage.context().close();
    await visitorPage.context().close();
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});
