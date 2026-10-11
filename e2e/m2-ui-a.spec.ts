import {
  expect,
  request as apiRequest,
  test,
  type APIRequestContext,
  type Page,
} from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';

const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-group-test-2026';
const prefix = `ui-a-${Date.now()}-${process.pid}`;
const screenshotRoot = process.env['COLETE_UI_A_SCREENSHOTS_DIR'];
type Actor = { authId: string; profileId: string; token: string; email: string };
const darkRoutes = new WeakMap<Page, Set<string>>();

async function assertUiAccessible(page: Page) {
  await assertAccessible(page);
  let visibleKeyboardFocus = false;
  for (let step = 0; step < 20 && !visibleKeyboardFocus; step += 1) {
    await page.keyboard.press('Tab');
    visibleKeyboardFocus = await page.evaluate(() => {
      const element = document.activeElement;
      return (
        element instanceof HTMLElement &&
        element !== document.body &&
        element.matches(':focus-visible') &&
        parseFloat(getComputedStyle(element).outlineWidth) > 0
      );
    });
  }
  expect(visibleKeyboardFocus).toBe(true);
  const route = new URL(page.url()).pathname.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gu, '/:id');
  const checked = darkRoutes.get(page) ?? new Set<string>();
  if (!checked.has(route)) {
    const darkTheme = page.getByRole('button', { name: 'Usar tema escuro' });
    await darkTheme.click();
    await assertAccessible(page);
    await page.getByRole('button', { name: 'Usar tema claro' }).click();
    checked.add(route);
    darkRoutes.set(page, checked);
  }
}

async function mobileWidth(page: Page, project: string) {
  if (project === 'mobile-chromium') await page.setViewportSize({ width: 320, height: 700 });
}

function captureLocalScreenshots(project: string): boolean {
  return project === 'mobile-chromium' && !!screenshotRoot && existsSync(screenshotRoot);
}

async function browserLeakCensus(page: Page, marker: string): Promise<boolean> {
  return page.evaluate(async (needle) => {
    const stores = [
      window.location.href,
      document.referrer,
      JSON.stringify(history.state),
      ...Object.keys(localStorage).map((key) => `${key}:${localStorage.getItem(key)}`),
      ...Object.keys(sessionStorage).map((key) => `${key}:${sessionStorage.getItem(key)}`),
    ];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        stores.push(request.url);
        const response = await cache.match(request);
        if (response) stores.push(await response.text());
      }
    }
    return stores.every((value) => !value.includes(needle));
  }, marker);
}

async function browserLeakCounterproof(page: Page) {
  const canary = `invite-census-${crypto.randomUUID()}`;
  expect(await browserLeakCensus(page, canary)).toBe(true);
  await page.evaluate(
    (value) => history.replaceState(history.state, '', `${location.pathname}#${value}`),
    canary,
  );
  expect(await browserLeakCensus(page, canary)).toBe(false);
  await page.evaluate(() => history.replaceState(history.state, '', location.pathname));
  const previousState = await page.evaluate(() => history.state);
  await page.evaluate(
    (value) => history.replaceState({ uiACensus: value }, '', location.pathname),
    canary,
  );
  expect(await browserLeakCensus(page, canary)).toBe(false);
  await page.evaluate((value) => history.replaceState(value, '', location.pathname), previousState);
  await page.evaluate((value) => localStorage.setItem('ui-a-census', value), canary);
  expect(await browserLeakCensus(page, canary)).toBe(false);
  await page.evaluate(() => localStorage.removeItem('ui-a-census'));
  await page.evaluate((value) => sessionStorage.setItem('ui-a-census', value), canary);
  expect(await browserLeakCensus(page, canary)).toBe(false);
  await page.evaluate(() => sessionStorage.removeItem('ui-a-census'));
  await page.evaluate(async (value) => {
    const cache = await caches.open('ui-a-census');
    await cache.put('/ui-a-census', new Response(value));
  }, canary);
  expect(await browserLeakCensus(page, canary)).toBe(false);
  await page.evaluate(() => caches.delete('ui-a-census'));
}

async function edge(
  request: APIRequestContext,
  actor: Actor,
  operation: string,
  body: Record<string, unknown>,
) {
  const response = await request.post(`${env.functionsUrl}/groups/${operation}`, {
    data: body,
    headers: { Authorization: `Bearer ${actor.token}` },
  });

  const value = (await response.json()) as {
    data?: Record<string, unknown>;
    error?: { code: string };
  };
  return { status: response.status(), value };
}

async function createActor(
  request: APIRequestContext,
  label: string,
  authIds: string[],
): Promise<Actor> {
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
  };
}

