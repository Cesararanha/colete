import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

import {
  applyCpuThrottling,
  assertMinimumInteractiveTargets,
  assertNoHorizontalOverflow,
} from './support/layout';

const { Client } = pg;
const repositoryRoot = process.cwd();
const supabaseBinary = path.join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
);
const runSuffix = `${Date.now()}-${process.pid}`;
const account = {
  email: `auth-e2e-${runSuffix}@colete.test`,
  inputName: 'Ana Acessi\u0301vel',
  name: 'Ana Acessível',
  newPassword: 'Frase-nova-segura-2026',
  password: 'Frase-segura-2026',
};

test.beforeEach(async ({ page }) => {
  await applyCpuThrottling(page, process.env.COLETE_E2E_CPU_THROTTLE_RATE);
});

function localEnvironment() {
  const raw = execFileSync(supabaseBinary, ['status', '-o', 'env'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const read = (name: string) => {
    const value = raw.match(new RegExp(`^${name}="([^"]+)"$`, 'm'))?.[1];
    if (value === undefined) throw new Error(`supabase status did not expose ${name}`);
    return value;
  };
  return {
    apiUrl: read('API_URL'),
    dbUrl: read('DB_URL'),
    mailUrl: read('MAILPIT_URL'),
    publishableKey: read('PUBLISHABLE_KEY'),
  };
}

type MailpitSummary = { ID: string; To?: { Address?: string }[] };

async function messagesForRecipient(
  request: APIRequestContext,
  mailUrl: string,
  email: string,
): Promise<MailpitSummary[]> {
  const inbox = await request.get(`${mailUrl}/api/v1/messages`);
  if (!inbox.ok()) throw new Error('The local Mailpit inbox could not be read.');
  const payload = (await inbox.json()) as { messages?: MailpitSummary[] };
  return (payload.messages ?? []).filter((candidate) =>
    candidate.To?.some((recipient) => recipient.Address?.toLowerCase() === email.toLowerCase()),
  );
}

async function deleteMessagesForRecipient(
  request: APIRequestContext,
  mailUrl: string,
  email: string,
) {
  const ids = (await messagesForRecipient(request, mailUrl, email)).map((message) => message.ID);
  if (ids.length === 0) return;
  const removed = await request.delete(`${mailUrl}/api/v1/messages`, { data: { IDs: ids } });
  if (!removed.ok()) throw new Error('The local OTP message could not be removed from Mailpit.');
}

async function readLatestOtp(request: APIRequestContext, mailUrl: string, email: string) {
  return expect
    .poll(
      async () => {
        const message = (await messagesForRecipient(request, mailUrl, email))[0];
        if (message === undefined) return null;
        const detail = await request.get(`${mailUrl}/api/v1/message/${message.ID}`);
        if (!detail.ok()) return null;
        const content = (await detail.json()) as { HTML?: string; Text?: string };
        return `${content.Text ?? ''}\n${content.HTML ?? ''}`.match(/\b(\d{6})\b/u)?.[1] ?? null;
      },
      { intervals: [250, 500, 1_000], timeout: 15_000 },
    )
    .not.toBeNull()
    .then(async () => {
      const message = (await messagesForRecipient(request, mailUrl, email))[0];
      if (message === undefined) throw new Error('The OTP message disappeared from Mailpit.');
      const detail = (await (
        await request.get(`${mailUrl}/api/v1/message/${message.ID}`)
      ).json()) as { HTML?: string; Text?: string };
      const otp = `${detail.Text ?? ''}\n${detail.HTML ?? ''}`.match(/\b(\d{6})\b/u)?.[1];
      if (otp === undefined) throw new Error('The local e-mail did not contain a six-digit OTP.');
      await deleteMessagesForRecipient(request, mailUrl, email);
      return otp;
    });
}

async function createVerifiedAuthUserWithoutProfile(
  request: APIRequestContext,
  env: ReturnType<typeof localEnvironment>,
  user: { email: string; name: string; password: string },
) {
  const signup = await request.post(`${env.apiUrl}/auth/v1/signup`, {
    data: { data: { name: user.name }, email: user.email, password: user.password },
    headers: { apikey: env.publishableKey },
  });
  expect(signup.ok()).toBe(true);

  const otp = await readLatestOtp(request, env.mailUrl, user.email);
  const verification = await request.post(`${env.apiUrl}/auth/v1/verify`, {
    data: { email: user.email, token: otp, type: 'signup' },
    headers: { apikey: env.publishableKey },
  });
  expect(verification.ok()).toBe(true);
}

async function assertAccessible(page: Page) {
  await assertNoHorizontalOverflow(page);
  await assertMinimumInteractiveTargets(
    page,
    'a:visible, button:visible, input:visible, [role="button"]:visible, [role="link"]:visible',
  );

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
}

function waitForProfileGate(page: Page) {
  const ownProfile = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === 'GET' && url.pathname === '/rest/v1/profiles' && response.ok()
    );
  });
  const deletionRequest = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === 'POST' &&
      url.pathname === '/rest/v1/rpc/get_own_deletion_request'
    );
  });
  return Promise.all([ownProfile, deletionRequest]).then((responses) => {
    for (const response of responses) {
      const request = response.request();
      expect(
        response.ok(),
        `${request.method()} ${new URL(response.url()).pathname} returned ${response.status()}`,
      ).toBe(true);
    }
  });
}

