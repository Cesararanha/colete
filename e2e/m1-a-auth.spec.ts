import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type Response,
} from './support/csp';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

import {
  applyCpuThrottling,
  assertMinimumInteractiveTargets,
  assertNoHorizontalOverflow,
  assertNoPhantomScroll,
} from './support/layout';
import { handledObserver } from './support/observers';
import { observeRestAuthorization } from './support/rest-authorization';

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

// Each observer captures the FIRST response of its request, ok or not, and
// asserts it the moment it arrives. Waiting only for an ok response would sit
// blind on a rejected one (a 401 PGRST303, for example) until the timeout.
function firstResponseMustBeOk(page: Page, method: string, pathname: string) {
  return page
    .waitForResponse(
      (response) =>
        response.request().method() === method && new URL(response.url()).pathname === pathname,
    )
    .then(async (response) => {
      const body = response.ok() ? '' : `: ${await failedResponseBody(response)}`;
      expect(response.ok(), `${method} ${pathname} returned ${response.status()}${body}`).toBe(
        true,
      );
    });
}

function waitForProfileGate(page: Page) {
  return handledObserver(
    Promise.all([
      firstResponseMustBeOk(page, 'GET', '/rest/v1/profiles'),
      firstResponseMustBeOk(page, 'POST', '/rest/v1/rpc/get_own_deletion_request'),
    ]),
  );
}

