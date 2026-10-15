import { expect, test, type APIRequestContext, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';

const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-rachas-test-2026';
const prefix = `rachas-${Date.now()}-${process.pid}`;
const screenshotRoot = process.env['COLETE_RACHAS_SCREENSHOTS_DIR'];
const ZONE = 'America/Sao_Paulo';
type Actor = { authId: string; profileId: string; token: string; email: string };

// The device the form reads its wall clock from: São Paulo, and a fixed place.
test.use({ timezoneId: ZONE, colorScheme: 'dark' });

async function shot(page: Page, project: string, file: string) {
  if (project !== 'mobile-chromium' || !screenshotRoot || !existsSync(screenshotRoot)) return;
  await page.screenshot({ path: path.join(screenshotRoot, file), fullPage: true });
}

async function createActor(request: APIRequestContext, label: string, authIds: string[]) {
  const email = `${prefix}-${label}@colete.test`;
  const { id } = await createVerifiedUser(request, env, {
    email,
    name: `Pessoa ${label}`,
    password,
  });
  authIds.push(id);
  const signed = await request.post(`${env.apiUrl}/auth/v1/token?grant_type=password`, {
    data: { email, password },
    headers: { apikey: env.publishableKey },
  });
  expect(signed.status()).toBe(200);
  const session = (await signed.json()) as { access_token: string };
  const profiled = await request.post(`${env.functionsUrl}/identity/complete_profile`, {
    data: { request_id: crypto.randomUUID(), profile: { name: `Pessoa ${label}` } },
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  expect(profiled.status()).toBe(200);
  const profile = (await profiled.json()) as { data: { outcome: { profile_id: string } } };
  return {
    authId: id,
    profileId: profile.data.outcome.profile_id,
    token: session.access_token,
    email,
  } satisfies Actor;
}

async function createGroup(request: APIRequestContext, owner: Actor, name: string) {
  const response = await request.post(`${env.functionsUrl}/groups/create_group`, {
    data: { request_id: crypto.randomUUID(), name },
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { outcome: { group_id: string } } }).data.outcome
    .group_id;
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

/**
 * After a "Voltar", exactly one parent screen is mounted (hidden stack
 * screens stay in the DOM, so a stacked second parent would count twice),
 * the child is gone and the app keeps one tab bar.
 */
async function expectOneParent(page: Page, parentTestId: string, childTestId: string) {
  await expect(page.locator(`[data-testid="${parentTestId}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-testid="${childTestId}"]`)).toHaveCount(0);
  await expect(page.locator('[aria-label="Navegação principal"]')).toHaveCount(1);
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

/** Tomorrow in São Paulo, as the person types it: DD/MM/AAAA. */
function tomorrowInZone(): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: ZONE,
    year: 'numeric',
  }).format(new Date(Date.now() + 86_400_000));
  return parts;
}

async function fillMatch(page: Page, date: string) {
  await page.getByTestId('match-date').fill(date);
  await page.getByTestId('match-startTime').fill('19:30');
  await page.getByTestId('match-endTime').fill('21:00');
  await page.getByTestId('match-locationName').fill('Arena da Vila');
  await page.getByTestId('match-locationAddress').fill('Rua das Flores, 100');
  await page.getByTestId('match-slots').fill('14');
  await page.getByTestId('match-price').fill('25,50');
}

test('Rachas: tabs, modal creation with confirmed GPS, list and detail with real numbers', async ({
  page,
  request,
  browser,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    expect((await db.query('select count(*)::integer as n from auth.users')).rows[0].n).toBe(0);
    const owner = await createActor(request, 'owner', authIds);
    const player = await createActor(request, 'player', authIds);
    const groupId = await createGroup(request, owner, 'Racha de Quinta');
    await db.query(
      `insert into public.group_members(group_id, profile_id, role, status)
       values ($1, $2, 'player', 'active')`,
      [groupId, player.profileId],
    );
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({ latitude: -23.550519, longitude: -46.633309 });

    // Real tabs: three entries, Rachas among them.
    await login(page, owner);
    const navigation = page.getByRole('navigation', { name: 'Navegação principal' });
    await expect(navigation.getByRole('link')).toHaveCount(3);
    for (const [index, name] of ['Grupos', 'Rachas', 'Perfil'].entries()) {
      await expect(navigation.getByRole('link').nth(index)).toHaveAccessibleName(name);
    }
    await navigation.getByRole('link', { name: 'Rachas' }).click();
    await expect(page).toHaveURL(/\/rachas$/);
    // The active tab is announced as the current page; the others are not.
    await expect(navigation.getByRole('link', { name: 'Rachas' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(navigation.locator('[aria-current]')).toHaveCount(1);
    await expect(navigation.locator('[aria-selected]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Rachas', level: 1 })).toBeVisible();
    await expect(page.getByText('Nenhum racha marcado')).toBeVisible();
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '01-rachas-vazio.png');

    // The modal: refuses an empty form field by field, before any request.
    let gatewayCalls = 0;
    page.on('request', (item) => {
      if (new URL(item.url()).pathname.endsWith('/groups/create_match')) gatewayCalls += 1;
    });
    await page.getByRole('button', { name: 'Criar racha' }).click();
    await expect(page).toHaveURL(/\/criar-racha$/);
    await expect(page.getByRole('heading', { name: 'Criar racha', level: 1 })).toBeVisible();
    await expect(navigation).toHaveCount(0);
    await page.getByTestId('match-create-submit').click();
    await expect(page.getByText('Informe uma data válida no formato DD/MM/AAAA.')).toBeVisible();
    await expect(page.getByText('Informe de 1 a 99 vagas.')).toBeVisible();
    expect(gatewayCalls).toBe(0);

    // GPS granted: the rounded position is shown and kept only after confirmation.
    await fillMatch(page, tomorrowInZone());
    await page.getByTestId('match-locate').click();
    await expect(page.getByTestId('match-location-found')).toContainText('-23,5505, -46,6333');
    await page.getByTestId('match-location-confirm').click();
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '02-criar-racha-gps.png');
    const created = handledObserver(
      page.waitForResponse((item) => new URL(item.url()).pathname.endsWith('/groups/create_match')),
    );
    await page.getByTestId('match-create-submit').click();
    const response = await created;
    expect(response.status()).toBe(200);
    const sent = response.request().postDataJSON() as {
      group_id: string;
      config: Record<string, unknown>;
    };
    expect(sent.group_id).toBe(groupId);
    expect(sent.config['latitude']).toBe(-23.5505);
    expect(sent.config['longitude']).toBe(-46.6333);
    expect(sent.config['timezone']).toBe(ZONE);

    // Detail: the scoreboard shows the real start and slots from the database.
    await expect(page).toHaveURL(/\/rachas\/[0-9a-f-]{36}$/);
    const matchUrl = new URL(page.url()).pathname;
    await expect(page.getByRole('heading', { name: 'Arena da Vila', level: 1 })).toBeVisible();
    await expect(page.getByTestId('match-create-submit')).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'Começa às 19:30, 14 vagas' })).toBeVisible();
    await expect(page.getByTestId('match-fact-when')).toContainText('das 19:30 às 21:00');
    await expect(page.getByTestId('match-fact-price')).toContainText('R$ 25,50');
    await expect(page.getByTestId('match-fact-group')).toContainText('Racha de Quinta');
    const row = (
      await db.query(
        `select latitude::text, longitude::text, field_slots, field_price::text, timezone,
           to_char(starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') as start
         from private.matches where group_id = $1`,
        [groupId],
      )
    ).rows;
    expect(row).toEqual([
      {
        latitude: '-23.5505',
        longitude: '-46.6333',
        field_slots: 14,
        field_price: '25.50',
        timezone: ZONE,
        start: '19:30',
      },
    ]);
    // Human decision of 15/10/2026 (review of #70, P1-2): the coordinates reach
    // Google Maps only at the press, only as the search, in a noopener and
    // noreferrer tab, under a label that names Google Maps.
    const map = page.getByTestId('match-map');
    await expect(map).toHaveAccessibleName('Abrir no Google Maps');
    await expect(
      page.getByText('Abre o Google Maps fora do Colete.', { exact: false }),
    ).toBeVisible();
    expect(
      await page
        .locator(
          '[href*="/maps"], [href*="23.5505"], [href*="23,5505"], [href*="46.6333"], [href*="46,6333"]',
        )
        .count(),
    ).toBe(0);
    expect(page.url()).not.toMatch(/23[.,]5505|46[.,]6333/);
    const mapsRequests: string[] = [];
    page.on('request', (item) => {
      if (/google|maps/.test(new URL(item.url()).hostname)) mapsRequests.push(item.url());
    });
    await page.evaluate(() => {
      const record = window as unknown as { __opened?: unknown[] };
      window.open = (...args: unknown[]) => {
        record.__opened = args;
        return null;
      };
    });
    expect(await page.evaluate(() => (window as unknown as { __opened?: unknown }).__opened)).toBe(
      undefined,
    );
    await map.click();
    const opened = (await page.evaluate(
      () => (window as unknown as { __opened?: unknown[] }).__opened,
    )) as [string, string, string];
    expect(opened[1]).toBe('_blank');
    expect(opened[2]).toBe('noopener,noreferrer');
    const target = new URL(opened[0]);
    expect(target.origin + target.pathname).toBe('https://www.google.com/maps/search/');
    expect([...target.searchParams.keys()]).toEqual(['api', 'query']);
    expect(target.searchParams.get('query')).toBe('-23.5505,-46.6333');
    const matchId = matchUrl.split('/').pop() ?? '';
    for (const id of [matchId, groupId, owner.profileId]) expect(opened[0]).not.toContain(id);
    expect(mapsRequests).toEqual([]);
    expect(page.url()).not.toMatch(/23[.,]5505|46[.,]6333/);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '03-detalhe-racha.png');

    // List: one row and the next match on the scoreboard; tabs keep working.
    // Right after creation the modal is gone and the back pops to the list.
    await page.getByTestId('match-back').click();
    await expect(page).toHaveURL(/\/rachas$/);
    await expectOneParent(page, 'match-list-card', 'match-back');
    // Normal navigation, twice: each round trip pops back to the same list.
    for (let round = 0; round < 2; round += 1) {
      await page.getByTestId('match-list-card').click();
      await expect(page.getByTestId('match-scoreboard')).toBeVisible();
      await page.getByTestId('match-back').click();
      await expect(page).toHaveURL(/\/rachas$/);
      await expectOneParent(page, 'match-list-card', 'match-back');
    }
    await expect(page.getByTestId('matches-scoreboard')).toHaveAttribute(
      'aria-label',
      /às 19:30, 14 vagas$/,
    );
    await shot(page, testInfo.project.name, '04-lista-rachas.png');
    await navigation.getByRole('link', { name: 'Grupos' }).click();
    await expect(page.getByRole('heading', { name: 'Grupos', level: 1 })).toBeVisible();
    await navigation.getByRole('link', { name: 'Perfil' }).click();
    await expect(page.getByRole('heading', { name: 'Perfil', level: 1 })).toBeVisible();
    // Direct URL: the list is not in the stack, so the back replaces the detail.
    await page.goto(matchUrl);
    await expect(page.getByTestId('match-scoreboard')).toBeVisible();
    await page.getByTestId('match-back').click();
    await expect(page).toHaveURL(/\/rachas$/);
    await expectOneParent(page, 'match-list-card', 'match-back');

    // A player reads the match through RLS but is not offered creation.
    const playerContext = await browser.newContext({ timezoneId: ZONE, colorScheme: 'dark' });
    const playerPage = await playerContext.newPage();
    try {
      await login(playerPage, player);
      await playerPage.goto('/rachas');
      await expect(playerPage.getByTestId('match-list-card')).toHaveCount(1);
      await expect(playerPage.getByTestId('matches-create')).toHaveCount(0);
    } finally {
      await playerContext.close();
    }
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('Rachas: denied location is explained and nothing about position is sent', async ({
  page,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'denied', authIds);
    const groupId = await createGroup(request, owner, 'Sem GPS');
    await page.context().clearPermissions();
    await login(page, owner);
    await page.goto(`/criar-racha?groupId=${groupId}`);
    await expect(page.getByRole('heading', { name: 'Criar racha', level: 1 })).toBeVisible();
    await fillMatch(page, tomorrowInZone());
    await page.getByTestId('match-locate').click();
    await expect(page.getByTestId('match-location-denied')).toContainText(
      'Permissão de localização negada.',
    );
    await expect(page.getByTestId('match-location-found')).toHaveCount(0);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, '05-gps-negado.png');
    const created = handledObserver(
      page.waitForResponse((item) => new URL(item.url()).pathname.endsWith('/groups/create_match')),
    );
    await page.getByTestId('match-create-submit').click();
    const sent = (await created).request().postDataJSON() as { config: Record<string, unknown> };
    expect(sent.config['latitude']).toBeNull();
    expect(sent.config['longitude']).toBeNull();
    await expect(page.getByRole('heading', { name: 'Arena da Vila', level: 1 })).toBeVisible();
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('the served document allows geolocation and camera to this origin only', async ({
  request,
}) => {
  const response = await request.get('/');
  expect(response.headers()['permissions-policy']).toBe(
    'camera=(self), microphone=(), geolocation=(self), payment=(), usb=()',
  );
});