async function cleanActors(authIds: string[], db: pg.Client) {
  if (authIds.length === 0) return;
  const profiles = await db.query(
    'select id from public.profiles where auth_user_id = any($1::uuid[])',
    [authIds],
  );
  const ids = profiles.rows.map((row: { id: string }) => row.id);
  await db.query('begin');
  try {
    await db.query('delete from private.invite_rate_limits where profile_id = any($1::uuid[])', [
      ids,
    ]);
    await db.query('delete from private.idempotency_records where actor_id = any($1::uuid[])', [
      ids,
    ]);
    await db.query('delete from private.revoked_auth_sessions where profile_id = any($1::uuid[])', [
      ids,
    ]);
    await db.query(
      `delete from public.group_invites where group_id in
      (select id from public.groups where owner_id = any($1::uuid[]))`,
      [ids],
    );
    await db.query(
      `delete from public.group_members where group_id in
      (select id from public.groups where owner_id = any($1::uuid[]))`,
      [ids],
    );
    await db.query('delete from public.groups where owner_id = any($1::uuid[])', [ids]);
    await db.query('delete from public.profiles where id = any($1::uuid[])', [ids]);
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
  // Auth Admin is the fixture boundary; bound concurrency keeps the 100-user
  // cleanup inside the normal Playwright deadline on slower CI runners.
  // Node fetch also keeps the local admin key out of Playwright call logs.
  const failures: Array<number | 'transport'> = [];
  for (let start = 0; start < authIds.length; start += 12) {
    const deleted = await Promise.allSettled(
      authIds.slice(start, start + 12).map(async (id) => {
        const response = await fetch(`${env.apiUrl}/auth/v1/admin/users/${id}`, {
          method: 'DELETE',
          headers: {
            apikey: env.secretKey,
            Authorization: `Bearer ${env.secretKey}`,
          },
        });
        return response.status;
      }),
    );
    for (const result of deleted) {
      if (result.status === 'rejected') failures.push('transport');
      else if (result.value !== 404 && (result.value < 200 || result.value >= 300)) {
        failures.push(result.value);
      }
    }
  }
  expect(failures).toEqual([]);
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
  await expect(page.getByRole('heading', { name: 'Perfil', level: 1 })).toBeVisible();
}

test('UI-A creates, lists, shares, previews and requests membership with a clean URL', async ({
  page,
  request,
}, testInfo) => {
  await mobileWidth(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const countBefore = await db.query('select count(*)::integer as count from auth.users');
    expect(countBefore.rows[0].count).toBe(0);
    const owner = await createActor(request, 'owner', authIds);
    await login(page, owner);
    await page.getByRole('link', { name: 'Grupos' }).click();
    await expect(page.getByText('Você ainda não participa de um grupo')).toBeVisible();
    await assertUiAccessible(page);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '10-vazio.png'),
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: 'Criar grupo' }).press('Enter');
    await expect(page.getByRole('heading', { name: 'Criar grupo', level: 1 })).toBeVisible();
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '16-formulario.png'),
        fullPage: true,
      });
    }
    await page.getByTestId('create-group-submit').press('Enter');
    await expect(page.getByTestId('group-name')).toHaveAttribute('aria-invalid', 'true');
    await assertUiAccessible(page);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '16-erro.png'),
        fullPage: true,
      });
    }
    await page.getByTestId('group-name').fill('Racha da Firma');
    await page.getByTestId('create-group-submit').click();
    await expect(page.getByTestId('group-invites-card')).toBeVisible();
    const code = await page.getByTestId('invite-code').innerText();
    const link = await page.getByTestId('invite-link').innerText();
    expect(code.length).toBe(11);
    expect(new URL(link).pathname).toBe('/join');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: 'Copiar código' }).press('Enter');
    expect(
      await page.evaluate(
        async (expected) => (await navigator.clipboard.readText()) === expected,
        code,
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Copiar link' }).press('Enter');
    expect(
      await page.evaluate(
        async (expected) => (await navigator.clipboard.readText()) === expected,
        link,
      ),
    ).toBe(true);
    expect(await browserLeakCensus(page, code)).toBe(true);
    await browserLeakCounterproof(page);
    await assertUiAccessible(page);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '24-dados.png'),
        fullPage: true,
        mask: [page.getByTestId('invite-code'), page.getByTestId('invite-link')],
      });
      await page.getByTestId('invite-link').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: path.join(screenshotRoot!, '24-link.png'),
        fullPage: true,
        mask: [page.getByTestId('invite-code'), page.getByTestId('invite-link')],
      });
    }
    const groupId = page.url().match(/\/grupos\/([^/]+)\/convites/u)?.[1];
    expect(groupId).toBeDefined();
    await page.goto('/grupos');
    await expect(page.getByTestId('group-list-card')).toBeVisible();
    await assertUiAccessible(page);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '10-com-dados.png'),
        fullPage: true,
      });
    }
    await page.goto(`/grupos/${groupId}`);
    await expect(page.getByRole('heading', { name: 'Racha da Firma', level: 2 })).toBeVisible();
    await assertUiAccessible(page);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '11-com-dados.png'),
        fullPage: true,
      });
    }
    const ownerLeave = page.getByTestId('leave-group');
    await expect(ownerLeave).toHaveAttribute('aria-disabled', 'true');
    await expect(ownerLeave).toHaveAttribute('aria-describedby', 'owner-leave-reason');
    await expect(
      page.getByText('Transfira a titularidade primeiro para sair deste grupo.'),
    ).toBeVisible();
    let ownerLeaveRequests = 0;
    page.on('request', (item) => {
      if (new URL(item.url()).pathname === '/functions/v1/groups/leave_group')
        ownerLeaveRequests += 1;
    });
    await ownerLeave.focus();
    await expect(ownerLeave).toBeFocused();
    await ownerLeave.press('Enter');
    expect(ownerLeaveRequests).toBe(0);
    const rejectedOwner = await edge(request, owner, 'leave_group', {
      group_id: groupId,
      request_id: crypto.randomUUID(),
    });
    expect(rejectedOwner.value.error?.code).toBe('OWNER_MUST_TRANSFER');
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '11-dono-bloqueado.png'),
        fullPage: true,
      });
    }
    await page.goto('/join');
    await page.getByTestId('group-code').fill(code.toLowerCase().replace('-', ' - '));
    await page.getByTestId('preview-code').press('Enter');
    await expect(page.getByTestId('join-confirmation')).toBeVisible();
    await page.getByTestId('join-submit').press('Enter');
    await expect(page.getByTestId('join-active')).toBeVisible();
    const joiner = await createActor(request, 'joiner', authIds);
    const otherGroup = await edge(request, joiner, 'create_group', {
      name: 'Outro Grupo',
      request_id: crypto.randomUUID(),
    });
    expect(otherGroup.status).toBe(200);
    await login(page, joiner);
    await page.goto('/join');
    await assertUiAccessible(page);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '12-vazio.png'),
        fullPage: true,
      });
    }
    const inviteToken = new URL(link).hash.slice(7);
    const seenRequests: { url: string; headers: string; body: string }[] = [];
    const seenLogs: string[] = [];
    page.on('request', (item) =>
      seenRequests.push({
        url: item.url(),
        headers: JSON.stringify(item.headers()),
        body: item.postData() ?? '',
      }),
    );
    page.on('console', (item) => seenLogs.push(item.text()));
    page.on('pageerror', (error) => seenLogs.push(error.message));
    await page.goto(`/join#token=${inviteToken}`);
    await expect.poll(() => page.evaluate(() => window.location.hash.length)).toBe(0);
    await expect(page.getByTestId('join-confirmation')).toBeVisible();
    await expect(page.getByText('Entrar no Racha da Firma?')).toBeVisible();
    const useBefore = await db.query(
      'select used_count from public.group_invites where group_id=$1',
      [groupId],
    );
    expect(useBefore.rows[0].used_count).toBe(0);
    await assertUiAccessible(page);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '12-confirmacao.png'),
        fullPage: true,
      });
    }
    await page.getByTestId('join-submit').click();
    await expect(page.getByTestId('join-pending')).toBeVisible();
    expect(await browserLeakCensus(page, inviteToken)).toBe(true);
    expect(seenLogs.every((item) => !item.includes(inviteToken))).toBe(true);
    expect(
      seenRequests.every(
        (item) =>
          !item.url.includes(inviteToken) &&
          !item.headers.includes(inviteToken) &&
          (!item.body.includes(inviteToken) ||
            ['/preview_group_by_invite', '/join_by_invite'].some((path) =>
              item.url.endsWith(path),
            )),
      ),
    ).toBe(true);
    expect(seenRequests.filter((item) => item.body.includes(inviteToken)).length).toBe(2);
    await page.goBack();
    expect(await browserLeakCensus(page, inviteToken)).toBe(true);
    await page.goForward();
    expect(await browserLeakCensus(page, inviteToken)).toBe(true);
    await page.getByTestId('group-code').fill(code);
    await page.getByTestId('preview-code').click();
    await expect(page.getByTestId('join-confirmation')).toBeVisible();
    await page.getByTestId('join-submit').click();
    await expect(page.getByTestId('join-pending')).toBeVisible();
    const useAfter = await db.query(
      'select used_count from public.group_invites where group_id=$1',
      [groupId],
    );
    expect(useAfter.rows[0].used_count).toBe(1);
    await page.getByRole('link', { name: 'Grupos' }).click();
    await expect(page.getByTestId('pending-group-card')).toBeVisible();
    await assertUiAccessible(page);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '10-pendente.png'),
        fullPage: true,
      });
    }
    const approved = await edge(request, owner, 'approve_member', {
      group_id: groupId,
      profile_id: joiner.profileId,
      approve: true,
      request_id: crypto.randomUUID(),
    });
    expect(approved.status).toBe(200);
    await page.goto(`/grupos/${groupId}`);
    await expect(page.getByTestId('leave-group')).not.toHaveAttribute('aria-disabled', 'true');
    const playerLeave = handledObserver(
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/functions/v1/groups/leave_group',
      ),
    );
    await page.getByTestId('leave-group').press('Enter');
    expect((await playerLeave).status()).toBe(200);
    await expect(page.getByTestId('group-left-status')).toBeVisible();
    await expect(page.getByTestId('group-list-card')).toHaveCount(1);
    await page.getByRole('link', { name: 'Perfil' }).click();
    await page.getByRole('link', { name: 'Grupos' }).click();
    await expect(page.getByRole('heading', { name: 'Outro Grupo' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Racha da Firma' })).not.toBeVisible();
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '11-jogador-saiu.png'),
        fullPage: true,
      });
    }
  } finally {
    await cleanActors(authIds, db);
    const countAfter = await db.query('select count(*)::integer as count from auth.users');
    expect(countAfter.rows[0].count).toBe(0);
    await db.end();
  }
});

