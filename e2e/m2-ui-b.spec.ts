import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import path from 'node:path';
import pg from 'pg';
import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { assertNoHorizontalOverflow } from './support/layout';
import { handledObserver } from './support/observers';

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
  await db.query('begin');
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
  await expect(page.getByRole('heading', { name: 'Perfil', level: 1 })).toBeVisible();
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
  await page.getByRole('button', { name: 'Usar tema escuro' }).click();
  await assertAccessible(page);
  await page.getByRole('button', { name: 'Usar tema claro' }).click();
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
async function clean(ids: string[], db: pg.Client) {
  await cleanActors(ids, db);
  expect((await db.query('select count(*)::integer as n from auth.users')).rows[0].n).toBe(0);
  await db.end();
}

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
      await expect(page.getByTestId('group-members-list')).toBeVisible();
      for (const name of ['Gestão de membros', 'Configurações do grupo'])
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
          await expect(page.getByRole('button', { name: 'Aprovar', exact: true })).toHaveCount(2);
          await expect(page.getByRole('button', { name: 'Recusar', exact: true })).toHaveCount(2);
          await expect(page.getByTestId(`role-${s.player.profileId}`)).toHaveCount(
            role === 'owner' ? 1 : 0,
          );
          await expect(page.getByTestId(`role-${s.organizer.profileId}`)).toHaveCount(
            role === 'owner' ? 1 : 0,
          );
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
        }
      }
    }
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
      .getByRole('button', { name: 'Aprovar', exact: true })
      .press('Enter');
    await expect(page.getByTestId(`member-${s.pending.profileId}`)).toContainText('Jogador');
    await page
      .getByTestId(`member-${s.refused.profileId}`)
      .getByRole('button', { name: 'Recusar', exact: true })
      .press('Enter');
    await expect(page.getByTestId(`member-${s.refused.profileId}`)).toHaveCount(0);
    await expect(page.getByText('Não há pedidos pendentes.')).toBeVisible();
    await capture(page, '17-sem-pendentes.png');
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
    await accessible(page);
    await capture(page, '25-transferencia-1.png');
    await page.getByRole('button', { name: 'Continuar transferência' }).press('Enter');
    await expect(page.getByTestId('transfer-confirmation-2-heading')).toBeFocused();
    await accessible(page);
    await capture(page, '25-transferencia-2.png');
    await page.getByRole('button', { name: 'Confirmar transferência' }).press('Enter');
    await expect(
      page.getByText('Titularidade transferida. Seu papel foi atualizado.'),
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
        .getByRole('button', { name: 'Aprovar', exact: true });
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
      .getByRole('button', { name: 'Aprovar', exact: true })
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
    await expect(page.getByTestId('administration-error')).toContainText(
      'Você não participa deste grupo',
    );
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
        .getByRole('button', { name: 'Aprovar', exact: true })
        .click();
      await expect(page.getByTestId('administration-error')).toHaveText(message!);
      await expect(page.getByTestId(`member-${s.pending.profileId}`)).toContainText('Aprovar');
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
      .getByRole('button', { name: 'Aprovar', exact: true })
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
    await page.getByTestId(`role-${s.player.profileId}`).click();
    await expect(page.getByTestId('administration-error')).toContainText(
      'Esta pessoa não é mais um membro ativo',
    );
    await expect(page.getByTestId(`member-${s.player.profileId}`)).toHaveCount(0);
    // M2-D11 explicitly allows suspended_at as a direct local fixture.
    await db.query('update public.groups set suspended_at=now() where id=$1', [s.groupId]);
    await page
      .getByTestId(`member-${s.refused.profileId}`)
      .getByRole('button', { name: 'Aprovar', exact: true })
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
    await page.getByRole('link', { name: 'Perfil', exact: true }).click();
    const unloaded = handledObserver(
      page.waitForEvent('framenavigated', {
        predicate: (frame) =>
          frame === page.mainFrame() && new URL(frame.url()).pathname === '/entrar',
      }),
    );
    await page.getByRole('button', { name: 'Sair com segurança' }).click();
    await unloaded;
    await expect(page.getByRole('heading', { name: 'Entrar', level: 1 })).toBeVisible();
    // Do not navigate or reload here: the application's logout must release the heap.
    await page.getByTestId('login-email').fill(other.email);
    await page.getByTestId('login-password').fill(password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Perfil', level: 1 })).toBeVisible();
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
      .getByRole('button', { name: 'Aprovar', exact: true })
      .click();
    await expect(page.getByTestId('administration-error')).toContainText(
      'Este pedido não foi encontrado',
    );
    await expect(page.getByText('Carregando com segurança…', { exact: true })).toHaveCount(0);
    await page.unroute('**/functions/v1/groups/approve_member');
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
      .getByRole('button', { name: 'Aprovar', exact: true })
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
      .getByRole('button', { name: 'Aprovar', exact: true })
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
    await expect(page.getByTestId('administration-error')).toHaveText(
      'Este grupo foi arquivado. Volte à lista de grupos.',
    );
    await expect(page.getByTestId('group-settings-card')).toHaveCount(0);
    await expect(page.getByText('Grupo UI B', { exact: true })).toHaveCount(0);
    expect(
      (await db.query('select name from public.groups where id=$1', [s.groupId])).rows[0].name,
    ).toBe('Grupo UI B');
  } finally {
    await clean(ids, db);
  }
});