async function installSessionPropagationGap(page: Page) {
  await page.addInitScript(() => {
    const state = { armed: false, denied: false };
    Object.defineProperty(window, '__coleteSessionPropagationGap', { value: state });
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/auth/v1/verify') && response.ok) state.armed = true;
      return response;
    };
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function getItem(key: string) {
      const sessionLookup = (new Error().stack ?? '').includes('_getSessionToken');
      if (state.armed && !state.denied && sessionLookup && key.includes('-auth-token')) {
        state.denied = true;
        return null;
      }
      return originalGetItem.call(this, key);
    };
  });
}

async function sessionPropagationGapWasApplied(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __coleteSessionPropagationGap: { denied: boolean };
        }
      ).__coleteSessionPropagationGap.denied,
  );
}

async function refreshStoredSession(page: Page, apiUrl: string, publishableKey: string) {
  return page.evaluate(
    async ({ authUrl, key }) => {
      const findRefreshToken = (value: unknown): string | null => {
        if (typeof value !== 'object' || value === null) return null;
        const record = value as Record<string, unknown>;
        if (typeof record.refresh_token === 'string') return record.refresh_token;
        for (const nested of Object.values(record)) {
          const token = findRefreshToken(nested);
          if (token !== null) return token;
        }
        return null;
      };
      let refreshToken: string | null = null;
      for (let index = 0; index < localStorage.length && refreshToken === null; index += 1) {
        const raw = localStorage.getItem(localStorage.key(index) ?? '');
        if (raw === null) continue;
        try {
          refreshToken = findRefreshToken(JSON.parse(raw) as unknown);
        } catch {
          // Ignore unrelated non-JSON browser state.
        }
      }
      if (refreshToken === null) throw new Error('The second session has no stored refresh token.');

      const response = await fetch(`${authUrl}/auth/v1/token?grant_type=refresh_token`, {
        body: JSON.stringify({ refresh_token: refreshToken }),
        headers: { apikey: key, 'content-type': 'application/json' },
        method: 'POST',
      });
      return { ok: response.ok, status: response.status };
    },
    { authUrl: apiUrl, key: publishableKey },
  );
}