test.describe('UI-A capacity and final invite use through real Edge state', () => {
  let db: pg.Client;
  let capacityRequest: APIRequestContext;
  let owner: Actor;
  let outcome: { group_id: string; invite_id: string };
  let code: string;
  const authIds: string[] = [];
  const members: Actor[] = [];

  test.beforeAll(async () => {
    capacityRequest = await apiRequest.newContext();
    db = new Client({ connectionString: env.dbUrl });
    await db.connect();
    const baseline = await db.query('select count(*)::integer as count from auth.users');
    expect(baseline.rows[0].count).toBe(0);
    // Local configuration only: the same private admission RPC remains active.
    await db.query(
      "update private.app_limits set limit_value=150 where limit_key='invite_attempts_per_hour'",
    );
    owner = await createActor(capacityRequest, 'capacity-owner', authIds);
    const created = await edge(capacityRequest, owner, 'create_group', {
      name: 'Grupo Lotado',
      request_id: crypto.randomUUID(),
    });
    expect(created.status).toBe(200);
    outcome = created.value.data?.['outcome'] as { group_id: string; invite_id: string };
    const shared = await edge(capacityRequest, owner, 'get_invite_share_link', {
      invite_id: outcome.invite_id,
    });
    expect(shared.status).toBe(200);
    code = shared.value.data?.['code'] as string;
  });

  async function seedActors(from: number, to: number) {
    // Bound GoTrue admin concurrency; every profile still comes from the real Edge.
    for (let start = from; start < to; start += 16) {
      const settled = await Promise.allSettled(
        Array.from({ length: Math.min(16, to - start) }, (_, offset) =>
          createActor(capacityRequest, `capacity-${start + offset}`, authIds),
        ),
      );
      expect(settled.every((item) => item.status === 'fulfilled')).toBe(true);
      members.push(...settled.map((item) => (item as PromiseFulfilledResult<Actor>).value));
    }
  }

  async function seedJoins(from: number, to: number) {
    for (let start = from; start < to; start += 8) {
      const joined = await Promise.allSettled(
        members.slice(start, Math.min(start + 8, to)).map((actor) =>
          edge(capacityRequest, actor, 'join_by_code', {
            code,
            request_id: crypto.randomUUID(),
          }),
        ),
      );
      const joinFailures = joined
        .filter((item) => item.status === 'rejected' || item.value.status !== 200)
        .map((item) =>
          item.status === 'rejected'
            ? 'transport'
            : `${item.value.status}:${item.value.value.error?.code ?? 'unknown'}`,
        );
      expect(joinFailures, `join failure codes: ${joinFailures.join(',')}`).toEqual([]);
    }
  }

  // Separate setup hooks retain the standard 30-second deadline for every step.
  test.beforeAll(async () => seedActors(0, 50));
  test.beforeAll(async () => seedActors(50, 99));
  test.beforeAll(async () => seedJoins(0, 50));
  test.beforeAll(async () => {
    await seedJoins(50, 99);
    const countFull = await db.query(
      `select count(*)::integer as count from public.group_members
        where group_id=$1 and status in ('pending','active')`,
      [outcome.group_id],
    );
    expect(countFull.rows[0].count).toBe(100);
  });

  test('UI-A distinguishes full capacity from the last invitation use through real Edge state', async ({
    page,
    request,
  }, testInfo) => {
    await mobileWidth(page, testInfo.project.name);
    const next = await createActor(request, 'capacity-next', authIds);
    await login(page, next);
    await page.goto('/join');
    await page.getByTestId('group-code').fill(code);
    await page.getByTestId('preview-code').click();
    await expect(page.getByTestId('preview-error')).toContainText('grupo está cheio');
    await assertUiAccessible(page);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '12-grupo-cheio.png'),
        fullPage: true,
        mask: [page.getByTestId('group-code')],
      });
    }
    const first = members[0]!;
    const approved = await edge(request, owner, 'approve_member', {
      group_id: outcome.group_id,
      profile_id: first.profileId,
      approve: true,
      request_id: crypto.randomUUID(),
    });
    expect(approved.status).toBe(200);
    const removed = await edge(request, owner, 'remove_member', {
      group_id: outcome.group_id,
      profile_id: first.profileId,
      reason: 'Ajuste sintético',
      request_id: crypto.randomUUID(),
    });
    expect(removed.status).toBe(200);
    await page.getByTestId('preview-code').click();
    await expect(page.getByTestId('join-confirmation')).toBeVisible();
    await page.getByTestId('join-submit').click();
    await expect(page.getByTestId('join-pending')).toBeVisible();
    const uses = await db.query('select used_count from public.group_invites where id=$1', [
      outcome.invite_id,
    ]);
    expect(uses.rows[0].used_count).toBe(100);
    const second = members[1]!;
    expect(
      (
        await edge(request, owner, 'approve_member', {
          group_id: outcome.group_id,
          profile_id: second.profileId,
          approve: true,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await edge(request, owner, 'remove_member', {
          group_id: outcome.group_id,
          profile_id: second.profileId,
          reason: 'Ajuste sintético',
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    const final = await createActor(request, 'capacity-final', authIds);
    await login(page, final);
    await page.goto('/join');
    await page.getByTestId('group-code').fill(code);
    await page.getByTestId('preview-code').click();
    await expect(page.getByTestId('preview-error')).toContainText('esgotou os usos');
    const vacancy = await db.query(
      `select count(*)::integer as count from public.group_members
        where group_id=$1 and status in ('pending','active')`,
      [outcome.group_id],
    );
    expect(vacancy.rows[0].count).toBe(99);
    await assertUiAccessible(page);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '12-convite-esgotado.png'),
        fullPage: true,
        mask: [page.getByTestId('group-code')],
      });
    }
  });

  test.afterAll(async () => {
    try {
      await cleanActors(authIds, db);
      const count = await db.query('select count(*)::integer as count from auth.users');
      expect(count.rows[0].count).toBe(0);
    } finally {
      await db.query(
        "update private.app_limits set limit_value=20 where limit_key='invite_attempts_per_hour'",
      );
      await db.end();
      await capacityRequest.dispose();
    }
  });
});