// The body is what tells an anonymous call (42501) from a rejected JWT in the
// CI log. Request headers never enter the message, and any credential a body
// might echo is redacted before truncation.
async function failedResponseBody(response: Response) {
  const text = await response.text().catch(() => '<body unavailable>');
  return text
    .replace(/eyJ[\w-]*\.[\w-]*\.[\w-]*/gu, '<jwt>')
    .replace(/sb_(?:publishable|secret)_[\w-]+/gu, '<api key>')
    .slice(0, 500);
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
    const restAuthorization = observeRestAuthorization(page);

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

      // First access (decisão humana de 14/10/2026): the home is Grupos, and
      // its gate asks for the profile first while there is none.
      await expect(page).toHaveURL(/\/grupos$/u);
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
      await expect(page).toHaveURL(/\/grupos$/u);
      await reloadedProfileGate;
      await expect(
        page.getByRole('heading', { level: 1, name: 'Complete seu perfil' }),
      ).toBeVisible();
      await expect(page.getByLabel('Nome')).toHaveValue(account.name);
      await page.getByRole('button', { name: 'Concluir perfil' }).click();
      await expect(page).toHaveTitle('Grupos · Colete');
      await expect(page.getByRole('heading', { level: 1, name: 'Grupos' })).toBeVisible();
      await expect(page).toHaveURL(/\/grupos$/u);
      await page.getByTestId('profile-avatar-link').filter({ visible: true }).first().click();
      await expect(page).toHaveTitle('Perfil · Colete');
      await expect(page.getByTestId('profile-summary')).toBeVisible();
      // Read mode: the data is text, not open fields, and leaving is at the top.
      await expect(page.getByTestId('profile-value-name')).toHaveText(account.name);
      await expect(page.getByTestId('profile-value-nickname')).toHaveText('Sem apelido');
      await expect(page.getByTestId('profile-data-card').getByRole('textbox')).toHaveCount(0);
      await expect(page.getByTestId('profile-account')).toContainText(
        `Conectado como ${account.email}`,
      );
      await expect(page.getByRole('button', { name: 'Sair da conta' })).toBeVisible();
      await page.getByRole('link', { name: 'Privacidade e conta' }).click();
      await expect(page).toHaveURL(/\/perfil\/privacidade$/u);
      await expect(page).toHaveTitle('Privacidade e conta · Colete');
      await expect(page.getByTestId('access-method')).toHaveText('Você entra com e-mail e senha.');
      await expect(page.getByTestId('profile-export-card')).toBeVisible();
      await expect(page.getByTestId('profile-deletion-card')).toBeVisible();
      await assertAccessible(page);
      await page.getByRole('link', { name: 'Voltar ao perfil' }).click();
      await expect(page.getByTestId('profile-summary')).toBeVisible();
      await expect(page.getByTestId('profile-export-card')).toHaveCount(0);
      await expect(page.getByTestId('profile-deletion-card')).toHaveCount(0);
      await expect(page.getByTestId('profile-provider-card')).toHaveCount(0);
      const profileAfterReloadedCompletion = await db.query<{ count: number; name: string }>(
        `select count(*)::int as count, min(profile.name) as name
           from public.profiles as profile
           join auth.users as users on users.id = profile.auth_user_id
          where lower(users.email) = lower($1)`,
        [account.email],
      );
      expect(profileAfterReloadedCompletion.rows).toEqual([{ count: 1, name: account.name }]);
      await assertAccessible(page);

      await page.getByRole('button', { name: 'Editar' }).click();
      await expect(page.getByLabel('Nome', { exact: true })).toBeFocused();
      await expect(page.getByRole('button', { name: 'Limpar apelido' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Limpar número da camisa' })).toHaveCount(0);
      await page.getByLabel('Apelido', { exact: true }).fill('Capitã');
      const position = page.getByTestId('profile-position');
      await expect(position).toHaveAttribute('role', 'radiogroup');
      await expect(position.getByRole('radio', { name: 'Não informar' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await position.getByRole('radio', { name: 'Meio-campista' }).click();
      await expect(position.getByRole('radio', { name: 'Meio-campista' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(position.getByRole('radio', { checked: true })).toHaveCount(1);
      await assertAccessible(page);
      await page.getByRole('button', { name: 'Salvar', exact: true }).click();
      await expect(page.getByTestId('profile-data-card').getByRole('status')).toContainText(
        'Dados do perfil salvos.',
      );
      await expect(page.getByTestId('profile-value-nickname')).toHaveText('Capitã');
      await expect(page.getByTestId('profile-value-position')).toHaveText('Meio-campista');
      await expect(page.getByTestId('profile-data-card').getByRole('textbox')).toHaveCount(0);
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

      // Emptying the field is how a nickname is removed now; it sends null.
      await page.getByRole('button', { name: 'Editar' }).click();
      await page.getByLabel('Apelido', { exact: true }).fill('');
      await page.getByRole('button', { name: 'Salvar', exact: true }).click();
      await expect(page.getByTestId('profile-data-card').getByRole('status')).toContainText(
        'Dados do perfil salvos.',
      );
      expect(profileBodies.at(-1)?.patch).toEqual({ nickname: null });
      await expect(page.getByTestId('profile-value-nickname')).toHaveText('Sem apelido');

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
      await page.getByRole('button', { name: 'Editar' }).click();
      await page.getByLabel('Apelido', { exact: true }).fill('   ');
      await page.getByRole('button', { name: 'Salvar', exact: true }).click();
      await expect(page.getByLabel('Apelido', { exact: true })).toBeFocused();
      await expect(page.getByTestId('profile-data-card').getByRole('alert')).toContainText(
        'Apague o campo ou escreva pelo menos um caractere.',
      );
      expect(profileBodies).toHaveLength(transmittedBeforeBlank);
      // Arrows move the one checked radio; Cancel discards every unsaved edit.
      const midfielder = page
        .getByTestId('profile-position')
        .getByRole('radio', { name: 'Meio-campista' });
      await midfielder.focus();
      await page.keyboard.press('ArrowRight');
      const forward = page.getByTestId('profile-position').getByRole('radio', { name: 'Atacante' });
      await expect(forward).toBeFocused();
      await expect(forward).toHaveAttribute('aria-checked', 'true');
      await expect(midfielder).toHaveAttribute('aria-checked', 'false');
      await page.getByRole('button', { name: 'Cancelar' }).click();
      await expect(page.getByTestId('profile-summary')).toBeFocused();
      await expect(page.getByTestId('profile-value-nickname')).toHaveText('Sem apelido');
      await expect(page.getByTestId('profile-value-position')).toHaveText('Meio-campista');
      expect(profileBodies).toHaveLength(transmittedBeforeBlank);

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
      // A returning account with a profile starts on Grupos.
      await expect(secondPage.getByRole('heading', { level: 1, name: 'Grupos' })).toBeVisible();
      await expect(secondPage).toHaveURL(/\/grupos$/u);
      await expect(secondPage).toHaveTitle('Grupos · Colete');
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

      // Changing the password inside the app is the recovery flow bound to the
      // account e-mail (decisão humana de 14/10/2026): code first, then the new
      // password. There is no direct change without the code.
      await page.getByRole('link', { name: 'Trocar senha' }).click();
      await expect(page).toHaveURL(/\/perfil\/senha$/u);
      await expect(page).toHaveTitle('Trocar senha · Colete');
      await expect(page.getByTestId('password-destination')).toHaveText(
        `O código vai para ${account.email}.`,
      );
      await expect(page.getByLabel('Nova senha', { exact: true })).toHaveCount(0);
      await assertAccessible(page);
      await page.getByRole('button', { name: 'Enviar código' }).click();
      await expect(page.getByTestId('password-code-sent')).toContainText(account.email);
      const changeOtp = await readLatestOtp(request, env.mailUrl, account.email);
      await expect(page.getByLabel('Código de 6 dígitos')).toBeFocused();
      await page.getByRole('button', { name: 'Verificar código' }).click();
      await expect(page.getByLabel('Código de 6 dígitos')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByLabel('Nova senha', { exact: true })).toHaveCount(0);
      await page.getByLabel('Código de 6 dígitos').fill(changeOtp);
      await page.getByRole('button', { name: 'Verificar código' }).click();
      await expect(page.getByTestId('password-change-card').getByRole('status')).toContainText(
        'Código confirmado. Agora escolha uma nova senha.',
      );
      await page.getByLabel('Nova senha', { exact: true }).fill(account.newPassword);
      await page.getByLabel('Confirmar nova senha', { exact: true }).fill(account.newPassword);
      await page.getByRole('button', { name: 'Salvar nova senha' }).click();
      await expect(page.getByTestId('password-complete').getByRole('status')).toContainText(
        'Senha atualizada.',
      );

      // The code signs this device in again; the new password then ends every
      // other session, the second device included, and keeps only this one.
      const sessionsAfterPasswordChange = await db.query<{ id: string }>(
        `select session.id
           from auth.sessions as session
           join auth.users as users on users.id = session.user_id
          where lower(users.email) = lower($1)`,
        [account.email],
      );
      expect(sessionsAfterPasswordChange.rows).toHaveLength(1);
      const currentSessionId = sessionsAfterPasswordChange.rows[0]?.id;
      expect(currentSessionId).toBeDefined();
      expect(currentSessionId).not.toBe(secondSession?.id);
      expect(initialSessionIds.has(currentSessionId ?? '')).toBe(false);
      await expect(
        refreshStoredSession(secondPage, env.apiUrl, env.publishableKey),
      ).resolves.toEqual({ ok: false, status: 400 });
      await page.getByRole('button', { name: 'Voltar ao perfil' }).click();
      await expect(page.getByTestId('profile-summary')).toBeVisible();

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
      await expect(thirdPage.getByRole('heading', { level: 1, name: 'Grupos' })).toBeVisible();

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
      // A failed read is read once, not in a loop: a fetching observer in the
      // top bar once remounted with the gate and refetched thousands of times.
      let profileReads = 0;
      const countProfileRead = (request: { url: () => string }) => {
        if (new URL(request.url()).pathname === '/rest/v1/profiles') profileReads += 1;
      };
      networkPage.on('request', countProfileRead);
      await networkPage.goto('http://127.0.0.1:4173/perfil');
      await expect(networkPage.getByRole('alert')).toContainText('Confira sua conexão');
      await expect(networkPage.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
      await networkPage.waitForTimeout(1_000);
      networkPage.off('request', countProfileRead);
      expect(profileReads).toBeLessThanOrEqual(2);
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

      const leavingAccount = await db.query<{ id: string }>(
        `select users.id from auth.users as users where lower(users.email) = lower($1)`,
        [account.email],
      );
      expect(leavingAccount.rows).toHaveLength(1);
      restAuthorization.markLogout(leavingAccount.rows[0]?.id);
      await page.getByRole('button', { name: 'Sair da conta' }).click();
      await page.getByTestId('profile-logout-confirm').click();
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
      expect(sessionsAfterLogout.rows).toEqual(
        sessionsBeforeSafeLogout.rows.filter((session) => session.id !== currentSessionId),
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
      expect(revocation.rows).toEqual([{ session_id: currentSessionId }]);

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

      // Supabase Auth refuses the current password with same_password (422);
      // the form names that refusal instead of the generic validation text.
      await page.getByLabel('Senha', { exact: true }).fill(account.newPassword);
      await page.getByLabel('Confirmar senha').fill(account.newPassword);
      await page.getByRole('button', { name: 'Salvar nova senha' }).click();
      await expect(page.getByRole('alert')).toHaveText(
        'A nova senha precisa ser diferente da atual.',
      );

      await page.getByLabel('Senha', { exact: true }).fill(account.password);
      await page.getByLabel('Confirmar senha').fill(account.password);
      await page.route('**/auth/v1/user**', (route) => route.abort('connectionfailed'));
      await page.getByRole('button', { name: 'Salvar nova senha' }).click();
      await expect(page.getByRole('alert')).toContainText('Confira sua conexão');
      await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
      await page.unroute('**/auth/v1/user**');
      restAuthorization.assertNoAnonymousRequestAfterLogout(testInfo);
      restAuthorization.assertNoLeavingAccountRequestAfterLogout(testInfo);
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
        // Sign-up and recovery flows stay in auth.flow_state when the user goes (BB-035).
        await db.query('delete from auth.flow_state where user_id = $1', [userId]);
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

      // A wrong password and an e-mail without an account get the same answer,
      // so the sign-in form never reveals whether an account exists.
      await page.goto('/entrar');
      const refusals: string[] = [];
      for (const attempt of [
        { email: profileless.email, password: 'Senha-errada-2026' },
        { email: `sem-conta-${runSuffix}@colete.test`, password: profileless.password },
      ]) {
        await page.getByLabel('E-mail').fill(attempt.email);
        await page.getByLabel('Senha', { exact: true }).fill(attempt.password);
        const refused = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/auth/v1/token' &&
            response.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Entrar', exact: true }).click();
        expect((await refused).status()).toBe(400);
        await expect(page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');
        refusals.push((await page.getByRole('alert').textContent()) ?? '');
      }
      expect(new Set(refusals).size).toBe(1);

      await page.getByLabel('E-mail').fill(profileless.email);
      await page.getByLabel('Senha', { exact: true }).fill(profileless.password);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();

      // First access: no profile yet, so the sign-in asks for it before Grupos.
      await expect(page).toHaveURL(/\/grupos$/u);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Complete seu perfil' }),
      ).toBeVisible();
      await expect(page.getByLabel('Nome')).toHaveValue(profileless.name);
      await expect(page.getByRole('button', { name: 'Tentar de novo' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Concluir perfil' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Grupos' })).toBeVisible();
      await expect(page).toHaveURL(/\/grupos$/u);
      await expect(page.getByTestId('profile-completion-card')).toHaveCount(0);

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
        // Sign-up and recovery flows stay in auth.flow_state when the user goes (BB-035).
        await db.query('delete from auth.flow_state where user_id = $1', [userId]);
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
      // No side text on wide layouts and no theme switch: dark is the only
      // theme, even under the light system preference emulated above.
      await expect(page.getByTestId('auth-wide-aside')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /tema/u })).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await assertAccessible(page);
    }

    // rev-previa / BB-028: with a mouse, a text link underlines under the pointer.
    if (testInfo.project.name === 'wide-chromium') {
      await page.goto('/entrar');
      const forgot = page.getByRole('link', { name: 'Esqueci minha senha' });
      const decoration = () =>
        forgot.evaluate((element) =>
          [element, ...element.querySelectorAll('*')]
            .map((part) => getComputedStyle(part).textDecorationLine)
            .join('|'),
        );
      await page.mouse.move(0, 0);
      const before = await decoration();
      expect(before).not.toContain('underline');
      await forgot.hover();
      await expect.poll(decoration).toContain('underline');
    }

    // Phantom scroll: at 390×844 the sign-in and recovery screens fit, so
    // nothing scrolls or bounces.
    if (testInfo.project.name === 'mobile-chromium') {
      const viewport = page.viewportSize();
      await page.setViewportSize({ height: 844, width: 390 });
      for (const path of ['/entrar', '/esqueci-senha']) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await assertNoPhantomScroll(page);
      }
      if (viewport !== null) await page.setViewportSize(viewport);
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

    // The password switch is an icon whose state is in its name, not in a colour.
    const password = page.getByLabel('Senha', { exact: true });
    const show = page.getByRole('button', { name: 'Mostrar senha' }).first();
    await expect(show).not.toContainText('Mostrar');
    await expect(password).toHaveAttribute('type', 'password');
    await show.click();
    await expect(password).not.toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: 'Ocultar senha' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Ocultar senha' }).click();
    await expect(password).toHaveAttribute('type', 'password');
  });

  test('Auth rate limits have their own message and missing codes never imply invalid credentials', async ({
    page,
  }) => {
    for (const attempt of [
      {
        status: 429,
        code: undefined,
        message: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
      },
      {
        status: 429,
        code: 'over_request_rate_limit',
        message: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
      },
      {
        status: 400,
        code: 'over_email_send_rate_limit',
        message: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
      },
      { status: 400, code: undefined, message: 'Entre novamente para continuar com segurança.' },
      { status: 400, code: 'invalid_credentials', message: 'E-mail ou senha incorretos.' },
    ]) {
      await page.route('**/auth/v1/token**', (route) =>
        route.fulfill({
          status: attempt.status,
          contentType: 'application/json',
          body: JSON.stringify({
            msg: 'RAW_SERVER_SENTINEL',
            ...(attempt.code === undefined ? {} : { error_code: attempt.code }),
          }),
        }),
      );
      await page.goto('/entrar');
      await page.getByTestId('login-email').fill('synthetic@colete.test');
      await page.getByTestId('login-password').fill('Synthetic-2026');
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText(attempt.message);
      await expect(page.locator('body')).not.toContainText('RAW_SERVER_SENTINEL');
      await page.unroute('**/auth/v1/token**');
    }
    // Other auth screens share authFailure and the general message mapper.
    await page.route('**/auth/v1/recover**', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error_code: 'over_email_send_rate_limit',
          msg: 'RAW_SERVER_SENTINEL',
        }),
      }),
    );
    await page.goto('/esqueci-senha');
    await page.getByTestId('recovery-email').fill('synthetic@colete.test');
    await page.getByRole('button', { name: 'Enviar código de recuperação' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
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
  test('a reload of "Verificar código" keeps the code field, the resend and finishes the sign up', async ({
    browser,
    page,
    request,
  }, testInfo) => {
    // rev84 P1: back from the e-mail app, the tab reloads on "Verificar código".
    // The resend wait of a minute is real: the Auth refuses an earlier one.
    test.setTimeout(150_000);
    const env = localEnvironment();
    const db = new Client({ connectionString: env.dbUrl });
    await db.connect();
    const email = `auth-recarga-${runSuffix}-${testInfo.project.name}@colete.test`;
    const kept = () =>
      page.evaluate(() => {
        const places = Object.keys(localStorage).filter((key) => key.includes('signup'));
        const value = sessionStorage.getItem('colete:pending-signup');
        return { local: places, session: value === null ? null : JSON.parse(value) };
      });
    try {
      await page.goto('/criar-conta');
      await page.getByTestId('signup-name').fill(account.name);
      await page.getByTestId('signup-email').fill(email);
      await page.getByTestId('signup-password').fill(account.password);
      await page.getByTestId('signup-confirm-password').fill(account.password);
      await page.getByRole('button', { name: 'Enviar código' }).click();
      await expect(page).toHaveURL(/\/verificar-codigo$/u);
      const first = await readLatestOtp(request, env.mailUrl, email);
      await page.reload();
      await expect(page.getByText(`Código enviado para ${email}.`)).toBeVisible();
      await expect(page.getByLabel('Código de 6 dígitos')).toBeVisible();
      // The resend wait survives too; only the e-mail and that time are kept.
      await expect(page.getByTestId('resend-countdown')).toContainText(/Reenvio disponível em/u);
      const stored = await kept();
      expect(stored.local).toEqual([]);
      expect(Object.keys(stored.session ?? {}).sort()).toEqual([
        'email',
        'expiresAt',
        'resendAvailableAt',
      ]);
      expect(stored.session.email).toBe(email);
      expect(stored.session.expiresAt).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
      expect(JSON.stringify(stored.session)).not.toContain(account.password);
      expect(JSON.stringify(stored.session)).not.toContain(first);
      // Once the restored wait is over (the Auth also refuses a resend for about
      // a minute), "Reenviar código" works on the reloaded page.
      await expect(page.getByRole('button', { name: 'Reenviar código' })).toBeVisible({
        timeout: 75_000,
      });
      await page.getByRole('button', { name: 'Reenviar código' }).click();
      await expect(
        page.getByText('Um novo código foi enviado. Use apenas o mais recente.'),
      ).toBeVisible();
      const second = await readLatestOtp(request, env.mailUrl, email);
      await page.reload();
      await page.getByLabel('Código de 6 dígitos').fill(second);
      await page.getByRole('button', { name: 'Verificar e continuar' }).click();
      await expect(page).toHaveURL(/\/grupos$/u);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Complete seu perfil' }),
      ).toBeVisible();
      // Accepted: the e-mail left the tab.
      expect((await kept()).session).toBeNull();
      await page.getByTestId('complete-profile-name').fill(account.name);
      await page.getByTestId('complete-profile-submit').click();
      await expect(page.getByRole('heading', { level: 1, name: 'Grupos' })).toBeVisible();

      // Back on the form, the code asked for earlier is no longer waited for.
      const fresh = await browser.newContext({ baseURL: 'http://127.0.0.1:4173', locale: 'pt-BR' });
      try {
        const form = await fresh.newPage();
        await form.goto('/criar-conta');
        await form.evaluate(
          (value) => sessionStorage.setItem('colete:pending-signup', value),
          JSON.stringify({ email, resendAvailableAt: null, expiresAt: Date.now() + 60_000 }),
        );
        await form.reload();
        await expect(form.getByTestId('signup-email')).toBeVisible();
        await expect
          .poll(() => form.evaluate(() => sessionStorage.getItem('colete:pending-signup')))
          .toBeNull();
      } finally {
        await fresh.close();
      }
    } finally {
      await deleteMessagesForRecipient(request, env.mailUrl, email);
      const user = await db.query<{ id: string }>(
        'select id from auth.users where lower(email) = lower($1)',
        [email],
      );
      const userId = user.rows[0]?.id;
      if (userId !== undefined) {
        await db.query(
          `delete from private.idempotency_records
            where actor_id in (select id from public.profiles where auth_user_id = $1)`,
          [userId],
        );
        await db.query(
          'delete from public.policy_acceptances where profile_id in (select id from public.profiles where auth_user_id = $1)',
          [userId],
        );
        await db.query('delete from public.profiles where auth_user_id = $1', [userId]);
        await db.query('delete from auth.flow_state where user_id = $1', [userId]);
        await db.query('delete from auth.users where id = $1', [userId]);
      }
      await db.query(
        `delete from auth.audit_log_entries
          where payload->>'actor_id' = $1
             or lower(payload->>'actor_username') = lower($2)`,
        [userId ?? '', email],
      );
      const residual = await db.query<{ users: number }>(
        'select count(*)::int as users from auth.users where lower(email) = lower($1)',
        [email],
      );
      expect(residual.rows).toEqual([{ users: 0 }]);
      await db.end();
    }
  });
});
