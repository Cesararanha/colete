import { expect, test, type APIRequestContext, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';

// Rachas: usabilidade (decisões humanas de 17/10/2026). Auth, Edge and
// Postgres are the real local stack; only search_address is simulated, so no
// test reaches Nominatim.
const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-rachas-ux-2026';
const prefix = `rachas-ux-${Date.now()}-${process.pid}`;
const screenshotRoot = process.env['COLETE_RACHAS_SCREENSHOTS_DIR'];
const ZONE = 'America/Sao_Paulo';
type Actor = { authId: string; profileId: string; token: string; email: string };

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

async function gateway(
  request: APIRequestContext,
  actor: Actor,
  operation: string,
  body: Record<string, unknown>,
) {
  const response = await request.post(`${env.functionsUrl}/groups/${operation}`, {
    data: { request_id: crypto.randomUUID(), ...body },
    headers: { Authorization: `Bearer ${actor.token}` },
  });
  expect(response.status(), `${operation}: ${await response.text()}`).toBe(200);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}

async function createGroup(request: APIRequestContext, owner: Actor, name: string) {
  const data = await gateway(request, owner, 'create_group', { name });
  return (data['outcome'] as { group_id: string }).group_id;
}

async function createMatch(
  request: APIRequestContext,
  owner: Actor,
  groupId: string,
  options: { days: number; place: string; coordinates?: [number, number] },
) {
  const start = new Date(Math.floor(Date.now() / 60_000) * 60_000 + options.days * 86_400_000);
  const created = await gateway(request, owner, 'create_match', {
    group_id: groupId,
    config: {
      starts_at: start.toISOString(),
      ends_at: new Date(start.getTime() + 90 * 60_000).toISOString(),
      timezone: ZONE,
      location_name: options.place,
      location_address: null,
      description: null,
      latitude: options.coordinates?.[0] ?? null,
      longitude: options.coordinates?.[1] ?? null,
      field_slots: 10,
      field_price: '20.00',
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
      `delete from private.match_players where match_id in
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

/** A day in São Paulo as digits typed into the date mask: DDMMAAAA. */
function dayDigits(offsetDays: number): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: ZONE,
    year: 'numeric',
  })
    .format(new Date(Date.now() + offsetDays * 86_400_000))
    .replaceAll('/', '');
}

/** The minutes since midnight in São Paulo now. */
function minutesNowInZone(): number {
  const [hour, minute] = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    timeZone: ZONE,
  })
    .format(new Date())
    .split(':')
    .map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

const SEARCH_RESULTS = [
  {
    label: 'Quadra do Zé, Rua das Flores, 100, São Paulo',
    latitude: -23.550519,
    longitude: -46.633309,
  },
  { label: 'Rua das Flores, Campinas', latitude: -22.905556, longitude: -47.060833 },
];

test('Usabilidade: create from the group with masks, address search and next-day end', async ({
  page,
  request,
  browser,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'owner', authIds);
    const player = await createActor(request, 'player', authIds);
    const groupId = await createGroup(request, owner, 'Racha de Sábado');
    await db.query(
      `insert into public.group_members(group_id, profile_id, role, status)
       values ($1, $2, 'player', 'active')`,
      [groupId, player.profileId],
    );

    // The simulated Edge: count the searches and what they carry. Nothing in
    // the page may talk to OpenStreetMap directly.
    const searches: { body: unknown; authorized: boolean }[] = [];
    await page.route('**/functions/v1/groups/search_address', async (route) => {
      searches.push({
        body: route.request().postDataJSON(),
        authorized: (route.request().headers()['authorization'] ?? '').startsWith('Bearer '),
      });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data: { results: SEARCH_RESULTS, attribution: '© OpenStreetMap' },
          request_id: crypto.randomUUID(),
        }),
      });
    });
    const osmRequests: string[] = [];
    page.on('request', (item) => {
      if (/openstreetmap/.test(new URL(item.url()).hostname)) osmRequests.push(item.url());
    });

    await login(page, owner);
    await page.goto(`/grupos/${groupId}`);
    const upcoming = page.getByTestId('group-upcoming-matches');
    await expect(
      upcoming.getByRole('heading', { name: 'Próximos rachas', level: 2 }),
    ).toBeVisible();
    await expect(upcoming).toContainText('Nenhum racha marcado neste grupo.');
    await page.getByTestId('group-create-match').click();
    await expect(page).toHaveURL(new RegExp(`/criar-racha\\?groupId=${groupId}$`));

    // The group is chosen; there is no group selector.
    await expect(page.getByTestId('match-fixed-group')).toContainText('Racha de Sábado');
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    await expect(page.getByTestId('match-locate')).toHaveCount(0);

    // Masks while typing, with no dependency.
    const tomorrow = dayDigits(1);
    await page.getByTestId('match-date').pressSequentially(tomorrow);
    await expect(page.getByTestId('match-date')).toHaveValue(
      `${tomorrow.slice(0, 2)}/${tomorrow.slice(2, 4)}/${tomorrow.slice(4)}`,
    );
    await page.getByTestId('match-startTime').pressSequentially('2200');
    await expect(page.getByTestId('match-startTime')).toHaveValue('22:00');
    await page.getByTestId('match-endTime').pressSequentially('0100');
    await expect(page.getByTestId('match-endTime')).toHaveValue('01:00');
    await expect(page.getByText('Termina às 01:00 do dia seguinte')).toBeVisible();
    await page.getByTestId('match-price').pressSequentially('2500');
    await expect(page.getByTestId('match-price')).toHaveValue('R$ 25,00');
    await page.getByTestId('match-slots').fill('14');
    await page.getByTestId('match-locationName').fill('Quadra do Zé');

    // Address search: only on the press, through the Edge, up to five results
    // with the OpenStreetMap attribution; choosing fills the address.
    await page.getByTestId('match-locationAddress').fill('Rua das Flores');
    expect(searches).toHaveLength(0);
    await page.getByRole('button', { name: 'Buscar endereço' }).click();
    const results = page.getByTestId('match-address-results');
    await expect(results.getByRole('button')).toHaveCount(2);
    await expect(page.getByTestId('match-attribution')).toContainText('© OpenStreetMap');
    expect(searches).toEqual([{ body: { query: 'Rua das Flores' }, authorized: true }]);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'ux-01-busca-endereco.png');
    await page
      .getByRole('button', { name: 'Usar o endereço Quadra do Zé, Rua das Flores, 100, São Paulo' })
      .click();
    await expect(page.getByTestId('match-locationAddress')).toHaveValue(
      'Quadra do Zé, Rua das Flores, 100, São Paulo',
    );
    await expect(page.getByTestId('match-address-chosen')).toBeVisible();
    await expect(results).toHaveCount(0);

    // While it sends, the button reads "Criando…" and is disabled.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/functions/v1/groups/create_match', async (route) => {
      await held;
      await route.continue();
    });
    const created = handledObserver(
      page.waitForResponse((item) => new URL(item.url()).pathname.endsWith('/groups/create_match')),
    );
    const submitButton = page.getByTestId('match-create-submit');
    await submitButton.click();
    await expect(submitButton).toHaveText('Criando…');
    await expect(submitButton).toHaveAttribute('aria-disabled', 'true');
    await submitButton.click({ force: true });
    release();
    const response = await created;
    expect(response.status()).toBe(200);
    const sent = response.request().postDataJSON() as {
      group_id: string;
      config: Record<string, unknown>;
    };
    expect(sent.group_id).toBe(groupId);
    expect(sent.config['latitude']).toBe(-23.5505);
    expect(sent.config['longitude']).toBe(-46.6333);
    expect(sent.config['field_price']).toBe('25.00');
    expect(sent.config['location_address']).toBe('Quadra do Zé, Rua das Flores, 100, São Paulo');
    expect(
      Date.parse(String(sent.config['ends_at'])) - Date.parse(String(sent.config['starts_at'])),
    ).toBe(3 * 3_600_000);

    // Detail: the board shows only the occupancy; date and time are text at the top.
    await expect(page.getByRole('heading', { name: 'Quadra do Zé', level: 1 })).toBeVisible();
    await expect(page.getByTestId('match-scoreboard')).toHaveAttribute(
      'aria-label',
      '0 de 14 vagas confirmadas',
    );
    await expect(
      page.getByText(/^[A-Z][a-zá]{2}, \d{1,2} [a-zç]{3} · 22:00–01:00$/u),
    ).toBeVisible();
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'ux-02-detalhe-topo.png');
    expect(
      (
        await db.query('select count(*)::integer as n from private.matches where group_id = $1', [
          groupId,
        ])
      ).rows[0].n,
    ).toBe(1);

    // Back in the group: the new card, without the group name it already shows.
    await page.goto(`/grupos/${groupId}`);
    const card = upcoming.getByTestId('match-list-card');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAccessibleName(
      /^Ver racha: Quadra do Zé, .+, 22:00–01:00, 0 de 14 vagas confirmadas$/u,
    );
    await expect(upcoming.getByTestId('match-card-group')).toHaveCount(0);
    await expect(upcoming.getByTestId('match-card-ticket')).toBeVisible();
    await shot(page, testInfo.project.name, 'ux-03-grupo-proximos.png');
    expect(osmRequests).toEqual([]);

    // A player sees the group's matches but is not offered "Criar racha".
    const playerContext = await browser.newContext({ timezoneId: ZONE, colorScheme: 'dark' });
    const playerPage = await playerContext.newPage();
    try {
      await login(playerPage, player);
      await playerPage.goto(`/grupos/${groupId}`);
      await expect(
        playerPage.getByTestId('group-upcoming-matches').getByTestId('match-list-card'),
      ).toHaveCount(1);
      await expect(playerPage.getByTestId('group-create-match')).toHaveCount(0);
    } finally {
      await playerContext.close();
    }
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('Usabilidade: the Agenda tab lists my matches of every group with the group name', async ({
  page,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'agenda', authIds);
    const first = await createGroup(request, owner, 'Futebol de Quarta');
    const second = await createGroup(request, owner, 'Pelada de Domingo');
    await createMatch(request, owner, second, { days: 4, place: 'Campo do Bairro' });
    await createMatch(request, owner, first, { days: 2, place: 'Arena Central' });
    await login(page, owner);
    const navigation = page.getByRole('navigation', { name: 'Navegação principal' });
    for (const [index, name] of ['Grupos', 'Agenda', 'Perfil'].entries()) {
      await expect(navigation.getByRole('link').nth(index)).toHaveAccessibleName(name);
    }
    await navigation.getByRole('link', { name: 'Agenda' }).click();
    await expect(page).toHaveURL(/\/rachas$/);
    await expect(page.getByRole('heading', { name: 'Agenda', level: 1 })).toBeVisible();
    const cards = page.getByTestId('match-list-card');
    await expect(cards).toHaveCount(2);
    // By date, each with its group's name and the full accessible name.
    await expect(cards.nth(0).getByTestId('match-card-group')).toHaveText('Futebol de Quarta');
    await expect(cards.nth(1).getByTestId('match-card-group')).toHaveText('Pelada de Domingo');
    await expect(cards.nth(0)).toHaveAccessibleName(
      /^Ver racha: Arena Central, .+, \d{2}:\d{2}–\d{2}:\d{2}, Grupo Futebol de Quarta, 0 de 10 vagas confirmadas$/u,
    );
    await expect(cards.nth(0).getByTestId('match-list-occupancy')).toHaveText('0/10');
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'ux-04-agenda.png');
    // Review of #72 (P2): at 200% the time and the group keep a readable width;
    // on the phone the date block moves above the content instead of
    // squeezing it.
    await page.evaluate(() => {
      document.documentElement.style.zoom = '2';
    });
    const box = async (id: string) => (await cards.nth(0).getByTestId(id).boundingBox())!;
    const time = await box('match-card-time');
    const group = await box('match-card-group');
    const ticket = await box('match-card-ticket');
    expect(time.width).toBeGreaterThan(80);
    expect(group.width).toBeGreaterThan(80);
    expect(time.height).toBeLessThan(ticket.height);
    const count = await box('match-list-occupancy');
    const frame = (await cards.nth(0).boundingBox())!;
    expect(count.x + count.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
    if (testInfo.project.name === 'mobile-chromium') {
      expect(ticket.y + ticket.height).toBeLessThanOrEqual(time.y + 1);
    }
    if (
      testInfo.project.name === 'mobile-chromium' &&
      screenshotRoot &&
      existsSync(screenshotRoot)
    ) {
      await cards.nth(0).screenshot({ path: path.join(screenshotRoot, 'ux-04b-card-200.png') });
    }
    await page.evaluate(() => {
      document.documentElement.style.zoom = '1';
    });
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('Usabilidade: field errors focus the first invalid field; server errors land in place', async ({
  page,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'focus', authIds);
    const groupId = await createGroup(request, owner, 'Grupo Foco');
    let creations = 0;
    page.on('request', (item) => {
      if (new URL(item.url()).pathname.endsWith('/groups/create_match')) creations += 1;
    });
    await login(page, owner);
    await page.goto(`/criar-racha?groupId=${groupId}`);
    await expect(page.getByTestId('match-fixed-group')).toBeVisible();
    await page.getByTestId('match-locationName').fill('Quadra');
    await page.getByTestId('match-slots').fill('10');
    await page.getByTestId('match-price').pressSequentially('2000');

    // A date before today: the error is on the date, which takes the focus.
    await page.getByTestId('match-date').pressSequentially(dayDigits(-1));
    await page.getByTestId('match-startTime').pressSequentially('1000');
    await page.getByTestId('match-endTime').pressSequentially('0800');
    await page.getByTestId('match-create-submit').click();
    await expect(page.getByTestId('match-date')).toBeFocused();
    await expect(page.getByText('A data não pode ser anterior a hoje')).toBeVisible();
    await expect(page.getByText('O horário final precisa ser depois do início')).toBeVisible();
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'ux-05-erros-campo.png');

    // A future date: 10:00 to 08:00 is 22 h, so the end is the first error.
    await page.getByTestId('match-date').fill('');
    await page.getByTestId('match-date').pressSequentially(dayDigits(2));
    await page.getByTestId('match-create-submit').click();
    await expect(page.getByTestId('match-endTime')).toBeFocused();
    await expect(page.getByText('A data não pode ser anterior a hoje')).toHaveCount(0);

    // Today with a start already gone: the error is on the start.
    if (minutesNowInZone() >= 5) {
      await page.getByTestId('match-date').fill('');
      await page.getByTestId('match-date').pressSequentially(dayDigits(0));
      await page.getByTestId('match-startTime').fill('');
      await page.getByTestId('match-startTime').pressSequentially('0000');
      await page.getByTestId('match-endTime').fill('');
      await page.getByTestId('match-endTime').pressSequentially('0100');
      await page.getByTestId('match-create-submit').click();
      await expect(page.getByTestId('match-startTime')).toBeFocused();
      await expect(page.getByText('O horário de início já passou')).toBeVisible();
    }
    expect(creations).toBe(0);

    // A valid form refused by the server: a field refusal lands on its field…
    await page.getByTestId('match-date').fill('');
    await page.getByTestId('match-date').pressSequentially(dayDigits(2));
    await page.getByTestId('match-startTime').fill('');
    await page.getByTestId('match-startTime').pressSequentially('1900');
    await page.getByTestId('match-endTime').fill('');
    await page.getByTestId('match-endTime').pressSequentially('2030');
    const refusals = [
      {
        status: 422,
        error: {
          code: 'VALIDATION',
          message: 'The request did not pass validation.',
          fields: { 'config.location_name': 'must be between 2 and 80 code points' },
        },
      },
      { status: 403, error: { code: 'NOT_ORGANIZER', message: 'Not an organizer.' } },
    ];
    await page.route('**/functions/v1/groups/create_match', (route) => {
      const refusal = refusals.shift();
      return route.fulfill({
        status: refusal?.status ?? 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: refusal?.error, request_id: crypto.randomUUID() }),
      });
    });
    await page.getByTestId('match-create-submit').click();
    await expect(page.getByTestId('match-locationName')).toBeFocused();
    await expect(page.getByText('Informe o local com 2 a 80 caracteres.')).toBeVisible();
    // …and one without a field goes to the notice at the top, with the focus.
    await page.getByTestId('match-create-submit').click();
    await expect(page.getByTestId('match-create-error-box')).toBeFocused();
    await expect(page.getByTestId('match-create-error')).not.toBeEmpty();
    expect(
      (
        await db.query('select count(*)::integer as n from private.matches where group_id = $1', [
          groupId,
        ])
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('Usabilidade: "Ver distância" computes on the device, granted and denied', async ({
  page,
  request,
  browser,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'distance', authIds);
    const groupId = await createGroup(request, owner, 'Grupo Distância');
    const withPlace = await createMatch(request, owner, groupId, {
      days: 2,
      place: 'Praça da Sé',
      coordinates: [-23.5505, -46.6333],
    });
    const withoutPlace = await createMatch(request, owner, groupId, { days: 3, place: 'Sem mapa' });

    // Granted: the position (Avenida Paulista) never leaves the page.
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({ latitude: -23.5614, longitude: -46.6559 });
    const leaks: string[] = [];
    page.on('request', (item) => {
      const carried = `${item.url()} ${item.postData() ?? ''}`;
      if (/23[.,]561|46[.,]655/.test(carried)) leaks.push(item.url());
    });
    await login(page, owner);
    await page.goto(`/rachas/${withPlace}`);
    await expect(page.getByRole('heading', { name: 'Praça da Sé', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Ver distância' }).click();
    await expect(page.getByTestId('match-distance-result')).toHaveText('a 2,6 km de você');
    expect(page.url()).not.toMatch(/23[.,]56|46[.,]65/);
    expect(leaks).toEqual([]);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'ux-06-distancia.png');

    // No coordinates, no button.
    await page.goto(`/rachas/${withoutPlace}`);
    await expect(page.getByRole('heading', { name: 'Sem mapa', level: 1 })).toBeVisible();
    await expect(page.getByTestId('match-distance-button')).toHaveCount(0);

    // Denied: a clear text, and no distance.
    const deniedContext = await browser.newContext({ timezoneId: ZONE, colorScheme: 'dark' });
    const deniedPage = await deniedContext.newPage();
    try {
      await deniedContext.clearPermissions();
      await login(deniedPage, owner);
      await deniedPage.goto(`/rachas/${withPlace}`);
      await deniedPage.getByRole('button', { name: 'Ver distância' }).click();
      await expect(deniedPage.getByTestId('match-distance-denied')).toContainText(
        'Sem permissão de localização',
      );
      await expect(deniedPage.getByTestId('match-distance-result')).toHaveCount(0);
      await assertAccessible(deniedPage);
      await shot(deniedPage, testInfo.project.name, 'ux-07-distancia-negada.png');
    } finally {
      await deniedContext.close();
    }
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});
