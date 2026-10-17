import { expect, test, type APIRequestContext, type Page } from './support/csp';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

import { assertAccessible, createVerifiedUser, localEnvironment } from './support/local-stack';
import { handledObserver } from './support/observers';

// Ajustes do teste do César (PR F): full profile on the first access, fewer
// field descriptions, no small label over the screen title, and "Sair da
// conta" as the last, confirmed action of the profile. The join flow change
// is proved in m2-ui-a.spec.ts, where the join journey lives.
const { Client } = pg;
const env = localEnvironment();
const password = 'Synthetic-ajustes-test-2026';
const prefix = `ajustes-${Date.now()}-${process.pid}`;
const screenshotRoot = process.env['COLETE_AJUSTES_SCREENSHOTS_DIR'];
type Actor = { authId: string; profileId: string; token: string; email: string };

test.use({ colorScheme: 'dark' });

async function shot(page: Page, project: string, file: string) {
  if (project !== 'mobile-chromium' || !screenshotRoot || !existsSync(screenshotRoot)) return;
  await page.screenshot({ path: path.join(screenshotRoot, file), fullPage: true });
}

async function login(page: Page, email: string) {
  await page.goto('/entrar');
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
    await db.query('delete from private.revoked_auth_sessions where profile_id = any($1::uuid[])', [
      ids,
    ]);
    await db.query(`delete from public.group_invites where group_id in (${groups})`, [ids]);
    await db.query(`delete from public.group_members where group_id in (${groups})`, [ids]);
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
}

test('Ajustes: the first access takes the whole profile, with the edit rules', async ({
  page,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const email = `${prefix}-novo@colete.test`;
    const { id } = await createVerifiedUser(request, env, { email, name: 'Ana Souza', password });
    authIds.push(id);
    await login(page, email);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Complete seu perfil' }),
    ).toBeVisible();
    // No small label over the title, no "Opcional. Apague…" under the fields.
    await expect(page.getByText('Última etapa', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Opcional. Apague o texto', { exact: false })).toHaveCount(0);
    for (const field of ['name', 'nickname', 'position', 'dominant-foot', 'shirt-number']) {
      await expect(page.getByTestId(`complete-profile-${field}`)).toBeVisible();
    }
    await expect(page.getByTestId('complete-profile-name')).toHaveValue('Ana Souza');
    // The edit's validation: a shirt number out of 0–99 is refused on its field.
    await page.getByTestId('complete-profile-shirt-number').fill('100');
    await page.getByTestId('complete-profile-submit').click();
    await expect(page.getByText('Escolha um número de 0 a 99.')).toBeVisible();
    await page.getByTestId('complete-profile-shirt-number').fill('10');
    await page.getByTestId('complete-profile-nickname').fill('Aninha');
    await page
      .getByTestId('complete-profile-position')
      .getByRole('radio', { name: 'Atacante' })
      .click();
    await page
      .getByTestId('complete-profile-dominant-foot')
      .getByRole('radio', { name: 'Direita' })
      .click();
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'aj-01-completar-perfil.png');
    const completion = handledObserver(
      page.waitForResponse((item) =>
        new URL(item.url()).pathname.endsWith('/identity/complete_profile'),
      ),
    );
    await page.getByTestId('complete-profile-submit').click();
    const response = await completion;
    expect(response.status()).toBe(200);
    // One complete_profile call carries every field filled in.
    expect(response.request().postDataJSON().profile).toEqual({
      name: 'Ana Souza',
      nickname: 'Aninha',
      position: 'forward',
      dominant_foot: 'right',
      shirt_number: 10,
    });
    await expect(page.getByRole('heading', { level: 1, name: 'Grupos' })).toBeVisible();
    await page.getByRole('link', { name: 'Perfil', exact: true }).click();
    await expect(page.getByTestId('profile-value-nickname')).toHaveText('Aninha');
    await expect(page.getByTestId('profile-value-position')).toHaveText('Atacante');
    await expect(page.getByTestId('profile-value-dominant-foot')).toHaveText('Direita');
    await expect(page.getByTestId('profile-value-shirt-number')).toHaveText('10');
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});

test('Ajustes: titles stand alone, hints are gone, and signing out is last and confirmed', async ({
  page,
  request,
}, testInfo) => {
  const db = new Client({ connectionString: env.dbUrl });
  await db.connect();
  const authIds: string[] = [];
  try {
    const owner = await createActor(request, 'dono', authIds);
    const created = await request.post(`${env.functionsUrl}/groups/create_group`, {
      data: { request_id: crypto.randomUUID(), name: 'Grupo Limpo' },
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(created.status()).toBe(200);
    const groupId = ((await created.json()) as { data: { outcome: { group_id: string } } }).data
      .outcome.group_id;
    await login(page, owner.email);
    await expect(page.getByRole('heading', { level: 1, name: 'Grupos' })).toBeVisible();

    await page.goto(`/grupos/${groupId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Detalhe do grupo' })).toBeVisible();
    await expect(page.getByText('Grupo Limpo').first()).toBeVisible();
    await expect(page.getByText('Seu grupo', { exact: true })).toHaveCount(0);
    await shot(page, testInfo.project.name, 'aj-02-grupo-sem-rotulo.png');

    await page.goto(`/criar-racha?groupId=${groupId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Criar racha' })).toBeVisible();
    await expect(page.getByText('Novo racha', { exact: true })).toHaveCount(0);
    for (const gone of [
      'DD/MM/AAAA.',
      'HH:MM, no horário deste aparelho.',
      'Texto livre: nome da quadra',
      'Digite o endereço ou toque em Buscar',
      'Texto simples, sem links ativos.',
    ]) {
      await expect(page.getByText(gone, { exact: false })).toHaveCount(0);
    }
    // The description that prevents a real error stays: the price mask.
    await expect(page.getByText('Só números: 2500 vira R$ 25,00.')).toBeVisible();
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'aj-03-criar-racha-sem-dicas.png');

    await page.goto('/perfil');
    await expect(page.getByRole('heading', { level: 1, name: 'Perfil' })).toBeVisible();
    await expect(page.getByText('Conta e identidade', { exact: true })).toHaveCount(0);
    // "Sair da conta" is the last block, below security and privacy.
    const settings = (await page.getByTestId('profile-settings-card').boundingBox())!;
    const logoutCard = (await page.getByTestId('profile-logout-card').boundingBox())!;
    expect(logoutCard.y).toBeGreaterThan(settings.y + settings.height);
    const logout = page.getByTestId('profile-logout');
    await logout.click();
    await expect(page.getByTestId('profile-logout-confirmation-heading')).toBeFocused();
    await expect(page.getByTestId('profile-logout-confirmation')).toContainText(
      'Sair da conta neste aparelho?',
    );
    await assertAccessible(page);
    await shot(page, testInfo.project.name, 'aj-04-perfil-sair-confirmacao.png');
    await page.getByTestId('profile-logout-cancel').click();
    await expect(page.getByTestId('profile-logout-confirmation')).toHaveCount(0);
    await expect(logout).toBeFocused();
    await logout.click();
    const revoked = handledObserver(
      page.waitForResponse((item) =>
        new URL(item.url()).pathname.endsWith('/identity/revoke_current_session'),
      ),
    );
    await page.getByTestId('profile-logout-confirm').click();
    expect((await revoked).status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
  } finally {
    await cleanActors(authIds, db);
    await db.end();
  }
});
