import { expect, test, type APIRequestContext, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { createVerifiedUser, localEnvironment } from './support/local-stack';
import { textOutsideItsBox } from './support/layout';
import { handledObserver } from './support/observers';

// Polimento final (bugbash BB-002, BB-008, BB-011, BB-015; rev-previa "Content
// Handling"): the longest names the contracts accept, without spaces, stay
// inside their cards, headers and the screen, on a phone and on a wide screen.
const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-textos-longos-2026';
const prefix = `textos-longos-${Date.now()}-${process.pid}`;
const ZONE = 'America/Sao_Paulo';
type Actor = { authId: string; profileId: string; token: string; email: string; name: string };

test.use({ timezoneId: ZONE, colorScheme: 'dark' });

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

function localAt(days: number, hour: number) {
  const now = new Date();
  const local = new Date(now.getTime() - 3 * 3_600_000);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, hour + 3),
  );
}

async function createMatch(
  request: APIRequestContext,
  owner: Actor,
  groupId: string,
  config: {
    start: Date;
    minutes: number;
    place: string;
    slots: number;
    description?: string;
    address?: string;
  },
) {
  const created = await gateway(request, owner, 'create_match', {
    group_id: groupId,
    config: {
      starts_at: config.start.toISOString(),
      ends_at: new Date(config.start.getTime() + config.minutes * 60_000).toISOString(),
      timezone: ZONE,
      location_name: config.place,
      location_address: config.address ?? 'Av. Dr. Antônio Gouveia, 1200 · Maceió',
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

const screenshotRoot = process.env['COLETE_LONG_TEXT_SCREENSHOTS_DIR'];

async function contained(page: Page, route: string, ready: () => Promise<void>) {
  await page.goto(route);
  await ready();
  if (screenshotRoot && existsSync(screenshotRoot))
    await page.screenshot({
      path: path.join(
        screenshotRoot,
        `${page.viewportSize()!.width}${route.replace(/\W+/gu, '-')}.png`,
      ),
    });
  expect.soft(await textOutsideItsBox(page), route).toEqual([]);
}

test('Textos longos: names at their maximum stay inside every screen', async ({
  page,
  request,
}, testInfo) => {
  if (testInfo.project.name === 'mobile-chromium')
    await page.setViewportSize({ width: 390, height: 844 });
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const ownerName = 'W'.repeat(80);
    const owner = await createActor(request, 'dono', ownerName, authIds, {
      nickname: 'W'.repeat(30),
      shirt_number: 10,
    });
    const member = await createActor(request, 'membro', 'M'.repeat(80), authIds);
    const pending = await createActor(request, 'pendente', 'P'.repeat(80), authIds);
    const groupName = 'W'.repeat(40);
    const groupId = await createGroup(request, owner, groupName, [member, pending], [member]);
    const matchId = await createMatch(request, owner, groupId, {
      start: localAt(1, 20),
      minutes: 90,
      place: 'W'.repeat(80),
      address: 'M'.repeat(160),
      slots: 10,
      description: 'W'.repeat(500),
    });
    await gateway(request, member, 'join_match', { match_id: matchId });
    await login(page, owner);
    const heading = (name: string) => () =>
      expect(page.getByRole('heading', { level: 1, name }).first()).toBeVisible();
    await contained(page, '/rachas', () =>
      expect(page.getByTestId('match-card-group').first()).toHaveText(groupName),
    );
    await contained(page, '/grupos', heading('Grupos'));
    await contained(page, `/grupos/${groupId}`, heading(groupName));
    await contained(page, `/grupos/${groupId}/membros`, () =>
      expect(page.getByText('M'.repeat(80)).first()).toBeVisible(),
    );
    await contained(page, `/grupos/${groupId}/icone`, heading('Ícone do grupo'));
    await contained(page, `/grupos/${groupId}/configuracoes`, heading('Configurações'));
    await contained(page, `/grupos/${groupId}/convites`, () =>
      expect(page.getByTestId('invite-code')).toBeVisible(),
    );
    await contained(page, `/grupos/${groupId}/notas`, () =>
      expect(page.getByText('M'.repeat(80)).first()).toBeVisible(),
    );
    await contained(page, `/rachas/${matchId}`, () =>
      expect(page.getByTestId('match-fact-where')).toBeVisible(),
    );
    await contained(page, '/perfil', () => expect(page.getByText(ownerName).first()).toBeVisible());
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});