test('UI-A revokes, issues and regenerates an invitation; quota reports an absolute retry time', async ({
  page,
  request,
}, testInfo) => {
  await mobileWidth(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'invite-owner', authIds);
    const created = await edge(request, owner, 'create_group', {
      name: 'Grupo Convite',
      request_id: crypto.randomUUID(),
    });
    expect(created.status).toBe(200);
    const outcome = created.value.data?.['outcome'] as { group_id: string; invite_id: string };
    await login(page, owner);
    let shareInterrupted = false;
    await page.route('**/functions/v1/groups/get_invite_share_link', (route) => {
      if (!shareInterrupted) {
        shareInterrupted = true;
        return route.abort('failed');
      }
      return route.continue();
    });
    await page.goto(`/grupos/${outcome.group_id}/convites`);
    await expect(
      page.getByText('A rede não respondeu. Confira a conexão e tente novamente.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
    await assertUiAccessible(page);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '24-erro-rede.png'),
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: 'Tentar de novo' }).click();
    await expect(page.getByTestId('invite-code')).toBeVisible();
    const original = await page.getByTestId('invite-code').innerText();
    await page.getByRole('button', { name: 'Revogar convite', exact: true }).click();
    await expect(page.getByTestId('revoke-confirmation')).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar revogação' }).click();
    await expect(page.getByRole('button', { name: 'Emitir novo convite' })).toBeVisible();
    await assertUiAccessible(page);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '24-terminal.png'),
        fullPage: true,
      });
    }
    const joiner = await createActor(request, 'invite-joiner', authIds);
    await login(page, joiner);
    await page.goto('/join');
    await page.getByTestId('group-code').fill(original);
    await page.getByTestId('preview-code').click();
    await expect(page.getByTestId('preview-error')).toContainText('foi revogado');
    await assertUiAccessible(page);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '12-revogado.png'),
        fullPage: true,
        mask: [page.getByTestId('group-code')],
      });
    }
    await login(page, owner);
    await page.goto(`/grupos/${outcome.group_id}/convites`);
    await page.getByRole('button', { name: 'Emitir novo convite' }).click();
    await expect(page.getByTestId('invite-code')).toBeVisible();
    const second = await page.getByTestId('invite-code').innerText();
    expect(second === original).toBe(false);
    await page.getByRole('button', { name: 'Regenerar convite' }).click();
    await expect.poll(async () => page.getByTestId('invite-code').innerText()).not.toBe(second);
    const current = await page.getByTestId('invite-code').innerText();
    await login(page, joiner);
    await page.goto('/join');
    await page.getByTestId('group-code').fill(second);
    await page.getByTestId('preview-code').click();
    await expect(page.getByTestId('preview-error')).toContainText('inválido');
    await page.getByTestId('group-code').fill(current);
    await page.getByTestId('preview-code').click();
    await expect(page.getByTestId('join-confirmation')).toBeVisible();
    // Local value changes only the limit. It does not bypass the admission RPC.
    await db.query(
      "update private.app_limits set limit_value=2 where limit_key='invite_attempts_per_hour'",
    );
    const rateActor = await createActor(request, 'invite-rate', authIds);
    await login(page, rateActor);
    await page.goto('/join');
    await page.getByTestId('group-code').fill('22222-22222');
    let availableAt = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const observed = handledObserver(
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/functions/v1/groups/preview_group_by_code',
        ),
      );
      await page.getByTestId('preview-code').click();
      const response = await observed;
      expect(response.status()).toBe(attempt === 2 ? 429 : 400);
      if (attempt === 2) {
        const envelope = (await response.json()) as { error: { available_at: string } };
        availableAt = envelope.error.available_at;
      }
    }
    const expectedTime = new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(availableAt));
    await expect(page.getByTestId('preview-error')).toContainText(
      `Tente novamente a partir de ${expectedTime}.`,
    );
    await assertUiAccessible(page);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '12-limite.png'),
        fullPage: true,
        mask: [page.getByTestId('group-code')],
      });
    }
  } finally {
    await cleanActors(authIds, db);
    await db.query(
      "update private.app_limits set limit_value=20 where limit_key='invite_attempts_per_hour'",
    );
    const count = await db.query('select count(*)::integer as count from auth.users');
    expect(count.rows[0].count).toBe(0);
    await db.end();
  }
});