test.describe('M1-A authentication', () => {
  test('creates a real account, reads OTP from local e-mail and completes the profile', async ({
    browser,
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium');
    test.setTimeout(60_000);
    const env = localEnvironment();
    const db = new Client({ connectionString: env.dbUrl });
    await db.connect();
    let secondContext: BrowserContext | undefined;
    let thirdContext: BrowserContext | undefined;
    const probeContexts: BrowserContext[] = [];
    const profileBodies: { patch?: Record<string, unknown>; request_id?: string }[] = [];
    page.on('request', (request) => {
      if (!request.url().endsWith('/functions/v1/identity/update_profile')) return;
      const body = request.postDataJSON() as {
        patch?: Record<string, unknown>;
        request_id?: string;
      };
      profileBodies.push(body);
    });

    try {
      await installSessionPropagationGap(page);
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      await page.goto('/criar-conta');
      await page.getByLabel('Nome').fill(account.inputName);
      await page.getByLabel('E-mail').fill(account.email.toUpperCase());
      await page.getByLabel('Senha', { exact: true }).fill(account.password);
      await page.getByLabel('Confirmar senha').fill(account.password);
      await page.getByRole('button', { name: 'Enviar código' }).click();

      await expect(page).toHaveURL(/\/verificar-codigo$/u);
      await expect(page.getByTestId('resend-countdown')).toContainText(
        /Reenvio disponível em \d+ segundos?\./u,
      );
      await expect(page.getByText(/Você poderá reenviar às \d{2}:\d{2}\./u)).toBeVisible();
      const otp = await readLatestOtp(request, env.mailUrl, account.email);
      await page.getByLabel('Código de 6 dígitos').fill(otp);
      await page.route('**/auth/v1/verify**', (route) => route.abort('connectionfailed'));
      await page.getByRole('button', { name: 'Verificar e continuar' }).click();
      await expect(page.getByRole('alert')).toContainText('Confira sua conexão');
      await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
      await page.unroute('**/auth/v1/verify**');
      const firstProfileGate = waitForProfileGate(page);
      await page.getByRole('button', { name: 'Tentar de novo' }).click();

      await expect(page).toHaveURL(/\/perfil$/u);
      await firstProfileGate;
      expect(await sessionPropagationGapWasApplied(page)).toBe(true);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Complete seu perfil' }),
      ).toBeVisible();
      const invalidSession = await request.post(
        `${env.apiUrl}/rest/v1/rpc/get_own_deletion_request`,
        {
          headers: {
            apikey: env.publishableKey,
            Authorization: 'Bearer invalid-session-token',
          },
        },
      );
      expect(invalidSession.status()).toBe(401);
      await expect(page.getByLabel('Nome')).toHaveValue(account.name);
      const reloadedProfileGate = waitForProfileGate(page);
      await page.reload();
      await expect(page).toHaveURL(/\/perfil$/u);
      await reloadedProfileGate;
      await expect(
        page.getByRole('heading', { level: 1, name: 'Complete seu perfil' }),
      ).toBeVisible();
      await expect(page.getByLabel('Nome')).toHaveValue(account.name);
      await page.getByRole('button', { name: 'Concluir perfil' }).click();
      await expect(page).toHaveTitle('Perfil · Colete');
      await expect(page.getByRole('heading', { level: 1, name: 'Perfil' })).toBeVisible();
      await expect(page.getByLabel('Nome')).toHaveValue(account.name);
      await expect(page.getByTestId('profile-provider-card')).toContainText('E-mail e senha');
      const profileAfterReloadedCompletion = await db.query<{ count: number; name: string }>(
        `select count(*)::int as count, min(profile.name) as name
           from public.profiles as profile
           join auth.users as users on users.id = profile.auth_user_id
          where lower(users.email) = lower($1)`,
        [account.email],
      );
      expect(profileAfterReloadedCompletion.rows).toEqual([{ count: 1, name: account.name }]);
      await assertAccessible(page);
      await page.getByRole('button', { name: 'Usar tema escuro' }).click();
      await assertAccessible(page);
      await page.getByRole('button', { name: 'Usar tema claro' }).click();

      await page.getByLabel('Apelido', { exact: true }).fill('Capitã');
      await page.getByRole('button', { name: 'Meio-campista' }).click();
      await page.getByRole('button', { name: 'Salvar dados' }).click();
      await expect(page.getByTestId('profile-data-card').getByRole('status')).toContainText(
        'Dados do perfil salvos.',
      );
      expect(profileBodies.at(-1)?.patch).toEqual({
        nickname: 'Capitã',
        position: 'midfielder',
      });

      const editedProfile = await db.query<{
        nickname: string | null;
        position: string | null;
      }>(
        `select profile.nickname, profile.position
           from public.profiles as profile
           join auth.users as users on users.id = profile.auth_user_id
          where lower(users.email) = lower($1)`,
        [account.email],
      );
      expect(editedProfile.rows).toEqual([{ nickname: 'Capitã', position: 'midfielder' }]);

      await page.getByRole('button', { name: 'Limpar apelido' }).click();
      await page.getByRole('button', { name: 'Salvar dados' }).click();
      await expect(page.getByTestId('profile-data-card').getByRole('status')).toContainText(
        'Dados do perfil salvos.',
      );
      expect(profileBodies.at(-1)?.patch).toEqual({ nickname: null });

      const clearedProfile = await db.query<{
        nickname: string | null;
        position: string | null;
      }>(
        `select profile.nickname, profile.position
           from public.profiles as profile
           join auth.users as users on users.id = profile.auth_user_id
          where lower(users.email) = lower($1)`,
        [account.email],
      );
      expect(clearedProfile.rows).toEqual([{ nickname: null, position: 'midfielder' }]);

      const transmittedBeforeBlank = profileBodies.length;
      await page.getByLabel('Apelido', { exact: true }).fill('   ');
      await page.getByRole('button', { name: 'Salvar dados' }).click();
      await expect(page.getByLabel('Apelido', { exact: true })).toBeFocused();
      await expect(page.getByTestId('profile-data-card').getByRole('alert')).toContainText(
        'Apague o campo ou escreva pelo menos um caractere.',
      );
      expect(profileBodies).toHaveLength(transmittedBeforeBlank);
      await page.getByRole('button', { name: 'Limpar apelido' }).click();

      const evidence = await db.query<{
        acceptance_count: number;
        auth_name: string;
        idempotency_state: string;
        profile_nickname: string | null;
        profile_count: number;
        profile_name: string;
        profile_position: string | null;
      }>(
        `select
           users.raw_user_meta_data->>'name' as auth_name,
           (select count(*)::int from public.profiles where auth_user_id = users.id) as profile_count,
           (select name from public.profiles where auth_user_id = users.id) as profile_name,
           (select nickname from public.profiles where auth_user_id = users.id) as profile_nickname,
           (select position from public.profiles where auth_user_id = users.id) as profile_position,
           (select count(*)::int
              from public.policy_acceptances as acceptance
              join public.profiles as profile on profile.id = acceptance.profile_id
             where profile.auth_user_id = users.id) as acceptance_count,
           (select record.state
              from private.idempotency_records as record
              join public.profiles as profile on profile.id = record.actor_id
             where profile.auth_user_id = users.id
               and record.operation = 'complete_profile') as idempotency_state
         from auth.users as users
        where lower(users.email) = lower($1)`,
        [account.email],
      );
      expect(evidence.rows).toEqual([
        {
          acceptance_count: 0,
          auth_name: account.name,
          idempotency_state: 'completed',
          profile_count: 1,
          profile_name: account.name,
          profile_nickname: null,
          profile_position: 'midfielder',
        },
      ]);

      const initialSessions = await db.query<{ id: string }>(
        `select session.id
           from auth.sessions as session
           join auth.users as users on users.id = session.user_id
          where lower(users.email) = lower($1)`,
        [account.email],
      );
      expect(initialSessions.rows).toHaveLength(1);
      const initialSessionIds = new Set(initialSessions.rows.map((session) => session.id));

      secondContext = await browser.newContext({
        colorScheme: 'light',
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
        viewport: { height: 800, width: 1280 },
      });
      const secondPage = await secondContext.newPage();
      await secondPage.goto('http://127.0.0.1:4173/entrar');
      await secondPage.getByLabel('E-mail').fill(account.email);
      await secondPage.getByLabel('Senha', { exact: true }).fill(account.password);
      await secondPage.getByRole('button', { name: 'Entrar', exact: true }).click();
      await expect(secondPage.getByRole('heading', { level: 1, name: 'Perfil' })).toBeVisible();
      await expect(secondPage).toHaveTitle('Perfil · Colete');
      await assertAccessible(secondPage);
      await secondPage.getByRole('button', { name: 'Usar tema escuro' }).click();
      await assertAccessible(secondPage);

      const sessionsBeforePasswordChange = await db.query<{
        active_refresh_token_id: string;
        active_refresh_tokens: number;
        id: string;
      }>(
        `select session.id,
                (select token.id::text
                   from auth.refresh_tokens as token
                  where token.session_id = session.id
                    and not token.revoked
                  order by token.id desc
                  limit 1) as active_refresh_token_id,
                (select count(*)::int
                   from auth.refresh_tokens as token
                  where token.session_id = session.id
                    and not token.revoked) as active_refresh_tokens
           from auth.sessions as session
           join auth.users as users on users.id = session.user_id
          where lower(users.email) = lower($1)`,
        [account.email],
      );
      expect(sessionsBeforePasswordChange.rows).toHaveLength(2);
      const secondSessions = sessionsBeforePasswordChange.rows.filter(
        (session) => !initialSessionIds.has(session.id),
      );
      expect(secondSessions).toHaveLength(1);
      const secondSession = secondSessions[0];
      expect(secondSession).toBeDefined();
      expect(secondSession?.active_refresh_tokens).toBeGreaterThan(0);

      await page.getByLabel('Nova senha', { exact: true }).fill(account.newPassword);
      await page.getByLabel('Confirmar nova senha', { exact: true }).fill(account.newPassword);
      await page.getByRole('button', { name: 'Salvar nova senha' }).click();
      await expect(page.getByTestId('profile-password-card').getByRole('status')).toContainText(
        'Senha atualizada.',
      );

      const sessionsAfterPasswordChange = await db.query<{ id: string }>(
        `select session.id
           from auth.sessions as session
           join auth.users as users on users.id = session.user_id
          where lower(users.email) = lower($1)`,
        [account.email],
      );
      expect(sessionsAfterPasswordChange.rows).toEqual(initialSessions.rows);
      await expect(
        refreshStoredSession(secondPage, env.apiUrl, env.publishableKey),
      ).resolves.toEqual({ ok: false, status: 400 });

      thirdContext = await browser.newContext({
        colorScheme: 'light',
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
        viewport: { height: 800, width: 1280 },
      });
      const thirdPage = await thirdContext.newPage();
      await thirdPage.goto('http://127.0.0.1:4173/entrar');
      await thirdPage.getByLabel('E-mail').fill(account.email);
      await thirdPage.getByLabel('Senha', { exact: true }).fill(account.newPassword);
      await thirdPage.getByRole('button', { name: 'Entrar', exact: true }).click();
      await expect(thirdPage.getByRole('heading', { level: 1, name: 'Perfil' })).toBeVisible();

      const authenticatedState = await thirdContext.storageState();
      await thirdContext.close();
      thirdContext = undefined;
      const newProbeContext = async () => {
        const context = await browser.newContext({
          colorScheme: 'light',
          reducedMotion: 'reduce',
          serviceWorkers: 'block',
          storageState: authenticatedState,
          viewport: { height: 800, width: 1280 },
        });
        probeContexts.push(context);
        return context;
      };

      let releaseProfileRead: () => void = () => undefined;
      const heldProfileRead = new Promise<void>((resolve) => {
        releaseProfileRead = resolve;
      });
      const loadingContext = await newProbeContext();
      const loadingPage = await loadingContext.newPage();
      await loadingPage.route('**/rest/v1/profiles**', async (route) => {
        await heldProfileRead;
        await route.continue();
      });
      const loadingNavigation = loadingPage.goto('http://127.0.0.1:4173/perfil');
      await expect(loadingPage.getByTestId('loading-skeleton')).toBeVisible();
      releaseProfileRead();
      await loadingNavigation;
      await loadingPage.unroute('**/rest/v1/profiles**');
      await expect(loadingPage.getByTestId('profile-data-card')).toBeVisible();

      // 500 and not 503: postgrest-js retries an idempotent 503 three times with
      // exponential backoff, so the honest error would only reach the screen about
      // seven seconds later. The screen behaviour under test is the same either way.
      const networkPage = loadingPage;
      await networkPage.route('**/rest/v1/profiles**', (route) =>
        route.fulfill({
          body: JSON.stringify({ message: 'local unavailable' }),
          contentType: 'application/json',
          status: 500,
        }),
      );
      await networkPage.goto('http://127.0.0.1:4173/perfil');
      await expect(networkPage.getByRole('alert')).toContainText('Confira sua conexão');
      await expect(networkPage.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
      await networkPage.unroute('**/rest/v1/profiles**');
      await networkPage.getByRole('button', { name: 'Tentar de novo' }).click();
      await expect(networkPage.getByTestId('profile-data-card')).toBeVisible();

      const incompletePage = loadingPage;
      await incompletePage.route('**/rest/v1/profiles**', (route) =>
        route.fulfill({ body: '[]', contentType: 'application/json', status: 200 }),
      );
      await incompletePage.goto('http://127.0.0.1:4173/perfil');
      await expect(
        incompletePage.getByRole('heading', { level: 1, name: 'Complete seu perfil' }),
      ).toBeVisible();
      await expect(incompletePage.getByRole('button', { name: 'Concluir perfil' })).toBeVisible();
      await expect(incompletePage.getByRole('button', { name: 'Tentar de novo' })).toHaveCount(0);
      await incompletePage.unroute('**/rest/v1/profiles**');
      await incompletePage.reload();
      await expect(incompletePage.getByTestId('profile-data-card')).toBeVisible();
      await loadingContext.close();

      const sessionsBeforeSafeLogout = await db.query<{
        active_refresh_tokens: number;
        id: string;
      }>(
        `select session.id,
                (select count(*)::int
                   from auth.refresh_tokens as token
                  where token.session_id = session.id
                    and not token.revoked) as active_refresh_tokens
           from auth.sessions as session
           join auth.users as users on users.id = session.user_id
          where lower(users.email) = lower($1)
          order by session.id`,
        [account.email],
      );
      expect(sessionsBeforeSafeLogout.rows).toHaveLength(2);
      expect(
        sessionsBeforeSafeLogout.rows.every((session) => session.active_refresh_tokens > 0),
      ).toBe(true);

      await page.getByRole('button', { name: 'Sair com segurança' }).click();
      await expect(page).toHaveURL(/\/entrar$/u);
      const sessionsAfterLogout = await db.query<{
        active_refresh_tokens: number;
        id: string;
      }>(
        `select session.id,
                (select count(*)::int
                   from auth.refresh_tokens as token
                  where token.session_id = session.id
                    and not token.revoked) as active_refresh_tokens
           from auth.sessions as session
           join auth.users as users on users.id = session.user_id
          where lower(users.email) = lower($1)
          order by session.id`,
        [account.email],
      );
      const originalSessionId = initialSessions.rows[0]?.id;
      expect(originalSessionId).toBeDefined();
      expect(sessionsAfterLogout.rows).toEqual(
        sessionsBeforeSafeLogout.rows.filter((session) => session.id !== originalSessionId),
      );

      const revocation = await db.query<{
        session_id: string;
      }>(
        `select revoked.session_id
           from private.revoked_auth_sessions as revoked
           join public.profiles as profile on profile.id = revoked.profile_id
           join auth.users as users on users.id = profile.auth_user_id
          where lower(users.email) = lower($1)`,
        [account.email],
      );
      expect(revocation.rows).toEqual([{ session_id: originalSessionId }]);

      await page.goto('/esqueci-senha');
      await page.getByLabel('E-mail').fill(account.email);
      await page.getByRole('button', { name: 'Enviar código de recuperação' }).click();
      const recoveryOtp = await readLatestOtp(request, env.mailUrl, account.email);
      const recoveryCode = page.getByLabel('Código de 6 dígitos');
      await page.getByRole('button', { name: 'Verificar código' }).click();
      const recoveryDescriptionId = await recoveryCode.getAttribute('aria-describedby');
      expect(recoveryDescriptionId).toMatch(/^app-field-[A-Za-z0-9_-]+-description$/u);
      await expect(page.locator(`[id="${recoveryDescriptionId ?? ''}"]`)).toHaveCount(1);
      await recoveryCode.fill(recoveryOtp);
      await page.route('**/auth/v1/verify**', (route) => route.abort('connectionfailed'));
      await page.getByRole('button', { name: 'Verificar código' }).click();
      await expect(page.getByRole('alert')).toContainText('Confira sua conexão');
      await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
      await page.unroute('**/auth/v1/verify**');
      await page.getByRole('button', { name: 'Tentar de novo' }).click();
      await expect(
        page.getByText('Código confirmado. Agora escolha uma nova senha.'),
      ).toBeVisible();

      await page.getByLabel('Senha', { exact: true }).fill(account.password);
      await page.getByLabel('Confirmar senha').fill(account.password);
      await page.route('**/auth/v1/user**', (route) => route.abort('connectionfailed'));
      await page.getByRole('button', { name: 'Salvar nova senha' }).click();
      await expect(page.getByRole('alert')).toContainText('Confira sua conexão');
      await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
      await page.unroute('**/auth/v1/user**');
    } finally {
      await Promise.all(probeContexts.map((context) => context.close()));
      await secondContext?.close();
      await thirdContext?.close();
      await deleteMessagesForRecipient(request, env.mailUrl, account.email);
      const user = await db.query<{ id: string; profile_id: string | null }>(
        `select auth_user.id,
                (select profile.id
                   from public.profiles as profile
                  where profile.auth_user_id = auth_user.id) as profile_id
           from auth.users as auth_user
          where lower(auth_user.email) = lower($1)`,
        [account.email],
      );
      const userId = user.rows[0]?.id;
      const profileId = user.rows[0]?.profile_id;
      if (userId !== undefined) {
        await db.query(
          `delete from private.idempotency_records
            where actor_id in (select id from public.profiles where auth_user_id = $1)`,
          [userId],
        );
        await db.query(
          `delete from private.revoked_auth_sessions
            where profile_id in (select id from public.profiles where auth_user_id = $1)`,
          [userId],
        );
        await db.query('delete from public.profiles where auth_user_id = $1', [userId]);
        await db.query('delete from auth.users where id = $1', [userId]);
      }
      await db.query(
        `delete from auth.audit_log_entries
          where payload->>'actor_id' = $1
             or lower(payload->>'actor_username') = lower($2)`,
        [userId ?? '', account.email],
      );
      const residual = await db.query<{
        audit_logs: number;
        identities: number;
        idempotency_records: number;
        profiles: number;
        refresh_tokens: number;
        revoked_sessions: number;
        sessions: number;
        users: number;
      }>(
        `select
           (select count(*)::int from auth.users where lower(email) = lower($1)) as users,
           (select count(*)::int from auth.identities where user_id = $2::uuid) as identities,
           (select count(*)::int from auth.sessions where user_id = $2::uuid) as sessions,
           (select count(*)::int from auth.refresh_tokens where user_id = $2::text) as refresh_tokens,
           (select count(*)::int from public.profiles where auth_user_id = $2::uuid) as profiles,
           (select count(*)::int from private.revoked_auth_sessions
             where profile_id = $3::uuid)
             as revoked_sessions,
           (select count(*)::int from private.idempotency_records
             where actor_id = $3::uuid)
             as idempotency_records,
           (select count(*)::int from auth.audit_log_entries
             where payload->>'actor_id' = $2::text
                or lower(payload->>'actor_username') = lower($1)) as audit_logs`,
        [account.email, userId ?? null, profileId ?? null],
      );
      expect(residual.rows).toEqual([
        {
          audit_logs: 0,
          identities: 0,
          idempotency_records: 0,
          profiles: 0,
          refresh_tokens: 0,
          revoked_sessions: 0,
          sessions: 0,
          users: 0,
        },
      ]);
      expect(await messagesForRecipient(request, env.mailUrl, account.email)).toEqual([]);
      await db.end();
    }
  });

  test('signing in with a verified Auth user without a profile resumes profile completion', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium');
    const env = localEnvironment();
    const db = new Client({ connectionString: env.dbUrl });
    const profileless = {
      email: `profileless-${runSuffix}@colete.test`,
      name: 'Bia Retomada',
      password: 'Frase-segura-2026',
    };
    await db.connect();

    try {
      await createVerifiedAuthUserWithoutProfile(request, env, profileless);
      const beforeLogin = await db.query<{ profiles: number }>(
        `select count(profile.id)::int as profiles
           from auth.users as users
           left join public.profiles as profile on profile.auth_user_id = users.id
          where lower(users.email) = lower($1)`,
        [profileless.email],
      );
      expect(beforeLogin.rows).toEqual([{ profiles: 0 }]);

      await page.goto('/entrar');
      await page.getByLabel('E-mail').fill(profileless.email);
      await page.getByLabel('Senha', { exact: true }).fill(profileless.password);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();

      await expect(page).toHaveURL(/\/perfil$/u);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Complete seu perfil' }),
      ).toBeVisible();
      await expect(page.getByLabel('Nome')).toHaveValue(profileless.name);
      await expect(page.getByRole('button', { name: 'Tentar de novo' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Concluir perfil' }).click();
      await expect(page.getByTestId('profile-data-card')).toBeVisible();

      const completed = await db.query<{ name: string; profiles: number }>(
        `select min(profile.name) as name, count(profile.id)::int as profiles
           from auth.users as users
           left join public.profiles as profile on profile.auth_user_id = users.id
          where lower(users.email) = lower($1)`,
        [profileless.email],
      );
      expect(completed.rows).toEqual([{ name: profileless.name, profiles: 1 }]);
    } finally {
      await deleteMessagesForRecipient(request, env.mailUrl, profileless.email);
      const user = await db.query<{ id: string }>(
        'select id from auth.users where lower(email) = lower($1)',
        [profileless.email],
      );
      const userId = user.rows[0]?.id;
      if (userId !== undefined) {
        await db.query(
          `delete from private.idempotency_records
            where actor_id in (select id from public.profiles where auth_user_id = $1)`,
          [userId],
        );
        await db.query(
          `delete from private.revoked_auth_sessions
            where profile_id in (select id from public.profiles where auth_user_id = $1)`,
          [userId],
        );
        await db.query('delete from public.profiles where auth_user_id = $1', [userId]);
        await db.query('delete from auth.users where id = $1', [userId]);
      }
      await db.query(
        `delete from auth.audit_log_entries
          where payload->>'actor_id' = $1
             or lower(payload->>'actor_username') = lower($2)`,
        [userId ?? '', profileless.email],
      );
      const residual = await db.query<{ users: number }>(
        'select count(*)::int as users from auth.users where lower(email) = lower($1)',
        [profileless.email],
      );
      expect(residual.rows).toEqual([{ users: 0 }]);
      expect(await messagesForRecipient(request, env.mailUrl, profileless.email)).toEqual([]);
      await db.end();
    }
  });

  test('all four screens reflow, expose focus, validation and automated accessibility', async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    const routes = [
      { path: '/entrar', title: 'Entrar · Colete' },
      { path: '/criar-conta', title: 'Criar conta · Colete' },
      { path: '/verificar-codigo', title: 'Verificar código · Colete' },
      { path: '/esqueci-senha', title: 'Esqueci minha senha · Colete' },
    ];
    for (const route of routes) {
      await page.goto(route.path);
      await expect(page).toHaveTitle(route.title);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByTestId('auth-wide-aside')).toHaveCount(
        testInfo.project.name === 'wide-chromium' ? 1 : 0,
      );
      await assertAccessible(page);
      await page.getByRole('button', { name: 'Usar tema escuro' }).click();
      await expect(page.getByRole('button', { name: 'Usar tema claro' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await assertAccessible(page);
    }

    await page.goto('/criar-conta');
    await page.getByRole('button', { name: 'Enviar código' }).click();
    await expect(page.getByLabel('Nome')).toBeFocused();
    await expect(page.getByRole('alert').first()).toContainText('pelo menos 2 caracteres');
    await page.getByLabel('Nome').fill('A');
    await expect(page.getByRole('alert').first()).toContainText('pelo menos 2 caracteres');
    await page.getByLabel('Nome').fill('Ana');
    await expect(page.getByText('Digite pelo menos 2 caracteres para o nome.')).toHaveCount(0);

    await page.goto('/esqueci-senha');
    await page.getByRole('button', { name: 'Enviar código de recuperação' }).click();
    const recoveryEmail = page.getByLabel('E-mail');
    const recoveryAlert = page.getByRole('alert');
    await expect(recoveryEmail).toBeFocused();
    await expect(recoveryEmail).toHaveAttribute('aria-invalid', 'true');
    await expect(recoveryAlert).toHaveAttribute('aria-live', 'assertive');
    await expect(recoveryAlert).toContainText('Preencha este campo');
    await recoveryEmail.fill('incompleto');
    await expect(recoveryAlert).toContainText('Digite um e-mail completo');
    await recoveryEmail.fill('pessoa@colete.test');
    await expect(recoveryAlert).toHaveCount(0);

    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() =>
      document.activeElement === null
        ? 'none'
        : getComputedStyle(document.activeElement).outlineStyle,
    );
    expect(outline).not.toBe('none');
  });

  test('validation and selected states never rely on color alone', async ({ page }) => {
    await page.goto('/criar-conta');
    await page.getByLabel('Senha', { exact: true }).fill('curta');
    await expect(page.getByText(/Força da senha: Ainda curta/u)).toBeVisible();

    await page.getByRole('button', { name: 'Enviar código' }).click();
    const name = page.getByLabel('Nome');
    const alert = page.getByRole('alert').first();
    const alertId = await alert.getAttribute('id');
    expect(alertId).not.toBeNull();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAttribute('aria-describedby', alertId ?? 'missing-alert-id');
    await expect(alert).not.toBeEmpty();

    const theme = page.getByRole('button', { name: 'Usar tema escuro' });
    await theme.click();
    await expect(page.getByRole('button', { name: 'Usar tema claro' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('a network failure is honest and offers a retry', async ({ page }) => {
    await page.route('**/auth/v1/token**', (route) => route.abort('connectionfailed'));
    await page.goto('/entrar');
    await page.getByLabel('E-mail').fill('pessoa@colete.test');
    await page.getByLabel('Senha', { exact: true }).fill('senha-segura');
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Confira sua conexão');
    await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
  });
});
