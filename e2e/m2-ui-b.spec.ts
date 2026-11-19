import { beginCleanup } from './support/cleanup';
import { expect, test, type APIRequestContext, type Page } from './support/csp';
import path from 'node:path';
import pg from 'pg';
import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { assertNoHorizontalOverflow } from './support/layout';
import { handledObserver } from './support/observers';
import { assertDistinctConnections, awaitLockWait, track } from '../scripts/lock-barrier.mjs';

const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-group-test-2026';
const prefix = `ui-b-${Date.now()}-${process.pid}`;
const knownProfiles = new Map<string, string>();
const screenshotRoot = process.env['COLETE_UI_B_SCREENSHOTS_DIR'];
type Actor = { authId: string; profileId: string; token: string; email: string };
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
  knownProfiles.set(id, profile.data.outcome.profile_id);
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
  const ids = [
    ...new Set([
      ...profiles.rows.map((row: { id: string }) => row.id),
      ...authIds.flatMap((id) => (knownProfiles.has(id) ? [knownProfiles.get(id)!] : [])),
    ]),
  ];
  await beginCleanup(db, ids);
  try {
    await db.query('delete from private.invite_rate_limits where profile_id = any($1::uuid[])', [
      ids,
    ]);
    await db.query(
      `delete from private.external_effects where resource_id = any($1::uuid[]) or resource_id in (select id from private.deletion_requests where profile_id = any($1::uuid[]))`,
      [ids],
    );
    await db.query('delete from private.deletion_requests where profile_id = any($1::uuid[])', [
      ids,
    ]);
    await db.query('delete from public.privacy_requests where profile_id = any($1::uuid[])', [ids]);
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
  for (const id of authIds) knownProfiles.delete(id);
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

async function accessible(page: Page) {
  await assertAccessible(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await assertAccessible(page);
  const textStyles = await page
    .locator('div[dir="auto"], h3, input, textarea')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const element = node as HTMLElement;
        const previous = element.getAttribute('style');
        const style = getComputedStyle(element);
        element.style.fontSize = `${parseFloat(style.fontSize) * 2}px`;
        if (style.lineHeight !== 'normal')
          element.style.lineHeight = `${parseFloat(style.lineHeight) * 2}px`;
        return previous;
      }),
    );
  await assertNoHorizontalOverflow(page);
  await page.locator('div[dir="auto"], h3, input, textarea').evaluateAll((nodes, styles) => {
    nodes.forEach((node, index) => {
      const previous = styles[index];
      if (previous === null) node.removeAttribute('style');
      else node.setAttribute('style', previous!);
    });
  }, textStyles);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.matches(':focus-visible'))).toBe(true);
}
async function capture(page: Page, file: string) {
  if (!screenshotRoot) return;
  const previous = page.viewportSize()!;
  await page.setViewportSize({ width: 840, height: 900 });
  const contentHeight = await page
    .getByTestId('authenticated-main')
    .evaluate((element) => element.scrollHeight);
  await page.setViewportSize({ width: 840, height: Math.max(900, contentHeight + 160) });
  await page.screenshot({ path: path.join(screenshotRoot, file), fullPage: true, scale: 'css' });
  await page.setViewportSize(previous);
}
/** Prévia aprovada: a member's role and removal actions sit behind its "…", opened by keyboard. */
async function openActions(page: Page, profileId: string) {
  const menu = page.getByTestId(`member-menu-${profileId}`);
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.press('Enter');
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
}

