import { beginCleanup } from './support/cleanup';
import { expect, test, type APIRequestContext, type Browser, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';

const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-notas-2026';
const prefix = `notas-${Date.now()}-${process.pid}`;
const screenshotRoot = process.env['COLETE_NOTAS_SCREENSHOTS_DIR'];
const ZONE = 'America/Sao_Paulo';
type Actor = { authId: string; profileId: string; token: string; email: string; name: string };

test.use({ timezoneId: ZONE, colorScheme: 'dark' });

/** Captures at 390 px, the width of the prévia, then restore the project viewport. */
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
    data: { request_id: crypto.randomUUID(), profile: { name, position } },
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

async function call(
  request: APIRequestContext,
  actor: Actor,
  operation: string,
  data: Record<string, unknown>,
) {
  const response = await request.post(`${env.functionsUrl}/groups/${operation}`, {
    data: { request_id: crypto.randomUUID(), ...data },
    headers: { Authorization: `Bearer ${actor.token}` },
  });
  return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
}

async function gateway(
  request: APIRequestContext,
  actor: Actor,
  operation: string,
  data: Record<string, unknown>,
) {
  const response = await call(request, actor, operation, data);
  expect(response.status, `${operation}: ${JSON.stringify(response.body)}`).toBe(200);
  return response.body['data'] as Record<string, unknown>;
}

async function createMatch(request: APIRequestContext, owner: Actor, groupId: string) {
  const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 2 * 86_400_000);
  const created = await gateway(request, owner, 'create_match', {
    group_id: groupId,
    config: {
      starts_at: start.toISOString(),
      ends_at: new Date(start.getTime() + 90 * 60_000).toISOString(),
      timezone: ZONE,
      location_name: 'Arena das Notas',
      location_address: null,
      description: null,
      latitude: null,
      longitude: null,
      field_slots: 10,
      field_price: '15.00',
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
  const matches = `select id from private.matches where group_id in (${groups})`;
  await beginCleanup(db, ids);
  try {
    await db.query('delete from private.idempotency_records where actor_id = any($1::uuid[])', [
      ids,
    ]);
    await db.query(`delete from private.ratings where group_id in (${groups})`, [ids]);
    await db.query(`delete from private.rating_history where group_id in (${groups})`, [ids]);
    await db.query(
      `delete from private.match_players where profile_id = any($1::uuid[]) or match_id in
         (${matches})`,
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

async function setup(request: APIRequestContext, db: pg.Client, authIds: string[]) {
  const owner = await createActor(request, 'dona', authIds);
  const organizer = await createActor(request, 'org', authIds);
  const ana = await createActor(request, 'ana', authIds, 'forward');
  const bia = await createActor(request, 'bia', authIds, 'defender');
  const stranger = await createActor(request, 'fora', authIds);
  const created = await gateway(request, owner, 'create_group', { name: 'Grupo das Notas' });
  const groupId = (created['outcome'] as { group_id: string }).group_id;
  for (const [member, role] of [
    [organizer, 'organizer'],
    [ana, 'player'],
    [bia, 'player'],
  ] as const) {
    await db.query(
      `insert into public.group_members(group_id, profile_id, role, status)
       values ($1, $2, $3, 'active')`,
      [groupId, member.profileId, role],
    );
  }
  return { owner, organizer, ana, bia, stranger, groupId };
}

/** A member's card, found by its 1–5 group: names also appear in "Alterada por". */
function memberCard(page: Page, name: string) {
  return page
    .getByTestId(/^rating-member-\d+$/)
    .filter({ has: page.getByRole('radiogroup', { name: `Nota de ${name}`, exact: true }) });
}

test('Notas: the organization rates, a player sees only their own, and the owner can show them to members', async ({
  browser,
  page,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const { owner, organizer, ana, bia, stranger, groupId } = await setup(request, db, authIds);

    // The organizer: no own rating yet, four members without one, and the screen.
    await login(page, organizer);
    await page.goto(`/grupos/${groupId}`);
    await expect(page.getByTestId('group-my-rating-value')).toHaveText(
      'Você ainda não tem nota neste grupo.',
    );
    await expect(page.getByTestId('group-unrated')).toHaveText('4 sem nota');
    await page.getByTestId('group-ratings-link').click();
    await expect(
      page.getByRole('heading', { name: 'Notas dos jogadores', level: 1 }),
    ).toBeVisible();
    await expect(page.getByTestId('ratings-visibility')).toHaveText(
      'As notas são privadas neste grupo.',
    );
    await expect(page.getByTestId('ratings-missing')).toHaveText(
      '4 sem nota — o sorteio não roda sem isso.',
    );
    await shot(page, testInfo.project.name, '01-notas-sem-nota.png');

    // Choosing is a draft: arrows move the choice and send nothing.
    let rateCalls = 0;
    page.on('request', (item) => {
      if (new URL(item.url()).pathname.endsWith('/groups/set_rating')) rateCalls += 1;
    });
    const anaCard = memberCard(page, ana.name);
    const anaGroup = anaCard.getByRole('radiogroup', { name: `Nota de ${ana.name}` });
    await anaGroup.getByRole('radio', { name: '1 estrela' }).focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(anaGroup.getByRole('radio', { name: '4 estrelas' })).toBeFocused();
    await expect(anaGroup.getByRole('radio', { name: '4 estrelas' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(rateCalls).toBe(0);
    await anaCard.getByRole('button', { name: 'Salvar nota' }).click();
    await expect(anaCard.getByTestId(/-result$/)).toHaveText(`${ana.name}: nota 4.`);
    await expect(memberCard(page, ana.name).getByTestId(/-stars$/)).toHaveText('Nota 4');
    await expect(memberCard(page, ana.name).getByTestId(/-changed$/)).toContainText(
      `Alterada por ${organizer.name} em`,
    );
    expect(rateCalls).toBe(1);
    // The organizer rates themself too; the count drops.
    const selfCard = memberCard(page, organizer.name);
    await selfCard.getByRole('radio', { name: '5 estrelas' }).click();
    await selfCard.getByRole('button', { name: 'Salvar nota' }).click();
    await expect(memberCard(page, organizer.name).getByTestId(/-stars$/)).toHaveText('Nota 5');
    await expect(page.getByTestId('ratings-missing')).toHaveText(
      '2 sem nota — o sorteio não roda sem isso.',
    );
    const versions = await db.query(
      `select old_stars, new_stars, changed_by from private.rating_history
        where group_id = $1 and profile_id = $2`,
      [groupId, ana.profileId],
    );
    expect(versions.rows).toEqual([
      { old_stars: null, new_stars: 4, changed_by: organizer.profileId },
    ]);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '02-notas-organizador.png');

    // Ana sees her own rating and nothing of the others, and gets no tool.
    const anaView = await browser.newContext({ timezoneId: ZONE, colorScheme: 'dark' });
    contexts.push(anaView);
    const anaPage = await anaView.newPage();
    await login(anaPage, ana);
    await anaPage.goto(`/grupos/${groupId}`);
    await expect(anaPage.getByTestId('group-my-rating-value')).toHaveText(
      'Sua nota neste grupo: 4 de 5',
    );
    await expect(anaPage.getByTestId('group-ratings-link')).toHaveCount(0);
    await expect(anaPage.getByTestId('group-members-list')).not.toContainText('Nota');
    await assertAccessible(anaPage);
    await shot(anaPage, testInfo.project.name, '03-minha-nota.png');

    // Straight to the Edge: a player and a stranger are refused, nothing changes.
    const forced = await call(request, ana, 'set_rating', {
      group_id: groupId,
      profile_id: bia.profileId,
      stars: 5,
    });
    expect(forced.status).toBe(403);
    expect((forced.body['error'] as { code: string }).code).toBe('NOT_ORGANIZER');
    const outside = await call(request, stranger, 'set_rating', {
      group_id: groupId,
      profile_id: bia.profileId,
      stars: 5,
    });
    expect(outside.status).toBe(403);
    expect((outside.body['error'] as { code: string }).code).toBe('NOT_MEMBER');
    const ratingsRead = await request.post(`${env.functionsUrl}/groups/get_group_ratings`, {
      data: { group_id: groupId },
      headers: { Authorization: `Bearer ${ana.token}` },
    });
    expect(((await ratingsRead.json()) as { data: { members: unknown } }).data.members).toBeNull();
    const biaRating = await db.query(
      'select count(*)::integer as n from private.ratings where group_id = $1 and profile_id = $2',
      [groupId, bia.profileId],
    );
    expect(biaRating.rows[0].n).toBe(0);

    // The owner shows the ratings to members after confirming in place.
    const ownerView = await browser.newContext({ timezoneId: ZONE, colorScheme: 'dark' });
    contexts.push(ownerView);
    const ownerPage = await ownerView.newPage();
    await login(ownerPage, owner);
    await ownerPage.goto(`/grupos/${groupId}/configuracoes`);
    await expect(ownerPage.getByTestId('ratings-visibility-private')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    let visibilityCalls = 0;
    ownerPage.on('request', (item) => {
      if (new URL(item.url()).pathname.endsWith('/groups/set_ratings_visibility')) {
        visibilityCalls += 1;
      }
    });
    await ownerPage.getByTestId('ratings-visibility-members').click();
    await expect(ownerPage.getByTestId('ratings-visibility-confirmation-heading')).toBeFocused();
    await expect(ownerPage.getByTestId('ratings-visibility-confirmation')).toContainText(
      'Todos os membros ativos vão ver a nota atual de cada um.',
    );
    await shot(ownerPage, testInfo.project.name, '04-mostrar-notas.png');
    await ownerPage.getByTestId('ratings-visibility-keep').click();
    await expect(ownerPage.getByTestId('ratings-visibility-members')).toBeFocused();
    expect(visibilityCalls).toBe(0);
    await ownerPage.getByTestId('ratings-visibility-members').click();
    await ownerPage.getByTestId('ratings-visibility-confirm').click();
    await expect(ownerPage.getByTestId('ratings-visibility-result')).toHaveText(
      'As notas agora estão visíveis para os membros.',
    );
    await expect(ownerPage.getByTestId('ratings-visibility-members')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(visibilityCalls).toBe(1);

    // Now Ana sees the current ratings in the member list, never who or when.
    await anaPage.reload();
    const list = anaPage.getByTestId('group-members-list');
    await expect(list.getByRole('listitem').filter({ hasText: organizer.name })).toContainText(
      'Nota 5',
    );
    await expect(list.getByRole('listitem').filter({ hasText: bia.name })).toContainText(
      'Sem nota',
    );
    await expect(list).not.toContainText('Alterada');
    await assertAccessible(anaPage);
    await shot(anaPage, testInfo.project.name, '05-notas-visiveis.png');
  } finally {
    for (const context of contexts) await context.close();
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('Notas: the match shows who still has no rating to the organization only', async ({
  browser,
  page,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const { owner, organizer, ana, bia, groupId } = await setup(request, db, authIds);
    await gateway(request, organizer, 'set_rating', {
      group_id: groupId,
      profile_id: ana.profileId,
      stars: 3,
    });
    const matchId = await createMatch(request, owner, groupId);
    for (const member of [ana, bia]) {
      await gateway(request, member, 'join_match', { match_id: matchId });
    }
    const { page: anaPage, context } = await open(browser, ana, matchId);
    contexts.push(context);
    await expect(anaPage.getByTestId('match-confirmed-0')).toBeVisible();
    await expect(anaPage.getByTestId('match-unrated')).toHaveCount(0);

    await login(page, organizer);
    await page.goto(`/rachas/${matchId}`);
    // The button's icon glyph is part of its text; its name is the count alone.
    await expect(page.getByTestId('match-unrated')).toHaveAccessibleName('1 sem nota');
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '06-racha-sem-nota.png');
    await page.getByTestId('match-unrated').click();
    await expect(
      page.getByRole('heading', { name: 'Notas dos jogadores', level: 1 }),
    ).toBeVisible();
    const biaCard = memberCard(page, bia.name);
    await biaCard.getByRole('radio', { name: '2 estrelas' }).click();
    await biaCard.getByRole('button', { name: 'Salvar nota' }).click();
    await expect(memberCard(page, bia.name).getByTestId(/-stars$/)).toHaveText('Nota 2');
    await page.goto(`/rachas/${matchId}`);
    await expect(page.getByTestId('match-confirmed-1')).toBeVisible();
    await expect(page.getByTestId('match-unrated')).toHaveCount(0);
  } finally {
    for (const context of contexts) await context.close();
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('Notas: an untouched card follows another session, and a removed organizer loses the projection', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const { owner, organizer, ana, bia, groupId } = await setup(request, db, authIds);
    await gateway(request, owner, 'set_rating', {
      group_id: groupId,
      profile_id: ana.profileId,
      stars: 4,
    });
    await login(page, organizer);
    await page.goto(`/grupos/${groupId}/notas`);
    const anaGroup = () =>
      memberCard(page, ana.name).getByRole('radiogroup', { name: `Nota de ${ana.name}` });
    await expect(anaGroup().getByRole('radio', { name: '4 estrelas' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // rev83 / BB-003: another session changes Ana to 2; a later read moves her
    // untouched card along, with nothing to save.
    await gateway(request, owner, 'set_rating', {
      group_id: groupId,
      profile_id: ana.profileId,
      stars: 2,
    });
    const biaCard = memberCard(page, bia.name);
    await biaCard.getByRole('radio', { name: '3 estrelas' }).click();
    await biaCard.getByRole('button', { name: 'Salvar nota' }).click();
    await expect(biaCard.getByTestId(/-result$/)).toHaveText(`${bia.name}: nota 3.`);
    await expect(memberCard(page, ana.name).getByTestId(/-stars$/)).toHaveText('Nota 2');
    await expect(anaGroup().getByRole('radio', { name: '2 estrelas' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(
      memberCard(page, ana.name).getByRole('button', { name: 'Salvar nota' }),
    ).toHaveCount(0);
    // A saved card follows the server too: nothing left to save for Bia.
    await expect(biaCard.getByRole('button', { name: 'Salvar nota' })).toHaveCount(0);

    // rev83 / BB-004: the owner removes the organizer; the refused save drops
    // the private ratings, their authors and the controls from the open screen.
    await gateway(request, owner, 'remove_member', {
      group_id: groupId,
      profile_id: organizer.profileId,
      reason: 'Ajuste sintético',
    });
    await anaGroup().getByRole('radio', { name: '5 estrelas' }).click();
    await memberCard(page, ana.name).getByRole('button', { name: 'Salvar nota' }).click();
    await expect(page.getByTestId('ratings-error')).toBeVisible();
    await expect(page.getByTestId(/^rating-member-\d+$/)).toHaveCount(0);
    await expect(page.getByText('Nota 2')).toHaveCount(0);
    await expect(page.getByText(`Alterada por ${owner.name}`, { exact: false })).toHaveCount(0);
    const stored = await db.query(
      'select stars from private.ratings where group_id = $1 and profile_id = $2',
      [groupId, ana.profileId],
    );
    expect(stored.rows).toEqual([{ stars: 2 }]);
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});