test('UI-A explains the sixth-group limit without creating another group', async ({
  page,
  request,
}, testInfo) => {
  await mobileWidth(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'limit-owner', authIds);
    for (let index = 0; index < 5; index += 1) {
      const result = await edge(request, owner, 'create_group', {
        name: `Grupo ${index + 1}`,
        request_id: crypto.randomUUID(),
      });
      expect(result.status).toBe(200);
    }
    await login(page, owner);
    await page.goto('/grupos/criar');
    await page.getByTestId('group-name').fill('Grupo Sexto');
    await page.getByTestId('create-group-submit').click();
    await expect(
      page.getByText(
        'Você chegou ao limite de cinco grupos ativos. Saia de um grupo antes de tentar novamente.',
      ),
    ).toBeVisible();
    await assertUiAccessible(page);
    const count = await db.query(
      'select count(*)::integer as count from public.groups where owner_id=$1',
      [owner.profileId],
    );
    expect(count.rows[0].count).toBe(5);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '16-limite.png'),
        fullPage: true,
      });
    }
  } finally {
    await cleanActors(authIds, db);
    const count = await db.query('select count(*)::integer as count from auth.users');
    expect(count.rows[0].count).toBe(0);
    await db.end();
  }
});

test('UI-A preserves an invitation in page memory through login and clears the fragment', async ({
  page,
  request,
}, testInfo) => {
  await mobileWidth(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'link-owner', authIds);
    const created = await edge(request, owner, 'create_group', {
      name: 'Grupo do Link',
      request_id: crypto.randomUUID(),
    });
    expect(created.status).toBe(200);
    const outcome = created.value.data?.['outcome'] as { invite_id: string };
    const shared = await edge(request, owner, 'get_invite_share_link', {
      invite_id: outcome.invite_id,
    });
    expect(shared.status).toBe(200);
    const url = shared.value.data?.['share_url'] as string;
    const inviteToken = new URL(url).hash.slice(7);
    const joiner = await createActor(request, 'link-joiner', authIds);
    let interrupted = false;
    await page.route('**/functions/v1/groups/preview_group_by_invite', (route) => {
      if (!interrupted) {
        interrupted = true;
        return route.abort('failed');
      }
      return route.continue();
    });
    await page.goto(`/join#token=${inviteToken}`);
    await expect.poll(() => page.evaluate(() => location.hash.length)).toBe(0);
    await expect(page.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
    expect(await browserLeakCensus(page, inviteToken)).toBe(true);
    await page.getByTestId('login-email').fill(joiner.email);
    await page.getByTestId('login-password').fill(password);
    const response = handledObserver(
      page.waitForResponse(
        (item) =>
          new URL(item.url()).pathname === '/auth/v1/token' && item.request().method() === 'POST',
      ),
    );
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(page.getByTestId('preview-error')).toContainText('A rede não respondeu');
    await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '12-erro-rede.png'),
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: 'Tentar de novo' }).click();
    await expect(page.getByTestId('join-confirmation')).toBeVisible();
    await expect(page.getByText('Entrar no Grupo do Link?')).toBeVisible();
    await assertUiAccessible(page);
    expect(await browserLeakCensus(page, inviteToken)).toBe(true);
    // Repeat with an authenticated account on a fresh navigation. The hash
    // must disappear before the app can retain it in browser history.
    await page.goto('/grupos');
    await page.goto(`/join#token=${inviteToken}`);
    await expect.poll(() => page.evaluate(() => location.hash.length)).toBe(0);
    await expect(page.getByTestId('join-confirmation')).toBeVisible();
    expect(await browserLeakCensus(page, inviteToken)).toBe(true);
    await page.getByTestId('join-submit').click();
    await expect(page.getByTestId('join-pending')).toBeVisible();
  } finally {
    await cleanActors(authIds, db);
    const count = await db.query('select count(*)::integer as count from auth.users');
    expect(count.rows[0].count).toBe(0);
    await db.end();
  }
});

