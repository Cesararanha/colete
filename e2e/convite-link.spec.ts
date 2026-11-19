import { beginCleanup } from './support/cleanup';
import { expect, test, type APIRequestContext, type Browser, type Page } from './support/csp';
import jsQR from 'jsqr';
import pg from 'pg';
import sharp from 'sharp';

import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';

// Polimento final, pedido do César: the invitation link, or its QR read by the
// phone's own camera (outside the app), lands on the group's page with no code
// to type, signed in or not, for an existing or a new account, and a reload
// on any step does not lose it. The four paths run on both screen sizes.
const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-convite-link-2026';
const prefix = `convite-link-${Date.now()}-${process.pid}`;
const KEPT = 'colete:invite';
type Actor = { authId: string; profileId: string; token: string; email: string };

test.use({ colorScheme: 'dark' });

async function phone(page: Page, project: string) {
  if (project === 'mobile-chromium') await page.setViewportSize({ width: 390, height: 844 });
}

async function freshPage(browser: Browser, project: string, use: object) {
  const context = await browser.newContext({ ...use, serviceWorkers: 'allow' });
  const page = await context.newPage();
  await phone(page, project);
  return page;
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
  name: string,
) {
  const email = `${prefix}-${label}@colete.test`;
  const { id } = await createVerifiedUser(request, env, { email, name, password });
  authIds.push(id);
  const signed = await request.post(`${env.apiUrl}/auth/v1/token?grant_type=password`, {
    data: { email, password },
    headers: { apikey: env.publishableKey },
  });
  const session = (await signed.json()) as { access_token: string };
  const profiled = await request.post(`${env.functionsUrl}/identity/complete_profile`, {
    data: { request_id: crypto.randomUUID(), profile: { name } },
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

async function cleanActors(authIds: string[], emails: string[]) {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  try {
    const signedUp = await db.query('select id from auth.users where email = any($1::text[])', [
      emails,
    ]);
    for (const { id } of signedUp.rows as { id: string }[])
      if (!authIds.includes(id)) authIds.push(id);
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
    // The sign up through the app leaves its flow in auth.flow_state (BB-035).
    await db.query('delete from auth.flow_state where user_id = any($1::uuid[])', [authIds]);
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
  } finally {
    await db.end();
  }
}

/** A group with its owner and its live invitation link (the share URL the QR carries). */
async function groupWithLink(request: APIRequestContext, authIds: string[], name: string) {
  const owner = await createActor(request, `${name.replace(/\W+/gu, '-')}-dono`, authIds, 'Dono');
  const created = await edge(owner, 'create_group', { name, request_id: crypto.randomUUID() });
  expect(created.status).toBe(200);
  const { outcome } = created.body['data'] as { outcome: { group_id: string; invite_id: string } };
  const share = (await edge(owner, 'get_invite_share_link', { invite_id: outcome.invite_id })).body[
    'data'
  ] as { share_url: string };
  const url = new URL(share.share_url);
  return {
    owner,
    groupId: outcome.group_id,
    shareUrl: share.share_url,
    link: `${url.pathname}${url.hash}`,
    token: url.hash.slice(7),
  };
}

async function submitLogin(page: Page, email: string) {
  await page.getByTestId('login-email').fill(email);
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

/** The group's page, with the code already applied: nothing to type. */
async function expectGroupPage(page: Page, name: string) {
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByTestId('join-confirmation')).toBeVisible();
  await expect(page.getByTestId('invite-page-header')).toBeFocused();
  await expect(page.getByTestId('group-code')).toHaveCount(0);
  await expect(page).toHaveURL(/\/join$/u);
}

/**
 * Where the token is: only this tab's sessionStorage under KEPT, with a
 * deadline within thirty minutes, until used; never the URL, history,
 * localStorage or a cache.
 */
async function tokenPlaces(page: Page, token: string) {
  return page.evaluate(
    async ({ token, key }) => {
      const places: string[] = [];
      if (location.href.includes(token)) places.push('url');
      if (JSON.stringify(history.state ?? null).includes(token)) places.push('history');
      for (const name of Object.keys(localStorage))
        if (localStorage.getItem(name)?.includes(token)) places.push(`local:${name}`);
      for (const name of Object.keys(sessionStorage)) {
        const value = sessionStorage.getItem(name) ?? '';
        if (!value.includes(token)) continue;
        const kept = JSON.parse(value) as { expiresAt?: number };
        const fresh =
          name === key &&
          typeof kept.expiresAt === 'number' &&
          kept.expiresAt <= Date.now() + 30 * 60 * 1000;
        places.push(fresh ? 'kept' : `session:${name}`);
      }
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          if (request.url.includes(token) || (response && (await response.text()).includes(token)))
            places.push(`cache:${name}`);
        }
      }
      return places;
    },
    { token, key: KEPT },
  );
}

/**
 * Where a sign up waiting for its code is: only this tab's sessionStorage
 * under colete:pending-signup (the e-mail, with a deadline within the code's
 * hour); never localStorage, and never the password, the code or the name.
 */
async function signupPlaces(page: Page, email: string, secrets: string[]) {
  return page.evaluate(
    ({ email, secrets }) => {
      const places: string[] = [];
      // The Supabase session (sb-…) holds the account by design; this census is
      // about what the app keeps for the sign up.
      const stores = [
        ...Object.keys(localStorage)
          .filter((key) => !key.startsWith('sb-'))
          .map((key) => [`local:${key}`, localStorage.getItem(key)]),
        ...Object.keys(sessionStorage).map((key) => [
          `session:${key}`,
          sessionStorage.getItem(key),
        ]),
      ] as [string, string | null][];
      for (const [name, value] of stores) {
        if (secrets.some((secret) => value?.includes(secret))) places.push(`secret:${name}`);
        if (!value?.includes(email)) continue;
        const kept = JSON.parse(value) as { expiresAt?: number };
        places.push(
          name === 'session:colete:pending-signup' &&
            typeof kept.expiresAt === 'number' &&
            kept.expiresAt <= Date.now() + 60 * 60 * 1000
            ? 'kept'
            : name,
        );
      }
      return places;
    },
    { email, secrets },
  );
}

async function readOtp(request: APIRequestContext, email: string) {
  let code: string | null = null;
  await expect
    .poll(
      async () => {
        const inbox = (await (await request.get(`${env.mailUrl}/api/v1/messages`)).json()) as {
          messages?: { ID: string; To?: { Address?: string }[] }[];
        };
        const message = (inbox.messages ?? []).find((item) =>
          item.To?.some((to) => to.Address?.toLowerCase() === email.toLowerCase()),
        );
        if (message === undefined) return null;
        const detail = (await (
          await request.get(`${env.mailUrl}/api/v1/message/${message.ID}`)
        ).json()) as { HTML?: string; Text?: string };
        code = `${detail.Text ?? ''}\n${detail.HTML ?? ''}`.match(/\b(\d{6})\b/u)?.[1] ?? null;
        if (code !== null)
          await request.delete(`${env.mailUrl}/api/v1/messages`, { data: { IDs: [message.ID] } });
        return code;
      },
      { intervals: [250, 500, 1_000], timeout: 15_000 },
    )
    .not.toBeNull();
  return code!;
}

test('Convite pelo link: signed in, the link opens the group page, also after a reload', async ({
  browser,
  page,
  request,
}, testInfo) => {
  await phone(page, testInfo.project.name);
  const authIds: string[] = [];
  try {
    const group = await groupWithLink(request, authIds, 'Racha do Link Logado');
    const visitor = await createActor(request, 'logado', authIds, 'Rui Souza');
    await page.goto('/entrar');
    await submitLogin(page, visitor.email);
    await expect(page.getByRole('heading', { name: 'Grupos', level: 1 })).toBeVisible();
    await page.goto(group.link);
    await expectGroupPage(page, 'Racha do Link Logado');
    await expect(page.getByTestId('join-submit')).toHaveText('Pedir para entrar');
    expect(await tokenPlaces(page, group.token)).toEqual(['kept']);
    // Before the fix a reload here fell back to the form asking for the code.
    await page.reload();
    await expectGroupPage(page, 'Racha do Link Logado');
    await assertAccessible(page);
    await page.getByTestId('join-submit').click();
    await expect(page.getByTestId('group-request-sent')).toHaveText(/^Pedido enviado\./u);
    // Used: the invitation left the tab.
    expect(await tokenPlaces(page, group.token)).toEqual([]);
    // The request already sent: the same link says it is waiting.
    await page.goto(group.link);
    await expect(page.getByTestId('join-pending')).toHaveText('Aguardando aprovação');
    await expect(page.getByTestId('join-submit')).toHaveCount(0);
    expect(await tokenPlaces(page, group.token)).toEqual([]);
    // A member following the link opens the group, through a real link.
    const owner = await freshPage(browser, testInfo.project.name, testInfo.project.use);
    try {
      await owner.goto('/entrar');
      await submitLogin(owner, group.owner.email);
      await expect(owner.getByRole('heading', { name: 'Grupos', level: 1 })).toBeVisible();
      await owner.goto(group.link);
      const open = owner.getByTestId('join-open-group');
      await expect(open).toHaveText('Abrir grupo');
      // A member has no use for the link: nothing of it stays in the tab.
      expect(await tokenPlaces(owner, group.token)).toEqual([]);
      await expect(open).toHaveAttribute('href', `/grupos/${group.groupId}`);
      await open.click();
      await expect(owner).toHaveURL(new RegExp(`/grupos/${group.groupId}$`, 'u'));
      expect(await tokenPlaces(owner, group.token)).toEqual([]);
    } finally {
      await owner.context().close();
    }
    // An invalid link: today's generic message, and nothing is kept.
    const broken = `/join#token=${'A'.repeat(88)}`;
    await page.goto(broken);
    await expect(page.getByTestId('preview-error')).toContainText('inválido');
    await expect.poll(() => tokenPlaces(page, 'A'.repeat(88))).toEqual([]);
  } finally {
    await cleanActors(authIds, []);
  }
});

test('Convite pelo link: without a session, an existing account signs in and lands on the page', async ({
  page,
  request,
}, testInfo) => {
  await phone(page, testInfo.project.name);
  const authIds: string[] = [];
  try {
    const group = await groupWithLink(request, authIds, 'Racha da Conta Existente');
    const visitor = await createActor(request, 'existente', authIds, 'Bia Melo');
    await page.goto(group.link);
    await expect(page.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
    await expect.poll(() => page.evaluate(() => location.hash.length)).toBe(0);
    expect(await tokenPlaces(page, group.token)).toEqual(['kept']);
    // Before the fix a reload on Entrar lost the invitation: login went to Grupos.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
    await submitLogin(page, visitor.email);
    await expectGroupPage(page, 'Racha da Conta Existente');
    await page.reload();
    await expectGroupPage(page, 'Racha da Conta Existente');
    await page.getByTestId('join-submit').click();
    await expect(page.getByTestId('group-request-sent')).toHaveText(/^Pedido enviado\./u);
    await expect(page).toHaveURL(/\/grupos\?requested=1$/u);
    expect(await tokenPlaces(page, group.token)).toEqual([]);
  } finally {
    await cleanActors(authIds, []);
  }
});

test('Convite pelo link: without an account, the sign up, its e-mail code and the profile end on the page', async ({
  page,
  request,
}, testInfo) => {
  await phone(page, testInfo.project.name);
  const authIds: string[] = [];
  const email = `${prefix}-nova-${testInfo.project.name}@colete.test`;
  try {
    const group = await groupWithLink(request, authIds, 'Racha da Conta Nova');
    await page.goto(group.link);
    await expect(page.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
    await page.reload();
    await page.getByRole('link', { name: 'Criar conta' }).click();
    await page.getByTestId('signup-name').fill('Nina Prado');
    await page.getByTestId('signup-email').fill(email);
    await page.getByTestId('signup-password').fill(password);
    await page.getByTestId('signup-confirm-password').fill(password);
    await page.getByRole('button', { name: 'Enviar código' }).click();
    await expect(page).toHaveURL(/\/verificar-codigo$/u);
    const code = await readOtp(request, email);
    // rev84 P1: back from the e-mail app, the tab reloads on "Verificar código";
    // the code field is still there for the code already received.
    await page.reload();
    await expect(page.getByText(`Código enviado para ${email}.`)).toBeVisible();
    expect(await signupPlaces(page, email, [password, code, 'Nina Prado'])).toEqual(['kept']);
    await page.getByLabel('Código de 6 dígitos').fill(code);
    await page.getByRole('button', { name: 'Verificar e continuar' }).click();
    // First access: "Complete seu perfil" comes first, on the invitation's route.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Complete seu perfil' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/join$/u);
    // Bugbash BB-032: only the name is required, and the screen says so.
    await expect(page.getByText('Só o nome é obrigatório; o resto é opcional.')).toBeVisible();
    // Before the fix a reload here ended on the form asking for the code.
    await page.reload();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Complete seu perfil' }),
    ).toBeVisible();
    expect(await tokenPlaces(page, group.token)).toEqual(['kept']);
    // Accepted: the e-mail left the tab.
    expect(await signupPlaces(page, email, [password, code, 'Nina Prado'])).toEqual([]);
    await page.getByTestId('complete-profile-name').fill('Nina Prado');
    await page.getByTestId('complete-profile-submit').click();
    await expectGroupPage(page, 'Racha da Conta Nova');
    await expect(page.getByTestId('join-submit')).toHaveText('Pedir para entrar');
    await assertAccessible(page);
    await page.getByTestId('join-submit').click();
    await expect(page.getByTestId('group-request-sent')).toHaveText(/^Pedido enviado\./u);
    expect(await tokenPlaces(page, group.token)).toEqual([]);
  } finally {
    await cleanActors(authIds, [email]);
  }
});

test('Convite pelo QR: the phone camera opens the same link, signed out and signed in', async ({
  browser,
  page,
  request,
}, testInfo) => {
  await phone(page, testInfo.project.name);
  const authIds: string[] = [];
  try {
    const group = await groupWithLink(request, authIds, 'Racha do QR da Câmera');
    const visitor = await createActor(request, 'camera', authIds, 'Téo Dias');
    // The QR the owner shows, decoded as the phone's camera app does.
    await page.goto('/entrar');
    await submitLogin(page, group.owner.email);
    await expect(page.getByRole('heading', { name: 'Grupos', level: 1 })).toBeVisible();
    await page.goto(`/grupos/${group.groupId}/convites`);
    let scanned: string | null = null;
    await expect
      .poll(async () => {
        const png = await page.getByTestId('invite-qr-code').screenshot({ scale: 'css' });
        const { data, info } = await sharp(png)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        scanned = jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
        return scanned === group.shareUrl;
      })
      .toBe(true);
    // The camera opens the link in the browser, where nobody is signed in.
    const outside = await freshPage(browser, testInfo.project.name, testInfo.project.use);
    try {
      await outside.goto(scanned!);
      await expect(outside.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
      await outside.reload();
      await submitLogin(outside, visitor.email);
      await expectGroupPage(outside, 'Racha do QR da Câmera');
      await expect(outside.getByTestId('join-submit')).toHaveText('Pedir para entrar');
      // The same camera, now signed in: straight to the page, after a reload too.
      await outside.goto('/grupos');
      await outside.goto(scanned!);
      await expectGroupPage(outside, 'Racha do QR da Câmera');
      await outside.reload();
      await expectGroupPage(outside, 'Racha do QR da Câmera');
      await outside.getByTestId('join-submit').click();
      await expect(outside.getByTestId('group-request-sent')).toHaveText(/^Pedido enviado\./u);
      expect(await tokenPlaces(outside, group.token)).toEqual([]);
    } finally {
      await outside.context().close();
    }
  } finally {
    await cleanActors(authIds, []);
  }
});
