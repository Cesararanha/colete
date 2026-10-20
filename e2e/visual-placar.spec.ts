import { expect, test, type APIRequestContext, type Locator, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';

// PR G (prévia aprovada): the avatar at the top right, the two-tab bar, the
// Agenda filters, the group, member, match and profile screens. The scenario
// mirrors the prévia: an owner, an organizer, players, two requests and three
// matches in three states.

const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-visual-placar-2026';
const prefix = `visual-placar-${Date.now()}-${process.pid}`;
const screenshotRoot = process.env['COLETE_VISUAL_SCREENSHOTS_DIR'];
const ZONE = 'America/Sao_Paulo';
type Actor = { authId: string; profileId: string; token: string; email: string; name: string };

test.use({ timezoneId: ZONE, colorScheme: 'dark' });

/** The prévia is 390 wide: captures resize to it, then restore the project viewport. */
async function shot(page: Page, project: string, file: string) {
  if (project !== 'mobile-chromium' || !screenshotRoot || !existsSync(screenshotRoot)) return;
  const previous = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  // Hidden screens stay mounted in the tab stacks: measure the visible one.
  const height = Math.max(
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
  name: string,
  authIds: string[],
  profile: Record<string, unknown> = {},
) {
  const email = `${prefix}-${label}@colete.test`;
  const { id } = await createVerifiedUser(request, env, { email, name, password });
  authIds.push(id);
  const signed = await request.post(`${env.apiUrl}/auth/v1/token?grant_type=password`, {
    data: { email, password },
    headers: { apikey: env.publishableKey },
  });
  expect(signed.status()).toBe(200);
  const session = (await signed.json()) as { access_token: string };
  const profiled = await request.post(`${env.functionsUrl}/identity/complete_profile`, {
    data: { request_id: crypto.randomUUID(), profile: { name, ...profile } },
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

async function gateway(
  request: APIRequestContext,
  actor: Actor,
  operation: string,
  data: Record<string, unknown>,
) {
  // A read (the invite share link) takes no request_id; every mutation does.
  const read = operation === 'get_invite_share_link';
  const response = await request.post(`${env.functionsUrl}/groups/${operation}`, {
    data: read ? data : { request_id: crypto.randomUUID(), ...data },
    headers: { Authorization: `Bearer ${actor.token}` },
  });
  expect(response.status(), `${operation}: ${await response.text()}`).toBe(200);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}

async function createGroup(
  request: APIRequestContext,
  owner: Actor,
  name: string,
  joiners: Actor[],
  approved: Actor[],
) {
  const created = await gateway(request, owner, 'create_group', { name });
  const { group_id: groupId, invite_id: inviteId } = created['outcome'] as {
    group_id: string;
    invite_id: string;
  };
  const share = await gateway(request, owner, 'get_invite_share_link', { invite_id: inviteId });
  for (const actor of joiners)
    await gateway(request, actor, 'join_by_code', { code: share['code'] });
  for (const actor of approved)
    await gateway(request, owner, 'approve_member', {
      group_id: groupId,
      profile_id: actor.profileId,
      approve: true,
    });
  return groupId;
}

/** A local day from today at a local hour, in São Paulo (UTC-3, no daylight saving). */
function localAt(days: number, hour: number) {
  const now = new Date();
  const local = new Date(now.getTime() - 3 * 3_600_000);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, hour + 3),
  );
}

/** The Agenda heading for a local day from today: weeks run Monday to Sunday. */
function weekHeading(days: number) {
  const weekday = (localAt(0, 12).getUTCDay() + 6) % 7;
  const weeks = Math.floor((weekday + days) / 7);
  return weeks === 0 ? 'Esta semana' : weeks === 1 ? 'Próxima semana' : 'Mais adiante';
}

async function createMatch(
  request: APIRequestContext,
  owner: Actor,
  groupId: string,
  config: { start: Date; minutes: number; place: string; slots: number; description?: string },
) {
  const created = await gateway(request, owner, 'create_match', {
    group_id: groupId,
    config: {
      starts_at: config.start.toISOString(),
      ends_at: new Date(config.start.getTime() + config.minutes * 60_000).toISOString(),
      timezone: ZONE,
      location_name: config.place,
      location_address: 'Av. Dr. Antônio Gouveia, 1200 · Maceió',
      description: config.description ?? null,
      latitude: -9.6658,
      longitude: -35.7139,
      field_slots: config.slots,
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
  await db.query('begin');
  try {
    // join_by_code counts attempts per person.
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

test('Prévia aprovada: avatar, two tabs, Agenda, group, members, match and profile', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const cesar = await createActor(request, 'cesar', 'César Aranha', authIds, {
      nickname: 'Cesinha',
      position: 'midfielder',
      dominant_foot: 'right',
      shirt_number: 10,
    });
    const junior = await createActor(request, 'junior', 'Júnior Pereira', authIds, {
      position: 'goalkeeper',
    });
    const lucas = await createActor(request, 'lucas', 'Lucas Melo', authIds, {
      position: 'defender',
    });
    const rafael = await createActor(request, 'rafael', 'Rafael Souza', authIds, {
      position: 'forward',
    });
    const bruno = await createActor(request, 'bruno', 'Bruno Teixeira', authIds, {
      nickname: 'Brunão',
      position: 'forward',
    });
    const diego = await createActor(request, 'diego', 'Diego Farias', authIds);
    const quinta = await createGroup(
      request,
      cesar,
      'Racha de Quinta',
      [junior, lucas, rafael, bruno, diego],
      [junior, lucas, rafael],
    );
    await gateway(request, cesar, 'set_role', {
      group_id: quinta,
      profile_id: junior.profileId,
      role: 'organizer',
    });
    const sabado = await createGroup(
      request,
      junior,
      'Pelada do Sábado',
      [cesar, lucas],
      [cesar, lucas],
    );
    // Tomorrow 20:00, full with César confirmed and Rafael waiting.
    const full = await createMatch(request, cesar, quinta, {
      start: localAt(1, 20),
      minutes: 120,
      place: 'Arena Pajuçara',
      slots: 3,
      description: 'Levar colete azul e branco. R$ 15 por pessoa no Pix do Júnior.',
    });
    for (const actor of [cesar, junior, lucas, rafael])
      await gateway(request, actor, 'join_match', { match_id: full });
    await gateway(request, cesar, 'set_match_payment', {
      match_id: full,
      profile_id: cesar.profileId,
      paid: true,
    });
    await gateway(request, cesar, 'set_match_payment', {
      match_id: full,
      profile_id: junior.profileId,
      paid: true,
    });
    // Tomorrow 09:00 in the other group: full, César on the waitlist.
    const waiting = await createMatch(request, junior, sabado, {
      start: localAt(1, 9),
      minutes: 120,
      place: 'Society Ponta Verde',
      slots: 2,
    });
    for (const actor of [junior, lucas, cesar])
      await gateway(request, actor, 'join_match', { match_id: waiting });
    // Five days on, 22:00 to 01:00: open, César out.
    await createMatch(request, cesar, quinta, {
      start: localAt(5, 22),
      minutes: 180,
      place: 'Arena Pajuçara',
      slots: 14,
    });

    // Any render error can blank the screen: the test fails on it. React #418
    // (hydration text mismatch) on a dynamic route opened by URL predates this
    // PR (same probe on a375e44) and React recovers from it; it is reported
    // apart, not hidden.
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      if (!error.message.includes('Minified React error #418')) pageErrors.push(error.message);
    });
    await login(page, cesar);

    // The bar holds Grupos and Agenda; the profile is the avatar at the top right.
    const navigation = page.getByRole('navigation', { name: 'Navegação principal' });
    await expect(navigation.getByRole('link')).toHaveCount(2);
    for (const [index, name] of ['Grupos', 'Agenda'].entries())
      await expect(navigation.getByRole('link').nth(index)).toHaveAccessibleName(name);
    const avatar = page.getByRole('link', { name: 'Abrir perfil de César Aranha' });
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveText('CA');

    // Agenda: three cards, three states, filters announced by aria-pressed.
    await navigation.getByRole('link', { name: 'Agenda' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Agenda' })).toBeVisible();
    const cards = page.getByTestId('match-list-card');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0).getByTestId('match-card-state')).toHaveText('Na espera');
    await expect(cards.nth(0)).toContainText('Lotado 2/2');
    await expect(cards.nth(1).getByTestId('match-card-state')).toHaveText('Você vai');
    await expect(cards.nth(1).getByTestId('match-card-group')).toHaveText('Racha de Quinta');
    await expect(cards.nth(2).getByTestId('match-card-state')).toHaveText('14 vagas abertas');
    await expect(cards.nth(2).getByTestId('match-card-time')).toContainText('(+1 dia)');
    // The first card starts tomorrow: on a Sunday that is already next week.
    await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText(weekHeading(1));
    const filters = page.getByRole('group', { name: 'Filtrar rachas' });
    await expect(filters.getByRole('button', { name: 'Todos' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'agenda.png');
    await filters.getByRole('button', { name: 'Vou jogar' }).click();
    await expect(filters.getByRole('button', { name: 'Vou jogar' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(filters.getByRole('button', { name: 'Todos' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(cards).toHaveCount(2);
    // rev-previa / BB-028: with a mouse, a filter and a card answer the hover.
    if (testInfo.project.name === 'wide-chromium') {
      const look = (target: Locator) =>
        target.evaluate((element) =>
          [element, ...element.querySelectorAll('*')]
            .slice(0, 8)
            .map((part) => {
              const style = getComputedStyle(part);
              return [
                style.backgroundColor,
                style.borderColor,
                style.opacity,
                style.color,
                style.textDecorationLine,
              ].join('|');
            })
            .join(';'),
        );
      const rail = page.getByRole('navigation', { name: 'Navegação principal' });
      for (const target of [
        filters.getByRole('button', { name: 'Com vaga' }),
        cards.first(),
        rail.getByRole('link', { name: 'Grupos' }),
      ]) {
        await page.mouse.move(0, 0);
        const before = await look(target);
        await target.hover();
        await expect.poll(() => look(target)).not.toBe(before);
      }
      await page.mouse.move(0, 0);
    }
    await filters.getByRole('button', { name: 'Com vaga' }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards.first().getByTestId('match-card-state')).toHaveText('14 vagas abertas');
    // rev74 / BB-027: the filter is in the address and survives a reload.
    await expect(page).toHaveURL(/\/rachas\?filtro=com-vaga$/u);
    await page.reload();
    await expect(filters.getByRole('button', { name: 'Com vaga' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(cards).toHaveCount(1);
    await filters.getByRole('button', { name: 'Todos' }).click();
    await expect(cards).toHaveCount(3);
    await expect(page).toHaveURL(/\/rachas$/u);

    // Perfil from the Agenda: Voltar returns to the Agenda.
    await avatar.click();
    await expect(page).toHaveURL(/\/perfil$/u);
    await expect(page.getByRole('heading', { level: 1, name: 'César Aranha' })).toBeVisible();
    await expect(page.getByTestId('profile-value-nickname')).toHaveText('Cesinha');
    await expect(page.getByTestId('profile-value-position')).toHaveText('Meio-campista');
    await expect(page.getByTestId('profile-value-dominant-foot')).toHaveText('Direita');
    await expect(page.getByTestId('profile-value-shirt-number')).toHaveText('10');
    await expect(page.getByRole('link', { name: /^Abrir perfil/u })).toHaveCount(0);
    // As in the prévia, the profile has no bar: only its "Voltar".
    await expect(page.locator('[aria-label="Navegação principal"]')).toHaveCount(0);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'perfil.png');
    await page.getByTestId('profile-back').click();
    await expect(page).toHaveURL(/\/rachas$/u);

    // The match: the board, the payment summary for the organisation, the chips.
    await cards.nth(1).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^[A-Z][a-zá]{2}, \d{1,2} /u);
    await expect(page.getByTestId('match-scoreboard')).toHaveAttribute(
      'aria-label',
      '3 de 3 vagas confirmadas',
    );
    await expect(page.getByTestId('match-viewer-chip')).toHaveText('Você vai');
    await expect(page.getByTestId('match-board-summary')).toHaveText('Lotado · 1 na espera');
    await expect(page.getByTestId('match-payment-summary')).toHaveText('Pagos 2 de 3 · R$ 30,00');
    await expect(page.getByTestId('match-confirmed-0-paid')).toHaveText('Pago');
    await expect(page.getByTestId('match-confirmed-2-paid')).toHaveText('Não pagou');
    await expect(page.getByTestId('match-waitlist-0')).toContainText('1º');
    await expect(page.getByTestId('match-waitlist-0')).toContainText('Rafael Souza');
    await expect(page.getByTestId('match-leave')).toHaveText('Desistir');
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'racha.png');

    // The group: icon, name and summary; the members card with the requests chip.
    await page.goto(`/grupos/${quinta}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Racha de Quinta' })).toBeVisible();
    await expect(page.getByTestId('group-summary')).toHaveText('4 membros · você é o dono');
    const membersLink = page.getByRole('link', { name: 'Ver os 4 membros e 2 pedidos pendentes' });
    await expect(membersLink).toBeVisible();
    await expect(page.getByTestId('group-requests')).toHaveText('2 pedidos');
    await expect(page.getByTestId('group-create-match')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Convidar' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Configurar' })).toBeVisible();
    await expect(
      page.getByTestId('group-upcoming-matches').getByTestId('match-list-card'),
    ).toHaveCount(2);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'grupo.png');

    // Members: requests first with named round buttons; "…" only where there are actions.
    await membersLink.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Membros' })).toBeVisible();
    await expect(page.getByTestId('members-back')).toHaveAccessibleName(
      'Voltar para Racha de Quinta',
    );
    // get_group_members names a person by display_name: the nickname when there is one.
    for (const name of ['Brunão', 'Diego Farias']) {
      await expect(
        page.getByRole('button', { name: `Aprovar ${name}`, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: `Recusar ${name}`, exact: true }),
      ).toBeVisible();
    }
    const owner = page.getByTestId(`member-${cesar.profileId}`);
    await expect(owner).toContainText('Dono');
    await expect(owner.getByRole('button')).toHaveCount(0);
    await expect(page.getByTestId(`member-${junior.profileId}`)).toContainText('Organizador');
    await expect(page.getByTestId(`member-${lucas.profileId}`)).toContainText('Jogador');
    const menu = page.getByRole('button', { name: 'Ações para Lucas Melo' });
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId(`remove-${lucas.profileId}`)).toHaveCount(0);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'membros.png');
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId(`role-${lucas.profileId}`)).toBeVisible();
    await expect(page.getByTestId(`remove-${lucas.profileId}`)).toBeVisible();
    await assertAccessible(page);
    await menu.click();
    await expect(page.getByTestId(`remove-${lucas.profileId}`)).toHaveCount(0);

    // Perfil from Members: Voltar returns to Members, and the bar comes back.
    await page.getByRole('link', { name: 'Abrir perfil de César Aranha' }).click();
    await expect(page).toHaveURL(/\/perfil$/u);
    await expect(page.locator('[aria-label="Navegação principal"]')).toHaveCount(0);
    await page.getByTestId('profile-back').click();
    await expect(page).toHaveURL(new RegExp(`/grupos/${quinta}/membros$`, 'u'));
    await expect(page.getByRole('heading', { level: 1, name: 'Membros' })).toBeVisible();
    await expect(page.locator('[aria-label="Navegação principal"]')).toHaveCount(1);

    // Perfil by URL: nothing to go back to, so Voltar opens Grupos.
    await page.goto('/perfil');
    await expect(page.getByRole('heading', { level: 1, name: 'César Aranha' })).toBeVisible();
    await expect(page.locator('[aria-label="Navegação principal"]')).toHaveCount(0);
    await page.getByTestId('profile-back').click();
    await expect(page).toHaveURL(/\/grupos$/u);
    await expect(page.getByRole('heading', { level: 1, name: 'Grupos' })).toBeVisible();
    await expect(page.locator('[aria-label="Navegação principal"]')).toHaveCount(1);

    // The group icon is the ball in blue for every group in this PR (choice in PR H).
    await page.goto(`/grupos/${sabado}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Pelada do Sábado' })).toBeVisible();
    await expect(page.getByTestId('group-summary')).toHaveText('3 membros · você é jogador');
    await expect(page.getByTestId('group-members-list')).toContainText('Júnior Pereira');
    await expect(page.getByRole('link', { name: /^Ver os/u })).toHaveCount(0);
    await expect(page.getByTestId('group-requests')).toHaveCount(0);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'icone-do-grupo.png');
    expect(pageErrors).toEqual([]);
    await page.goto('about:blank');
  } finally {
    await cleanActors(authIds, db);
    expect((await db.query('select count(*)::integer as n from auth.users')).rows[0].n).toBe(0);
    await db.end();
  }
});