test('UI-A explains a suspended group before consuming its invitation', async ({
  page,
  request,
}, testInfo) => {
  await mobileWidth(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'suspended-owner', authIds);
    const created = await edge(request, owner, 'create_group', {
      name: 'Grupo Suspenso',
      request_id: crypto.randomUUID(),
    });
    expect(created.status).toBe(200);
    const outcome = created.value.data?.['outcome'] as { group_id: string; invite_id: string };
    const shared = await edge(request, owner, 'get_invite_share_link', {
      invite_id: outcome.invite_id,
    });
    expect(shared.status).toBe(200);
    const code = shared.value.data?.['code'] as string;
    // M2-D11 permits suspended_at and invite expires_at as direct database fixtures.
    await db.query('update public.groups set suspended_at=now() where id=$1', [outcome.group_id]);
    const joiner = await createActor(request, 'suspended-joiner', authIds);
    await login(page, joiner);
    await page.goto('/join');
    await page.getByTestId('group-code').fill(code);
    await page.getByTestId('preview-code').click();
    await expect(page.getByTestId('preview-error')).toContainText('Este grupo está suspenso');
    await assertUiAccessible(page);
    const uses = await db.query('select used_count from public.group_invites where id=$1', [
      outcome.invite_id,
    ]);
    expect(uses.rows[0].used_count).toBe(0);
    const refused = await edge(request, joiner, 'join_by_code', {
      code,
      request_id: crypto.randomUUID(),
    });
    expect(refused.value.error?.code).toBe('GROUP_SUSPENDED');
    const afterRefusal = await db.query('select used_count from public.group_invites where id=$1', [
      outcome.invite_id,
    ]);
    expect(afterRefusal.rows[0].used_count).toBe(0);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '12-suspenso.png'),
        fullPage: true,
        mask: [page.getByTestId('group-code')],
      });
    }
  } finally {
    await cleanActors(authIds, db);
    const count = await db.query('select count(*)::integer as count from auth.users');
    expect(count.rows[0].count).toBe(0);
    await db.end();
  }
});

test('UI-A reports an expired invitation using the server deadline', async ({
  page,
  request,
}, testInfo) => {
  await mobileWidth(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'expired-owner', authIds);
    const created = await edge(request, owner, 'create_group', {
      name: 'Grupo Prazo',
      request_id: crypto.randomUUID(),
    });
    expect(created.status).toBe(200);
    const outcome = created.value.data?.['outcome'] as { group_id: string; invite_id: string };
    const shared = await edge(request, owner, 'get_invite_share_link', {
      invite_id: outcome.invite_id,
    });
    expect(shared.status).toBe(200);
    const code = shared.value.data?.['code'] as string;
    // M2-D11 planner exception: only expires_at is prepared directly as postgres here.
    await db.query(
      "update public.group_invites set expires_at=now()-interval '1 second' where id=$1",
      [outcome.invite_id],
    );
    const joiner = await createActor(request, 'expired-joiner', authIds);
    await login(page, joiner);
    await page.goto('/join');
    await page.getByTestId('group-code').fill(code);
    await page.getByTestId('preview-code').click();
    await expect(page.getByTestId('preview-error')).toContainText('expirou');
    await assertUiAccessible(page);
    const uses = await db.query('select used_count from public.group_invites where id=$1', [
      outcome.invite_id,
    ]);
    expect(uses.rows[0].used_count).toBe(0);
    if (captureLocalScreenshots(testInfo.project.name)) {
      await page.screenshot({
        path: path.join(screenshotRoot!, '12-expirado.png'),
        fullPage: true,
        mask: [page.getByTestId('group-code')],
      });
    }
    await login(page, owner);
    await page.goto(`/grupos/${outcome.group_id}/convites`);
    await expect(page.getByRole('button', { name: 'Emitir novo convite' })).toBeVisible();
  } finally {
    await cleanActors(authIds, db);
    const count = await db.query('select count(*)::integer as count from auth.users');
    expect(count.rows[0].count).toBe(0);
    await db.end();
  }
});

test('UI-A retries quota errors with the same join request_id', async ({
  page,
  request,
}, testInfo) => {
  await mobileWidth(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'retry-owner', authIds);
    const created = await edge(request, owner, 'create_group', {
      name: 'Grupo Retentativa',
      request_id: crypto.randomUUID(),
    });
    const inviteId = (created.value.data?.['outcome'] as { invite_id: string }).invite_id;
    const shared = await edge(request, owner, 'get_invite_share_link', { invite_id: inviteId });
    const code = shared.value.data?.['code'] as string;
    const joiner = await createActor(request, 'retry-joiner', authIds);
    await login(page, joiner);
    await page.goto('/join');
    await page.getByTestId('group-code').fill(code);
    await page.getByTestId('preview-code').click();
    await expect(page.getByTestId('join-confirmation')).toBeVisible();
    await db.query(
      "update private.app_limits set limit_value=1 where limit_key='invite_attempts_per_hour'",
    );
    const joinBodies: string[] = [];
    page.on('request', (item) => {
      if (new URL(item.url()).pathname === '/functions/v1/groups/join_by_code') {
        const body = item.postData();
        if (body) joinBodies.push(JSON.parse(body).request_id as string);
      }
    });
    await page.getByTestId('join-submit').click();
    await expect(page.getByTestId('join-error')).toContainText('Tente novamente a partir de');
    // Preview and the refused join both count; three admits the retry.
    await db.query(
      "update private.app_limits set limit_value=3 where limit_key='invite_attempts_per_hour'",
    );
    await page.getByTestId('join-submit').click();
    await expect(page.getByTestId('join-pending')).toBeVisible();
    expect(joinBodies).toHaveLength(2);
    expect(joinBodies[1]).toBe(joinBodies[0]);
  } finally {
    await db.query(
      "update private.app_limits set limit_value=20 where limit_key='invite_attempts_per_hour'",
    );
    await cleanActors(authIds, db);
    const count = await db.query('select count(*)::integer as count from auth.users');
    expect(count.rows[0].count).toBe(0);
    await db.end();
  }
});

