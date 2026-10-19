import { expect, test, type APIRequestContext, type Browser, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';

// PR J (item 1 do feedback do César, 19/10/2026): only the active owner
// deletes the group, from the end of Configurações, typing its name; it is
// final. Every member then loses it: a group screen, refreshed, says it was
// not found and goes back to Grupos; the Agenda drops its matches. The
// organizer has no way to it, and a forced call through the Edge is refused.
// The memberships stop counting towards the five active groups.

const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-apagar-grupo-2026';
const prefix = `apagar-grupo-${Date.now()}-${process.pid}`;
const screenshotRoot = process.env['COLETE_APAGAR_SCREENSHOTS_DIR'];
const ZONE = 'America/Sao_Paulo';
type Actor = { authId: string; profileId: string; token: string; email: string; name: string };

test.use({ timezoneId: ZONE, colorScheme: 'dark' });

/** Captures are 390 wide: resize to it, then restore the project viewport. */
async function shot(page: Page, project: string, file: string) {
  if (project !== 'mobile-chromium' || !screenshotRoot || !existsSync(screenshotRoot)) return;
  const previous = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
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

/** A group with its code, and the given members approved through the Edge. */
async function groupWith(request: APIRequestContext, owner: Actor, name: string, members: Actor[]) {
  const created = await gateway(request, owner, 'create_group', { name });
  const { group_id: groupId, invite_id: inviteId } = created['outcome'] as {
    group_id: string;
    invite_id: string;
  };
  const share = await gateway(request, owner, 'get_invite_share_link', { invite_id: inviteId });
  for (const actor of members) {
    await gateway(request, actor, 'join_by_code', { code: share['code'] });
    await gateway(request, owner, 'approve_member', {
      group_id: groupId,
      profile_id: actor.profileId,
      approve: true,
    });
  }
  return { groupId, code: String(share['code']) };
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
    await db.query(`delete from private.group_deletions where group_id in (${groups})`, [ids]);
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

/** Back on Grupos, with the one line that says the group is not there. */
async function expectGone(page: Page, groupName: string) {
  await expect(page).toHaveURL(/\/grupos\?missing=1$/u);
  await expect(page.getByTestId('group-missing-status')).toHaveText('Grupo não encontrado.');
  await expect(page.getByRole('heading', { level: 2, name: groupName })).toHaveCount(0);
}

test('the owner deletes the group; members lose it; the organizer has no way to it', async ({
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
    const { groupId } = await groupWith(request, owner, 'Pelada de Terça', [organizer, player]);
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

    // Forced calls through the Edge: organizer and player get the standard
    // refusal; nothing is closed.
    for (const actor of [organizer, player]) {
      const refused = await call(request, actor, 'delete_group', { group_id: groupId });
      expect(refused.status).toBe(403);
      expect(refused.body['error']['code']).toBe('OWNER_ONLY');
    }
    const unauthenticated = await request.post(`${env.functionsUrl}/groups/delete_group`, {
      data: { request_id: crypto.randomUUID(), group_id: groupId },
    });
    expect(unauthenticated.status()).toBe(401);
    const untouched = await db.query(
      `select archived_at, (select count(*)::integer from private.group_deletions
         where group_id = $1) as closed from public.groups where id = $1`,
      [groupId],
    );
    expect(untouched.rows[0]).toEqual({ archived_at: null, closed: 0 });

    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      if (!error.message.includes('Minified React error #418')) pageErrors.push(error.message);
    });

    // The organizer reaches Configurações but sees no "Apagar grupo".
    const organizerPage = await pageFor(browser, organizer, page);
    await organizerPage.goto(`/grupos/${groupId}/configuracoes`);
    await expect(organizerPage.getByTestId('group-settings-card')).toBeVisible();
    await expect(organizerPage.getByTestId('settings-role')).toHaveText('Organizador');
    await expect(organizerPage.getByTestId('group-delete-section')).toHaveCount(0);
    await expect(organizerPage.getByRole('button', { name: 'Apagar grupo' })).toHaveCount(0);
    await shot(organizerPage, testInfo.project.name, 'configuracoes-organizador.png');

    // The player has the group and its match open.
    const playerPage = await pageFor(browser, player, page);
    await playerPage.goto(`/grupos/${groupId}`);
    await expect(
      playerPage.getByRole('heading', { level: 1, name: 'Pelada de Terça' }),
    ).toBeVisible();
    await expect(playerPage.getByTestId('match-list-card')).toHaveCount(1);

    // The owner: Configurações, the destructive action last.
    await login(page, owner);
    await page.goto(`/grupos/${groupId}/configuracoes`);
    await expect(page.getByTestId('group-settings-card')).toBeVisible();
    const open = page.getByTestId('group-delete');
    await expect(open).toHaveAccessibleName('Apagar grupo');
    await shot(page, testInfo.project.name, 'configuracoes-dono.png');
    await open.click();
    const confirmation = page.getByTestId('group-delete-confirmation');
    await expect(
      confirmation.getByRole('heading', { level: 2, name: 'Apagar Pelada de Terça?' }),
    ).toBeFocused();
    await expect(confirmation).toContainText(
      'Ninguém mais vai acessar o grupo e os rachas futuros serão cancelados.',
    );
    const typed = confirmation.getByLabel('Nome do grupo');
    const confirm = page.getByTestId('group-delete-confirm');
    await expect(confirm).toHaveAttribute('aria-disabled', 'true');
    // A wrong name keeps the button locked: pressing it sends nothing.
    let sent = 0;
    page.on('request', (item) => {
      if (item.url().endsWith('/groups/delete_group')) sent += 1;
    });
    await typed.fill('Pelada de Quarta');
    await expect(confirm).toHaveAttribute('aria-disabled', 'true');
    // Forced past the actionability check: the press itself must send nothing.
    await confirm.click({ force: true });
    await typed.press('Enter');
    await page.waitForTimeout(300);
    expect(sent).toBe(0);
    // "Cancelar" closes it, gives the focus back and clears the field.
    await page.getByTestId('group-delete-keep').click();
    await expect(open).toBeFocused();
    await open.click();
    await expect(page.getByTestId('group-delete-name')).toHaveValue('');
    await page.getByTestId('group-delete-name').fill('pelada de terça');
    await expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'apagar-confirmacao.png');
    const deleted = handledObserver(
      page.waitForResponse((item) => item.url().endsWith('/groups/delete_group')),
    );
    await confirm.click();
    expect((await deleted).status()).toBe(200);
    expect(sent).toBe(1);
    await expect(page).toHaveURL(/\/grupos\?deleted=1$/u);
    await expect(page.getByTestId('group-deleted-status')).toHaveText('Grupo apagado.');
    await expect(page.getByRole('heading', { level: 2, name: 'Pelada de Terça' })).toHaveCount(0);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'grupo-apagado.png');
    const closed = await db.query(
      `select g.archived_at is not null as archived,
              (select count(*)::integer from private.group_deletions d where d.group_id = g.id) as closed,
              (select canceled_at is not null from private.matches where id = $2) as canceled
         from public.groups g where g.id = $1`,
      [groupId, matchId],
    );
    expect(closed.rows[0]).toEqual({ archived: true, closed: 1, canceled: true });
    // The owner, too, gets the not-found by address.
    await page.goto(`/grupos/${groupId}/configuracoes`);
    await expectGone(page, 'Pelada de Terça');

    // The player refreshes the open group: not found, back to Grupos.
    await playerPage.reload();
    await expectGone(playerPage, 'Pelada de Terça');
    await shot(playerPage, testInfo.project.name, 'grupo-nao-encontrado.png');
    await playerPage
      .getByRole('navigation', { name: 'Navegação principal' })
      .getByRole('link', { name: 'Agenda' })
      .click();
    await expect(playerPage.getByRole('heading', { level: 1, name: 'Agenda' })).toBeVisible();
    await expect(
      playerPage
        .getByTestId('authenticated-main')
        .filter({ has: playerPage.getByRole('heading', { level: 1, name: 'Agenda' }) })
        .getByTestId('match-list-card'),
    ).toHaveCount(0);
    await playerPage.goto(`/rachas/${matchId}`);
    await expect(playerPage.getByText('Racha não encontrado')).toBeVisible();

    // The organizer still had Configurações open: "Atualizar dados" goes back.
    await organizerPage.getByTestId('settings-refresh').click();
    await expectGone(organizerPage, 'Pelada de Terça');
    for (const route of ['', '/membros', '/convites']) {
      await organizerPage.goto(`/grupos/${groupId}${route}`);
      await expectGone(organizerPage, 'Pelada de Terça');
    }

    expect(pageErrors).toEqual([]);
    await organizerPage.context().close();
    await playerPage.context().close();
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('a member of five groups joins another once one of them is deleted', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'five-owner', 'Edu Dono', authIds);
    const other = await createActor(request, 'other-owner', 'Fabi Dona', authIds);
    const member = await createActor(request, 'member', 'Gil Cinco', authIds);
    const groups = [];
    for (const name of ['Grupo Um', 'Grupo Dois', 'Grupo Três', 'Grupo Quatro', 'Grupo Cinco'])
      groups.push(await groupWith(request, owner, name, [member]));
    const target = await groupWith(request, other, 'Grupo Seis', []);

    await login(page, member);
    await expect(page.getByTestId('group-list-card')).toHaveCount(5);
    await page.goto('/join');
    await page.getByTestId('group-code').fill(target.code);
    await page.getByTestId('preview-code').click();
    await expect(page.getByTestId('invite-page-header')).toContainText('Grupo Seis');
    await expect(
      page.getByText('Você chegou ao limite de cinco grupos ativos', { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pedir para entrar' })).toHaveCount(0);
    await shot(page, testInfo.project.name, 'limite-antes.png');

    await gateway(request, owner, 'delete_group', { group_id: groups[0]!.groupId });

    await page.goto('/grupos');
    await expect(page.getByTestId('group-list-card')).toHaveCount(4);
    await page.goto('/join');
    await page.getByTestId('group-code').fill(target.code);
    await page.getByTestId('preview-code').click();
    await expect(page.getByTestId('invite-page-header')).toContainText('Grupo Seis');
    const joined = handledObserver(
      page.waitForResponse((item) => item.url().endsWith('/groups/join_by_code')),
    );
    await page.getByRole('button', { name: 'Pedir para entrar' }).click();
    expect((await joined).status()).toBe(200);
    await expect(page.getByTestId('group-request-sent')).toBeVisible();
    await expect(page.getByTestId('pending-group-card')).toContainText('Grupo Seis');
    await shot(page, testInfo.project.name, 'limite-depois.png');
    await gateway(request, other, 'approve_member', {
      group_id: target.groupId,
      profile_id: member.profileId,
      approve: true,
    });
    await page.reload();
    await expect(page.getByTestId('group-list-card')).toHaveCount(5);
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});
