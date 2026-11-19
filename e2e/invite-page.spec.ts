import { beginCleanup } from './support/cleanup';
import { expect, test, type APIRequestContext, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';
import { simulateCamera, stopped } from './support/qr-camera';

// PR D, página do convite (0026): the code typed in "Entrar em grupo", the QR
// read by the camera and the /join link lead to the same group page, with the
// icon, the name, the active members, the owner's display name and the
// person's own state. Before login, the link comes back to the page.
const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-invite-page-2026';
const prefix = `convite-${Date.now()}-${process.pid}`;
const origin = 'http://127.0.0.1:4173';
const screenshotRoot = process.env.COLETE_INVITE_PAGE_SCREENSHOTS_DIR;
const pageFields = [
  'group_color',
  'group_icon',
  'group_id',
  'group_name',
  'member_count',
  'owner_name',
  'refusal',
  'viewer_status',
];
type Actor = { authId: string; profileId: string; token: string; email: string };

test.use({ colorScheme: 'dark' });
// The page is a phone page (390 px). Its wide layout is proved by m2-ui-a,
// which runs on both projects and goes through the same page.
test.skip(({ isMobile }) => !isMobile, 'phone page; the wide layout is covered by m2-ui-a');

async function phone(page: Page, project: string) {
  if (project === 'mobile-chromium') await page.setViewportSize({ width: 390, height: 844 });
}

async function shot(page: Page, project: string, file: string) {
  if (project !== 'mobile-chromium' || !screenshotRoot || !existsSync(screenshotRoot)) return;
  await page.screenshot({ path: path.join(screenshotRoot, file), fullPage: true });
}

async function submitLogin(page: Page, actor: Actor) {
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
}

async function login(page: Page, actor: Actor) {
  await page.goto('/entrar');
  await submitLogin(page, actor);
  await expect(page.getByRole('heading', { name: 'Grupos', level: 1 })).toBeVisible();
}

async function edge(actor: Actor, operation: string, input: object) {
  const response = await fetch(`${env.functionsUrl}/groups/${operation}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function createActor(
  request: APIRequestContext,
  label: string,
  authIds: string[],
  profile: { name: string; nickname?: string },
) {
  const email = `${prefix}-${label}@colete.test`;
  const { id } = await createVerifiedUser(request, env, { email, name: profile.name, password });
  authIds.push(id);
  const signed = await request.post(`${env.apiUrl}/auth/v1/token?grant_type=password`, {
    data: { email, password },
    headers: { apikey: env.publishableKey },
  });
  const session = (await signed.json()) as { access_token: string };
  const profiled = await request.post(`${env.functionsUrl}/identity/complete_profile`, {
    data: { request_id: crypto.randomUUID(), profile },
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  expect(profiled.status()).toBe(200);
  const body = (await profiled.json()) as { data: { outcome: { profile_id: string } } };
  return {
    authId: id,
    profileId: body.data.outcome.profile_id,
    token: session.access_token,
    email,
  } satisfies Actor;
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
    for (const table of ['private.invite_rate_limits', 'private.revoked_auth_sessions'])
      await db.query(`delete from ${table} where profile_id = any($1::uuid[])`, [ids]);
    await db.query('delete from private.idempotency_records where actor_id = any($1::uuid[])', [
      ids,
    ]);
    await db.query(`delete from public.group_invites where group_id in (${groups})`, [ids]);
    await db.query(
      `delete from public.group_members where profile_id = any($1::uuid[]) or group_id in (${groups})`,
      [ids],
    );
    await db.query('delete from public.groups where owner_id = any($1::uuid[])', [ids]);
    await db.query('delete from public.policy_acceptances where profile_id = any($1::uuid[])', [
      ids,
    ]);
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
  const left = await db.query(
    'select count(*)::integer as count from auth.users where id = any($1::uuid[])',
    [authIds],
  );
  expect(left.rows[0].count).toBe(0);
}

/** A group with its owner (nickname "Capitão"), one approved member and its live invitation. */
async function groupWithMember(request: APIRequestContext, authIds: string[], name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
  const owner = await createActor(request, `${slug}-dono`, authIds, {
    name: 'César Aranha',
    nickname: 'Capitão',
  });
  const created = await edge(owner, 'create_group', { name, request_id: crypto.randomUUID() });
  expect(created.status).toBe(200);
  const { outcome } = created.body['data'] as { outcome: { group_id: string; invite_id: string } };
  const share = (await edge(owner, 'get_invite_share_link', { invite_id: outcome.invite_id })).body[
    'data'
  ] as { share_url: string; code: string };
  const member = await createActor(request, `${slug}-membro`, authIds, { name: 'Joana Lima' });
  expect(
    (await edge(member, 'join_by_code', { code: share.code, request_id: crypto.randomUUID() }))
      .status,
  ).toBe(200);
  expect(
    (
      await edge(owner, 'approve_member', {
        group_id: outcome.group_id,
        profile_id: member.profileId,
        approve: true,
        request_id: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200);
  return {
    owner,
    member,
    groupId: outcome.group_id,
    inviteId: outcome.invite_id,
    code: share.code,
    token: new URL(share.share_url).hash.slice(7),
  };
}

/** The page shows exactly the group's public face: icon, name, members, owner. */
async function expectGroupPage(page: Page, name: string) {
  await expect(page.getByTestId('join-confirmation')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByTestId('invite-page-header')).toBeFocused();
  await expect(page.getByTestId('invite-page-members')).toHaveText('2 membros');
  await expect(page.getByTestId('invite-page-owner')).toContainText('Capitão');
  await expect(page.getByTestId('invite-page-owner')).toContainText('Dono');
  await expect(page.getByTestId('invite-page-header').locator('svg').first()).toBeVisible();
  // No label above the title, no new help text.
  await expect(page.getByText('Convite', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('group-code')).toHaveCount(0);
}

/** Every preview answer the browser saw: only the eight fields, nothing of anyone else. */
function watchPreviews(page: Page, forbidden: () => string[]) {
  const seen: Record<string, unknown>[] = [];
  page.on('response', async (response) => {
    if (!/\/groups\/preview_group_by_(code|invite)$/u.test(new URL(response.url()).pathname))
      return;
    const body = (await response.json()) as { data?: Record<string, unknown> };
    if (body.data) seen.push(body.data);
  });
  return async () => {
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    for (const data of seen) {
      expect(Object.keys(data).sort()).toEqual(pageFields);
      const text = JSON.stringify(data);
      for (const value of forbidden()) expect(text.includes(value)).toBe(false);
    }
  };
}

test('Convite: the typed code opens the group page, then the request goes to Grupos', async ({
  page,
  request,
}, testInfo) => {
  await phone(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const group = await groupWithMember(request, authIds, 'Racha de Quinta');
    const visitor = await createActor(request, 'codigo-visita', authIds, { name: 'Rui Souza' });
    const checkPreviews = watchPreviews(page, () => [
      group.owner.profileId,
      group.member.profileId,
      group.owner.email,
      group.member.email,
      'Joana',
    ]);
    await login(page, visitor);
    await page.goto('/join');
    await page.getByTestId('group-code').fill(group.code);
    await page.getByTestId('preview-code').click();
    await expectGroupPage(page, 'Racha de Quinta');
    await expect(page.getByTestId('join-submit')).toHaveText('Pedir para entrar');
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'convite-codigo.png');
    // Back to the form keeps the code to try again; the page leaves memory.
    await page.getByTestId('invite-page-back').click();
    await expect(page.getByTestId('group-code')).toBeFocused();
    await expect(page.getByTestId('join-confirmation')).toHaveCount(0);
    await page.getByTestId('preview-code').click();
    await expectGroupPage(page, 'Racha de Quinta');
    await page.getByTestId('join-submit').click();
    // #73: the request goes to Grupos, replacing the form, with "Pedido enviado."
    await expect(page.getByTestId('group-request-sent')).toHaveText(/^Pedido enviado\./u);
    await expect(page).toHaveURL(/\/grupos\?requested=1$/u);
    await expect(page.getByTestId('pending-group-card')).toContainText('Racha de Quinta');
    // The same code again: the page says the request is waiting, with no button.
    await page.goto('/join');
    await page.getByTestId('group-code').fill(group.code);
    await page.getByTestId('preview-code').click();
    await expect(page.getByTestId('join-pending')).toHaveText('Aguardando aprovação');
    await expect(page.getByTestId('join-submit')).toHaveCount(0);
    await expect(page.getByTestId('join-open-group')).toHaveCount(0);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'convite-pendente.png');
    await checkPreviews();
    const uses = await db.query('select used_count from public.group_invites where id=$1', [
      group.inviteId,
    ]);
    // The member's request and the visitor's: the previews consumed nothing.
    expect(uses.rows[0].used_count).toBe(2);
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('Convite: a QR read by the camera opens the same page, and a member opens the group', async ({
  page,
  request,
}, testInfo) => {
  await phone(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const group = await groupWithMember(request, authIds, 'Racha do QR');
    await simulateCamera(page, `${origin}/join#token=${group.token}`);
    const checkPreviews = watchPreviews(page, () => [group.owner.profileId, group.owner.email]);
    await login(page, group.member);
    await page.goto('/join');
    await page.getByTestId('read-invite-qr').click();
    await expectGroupPage(page, 'Racha do QR');
    await stopped(page);
    await expect(page.getByTestId('join-submit')).toHaveCount(0);
    await expect(page.getByTestId('join-open-group')).toHaveText('Abrir grupo');
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'convite-qr-membro.png');
    await checkPreviews();
    await page.getByTestId('join-open-group').click();
    await expect(page).toHaveURL(new RegExp(`/grupos/${group.groupId}$`, 'u'));
    await expect(page.getByTestId('group-detail-card')).toContainText('Racha do QR');
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('Convite: the link before login comes back to the page after signing in', async ({
  page,
  request,
}, testInfo) => {
  await phone(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const group = await groupWithMember(request, authIds, 'Racha do Link');
    const visitor = await createActor(request, 'link-visita', authIds, { name: 'Bia Melo' });
    const checkPreviews = watchPreviews(page, () => [group.owner.profileId, group.owner.email]);
    await page.goto(`/join#token=${group.token}`);
    await expect.poll(() => page.evaluate(() => location.hash.length)).toBe(0);
    await expect(page.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
    await submitLogin(page, visitor);
    await expectGroupPage(page, 'Racha do Link');
    await expect(page).toHaveURL(/\/join$/u);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'convite-link.png');
    await checkPreviews();
    // Until used, the token is only in this tab's sessionStorage (colete:invite,
    // polimento final); never the URL, history or localStorage.
    const places = (token: string) =>
      page.evaluate(
        (token) => [
          location.href.includes(token),
          JSON.stringify(history.state ?? null).includes(token),
          Object.keys(localStorage).some((key) => localStorage.getItem(key)?.includes(token)),
          Object.keys(sessionStorage)
            .filter((key) => sessionStorage.getItem(key)?.includes(token))
            .join(','),
        ],
        token,
      );
    expect(await places(group.token)).toEqual([false, false, false, 'colete:invite']);
    await page.getByTestId('join-submit').click();
    await expect(page.getByTestId('group-request-sent')).toHaveText(/^Pedido enviado\./u);
    expect(await places(group.token)).toEqual([false, false, false, '']);
    // A signed-in person following the link lands on the page directly.
    await page.goto('/grupos');
    await page.goto(`/join#token=${group.token}`);
    await expect(page.getByTestId('join-pending')).toHaveText('Aguardando aprovação');
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('Convite: a full group shows its page with the current refusal', async ({
  page,
  request,
}, testInfo) => {
  await phone(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const group = await groupWithMember(request, authIds, 'Racha Cheio');
    const visitor = await createActor(request, 'cheio-visita', authIds, { name: 'Lia Prado' });
    await db.query(
      "update private.app_limits set limit_value=2 where limit_key='max_group_capacity'",
    );
    await login(page, visitor);
    await page.goto('/join');
    await page.getByTestId('group-code').fill(group.code);
    await page.getByTestId('preview-code').click();
    await expectGroupPage(page, 'Racha Cheio');
    await expect(page.getByTestId('join-refusal')).toHaveText(
      'Este grupo está cheio. Procure quem organiza o grupo.',
    );
    await expect(page.getByTestId('join-submit')).toHaveCount(0);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'convite-cheio.png');
  } finally {
    await db.query(
      "update private.app_limits set limit_value=100 where limit_key='max_group_capacity'",
    );
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('Convite: unknown, expired and revoked codes get the same generic answer', async ({
  page,
  request,
}, testInfo) => {
  await phone(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const group = await groupWithMember(request, authIds, 'Racha Fechado');
    const visitor = await createActor(request, 'generico-visita', authIds, { name: 'Téo Dias' });
    const answers: string[] = [];
    page.on('response', async (response) => {
      if (new URL(response.url()).pathname.endsWith('/groups/preview_group_by_code')) {
        const body = (await response.json()) as { error?: { code: string; message: string } };
        answers.push(`${response.status()} ${JSON.stringify(body.error ?? body)}`);
      }
    });
    await login(page, visitor);
    await page.goto('/join');
    const messages: string[] = [];
    async function tryCode(code: string) {
      await page.getByTestId('group-code').fill(code);
      await page.getByTestId('preview-code').click();
      await expect(page.getByTestId('preview-error')).toBeVisible();
      await expect(page.getByTestId('join-confirmation')).toHaveCount(0);
      messages.push(await page.getByTestId('preview-error').innerText());
    }
    await tryCode('22222-22222');
    await db.query(
      "update public.group_invites set expires_at=now()-interval '1 second' where id=$1",
      [group.inviteId],
    );
    await tryCode(group.code);
    await db.query(
      "update public.group_invites set expires_at=now()+interval '1 day', revoked_at=now() where id=$1",
      [group.inviteId],
    );
    await tryCode(group.code);
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'convite-invalido.png');
    expect(messages).toEqual(Array(3).fill(messages[0]));
    expect(messages[0]).toContain('inválido');
    await expect.poll(() => answers.length).toBe(3);
    expect(answers).toEqual(Array(3).fill(answers[0]));
    expect(answers[0]).toMatch(/^400 .*"code":"CODE_INVALID"/u);
    expect(answers.join(' ').includes('Racha Fechado')).toBe(false);
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});