async function scenario(request: APIRequestContext, db: pg.Client, ids: string[]) {
  expect((await db.query('select count(*)::integer as n from auth.users')).rows[0].n).toBe(0);
  const owner = await createActor(request, 'owner', ids);
  const organizer = await createActor(request, 'organizer', ids);
  const player = await createActor(request, 'player', ids);
  const pending = await createActor(request, 'pending', ids);
  const refused = await createActor(request, 'refused', ids);
  const created = await edge(request, owner, 'create_group', {
    name: 'Grupo UI B',
    request_id: crypto.randomUUID(),
  });
  expect(created.status).toBe(200);
  const { group_id: groupId, invite_id: inviteId } = created.value.data?.['outcome'] as {
    group_id: string;
    invite_id: string;
  };
  const share = await edge(request, owner, 'get_invite_share_link', { invite_id: inviteId });
  for (const actor of [organizer, player, pending, refused]) {
    expect(
      (
        await edge(request, actor, 'join_by_code', {
          code: share.value.data?.['code'],
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
  }
  for (const actor of [organizer, player]) {
    expect(
      (
        await edge(request, owner, 'approve_member', {
          group_id: groupId,
          profile_id: actor.profileId,
          approve: true,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
  }
  expect(
    (
      await edge(request, owner, 'set_role', {
        group_id: groupId,
        profile_id: organizer.profileId,
        role: 'organizer',
        request_id: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200);
  return { owner, organizer, player, pending, refused, groupId };
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
async function clean(ids: string[], db: pg.Client) {
  await cleanActors(ids, db);
  expect((await db.query('select count(*)::integer as n from auth.users')).rows[0].n).toBe(0);
  await db.end();
}

// Keep the real cleanup and RPC under the same interleaving on both versions.
// The reader owns the profile before cleanup starts. On the old path, let it
// request the group only after cleanup deleted that group; on NOWAIT rollback,
// let it finish before cleanup retries. The observer proves the old lock wait.
test('UI-B cleanup serializes with get_group_ratings', async ({ request }) => {
  const db = new Client({ connectionString: env.dbUrl, application_name: 'cleanup_writer' });
  const reader = new Client({ connectionString: env.dbUrl, application_name: 'cleanup_reader' });
  const observer = new Client({
    connectionString: env.dbUrl,
    application_name: 'cleanup_observer',
  });
  const authIds: string[] = [];
  await Promise.all([db.connect(), reader.connect(), observer.connect()]);
  let reading: ReturnType<typeof track> | undefined;
  let released = false;
  let busy = 0;
  try {
    const actor = await createActor(request, 'cleanup-ratings', authIds);
    const created = await edge(request, actor, 'create_group', {
      request_id: crypto.randomUUID(),
      name: 'Cleanup ratings',
    });
    expect(created.status).toBe(200);
    const groupId = (created.value.data!['outcome'] as { group_id: string }).group_id;
    const sessionId = (
      await db.query(
        'select id from auth.sessions where user_id = $1 order by created_at desc limit 1',
        [actor.authId],
      )
    ).rows[0].id;
    const pids = await assertDistinctConnections({ db, reader, observer }, 'cleanup ratings');
    await reader.query('begin');
    await reader.query('select 1 from public.profiles where id = $1 for no key update', [
      actor.profileId,
    ]);
    const releaseRead = () => {
      released = true;
      reading = track(
        (async () => {
          await reader.query('set local role service_role');
          const result = await reader.query('select public.get_group_ratings($1, $2, $3) as data', [
            actor.authId,
            sessionId,
            groupId,
          ]);
          expect(result.rows[0].data.group_id).toBe(groupId);
          await reader.query('commit');
        })(),
      );
    };
    const instrumented = new Proxy(db, {
      get(target, property) {
        if (property !== 'query') return Reflect.get(target, property, target);
        return async (sql: string, params?: unknown[]) => {
          try {
            const result = await target.query(sql, params);
            if (!released && sql === 'rollback') {
              releaseRead();
              expect((await reading!.settled).status).toBe('fulfilled');
            } else if (!released && sql.startsWith('delete from public.groups')) {
              releaseRead();
              await awaitLockWait(
                observer,
                reading!,
                pids.reader,
                pids.db,
                'ratings waits for cleanup group',
                'cleanup_',
              );
            }
            return result;
          } catch (error) {
            if ((error as { code?: string }).code === '55P03') busy += 1;
            throw error;
          }
        };
      },
    });
    const cleaning = track(cleanActors(authIds, instrumented));
    const result = await cleaning.settled;
    if (result.status === 'rejected')
      throw new Error(`cleanup SQLSTATE ${result.reason.code}`, { cause: result.reason });
    expect(reading).toBeDefined();
    const readResult = await reading!.settled;
    if (readResult.status === 'rejected')
      throw new Error(`get_group_ratings SQLSTATE ${readResult.reason.code}`, {
        cause: readResult.reason,
      });
    expect(busy).toBeGreaterThan(0);
    expect(
      (
        await db.query('select count(*)::int as n from public.profiles where id = $1', [
          actor.profileId,
        ])
      ).rows[0].n,
    ).toBe(0);
  } finally {
    try {
      await reader.query('rollback');
      if (reading) await reading.settled;
      await db.query('rollback');
      await cleanActors(authIds, db);
    } finally {
      await Promise.allSettled([db.end(), reader.end(), observer.end()]);
    }
  }
});

test('UI-B role matrix and direct routes do not disclose administration to players', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    for (const [actor, role] of [
      [s.owner, 'owner'],
      [s.organizer, 'organizer'],
      [s.player, 'player'],
    ] as const) {
      await login(page, actor);
      await page.goto(`/grupos/${s.groupId}`);
      await expect(page.getByTestId('group-detail-card')).toBeVisible();
      // Prévia aprovada: the organisation opens Membros from the members card and
      // has Convidar and Configurar; a player has the member list on the group.
      await expect(
        page.getByTestId(role === 'player' ? 'group-members-list' : 'group-members-link'),
      ).toBeVisible();
      await expect(page.getByTestId('group-members-link')).toHaveCount(role === 'player' ? 0 : 1);
      for (const name of ['Convidar', 'Configurar'])
        await expect(page.getByRole('button', { name, exact: true })).toHaveCount(
          role === 'player' ? 0 : 1,
        );
      await capture(page, role === 'owner' ? '11-titulo.png' : `11-${role}.png`);
      for (const route of ['membros', 'configuracoes']) {
        await page.goto(`/grupos/${s.groupId}/${route}`);
        if (role === 'player') {
          await expect(
            page.getByText('Você precisa ser dono ou organizador ativo', { exact: false }),
          ).toBeVisible();
          await expect(page.getByTestId('group-management-card')).toHaveCount(0);
          await expect(page.getByTestId('group-settings-card')).toHaveCount(0);
          await expect(page.getByText('Pessoa pending', { exact: true })).toHaveCount(0);
          await expect(page.getByText('Grupo UI B', { exact: true })).toHaveCount(0);
        } else if (route === 'membros') {
          await expect(page.getByTestId('group-management-card')).toBeVisible();
          await expect(page.getByRole('button', { name: /^Aprovar Pessoa / })).toHaveCount(2);
          await expect(page.getByRole('button', { name: /^Recusar Pessoa / })).toHaveCount(2);
          // One "…" is open at a time: each member's actions are read in turn.
          await openActions(page, s.player.profileId);
          await expect(page.getByTestId(`role-${s.player.profileId}`)).toHaveCount(
            role === 'owner' ? 1 : 0,
          );
          await openActions(page, s.organizer.profileId);
          await expect(page.getByTestId(`role-${s.organizer.profileId}`)).toHaveCount(
            role === 'owner' ? 1 : 0,
          );
          await openActions(page, s.player.profileId);
          await expect(page.getByTestId(`remove-${s.owner.profileId}`)).toHaveCount(0);
          await expect(page.getByTestId(`role-${s.owner.profileId}`)).toHaveCount(0);
          await expect(page.getByTestId(`remove-${s.player.profileId}`)).toHaveCount(1);
          await accessible(page);
          await capture(page, role === 'owner' ? '17-com-pendentes.png' : '17-organizador.png');
        } else {
          await expect(page.getByTestId('rename-group-submit')).toBeVisible();
          await expect(page.getByTestId(`transfer-${s.player.profileId}`)).toHaveCount(
            role === 'owner' ? 1 : 0,
          );
          await expect(page.getByTestId(`transfer-${s.pending.profileId}`)).toHaveCount(0);
          await expect(page.getByTestId(`transfer-${s.owner.profileId}`)).toHaveCount(0);
          await accessible(page);
          await capture(page, role === 'owner' ? '25-dono.png' : '25-organizador.png');
          const settingsBack = page.getByTestId('settings-back');
          await expect(settingsBack).toHaveAccessibleName('Voltar ao grupo');
          await settingsBack.click();
          await expect(page).toHaveURL(new RegExp(`/grupos/${s.groupId}$`, 'u'));
          await expect(page.getByTestId('group-members-link')).toBeVisible();
        }
      }
    }
  } finally {
    await clean(ids, db);
  }
});

test('UI-B every Voltar ao grupo keeps one group and one tab bar, by navigation and by direct URL', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    await login(page, s.owner);
    const children = [
      ['group-invites', 'convites', 'invites-back'],
      ['group-members-link', 'membros', 'members-back'],
      ['group-settings', 'configuracoes', 'settings-back'],
    ] as const;
    await page.goto('/grupos');
    await page.getByTestId('group-list-card').click();
    await expect(page.getByTestId('group-detail-card')).toBeVisible();
    // Normal navigation, twice per child: each round trip pops back to the same group.
    for (const [button, , back] of children) {
      for (let round = 0; round < 2; round += 1) {
        await page.getByTestId(button).click();
        await page.getByTestId(back).click();
        await expect(page).toHaveURL(new RegExp(`/grupos/${s.groupId}$`, 'u'));
        await expectOneParent(page, 'group-detail-card', back);
      }
    }
    // Direct URL: the group is not in the stack, so the back replaces the child.
    for (const [, route, back] of children) {
      await page.goto(`/grupos/${s.groupId}/${route}`);
      await page.getByTestId(back).click();
      await expect(page).toHaveURL(new RegExp(`/grupos/${s.groupId}$`, 'u'));
      await expectOneParent(page, 'group-detail-card', back);
      await expect(page.getByTestId('group-list-card')).toHaveCount(0);
    }
    // The group's member read locks profile then group; let it finish and
    // leave the page, so the cleanup's deletes never race it into a deadlock.
    await expect(page.getByTestId('group-members-link')).toBeVisible();
    await page.goto('about:blank');
  } finally {
    await clean(ids, db);
  }
});

test('UI-B approves refuses promotes demotes removes renames and transfers with server projections', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    await login(page, s.owner);
    await page.goto(`/grupos/${s.groupId}/membros`);
    await page
      .getByTestId(`member-${s.pending.profileId}`)
      .getByRole('button', { name: /^Aprovar Pessoa / })
      .press('Enter');
    await expect(page.getByTestId(`member-${s.pending.profileId}`)).toContainText('Jogador');
    await expect(page.getByTestId('member-result')).toHaveText('Pessoa pending foi aprovado.');
    await expect(page.getByTestId('member-result')).toBeFocused();
    await page
      .getByTestId(`member-${s.refused.profileId}`)
      .getByRole('button', { name: /^Recusar Pessoa / })
      .press('Enter');
    await expect(page.getByTestId(`member-${s.refused.profileId}`)).toHaveCount(0);
    await expect(page.getByTestId('member-result')).toHaveText('Pessoa refused foi recusado.');
    await expect(page.getByTestId('member-result')).toBeFocused();
    await expect(page.getByText('Não há pedidos pendentes.')).toBeVisible();
    await capture(page, '17-sem-pendentes.png');
    await openActions(page, s.player.profileId);
    await page.getByTestId(`role-${s.player.profileId}`).press('Enter');
    await expect(page.getByTestId(`member-${s.player.profileId}`)).toContainText('Organizador');
    expect(
      (
        await db.query(
          'select role from public.group_members where group_id=$1 and profile_id=$2',
          [s.groupId, s.player.profileId],
        )
      ).rows[0].role,
    ).toBe('organizer');
    await page.getByTestId(`role-${s.player.profileId}`).press('Enter');
    await expect(page.getByTestId(`member-${s.player.profileId}`)).toContainText('Jogador');
    expect(
      (
        await db.query(
          'select role from public.group_members where group_id=$1 and profile_id=$2',
          [s.groupId, s.player.profileId],
        )
      ).rows[0].role,
    ).toBe('player');
    const origin = page.getByTestId(`remove-${s.player.profileId}`);
    await origin.press('Enter');
    await expect(page.getByTestId('remove-confirmation-heading')).toBeFocused();
    await page.getByRole('button', { name: 'Cancelar', exact: true }).press('Enter');
    await expect(origin).toBeFocused();
    await origin.press('Enter');
    await page.getByRole('button', { name: 'Confirmar expulsão' }).press('Enter');
    await expect(page.getByTestId('remove-reason')).toBeFocused();
    await expect(page.getByTestId('remove-reason')).toHaveAttribute('aria-invalid', 'true');
    await page.getByTestId('remove-reason').fill('Motivo sintético');
    await expect(page.getByTestId('remove-reason')).toHaveAttribute('aria-invalid', 'false');
    await accessible(page);
    await capture(page, '17-expulsao.png');
    // rev74 / BB-030: one menu at a time. Opening another member's "…" closes
    // this confirmation; nothing is left expanded but the new menu.
    await page.getByTestId(`member-menu-${s.organizer.profileId}`).press('Enter');
    await expect(page.getByTestId(`member-menu-${s.organizer.profileId}`)).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.getByTestId(`member-menu-${s.player.profileId}`)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(page.getByTestId('remove-reason')).toHaveCount(0);
    await expect(page.locator('[aria-expanded="true"]')).toHaveCount(1);
    await openActions(page, s.player.profileId);
    await expect(page.locator('[aria-expanded="true"]')).toHaveCount(1);
    await page.getByTestId(`remove-${s.player.profileId}`).press('Enter');
    await page.getByTestId('remove-reason').fill('Motivo sintético');
    await page.getByRole('button', { name: 'Confirmar expulsão' }).press('Enter');
    await expect(page.getByTestId(`member-${s.player.profileId}`)).toHaveCount(0);
    expect(
      (
        await db.query(
          'select profile_id,status from public.group_members where group_id=$1 and profile_id=any($2::uuid[]) order by profile_id',
          [s.groupId, [s.pending.profileId, s.refused.profileId, s.player.profileId]],
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        { profile_id: s.pending.profileId, status: 'active' },
        { profile_id: s.refused.profileId, status: 'removed' },
        { profile_id: s.player.profileId, status: 'removed' },
      ]),
    );
    await page.goto(`/grupos/${s.groupId}/configuracoes`);
    await expect(page.getByTestId('rename-group-name')).toHaveValue('Grupo UI B');
    await page.getByTestId('rename-group-name').fill('');
    await page.getByTestId('rename-group-submit').press('Enter');
    await expect(page.getByTestId('rename-group-name')).toBeFocused();
    await page.getByTestId('rename-group-name').fill('Nome confirmado UI B');
    await page.getByTestId('rename-group-submit').press('Enter');
    await expect(page.getByTestId('confirmed-group-name')).toHaveText('Nome confirmado UI B');
    expect(
      (await db.query('select name from public.groups where id=$1', [s.groupId])).rows[0].name,
    ).toBe('Nome confirmado UI B');
    await page.getByTestId(`transfer-${s.organizer.profileId}`).press('Enter');
    await expect(page.getByTestId('transfer-confirmation-1-heading')).toBeFocused();
    await expect(
      page.getByText('Você deixa de ser dono e passa a ser organizador.', { exact: true }),
    ).toBeVisible();
    await accessible(page);
    await capture(page, '25-transferencia-1.png');
    await page.getByRole('button', { name: 'Continuar transferência' }).press('Enter');
    await expect(page.getByTestId('transfer-confirmation-2-heading')).toBeFocused();
    await accessible(page);
    await capture(page, '25-transferencia-2.png');
    await page.getByRole('button', { name: 'Confirmar transferência' }).press('Enter');
    await expect(
      page.getByText('A titularidade foi transferida para Pessoa organizer.'),
    ).toBeVisible();
    await expect(page.getByTestId(`transfer-${s.organizer.profileId}`)).toHaveCount(0);
    expect(
      (await db.query('select owner_id from public.groups where id=$1', [s.groupId])).rows[0]
        .owner_id,
    ).toBe(s.organizer.profileId);
    await expect(page.getByTestId('rename-group-submit')).toBeVisible();
    await expect(page.getByTestId('settings-role')).toHaveText('Organizador');
  } finally {
    await clean(ids, db);
  }
});

for (const code of ['RATE_LIMITED', 'RATE_LIMIT_UNAVAILABLE'])
  test(`UI-B preserves request_id after ${code} and mutates once`, async ({ page, request }) => {
    const db = new Client({ connectionString: env.dbUrl });
    await db.connect();
    const ids: string[] = [];
    try {
      const s = await scenario(request, db, ids);
      await login(page, s.owner);
      await page.goto(`/grupos/${s.groupId}/membros`);
      const seen: string[] = [];
      await page.route('**/functions/v1/groups/approve_member', async (route) => {
        const body = route.request().postDataJSON() as { request_id: string };
        seen.push(body.request_id);
        if (seen.length === 1)
          await route.fulfill({
            status: code === 'RATE_LIMITED' ? 429 : 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code,
                message: 'synthetic',
                ...(code === 'RATE_LIMITED'
                  ? { retry_after: 1, available_at: '2030-01-01T00:00:00Z' }
                  : {}),
              },
              request_id: body.request_id,
            }),
          });
        else await route.continue();
      });
      const approve = page
        .getByTestId(`member-${s.pending.profileId}`)
        .getByRole('button', { name: /^Aprovar Pessoa / });
      await approve.click();
      await expect(page.getByTestId('administration-error')).toContainText('Tente novamente');
      await approve.click();
      await expect(page.getByTestId(`member-${s.pending.profileId}`)).toContainText('Jogador');
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe(seen[1]);
      expect(
        (
          await db.query(
            "select count(*)::integer as n from private.idempotency_records where actor_id=$1 and operation='approve_member' and outcome->>'profile_id'=$2",
            [s.owner.profileId, s.pending.profileId],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await clean(ids, db);
    }
  });

test('UI-B loses authority on the next action after a second session removes or demotes the actor', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    await login(page, s.organizer);
    await page.goto(`/grupos/${s.groupId}/membros`);
    await expect(page.getByTestId('group-management-card')).toBeVisible();
    expect(
      (
        await edge(request, s.owner, 'set_role', {
          group_id: s.groupId,
          profile_id: s.organizer.profileId,
          role: 'player',
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    await page
      .getByTestId(`member-${s.pending.profileId}`)
      .getByRole('button', { name: /^Aprovar Pessoa / })
      .click();
    await expect(page.getByTestId('administration-error')).toContainText(
      'Você precisa ser dono ou organizador ativo',
    );
    await expect(page.getByTestId('group-management-card')).toHaveCount(0);
    await expect(page.getByText('Pessoa pending', { exact: true })).toHaveCount(0);
    expect(
      (
        await edge(request, s.owner, 'set_role', {
          group_id: s.groupId,
          profile_id: s.organizer.profileId,
          role: 'organizer',
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    await page.goto(`/grupos/${s.groupId}/configuracoes`);
    await expect(page.getByTestId('rename-group-submit')).toBeVisible();
    expect(
      (
        await edge(request, s.owner, 'remove_member', {
          group_id: s.groupId,
          profile_id: s.organizer.profileId,
          reason: 'fixture',
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    await page.getByTestId('rename-group-name').fill('Não pode mudar');
    await page.getByTestId('rename-group-submit').click();
    // 0029: the refusal refreshes the screen, whose read no longer finds the
    // group; like a deleted one, it goes back to Grupos and says so.
    await expect(page).toHaveURL(/\/grupos\?missing=1$/u);
    await expect(page.getByTestId('group-missing-status')).toHaveText('Grupo não encontrado.');
    await expect(page.getByTestId('group-settings-card')).toHaveCount(0);
    await expect(page.getByText('Grupo UI B', { exact: true })).toHaveCount(0);
  } finally {
    await clean(ids, db);
  }
});

test('UI-B displays stable contract messages without committing intercepted error responses', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    await login(page, s.owner);
    await page.goto(`/grupos/${s.groupId}/membros`);
    for (const [code, message] of [
      ['MEMBERSHIP_ALREADY_DECIDED', 'Este pedido já foi decidido. Confira a lista atualizada.'],
      [
        'GROUP_LIMIT',
        'Esta pessoa já participa de cinco grupos ativos. Peça que saia de um grupo antes de aprovar o pedido.',
      ],
      ['GROUP_FULL', 'Este grupo está cheio. Procure quem organiza o grupo.'],
      ['NOT_FOUND', 'Este pedido não foi encontrado. Confira a lista atualizada.'],
      [
        'IS_OWNER',
        'O dono não pode ser expulso nem ter o papel alterado. Transfira a titularidade primeiro.',
      ],
      ['NOT_ACTIVE_MEMBER', 'Esta pessoa não é mais um membro ativo. Confira a lista atualizada.'],
      ['OWNER_ONLY', 'Só o dono pode fazer esta ação. Volte ao grupo e atualize seu papel.'],
      [
        'NOT_ORGANIZER',
        'Você precisa ser dono ou organizador ativo para fazer esta ação. Volte ao grupo e atualize os dados.',
      ],
      ['GROUP_SUSPENDED', 'Este grupo está suspenso. Procure quem organiza o grupo.'],
      ['GROUP_ARCHIVED', 'Este grupo foi arquivado. Volte à lista de grupos.'],
      ['PROOFS_PENDING', 'Há comprovantes pendentes. Resolva-os antes de remover esta pessoa.'],
    ]) {
      await page.route('**/functions/v1/groups/approve_member', async (route) => {
        const body = route.request().postDataJSON() as { request_id: string };
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code, message: 'synthetic UI envelope' },
            request_id: body.request_id,
          }),
        });
      });
      await page
        .getByTestId(`member-${s.pending.profileId}`)
        .getByRole('button', { name: /^Aprovar Pessoa / })
        .click();
      await expect(page.getByTestId('administration-error')).toHaveText(message!);
      await expect(
        page
          .getByTestId(`member-${s.pending.profileId}`)
          .getByRole('button', { name: /^Aprovar Pessoa / }),
      ).toBeVisible();
      await expect(page.getByText('Carregando com segurança…', { exact: true })).toHaveCount(0);
      await page.unroute('**/functions/v1/groups/approve_member');
    }
    expect(
      (
        await db.query(
          'select status from public.group_members where group_id=$1 and profile_id=$2',
          [s.groupId, s.pending.profileId],
        )
      ).rows[0].status,
    ).toBe('pending');
  } finally {
    await clean(ids, db);
  }
});

test('UI-B real stale targets and suspended group return their contract errors', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    await login(page, s.owner);
    await page.goto(`/grupos/${s.groupId}/membros`);
    await expect(page.getByTestId(`member-${s.pending.profileId}`)).toBeVisible();
    expect(
      (
        await edge(request, s.owner, 'approve_member', {
          group_id: s.groupId,
          profile_id: s.pending.profileId,
          approve: true,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    await page
      .getByTestId(`member-${s.pending.profileId}`)
      .getByRole('button', { name: /^Aprovar Pessoa / })
      .click();
    await expect(page.getByTestId('administration-error')).toContainText(
      'Este pedido já foi decidido',
    );
    await expect(page.getByTestId(`member-${s.pending.profileId}`)).toContainText('Jogador');
    expect(
      (
        await edge(request, s.owner, 'remove_member', {
          group_id: s.groupId,
          profile_id: s.player.profileId,
          reason: 'fixture',
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    await openActions(page, s.player.profileId);
    await page.getByTestId(`role-${s.player.profileId}`).click();
    await expect(page.getByTestId('administration-error')).toContainText(
      'Esta pessoa não é mais um membro ativo',
    );
    await expect(page.getByTestId(`member-${s.player.profileId}`)).toHaveCount(0);
    // M2-D11 explicitly allows suspended_at as a direct local fixture.
    await db.query('update public.groups set suspended_at=now() where id=$1', [s.groupId]);
    await page
      .getByTestId(`member-${s.refused.profileId}`)
      .getByRole('button', { name: /^Aprovar Pessoa / })
      .click();
    await expect(page.getByTestId('administration-error')).toContainText(
      'Este grupo está suspenso',
    );
    expect(
      (
        await db.query(
          'select status from public.group_members where group_id=$1 and profile_id=$2',
          [s.groupId, s.refused.profileId],
        )
      ).rows[0].status,
    ).toBe('pending');
    await db.query('update public.groups set suspended_at=null where id=$1', [s.groupId]);
    await page.goto(`/grupos/${s.groupId}/configuracoes`);
    await expect(page.getByTestId(`transfer-${s.organizer.profileId}`)).toBeVisible();
    await page.getByTestId(`transfer-${s.organizer.profileId}`).press('Enter');
    await page.getByRole('button', { name: 'Continuar transferência' }).press('Enter');
    await page.getByRole('button', { name: 'Cancelar', exact: true }).press('Enter');
    await expect(page.getByTestId(`transfer-${s.organizer.profileId}`)).toBeFocused();
    expect(
      (await db.query('select owner_id from public.groups where id=$1', [s.groupId])).rows[0]
        .owner_id,
    ).toBe(s.owner.profileId);
    await page.getByTestId(`transfer-${s.organizer.profileId}`).click();
    await page.getByRole('button', { name: 'Continuar transferência' }).click();
    expect(
      (
        await edge(request, s.owner, 'transfer_ownership', {
          group_id: s.groupId,
          new_owner_id: s.organizer.profileId,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    await page.getByRole('button', { name: 'Confirmar transferência' }).click();
    await expect(page.getByTestId('administration-error')).toContainText(
      'Só o dono pode fazer esta ação',
    );
    await expect(page.getByRole('button', { name: 'Confirmar transferência' })).toHaveCount(0);
  } finally {
    await clean(ids, db);
  }
});

test('UI-B logout releases member names from heap caches and persistent storage before another account signs in', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    const unique = `Member${crypto.randomUUID().replaceAll('-', '')}`;
    const actor = await createActor(request, unique, ids);
    const other = await createActor(request, 'other-account', ids);
    const invites = await db.query('select id from public.group_invites where group_id=$1', [
      s.groupId,
    ]);
    const share = await edge(request, s.owner, 'get_invite_share_link', {
      invite_id: invites.rows[0].id,
    });
    expect(
      (
        await edge(request, actor, 'join_by_code', {
          code: share.value.data?.['code'],
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    await login(page, s.owner);
    await page.goto(`/grupos/${s.groupId}/membros`);
    await expect(page.getByText(`Pessoa ${unique}`, { exact: true })).toBeVisible();
    expect(await heapContains(page, [unique])).toEqual([true]);
    await page.getByTestId('profile-avatar-link').filter({ visible: true }).first().click();
    const unloaded = handledObserver(
      page.waitForEvent('framenavigated', {
        predicate: (frame) =>
          frame === page.mainFrame() && new URL(frame.url()).pathname === '/entrar',
      }),
    );
    await page.getByRole('button', { name: 'Sair da conta' }).click();
    await page.getByTestId('profile-logout-confirm').click();
    await unloaded;
    await expect(page.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
    // Do not navigate or reload here: the application's logout must release the heap.
    await page.getByTestId('login-email').fill(other.email);
    await page.getByTestId('login-password').fill(password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Grupos', level: 1 })).toBeVisible();
    expect(await heapContains(page, [unique])).toEqual([false]);
    expect(
      await page.evaluate(async (marker) => {
        const values = [
          document.body.textContent ?? '',
          JSON.stringify(history.state),
          ...Object.keys(localStorage).map((key) => localStorage.getItem(key) ?? ''),
          ...Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key) ?? ''),
        ];
        for (const name of await caches.keys()) {
          const cache = await caches.open(name);
          for (const key of await cache.keys()) {
            values.push(key.url);
            values.push(await (await cache.match(key))!.text());
          }
        }
        return values.every((value) => !value.includes(marker));
      }, unique),
    ).toBe(true);
  } finally {
    await clean(ids, db);
  }
});

test('UI-B real HTTP contract covers missing target owner protection and approval limits', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    await login(page, s.owner);
    await page.goto(`/grupos/${s.groupId}/membros`);
    await page.route('**/functions/v1/groups/approve_member', async (route) => {
      const body = route.request().postDataJSON();
      await route.continue({
        postData: JSON.stringify({ ...body, profile_id: crypto.randomUUID() }),
      });
    });
    await page
      .getByTestId(`member-${s.pending.profileId}`)
      .getByRole('button', { name: /^Aprovar Pessoa / })
      .click();
    await expect(page.getByTestId('administration-error')).toContainText(
      'Este pedido não foi encontrado',
    );
    await expect(page.getByText('Carregando com segurança…', { exact: true })).toHaveCount(0);
    await page.unroute('**/functions/v1/groups/approve_member');
    await openActions(page, s.player.profileId);
    await page.getByTestId(`remove-${s.player.profileId}`).click();
    await page.getByTestId('remove-reason').fill('Proteção do dono');
    await page.route('**/functions/v1/groups/remove_member', async (route) => {
      const body = route.request().postDataJSON();
      await route.continue({
        postData: JSON.stringify({ ...body, profile_id: s.owner.profileId }),
      });
    });
    await page.getByRole('button', { name: 'Confirmar expulsão' }).click();
    await expect(page.getByTestId('administration-error')).toContainText(
      'O dono não pode ser expulso',
    );
    await expect(page.getByText('Carregando com segurança…', { exact: true })).toHaveCount(0);
    await page.unroute('**/functions/v1/groups/remove_member');
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    // Local configuration only: lower the same canonical limits, never bypass the mechanism.
    await db.query(
      "update private.app_limits set limit_value=4 where limit_key='max_group_capacity'",
    );
    await page
      .getByTestId(`member-${s.pending.profileId}`)
      .getByRole('button', { name: /^Aprovar Pessoa / })
      .click();
    await expect(page.getByTestId('administration-error')).toContainText('Este grupo está cheio');
    await expect(page.getByText('Carregando com segurança…', { exact: true })).toHaveCount(0);
    await db.query(
      "update private.app_limits set limit_value=100 where limit_key='max_group_capacity'",
    );
    for (let index = 0; index < 5; index += 1) {
      expect(
        (
          await edge(request, s.pending, 'create_group', {
            name: `Grupo do alvo ${index}`,
            request_id: crypto.randomUUID(),
          })
        ).status,
      ).toBe(200);
    }
    await page
      .getByTestId(`member-${s.pending.profileId}`)
      .getByRole('button', { name: /^Aprovar Pessoa / })
      .click();
    await expect(page.getByTestId('administration-error')).toContainText(
      'Esta pessoa já participa de cinco grupos ativos',
    );
    await expect(page.getByText('Carregando com segurança…', { exact: true })).toHaveCount(0);
    expect(
      (
        await db.query(
          'select status from public.group_members where group_id=$1 and profile_id=$2',
          [s.groupId, s.pending.profileId],
        )
      ).rows[0].status,
    ).toBe('pending');
  } finally {
    await db.query(
      "update private.app_limits set limit_value=100 where limit_key='max_group_capacity'",
    );
    await db.query(
      "update private.app_limits set limit_value=5 where limit_key='max_active_groups_per_profile'",
    );
    await clean(ids, db);
  }
});

test('UI-B real archived error after the actor leaves and the solo owner deletes the account', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    await login(page, s.organizer);
    await page.goto(`/grupos/${s.groupId}/configuracoes`);
    await expect(page.getByTestId('rename-group-submit')).toBeVisible();
    expect(
      (
        await edge(request, s.organizer, 'leave_group', {
          group_id: s.groupId,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await edge(request, s.owner, 'remove_member', {
          group_id: s.groupId,
          profile_id: s.player.profileId,
          reason: 'Fixture de saída',
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    const deletion = await request.post(`${env.functionsUrl}/identity/delete_account`, {
      data: { request_id: crypto.randomUUID() },
      headers: { Authorization: `Bearer ${s.owner.token}` },
    });
    expect(deletion.status()).toBe(200);
    expect(
      (
        await db.query(
          'select archived_at is not null as archived from public.groups where id=$1',
          [s.groupId],
        )
      ).rows[0].archived,
    ).toBe(true);
    await page.getByTestId('rename-group-name').fill('Nome não permitido');
    await page.getByTestId('rename-group-submit').click();
    // 0029: the refusal refreshes the screen, whose read no longer finds the
    // group; it goes back to Grupos, which says so, as for a deleted group.
    await expect(page).toHaveURL(/\/grupos\?missing=1$/u);
    await expect(page.getByTestId('group-missing-status')).toHaveText('Grupo não encontrado.');
    await expect(page.getByTestId('group-settings-card')).toHaveCount(0);
    await expect(page.getByText('Grupo UI B', { exact: true })).toHaveCount(0);
    expect(
      (await db.query('select name from public.groups where id=$1', [s.groupId])).rows[0].name,
    ).toBe('Grupo UI B');
  } finally {
    await clean(ids, db);
  }
});

// CP3 and CP5 preserve the independent reviewer's probes in the regular suite.
test('UI-B role matrix CP3 checks administrative network traffic for player pending removed and outsider', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    const outsider = await createActor(request, 'outsider', ids);
    expect(
      (
        await edge(request, s.owner, 'remove_member', {
          group_id: s.groupId,
          profile_id: s.organizer.profileId,
          reason: 'fixture',
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    const names = [
      'Pessoa owner',
      'Pessoa player',
      'Pessoa pending',
      'Pessoa refused',
      'Pessoa organizer',
    ];
    for (const [own, actor] of [
      ['Pessoa player', s.player],
      ['Pessoa pending', s.pending],
      ['Pessoa organizer', s.organizer],
      ['Pessoa outsider', outsider],
    ] as const) {
      await login(page, actor);
      for (const route of ['membros', 'configuracoes']) {
        // Leave the previous document before observing: a request it still has
        // in flight is cancelled by the next navigation, and reading that
        // cancelled response's body can hang instead of rejecting. The census
        // then sees only the requests of the route's own document.
        await page.goto('about:blank');
        const reads: string[] = [];
        const bodies: Promise<string>[] = [];
        const requests = new Set<import('@playwright/test').Request>();
        const onRequest = (item: import('@playwright/test').Request) => {
          requests.add(item);
          if (new URL(item.url()).pathname === '/functions/v1/groups/get_group_members')
            reads.push(item.url());
        };
        const onResponse = (response: import('@playwright/test').Response) => {
          const url = new URL(response.url());
          // A response from the previous document may arrive after goto cancels its body.
          if (
            requests.has(response.request()) &&
            url.origin === env.apiUrl &&
            url.pathname !== '/rest/v1/profiles'
          )
            bodies.push(response.text().catch(() => ''));
        };
        page.on('request', onRequest);
        page.on('response', onResponse);
        await page.goto(`/grupos/${s.groupId}/${route}`);
        if (own === 'Pessoa player') {
          await expect(
            page.getByText('Você precisa ser dono ou organizador ativo', { exact: false }),
          ).toBeVisible();
        } else {
          // 0029: whoever does not read the group (pending, removed, outsider)
          // goes back to Grupos, the same as for a deleted group.
          await expect(page).toHaveURL(/\/grupos\?missing=1$/u);
          await expect(page.getByTestId('group-missing-status')).toHaveText(
            'Grupo não encontrado.',
          );
        }
        await expect(
          page.getByRole('button', {
            name: /Aprovar|Recusar|Expulsar|Promover|Rebaixar|Escolher|Salvar nome/,
          }),
        ).toHaveCount(0);
        page.off('request', onRequest);
        page.off('response', onResponse);
        expect(reads).toEqual([]);
        const responses = await Promise.all(bodies);
        expect(
          responses.filter((body) => names.some((name) => name !== own && body.includes(name))),
        ).toEqual([]);
        const text = (await page.locator('body').textContent()) ?? '';
        expect(names.filter((name) => name !== own && text.includes(name))).toEqual([]);
      }
      await page.getByTestId('profile-avatar-link').filter({ visible: true }).first().click();
      await page.getByRole('button', { name: 'Sair da conta' }).click();
      await page.getByTestId('profile-logout-confirm').click();
      await expect(page.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
    }
  } finally {
    await clean(ids, db);
  }
});

async function rapidDoublePress(button: import('@playwright/test').Locator) {
  await expect(button).toBeVisible();
  // Two browser click events in the same task: no timing assumption or sleep.
  await button.evaluate((element) => {
    (element as HTMLElement).click();
    (element as HTMLElement).click();
  });
}

test('UI-B CP5 double click sends one mutation for approve role remove and transfer', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    await login(page, s.owner);
    await page.goto(`/grupos/${s.groupId}/membros`);
    const seen = new Map<string, string[]>();
    await page.route('**/functions/v1/groups/*', async (route) => {
      const op = new URL(route.request().url()).pathname.split('/').at(-1)!;
      if (['approve_member', 'set_role', 'remove_member', 'transfer_ownership'].includes(op)) {
        const body = route.request().postDataJSON() as { request_id: string };
        seen.set(op, [...(seen.get(op) ?? []), body.request_id]);
      }
      await route.continue();
    });
    await rapidDoublePress(
      page.getByRole('button', { name: 'Aprovar Pessoa pending', exact: true }),
    );
    await expect(page.getByTestId('member-result')).toHaveText('Pessoa pending foi aprovado.');
    await expect(page.getByText('Carregando com segurança…', { exact: true })).toHaveCount(0);
    expect(seen.get('approve_member')).toHaveLength(1);
    await openActions(page, s.player.profileId);
    await rapidDoublePress(page.getByTestId(`role-${s.player.profileId}`));
    await expect(page.getByTestId(`member-${s.player.profileId}`)).toContainText('Organizador');
    await expect(page.getByText('Carregando com segurança…', { exact: true })).toHaveCount(0);
    expect(seen.get('set_role')).toHaveLength(1);
    await page.getByTestId(`remove-${s.player.profileId}`).click();
    await page.getByTestId('remove-reason').fill('Motivo sintético');
    await rapidDoublePress(page.getByRole('button', { name: 'Confirmar expulsão', exact: true }));
    await expect(page.getByTestId('member-result')).toHaveText('Pessoa player foi expulso.');
    await expect(page.getByText('Carregando com segurança…', { exact: true })).toHaveCount(0);
    expect(seen.get('remove_member')).toHaveLength(1);
    await page.goto(`/grupos/${s.groupId}/configuracoes`);
    await page.getByTestId(`transfer-${s.organizer.profileId}`).click();
    await page.getByRole('button', { name: 'Continuar transferência', exact: true }).click();
    await rapidDoublePress(
      page.getByRole('button', { name: 'Confirmar transferência', exact: true }),
    );
    await expect(page.getByTestId('settings-role')).toHaveText('Organizador');
    await expect(page.getByText('Carregando com segurança…', { exact: true })).toHaveCount(0);
    expect(seen.get('transfer_ownership')).toHaveLength(1);
    const counted = await db.query(
      'select operation,count(*)::integer as n from private.idempotency_records where actor_id=$1 and request_id=any($2::uuid[]) group by operation',
      [s.owner.profileId, [...seen.values()].flat()],
    );
    expect(counted.rows).toHaveLength(4);
    expect(counted.rows.every((row: { n: number }) => row.n === 1)).toBe(true);
  } finally {
    await clean(ids, db);
  }
});

test('UI-B CP5 new target reason and name use new request_id and network retry keeps the id', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    await login(page, s.owner);
    await page.goto(`/grupos/${s.groupId}/membros`);
    const approvals: { id: string; target: string }[] = [];
    let abortApprovals = true;
    await page.route('**/functions/v1/groups/approve_member', async (route) => {
      const body = route.request().postDataJSON();
      approvals.push({ id: body.request_id, target: body.profile_id });
      if (abortApprovals) await route.abort('failed');
      else await route.continue();
    });
    const first = page.getByRole('button', { name: 'Aprovar Pessoa pending', exact: true });
    await first.click();
    await expect(page.getByTestId('administration-error')).toContainText('conexão');
    abortApprovals = false;
    await first.click();
    await expect(page.getByTestId('member-result')).toHaveText('Pessoa pending foi aprovado.');
    await page.getByRole('button', { name: 'Aprovar Pessoa refused', exact: true }).click();
    await expect(page.getByTestId('member-result')).toHaveText('Pessoa refused foi aprovado.');
    expect(approvals).toHaveLength(5);
    expect(new Set(approvals.slice(0, 4).map((entry) => entry.id)).size).toBe(1);
    expect(approvals[3]!.id).not.toBe(approvals[4]!.id);
    expect(approvals[3]!.target).not.toBe(approvals[4]!.target);
    const rem: { reason: string; id: string }[] = [];
    await page.route('**/functions/v1/groups/remove_member', async (route) => {
      const body = route.request().postDataJSON();
      rem.push({ reason: body.reason, id: body.request_id });
      if (rem.length === 1)
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'RATE_LIMIT_UNAVAILABLE', message: 'synthetic' },
            request_id: body.request_id,
          }),
        });
      else await route.continue();
    });
    await openActions(page, s.player.profileId);
    await page.getByTestId(`remove-${s.player.profileId}`).click();
    await page.getByTestId('remove-reason').fill('Primeiro motivo');
    await page.getByRole('button', { name: 'Confirmar expulsão', exact: true }).click();
    await expect(page.getByTestId('administration-error')).toBeVisible();
    await page.getByTestId('remove-reason').fill('Segundo motivo');
    await page.getByRole('button', { name: 'Confirmar expulsão', exact: true }).click();
    await expect(page.getByTestId(`member-${s.player.profileId}`)).toHaveCount(0);
    expect(rem).toHaveLength(2);
    expect(rem[0]!.id).not.toBe(rem[1]!.id);
    expect(rem.map((entry) => entry.reason)).toEqual(['Primeiro motivo', 'Segundo motivo']);
    await page.goto(`/grupos/${s.groupId}/configuracoes`);
    const renames: { name: string; id: string }[] = [];
    let abortRenames = true;
    await page.route('**/functions/v1/groups/rename_group', async (route) => {
      const body = route.request().postDataJSON();
      renames.push({ name: body.name, id: body.request_id });
      if (abortRenames) await route.abort('failed');
      else await route.continue();
    });
    await page.getByTestId('rename-group-name').fill('Primeiro nome');
    await page.getByTestId('rename-group-submit').click();
    await expect(page.getByTestId('administration-error')).toBeVisible();
    await page.getByTestId('rename-group-name').fill('Segundo nome');
    await page.getByTestId('rename-group-submit').click();
    await expect(page.getByTestId('administration-error')).toBeVisible();
    await expect(page.getByText('Carregando com segurança…', { exact: true })).toHaveCount(0);
    abortRenames = false;
    await page.getByTestId('rename-group-submit').click();
    await expect(page.getByTestId('confirmed-group-name')).toHaveText('Segundo nome');
    expect(renames).toHaveLength(7);
    expect(renames[0]!.id).not.toBe(renames[3]!.id);
    expect(new Set(renames.slice(0, 3).map((entry) => entry.id)).size).toBe(1);
    expect(new Set(renames.slice(3).map((entry) => entry.id)).size).toBe(1);
    expect(renames.map((entry) => entry.name)).toEqual([
      'Primeiro nome',
      'Primeiro nome',
      'Primeiro nome',
      'Segundo nome',
      'Segundo nome',
      'Segundo nome',
      'Segundo nome',
    ]);
  } finally {
    await clean(ids, db);
  }
});

test('UI-B twenty active members have unique accessible names and inline visible confirmations', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    const invite = (
      await db.query('select id from public.group_invites where group_id=$1', [s.groupId])
    ).rows[0].id;
    const share = await edge(request, s.owner, 'get_invite_share_link', { invite_id: invite });
    for (let index = 0; index < 17; index++) {
      const actor = await createActor(request, `member-${index.toString().padStart(2, '0')}`, ids);
      expect(
        (
          await edge(request, actor, 'join_by_code', {
            code: share.value.data?.['code'],
            request_id: crypto.randomUUID(),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await edge(request, s.owner, 'approve_member', {
            group_id: s.groupId,
            profile_id: actor.profileId,
            approve: true,
            request_id: crypto.randomUUID(),
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await db.query(
          "select count(*)::integer as n from public.group_members where group_id=$1 and status='active'",
          [s.groupId],
        )
      ).rows[0].n,
    ).toBe(20);
    await login(page, s.owner);
    await page.goto(`/grupos/${s.groupId}/membros`);
    // Prévia aprovada: two requests (✕ and ✓ each) and one "…" per member who
    // is not the owner (19); each "…" opens Promover/Rebaixar and Expulsar.
    const buttons = page.getByTestId('group-management-card').getByRole('button');
    await expect(buttons).toHaveCount(23);
    for (const member of (
      await buttons.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')))
    ).filter((id): id is string => id?.startsWith('member-menu-') === true)) {
      await openActions(page, member.slice('member-menu-'.length));
      await expect(
        page
          .getByTestId(`member-actions-${member.slice('member-menu-'.length)}`)
          .getByRole('button'),
      ).toHaveCount(2);
    }
    await page
      .getByTestId(/^member-menu-/)
      .last()
      .press('Enter');
    await expect(buttons).toHaveCount(23);
    const labels = await buttons.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('aria-label')),
    );
    expect(new Set(labels).size).toBe(23);
    for (const label of labels) {
      expect(label).toMatch(/^(Aprovar Pessoa .+|Recusar Pessoa .+|Ações para Pessoa .+)$/);
      await expect(page.getByRole('button', { name: label!, exact: true })).toHaveAccessibleName(
        label!,
      );
    }
    const approve = page.getByRole('button', { name: 'Aprovar Pessoa pending', exact: true });
    const refuse = page.getByRole('button', { name: 'Recusar Pessoa pending', exact: true });
    expect(await approve.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(
      await refuse.evaluate((node) => getComputedStyle(node).backgroundColor),
    );
    await capture(page, '17-com-pendentes.png');
    // The first member's "…" opens its actions, Expulsar among them.
    const firstMenu = await page
      .getByTestId(/^member-menu-/)
      .first()
      .getAttribute('data-testid');
    await openActions(page, firstMenu!.slice('member-menu-'.length));
    const origin = page
      .getByTestId('group-management-card')
      .getByRole('button', { name: /^Expulsar Pessoa / })
      .first();
    const id = await origin.getAttribute('data-testid');
    const row = page.getByTestId(id!.replace('remove-', 'member-'));
    await origin.click();
    const confirmation = row.getByTestId('remove-confirmation');
    await expect(confirmation).toHaveCount(1);
    await expect(confirmation.getByTestId('remove-confirmation-heading')).toBeFocused();
    const rect = await confirmation.boundingBox();
    const originRect = await origin.boundingBox();
    expect(rect!.y - (originRect!.y + originRect!.height)).toBeLessThanOrEqual(24);
    await expect(confirmation.getByTestId('remove-confirmation-heading')).toBeInViewport({
      ratio: 1,
    });
    await expect(confirmation.getByRole('button', { name: 'Confirmar expulsão' })).toBeInViewport({
      ratio: 1,
    });
    expect(
      await confirmation
        .getByTestId('remove-confirmation-heading')
        .evaluate((node) => getComputedStyle(node).fontFamily),
    ).toContain('system-ui');
    await capture(page, '17-expulsao-20-membros.png');
    await confirmation.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(origin).toBeFocused();
    await expect(origin).toBeInViewport({ ratio: 1 });
    await page.goto(`/grupos/${s.groupId}/configuracoes`);
    await expect(page.getByTestId('rename-group-name')).toHaveValue('Grupo UI B');
    const choices = page.getByRole('button', { name: /^Escolher Pessoa / });
    await expect(choices).toHaveCount(19);
    const choiceNames = await choices.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('aria-label')),
    );
    expect(new Set(choiceNames).size).toBe(19);
    for (const name of choiceNames)
      await expect(page.getByRole('button', { name: name!, exact: true })).toHaveAccessibleName(
        name!,
      );
    await capture(page, '25-dono.png');
    const choice = choices.first();
    await choice.click();
    for (const step of [1, 2]) {
      const panel = page.getByTestId(`transfer-confirmation-${step}`);
      await expect(panel.getByTestId(`transfer-confirmation-${step}-heading`)).toBeFocused();
      expect(
        await panel.evaluate((node) => node.previousElementSibling?.getAttribute('data-testid')),
      ).toBe(await choice.getAttribute('data-testid'));
      await expect(panel).toBeInViewport({ ratio: 1 });
      await capture(page, `25-transferencia-${step}.png`);
      if (step === 1) await panel.getByRole('button', { name: 'Continuar transferência' }).click();
    }
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(choice).toBeFocused();
    await expect(choice).toBeInViewport({ ratio: 1 });
  } finally {
    await clean(ids, db);
  }
});

test('UI-B CP5 another target after failed intent gets a new request_id and mutates only the new target', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    await login(page, s.owner);
    await page.goto(`/grupos/${s.groupId}/membros`);
    const seen: { id: string; target: string }[] = [];
    await page.route('**/functions/v1/groups/approve_member', async (route) => {
      const body = route.request().postDataJSON();
      seen.push({ id: body.request_id, target: body.profile_id });
      if (seen.length === 1)
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'RATE_LIMIT_UNAVAILABLE', message: 'synthetic' },
            request_id: body.request_id,
          }),
        });
      else await route.continue();
    });
    await page.getByRole('button', { name: 'Aprovar Pessoa pending', exact: true }).click();
    await expect(page.getByTestId('administration-error')).toBeVisible();
    await page.getByRole('button', { name: 'Aprovar Pessoa refused', exact: true }).click();
    await expect(page.getByTestId(`member-${s.refused.profileId}`)).toContainText('Jogador');
    await expect(
      page
        .getByTestId(`member-${s.pending.profileId}`)
        .getByRole('button', { name: /^Aprovar Pessoa / }),
    ).toBeVisible();
    expect(seen).toHaveLength(2);
    expect(seen[0]!.id).not.toBe(seen[1]!.id);
    expect(seen.map((entry) => entry.target)).toEqual([s.pending.profileId, s.refused.profileId]);
    expect(
      (
        await db.query(
          'select profile_id,status from public.group_members where group_id=$1 and profile_id=any($2::uuid[])',
          [s.groupId, [s.pending.profileId, s.refused.profileId]],
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        { profile_id: s.pending.profileId, status: 'pending' },
        { profile_id: s.refused.profileId, status: 'active' },
      ]),
    );
  } finally {
    await clean(ids, db);
  }
});

test('UI-B ownership warning uses the confirmed stored player role', async ({ page, request }) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    expect(
      (
        await edge(request, s.owner, 'transfer_ownership', {
          group_id: s.groupId,
          new_owner_id: s.player.profileId,
          request_id: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    await login(page, s.player);
    await page.goto(`/grupos/${s.groupId}/configuracoes`);
    await page.getByTestId(`transfer-${s.owner.profileId}`).click();
    await expect(
      page.getByText('Você deixa de ser dono e passa a ser jogador.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Continuar transferência' }).click();
    await page.getByRole('button', { name: 'Confirmar transferência' }).click();
    await expect(
      page.getByText('A titularidade foi transferida para Pessoa owner.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('group-settings-card')).toHaveCount(0);
    await page.goto(`/grupos/${s.groupId}`);
    await expect(page.getByTestId('group-summary')).toContainText('você é jogador');
    await expect(page.getByRole('button', { name: 'Configurar', exact: true })).toHaveCount(0);
    expect(
      (
        await db.query(
          'select role from public.group_members where group_id=$1 and profile_id=$2',
          [s.groupId, s.player.profileId],
        )
      ).rows[0].role,
    ).toBe('player');
  } finally {
    await clean(ids, db);
  }
});

test('UI-B screen 25 keeps its live region across consecutive rename announcements', async ({
  page,
  request,
}) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const ids: string[] = [];
  try {
    const s = await scenario(request, db, ids);
    await login(page, s.owner);
    await page.goto(`/grupos/${s.groupId}/configuracoes`);
    const result = page.getByTestId('settings-result');
    await expect(result).toHaveText('');
    await result.evaluate((node) => {
      const state = window as typeof window & { statusNode?: Element; statusChanges?: string[] };
      state.statusNode = node;
      state.statusChanges = [];
      new MutationObserver(() => state.statusChanges!.push(node.textContent ?? '')).observe(node, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    for (const name of ['Primeira ação', 'Segunda ação']) {
      await page.getByTestId('rename-group-name').fill(name);
      await page.getByTestId('rename-group-submit').click();
      await expect(page.getByTestId('confirmed-group-name')).toHaveText(name);
      await expect(result).toHaveText('Nome atualizado.');
    }
    expect(
      await result.evaluate((node) => {
        const state = window as typeof window & { statusNode?: Element; statusChanges?: string[] };
        return { sameNode: state.statusNode === node, changes: state.statusChanges };
      }),
    ).toEqual({ sameNode: true, changes: ['Nome atualizado.', '', 'Nome atualizado.'] });
  } finally {
    await clean(ids, db);
  }
});