test('UI-A retries unavailable limiter with the same join request_id', async ({
  page,
  request,
}, testInfo) => {
  await mobileWidth(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'unavailable-owner', authIds);
    const created = await edge(request, owner, 'create_group', {
      name: 'Grupo Limite Indisponível',
      request_id: crypto.randomUUID(),
    });
    const inviteId = (created.value.data?.['outcome'] as { invite_id: string }).invite_id;
    const shared = await edge(request, owner, 'get_invite_share_link', { invite_id: inviteId });
    const code = shared.value.data?.['code'] as string;
    const joiner = await createActor(request, 'unavailable-joiner', authIds);
    await login(page, joiner);
    await page.goto('/join');
    await page.getByTestId('group-code').fill(code);
    await page.getByTestId('preview-code').click();
    await expect(page.getByTestId('join-confirmation')).toBeVisible();
    const ids: string[] = [];
    let rejected = false;
    await page.route('**/functions/v1/groups/join_by_code', async (route) => {
      const body = route.request().postDataJSON() as { request_id: string };
      ids.push(body.request_id);
      if (!rejected) {
        rejected = true;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'RATE_LIMIT_UNAVAILABLE', message: 'local synthetic limiter failure' },
            request_id: body.request_id,
          }),
        });
      } else await route.continue();
    });
    await page.getByTestId('join-submit').click();
    await expect(page.getByTestId('join-error')).toContainText('Tente novamente');
    await page.getByTestId('join-submit').click();
    await expect(page.getByTestId('join-pending')).toBeVisible();
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  } finally {
    await cleanActors(authIds, db);
    const count = await db.query('select count(*)::integer as count from auth.users');
    expect(count.rows[0].count).toBe(0);
    await db.end();
  }
});

async function heapContains(page: Page, markers: string[]): Promise<boolean[]> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  for (let pass = 0; pass < 3; pass += 1) await cdp.send('HeapProfiler.collectGarbage');
  const chunks: string[] = [];
  cdp.on('HeapProfiler.addHeapSnapshotChunk', ({ chunk }: { chunk: string }) => chunks.push(chunk));
  await cdp.send('HeapProfiler.takeHeapSnapshot');
  const snapshot = chunks.join('');
  await cdp.detach();
  return markers.map((marker) => snapshot.includes(marker));
}

