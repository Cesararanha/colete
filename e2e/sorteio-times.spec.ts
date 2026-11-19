import { beginCleanup } from './support/cleanup';
import { expect, test, type APIRequestContext, type Browser, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';

const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-sorteio-times-2026';
const prefix = `sorteio-times-${Date.now()}-${process.pid}`;
const screenshotRoot = process.env['COLETE_SORTEIO_SCREENSHOTS_DIR'];
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
      location_name: 'Arena do Sorteio',
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
    await db.query(`delete from private.match_draws where match_id in (${matches})`, [ids]);
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

/** The names in each team, in order, as the screen shows them. */
async function teamNames(page: Page) {
  const teams: string[] = [];
  for (const letter of ['A', 'B', 'C', 'D']) {
    const card = page.getByTestId(`match-team-${letter}`);
    if ((await card.count()) === 0) break;
    const players = card.locator('[data-testid^="match-team-"][data-testid*="-player-"]');
    // Only the names: the viewer's own line also says "você".
    const names = (await players.allTextContents()).map((text) => /Pessoa \S+/.exec(text)?.[0]);
    teams.push(names.join(' / '));
  }
  return teams;
}

async function drawCount(db: pg.Client, matchId: string) {
  const { rows } = await db.query(
    `select draw.id, count(member.*)::integer as members from private.match_draws draw
       left join private.match_draw_members member on member.draw_id = draw.id
      where draw.match_id = $1 group by draw.id`,
    [matchId],
  );
  return rows as { id: string; members: number }[];
}

async function rate(
  request: APIRequestContext,
  owner: Actor,
  groupId: string,
  member: Actor,
  stars: number,
) {
  await gateway(request, owner, 'set_rating', {
    group_id: groupId,
    profile_id: member.profileId,
    stars,
  });
}

async function setup(request: APIRequestContext, db: pg.Client, authIds: string[]) {
  const owner = await createActor(request, 'dona', authIds);
  const organizer = await createActor(request, 'org', authIds);
  const gk1 = await createActor(request, 'gol1', authIds, 'goalkeeper');
  const gk2 = await createActor(request, 'gol2', authIds, 'goalkeeper');
  const zag = await createActor(request, 'zag', authIds, 'defender');
  const mei = await createActor(request, 'mei', authIds, 'midfielder');
  const ana = await createActor(request, 'ana', authIds, 'forward');
  const late = await createActor(request, 'tarde', authIds, 'defender');
  const created = await gateway(request, owner, 'create_group', { name: 'Racha do Sorteio' });
  const groupId = (created['outcome'] as { group_id: string }).group_id;
  for (const [member, role] of [
    [organizer, 'organizer'],
    [gk1, 'player'],
    [gk2, 'player'],
    [zag, 'player'],
    [mei, 'player'],
    [ana, 'player'],
    [late, 'player'],
  ] as const) {
    await db.query(
      `insert into public.group_members(group_id, profile_id, role, status)
       values ($1, $2, $3, 'active')`,
      [groupId, member.profileId, role],
    );
  }
  // Notes 5, 4, 3, 2 for four of the five; gol2 stays unrated until the test rates it.
  for (const [member, stars] of [
    [gk1, 5],
    [zag, 4],
    [mei, 3],
    [ana, 2],
    [late, 3],
  ] as const) {
    await rate(request, owner, groupId, member, stars);
  }
  const matchId = await createMatch(request, owner, groupId);
  for (const member of [gk1, zag, ana, gk2, mei]) {
    await gateway(request, member, 'join_match', { match_id: matchId });
  }
  return { owner, organizer, gk1, gk2, zag, mei, ana, late, groupId, matchId };
}

test('Sorteio: the organizer draws the snake by rating, the player sees the same teams, drawing again and stale teams', async ({
  browser,
  page,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const { owner, organizer, gk1, gk2, zag, mei, ana, late, groupId, matchId } = await setup(
      request,
      db,
      authIds,
    );

    // Before any draw, the player sees no section at all.
    const anaView = await open(browser, ana, matchId);
    contexts.push(anaView.context);
    await expect(anaView.page.getByTestId('match-teams')).toHaveCount(0);

    // The organizer chooses the number of teams; the choice is aria-pressed.
    await login(page, organizer);
    await page.goto(`/rachas/${matchId}`);
    const section = page.getByTestId('match-teams');
    await expect(section.getByRole('heading', { name: 'Times', level: 2 })).toBeVisible();
    await expect(page.getByTestId('match-teams-count-2')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('match-teams-count-3')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('group', { name: 'Número de times' })).toBeVisible();
    await expect(page.getByTestId('match-unrated')).toHaveAccessibleName('1 sem nota');
    await shot(page, testInfo.project.name, '01-sorteio-antes.png');

    // rev82 / BB-013: when the server is the one asking about unequal sizes
    // (the list changed after the screen read it), closing that confirmation
    // also gives the focus back. The answer is simulated: four accounts cannot
    // reach the concurrent case here; the real one is proved in db:test:teams.
    await page.getByTestId('match-teams-count-3').click();
    await page.route('**/groups/draw_teams', (route) =>
      route.fulfill({
        status: 422,
        json: {
          error: {
            code: 'UNEQUAL_TEAMS_CONFIRMATION_REQUIRED',
            message: 'Confirme os tamanhos diferentes.',
            retryable: false,
          },
          request_id: crypto.randomUUID(),
        },
      }),
    );
    await page.getByTestId('match-teams-draw').click();
    await expect(page.getByTestId('match-teams-confirmation-heading')).toBeFocused();
    // The refusal re-reads the match first; the confirmation waits for it.
    await expect(page.getByTestId('match-teams-confirm')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.getByTestId('match-teams-keep').click();
    await expect(page.getByTestId('match-teams-confirmation')).toHaveCount(0);
    await expect(page.getByTestId('match-teams-draw')).toBeFocused();
    await page.unroute('**/groups/draw_teams');

    // Five confirmed cannot make three teams: the server says so, nothing is drawn.
    await expect(page.getByTestId('match-teams-count-3')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('match-teams-count-2')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('match-teams-draw').click();
    await expect(page.getByTestId('match-teams-draw-error')).toHaveText(
      'Para 3 times, é preciso ter pelo menos 6 confirmados.',
    );
    // The refusal re-reads the match before the action ends; until then the
    // number of teams ignores a press (a press there once kept 3 teams).
    await expect(page.getByTestId('match-teams-draw')).not.toHaveAttribute('aria-disabled', 'true');

    // Two teams of five ask for the unequal sizes first; one confirmed has no rating.
    await page.getByTestId('match-teams-count-2').click();
    await expect(page.getByTestId('match-teams-count-2')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('match-teams-draw').click();
    await expect(page.getByTestId('match-teams-confirmation-heading')).toBeFocused();
    await expect(page.getByTestId('match-teams-unequal')).toHaveText(
      'Com esse número de confirmados, um time fica com um jogador a mais. A média por jogador não compensa jogar com uma pessoa a menos.',
    );
    await shot(page, testInfo.project.name, '02-tamanhos-diferentes.png');
    await page.getByTestId('match-teams-confirm').click();
    await expect(page.getByTestId('match-teams-draw-error')).toHaveText(
      'Há confirmados sem nota. Dê a nota a todos antes de sortear.',
    );
    expect(await drawCount(db, matchId)).toEqual([]);

    // gol2 gets the lowest rating; the snake (5, 4, 3, 2, 1) gives A, B, B, A, A.
    await rate(request, owner, groupId, gk2, 1);
    await page.reload();
    await page.getByTestId('match-teams-draw').click();
    await page.getByTestId('match-teams-confirm').click();
    await expect(page.getByTestId('match-teams-result')).toHaveText('Times sorteados.');
    await expect(page.getByTestId('match-team-A-meta')).toHaveText('Colete âmbar · 3 jogadores');
    await expect(page.getByTestId('match-team-B-meta')).toHaveText('Colete azul · 2 jogadores');
    await expect(page.getByTestId('match-team-C')).toHaveCount(0);
    // Inside a team the players come by name, never in the order of the ratings;
    // both profile goalkeepers land in A, because position never enters (D8, D9).
    const drawn = await teamNames(page);
    expect(drawn).toEqual([
      [ana.name, gk1.name, gk2.name].join(' / '),
      [mei.name, zag.name].join(' / '),
    ]);
    expect(await drawCount(db, matchId)).toEqual([expect.objectContaining({ members: 5 })]);
    await expect(page.getByTestId('match-teams-draw')).toHaveCount(0);
    await expect(page.getByTestId('match-teams-redraw')).toBeVisible();
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '03-sorteio-organizador.png');

    // The player sees the same teams, in the same order, and no control nor rating.
    await anaView.page.reload();
    await expect(anaView.page.getByTestId('match-team-A')).toBeVisible();
    expect(await teamNames(anaView.page)).toEqual(drawn);
    await expect(anaView.page.getByTestId('match-teams-count')).toHaveCount(0);
    await expect(anaView.page.getByTestId('match-teams-draw')).toHaveCount(0);
    await expect(anaView.page.getByTestId('match-teams-redraw')).toHaveCount(0);
    await expect(anaView.page.getByTestId('match-unrated')).toHaveCount(0);
    await expect(anaView.page.getByTestId('match-teams')).toContainText('você');
    await expect(anaView.page.getByTestId('match-teams')).not.toContainText('Nota');
    await assertAccessible(anaView.page);
    await shot(anaView.page, testInfo.project.name, '04-sorteio-jogador.png');

    // "Sortear de novo" asks first; "Voltar" sends nothing and returns the focus.
    const [first] = await drawCount(db, matchId);
    let drawCalls = 0;
    page.on('request', (item) => {
      if (new URL(item.url()).pathname.endsWith('/groups/draw_teams')) drawCalls += 1;
    });
    await page.getByTestId('match-teams-redraw').click();
    await expect(page.getByTestId('match-teams-confirmation-heading')).toBeFocused();
    await expect(page.getByTestId('match-teams-confirmation')).toContainText(
      'Os times atuais serão substituídos.',
    );
    await shot(page, testInfo.project.name, '05-sortear-de-novo.png');
    await page.getByTestId('match-teams-keep').click();
    await expect(page.getByTestId('match-teams-confirmation')).toHaveCount(0);
    await expect(page.getByTestId('match-teams-redraw')).toBeFocused();
    expect(drawCalls).toBe(0);
    await page.getByTestId('match-teams-redraw').click();
    await page.getByTestId('match-teams-confirm').click();
    await expect(page.getByTestId('match-teams-result')).toHaveText('Times sorteados.');
    expect(drawCalls).toBe(1);
    const replaced = await drawCount(db, matchId);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.id).not.toBe(first?.id);
    // The same ratings give the same teams: nothing is random.
    expect(await teamNames(page)).toEqual(drawn);

    // A rating changed after the draw: stale for the organization, not for the player.
    // rev82 / BB-014: changed in the app itself and back to the match with no
    // reload, the cached teams are read again and say so.
    const nav = page.getByRole('navigation', { name: 'Navegação principal' });
    await nav.getByRole('link', { name: 'Grupos' }).click();
    await page.getByTestId('group-list-card').click();
    await page.getByTestId('group-ratings-link').click();
    const zagCard = page
      .getByTestId(/^rating-member-\d+$/)
      .filter({ has: page.getByRole('radiogroup', { name: `Nota de ${zag.name}`, exact: true }) });
    await zagCard.getByRole('radio', { name: '1 estrela' }).click();
    await zagCard.getByRole('button', { name: 'Salvar nota' }).click();
    await expect(zagCard.getByTestId(/-result$/)).toHaveText(`${zag.name}: nota 1.`);
    // Back through the history, as the browser's back button: no document load.
    const loads: string[] = [];
    page.on('load', () => loads.push(page.url()));
    await page.goBack();
    await page.goBack();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/rachas/${matchId}$`, 'u'));
    await expect(page.getByTestId('match-teams-stale').filter({ visible: true })).toHaveText(
      'Times desatualizados',
    );
    expect(loads).toEqual([]);
    expect(page.url()).toContain(`/rachas/${matchId}`);
    await page.reload();
    await expect(page.getByTestId('match-teams-stale')).toHaveText('Times desatualizados');
    await anaView.page.reload();
    await expect(anaView.page.getByTestId('match-team-A')).toBeVisible();
    await expect(anaView.page.getByTestId('match-teams-stale')).toHaveCount(0);

    // The list changes after the draw: Ana gives up and a late player confirms.
    await gateway(request, ana, 'leave_match', { match_id: matchId });
    await gateway(request, late, 'join_match', { match_id: matchId });
    await page.reload();
    await expect(page.getByTestId('match-teams-stale')).toHaveText('Times desatualizados');
    await expect(page.getByTestId('match-team-none')).toContainText('Sem time');
    await expect(page.getByTestId('match-team-none')).toContainText(late.name);
    await expect(page.getByTestId('match-team-A')).not.toContainText(ana.name);
    await expect(page.getByTestId('match-team-B')).not.toContainText(ana.name);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '06-times-desatualizados.png');
    await anaView.page.reload();
    await expect(anaView.page.getByTestId('match-teams-stale')).toHaveText('Times desatualizados');
    await expect(anaView.page.getByTestId('match-teams-redraw')).toHaveCount(0);

    // Drawing again brings everyone up to date; five again, so the sizes are confirmed too.
    await page.getByTestId('match-teams-redraw').click();
    await expect(page.getByTestId('match-teams-unequal')).toBeVisible();
    await page.getByTestId('match-teams-confirm').click();
    await expect(page.getByTestId('match-teams-result')).toHaveText('Times sorteados.');
    await expect(page.getByTestId('match-teams-stale')).toHaveCount(0);
    await expect(page.getByTestId('match-team-none')).toHaveCount(0);
    expect((await teamNames(page)).join(' / ')).toContain(late.name);
  } finally {
    for (const context of contexts) await context.close();
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('Sorteio: a player never gets the controls, and a forced call through the Edge is refused', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const { owner, gk2, ana, groupId, matchId } = await setup(request, db, authIds);
    await rate(request, owner, groupId, gk2, 1);
    const stranger = await createActor(request, 'fora', authIds);
    await login(page, ana);
    await page.goto(`/rachas/${matchId}`);
    await expect(page.getByTestId('match-presence')).toBeVisible();
    await expect(page.getByTestId('match-teams')).toHaveCount(0);
    await expect(page.getByTestId('match-teams-draw')).toHaveCount(0);

    // Straight to the Edge: the player is not an organizer; outside the group,
    // the match answers like one that does not exist.
    const body = { match_id: matchId, team_count: 2, confirm_unequal_sizes: true };
    const forced = await call(request, ana, 'draw_teams', body);
    expect(forced.status).toBe(403);
    expect((forced.body['error'] as { code: string }).code).toBe('NOT_ORGANIZER');
    const outside = await call(request, stranger, 'draw_teams', body);
    const unknown = await call(request, stranger, 'draw_teams', {
      ...body,
      match_id: crypto.randomUUID(),
    });
    expect(outside.status).toBe(404);
    expect(outside.body['error']).toEqual(unknown.body['error']);
    expect(await drawCount(db, matchId)).toEqual([]);

    // After the owner draws, the player reads the teams, still without controls;
    // a canceled match shows no teams and refuses the draw.
    await gateway(request, owner, 'draw_teams', body);
    await page.reload();
    await expect(page.getByTestId('match-team-A')).toBeVisible();
    await expect(page.getByTestId('match-teams-redraw')).toHaveCount(0);
    await gateway(request, owner, 'cancel_match', { match_id: matchId });
    await page.reload();
    await expect(page.getByTestId('match-viewer-chip')).toHaveText('Cancelado');
    await expect(page.getByTestId('match-teams')).toHaveCount(0);
    const canceled = await call(request, owner, 'draw_teams', body);
    expect(canceled.status).toBe(409);
    expect((canceled.body['error'] as { code: string }).code).toBe('MATCH_CANCELED');
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});