test('UI-A clears old account group and invite material from the browser heap', async ({
  page,
  request,
}, testInfo) => {
  await mobileWidth(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const accountA = await createActor(request, 'heap-a', authIds);
    const accountB = await createActor(request, 'heap-b', authIds);
    const memberA = await createActor(
      request,
      `Member${crypto.randomUUID().replaceAll('-', '')}`,
      authIds,
    );
    const pendingA = await createActor(
      request,
      `Pending${crypto.randomUUID().replaceAll('-', '')}`,
      authIds,
    );
    const groupSentinel = `Heap${crypto.randomUUID().replaceAll('-', '').slice(0, 22)}`;
    await login(page, accountA);
    await page.getByRole('link', { name: 'Grupos' }).click();
    await page.getByRole('button', { name: 'Criar grupo' }).click();
    await page.getByTestId('group-name').fill(groupSentinel);
    await page.getByTestId('create-group-submit').click();
    await expect(page.getByTestId('invite-link')).toBeVisible();
    const token = new URL(await page.getByTestId('invite-link').innerText()).hash.slice(7);
    expect(await heapContains(page, [groupSentinel, token])).toEqual([true, true]);
    const created = await db.query('select id from public.groups where owner_id=$1', [
      accountA.profileId,
    ]);
    const groupId = created.rows[0].id as string;
    for (const actor of [memberA, pendingA])
      expect(
        (await edge(request, actor, 'join_by_invite', { token, request_id: crypto.randomUUID() }))
          .status,
      ).toBe(200);
    expect(
      (
        await edge(request, accountA, 'approve_member', {
          group_id: groupId,
          profile_id: memberA.profileId,
          approve: true,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    const names = (
      await db.query('select name from public.profiles where id=any($1::uuid[])', [
        [accountA.profileId, memberA.profileId, pendingA.profileId],
      ])
    ).rows.map((row: { name: string }) => row.name);
    await page.goto(`/grupos/${groupId}`);
    for (const name of names)
      await expect(page.getByTestId('group-members-list')).toContainText(name);
    expect(await heapContains(page, names)).toEqual([true, true, true]);
    for (const name of names)
      expect(await browserLeakCensus(page, name)).toBe(name !== 'Pessoa heap-a');
    await page.getByRole('link', { name: 'Perfil' }).click();
    const unloaded = handledObserver(
      page.waitForEvent('framenavigated', {
        predicate: (frame) =>
          frame === page.mainFrame() && new URL(frame.url()).pathname === '/entrar',
      }),
    );
    const logoutDocuments: string[] = [];
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        logoutDocuments.push(new URL(request.url()).pathname);
    });
    await page.getByRole('button', { name: 'Sair com segurança' }).click();
    await unloaded;
    await page.waitForLoadState('load');
    expect(logoutDocuments).toEqual(['/entrar']);
    await expect(page.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
    // Account B uses the same browser tab after the app completes logout.
    await page.getByTestId('login-email').fill(accountB.email);
    await page.getByTestId('login-password').fill(password);
    const signedB = handledObserver(
      page.waitForResponse(
        (item) =>
          new URL(item.url()).pathname === '/auth/v1/token' && item.request().method() === 'POST',
      ),
    );
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    expect((await signedB).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Perfil', level: 1 })).toBeVisible();
    expect(
      await page.evaluate(
        (needle) => document.body.textContent?.includes(needle) ?? false,
        groupSentinel,
      ),
    ).toBe(false);
    for (const name of names) expect(await browserLeakCensus(page, name)).toBe(true);
    expect(await heapContains(page, [groupSentinel, token, ...names])).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  } finally {
    await cleanActors(authIds, db);
    const count = await db.query('select count(*)::integer as count from auth.users');
    expect(count.rows[0].count).toBe(0);
    await db.end();
  }
});

test('0019 screen 11 shows active roles and pending names with keyboard and 320px reflow', async ({
  page,
  request,
}, testInfo) => {
  await mobileWidth(page, testInfo.project.name);
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    expect((await db.query('select count(*)::integer as n from auth.users')).rows[0].n).toBe(0);
    const owner = await createActor(request, 'members-owner', authIds);
    const member = await createActor(request, 'members-active', authIds);
    const pending = await createActor(request, 'members-pending', authIds);
    const created = await edge(request, owner, 'create_group', {
      name: 'Lista de participantes',
      request_id: crypto.randomUUID(),
    });
    expect(created.status).toBe(200);
    const outcome = created.value.data?.['outcome'] as { group_id: string; invite_id: string };
    const share = await edge(request, owner, 'get_invite_share_link', {
      invite_id: outcome.invite_id,
    });
    expect(share.status).toBe(200);
    for (const actor of [member, pending]) {
      expect(
        (
          await edge(request, actor, 'join_by_code', {
            code: share.value.data?.['code'],
            request_id: crypto.randomUUID(),
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await edge(request, owner, 'approve_member', {
          group_id: outcome.group_id,
          profile_id: member.profileId,
          approve: true,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    await login(page, owner);
    await page.goto(`/grupos/${outcome.group_id}`);
    const list = page.getByTestId('group-members-list');
    await expect(list).toContainText('Pessoa members-active · Jogador');
    await expect(list).toContainText('Pessoa members-owner · Dono');
    const requests = page.getByTestId('group-pending-members-list');
    await expect(requests).toContainText('Pessoa members-pending');
    await expect(requests).not.toContainText('Jogador');
    await expect(page.getByRole('button', { name: /^(Aprovar|Recusar)$/ })).toHaveCount(0);
    await assertUiAccessible(page);
    await requests.scrollIntoViewIfNeeded();
    if (captureLocalScreenshots(testInfo.project.name))
      await page.screenshot({
        path: path.join(screenshotRoot!, '11-com-pendentes.png'),
        fullPage: true,
      });
    // Decision is fixture preparation through the productive HTTP Edge, never a dead UI control.
    expect(
      (
        await edge(request, owner, 'approve_member', {
          group_id: outcome.group_id,
          profile_id: pending.profileId,
          approve: false,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    await page.reload();
    await expect(page.getByTestId('group-members-list')).toContainText('Pessoa members-active');
    await expect(page.getByTestId('group-pending-members-list')).toHaveCount(0);
    await assertUiAccessible(page);
    await page.getByTestId('group-members-list').scrollIntoViewIfNeeded();
    if (captureLocalScreenshots(testInfo.project.name))
      await page.screenshot({
        path: path.join(screenshotRoot!, '11-com-lista.png'),
        fullPage: true,
      });
  } finally {
    await cleanActors(authIds, db);
    expect((await db.query('select count(*)::integer as n from auth.users')).rows[0].n).toBe(0);
    await db.end();
  }
});

// An expired local session fails refresh in the real Auth SDK. Visibility
// recovery triggers it without timers, a manual logout or an app broadcast.
test('UI-A Auth SIGNED_OUT discards the document and private group heap', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const actor = await createActor(request, 'auth-event', authIds);
    const sentinel = `AuthHeap${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const created = await edge(request, actor, 'create_group', {
      name: sentinel,
      request_id: crypto.randomUUID(),
    });
    expect(created.status).toBe(200);
    const groupId = (created.value.data?.['outcome'] as { group_id: string }).group_id;
    await login(page, actor);
    await page.goto(`/grupos/${groupId}`);
    await expect(page.getByRole('heading', { name: sentinel, exact: true })).toBeVisible();
    expect(await heapContains(page, [sentinel])).toEqual([true]);
    const unloaded = handledObserver(
      page.waitForEvent('framenavigated', {
        predicate: (frame) =>
          frame === page.mainFrame() && new URL(frame.url()).pathname === '/entrar',
      }),
    );
    const signedOutDocuments: string[] = [];
    page.on('request', (sent) => {
      if (sent.isNavigationRequest() && sent.frame() === page.mainFrame())
        signedOutDocuments.push(new URL(sent.url()).pathname);
    });
    const refresh = handledObserver(
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/auth/v1/token' &&
          new URL(response.url()).searchParams.get('grant_type') === 'refresh_token',
      ),
    );
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((item) => /^sb-.+-auth-token$/.test(item));
      if (!key) throw new Error('Auth storage key missing');
      const session = JSON.parse(localStorage.getItem(key)!);
      session.expires_at = 1;
      session.refresh_token = 'faxina-synthetic-invalid-refresh';
      localStorage.setItem(key, JSON.stringify(session));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      window.dispatchEvent(new Event('visibilitychange'));
    });
    expect((await refresh).status()).toBe(400);
    await page.waitForFunction(() =>
      Object.keys(localStorage).every((key) => !/^sb-.+-auth-token$/.test(key)),
    );
    await page.waitForLoadState('load');
    expect(await heapContains(page, [sentinel])).toEqual([false]);
    await expect(page.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: sentinel, exact: true })).toHaveCount(0);
    await unloaded;
    await page.waitForLoadState('networkidle');
    expect(signedOutDocuments).toEqual(['/entrar']);
    expect(await browserLeakCensus(page, sentinel)).toBe(true);
  } finally {
    await cleanActors(authIds, db);
    expect((await db.query('select count(*)::integer as n from auth.users')).rows[0].n).toBe(0);
    await db.end();
  }
});

test('UI-A no session keeps the login document without reloads', async ({ page }) => {
  await page.goto('/entrar');
  await expect(page.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
  const documents: string[] = [];
  page.on('request', (sent) => {
    if (sent.isNavigationRequest() && sent.frame() === page.mainFrame())
      documents.push(new URL(sent.url()).pathname);
  });
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    window.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
  expect(documents).toEqual([]);
});

test('UI-A expired session with valid refresh keeps its document', async ({ page, request }) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const actor = await createActor(request, 'valid-refresh', authIds);
    await login(page, actor);
    const documents: string[] = [];
    page.on('request', (sent) => {
      if (sent.isNavigationRequest() && sent.frame() === page.mainFrame())
        documents.push(new URL(sent.url()).pathname);
    });
    const refresh = handledObserver(
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/auth/v1/token' &&
          new URL(response.url()).searchParams.get('grant_type') === 'refresh_token',
      ),
    );
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((item) => /^sb-.+-auth-token$/.test(item));
      if (!key) throw new Error('Auth storage key missing');
      const session = JSON.parse(localStorage.getItem(key)!);
      session.expires_at = 1;
      localStorage.setItem(key, JSON.stringify(session));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      window.dispatchEvent(new Event('visibilitychange'));
    });
    expect((await refresh).status()).toBe(200);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Perfil', level: 1 })).toBeVisible();
    expect(documents).toEqual([]);
  } finally {
    await cleanActors(authIds, db);
    expect((await db.query('select count(*)::integer as n from auth.users')).rows[0].n).toBe(0);
    await db.end();
  }
});
