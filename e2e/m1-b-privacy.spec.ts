import { expect, test, type Page, type Request } from './support/csp';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

import {
  ageAuthentication,
  assertAccessible,
  createVerifiedUser,
  deleteAuthUser,
  localEnvironment,
  removeStorageObject,
  runWorker,
  type LocalEnvironment,
} from './support/local-stack';
import {
  applyCpuThrottling,
  assertMinimumInteractiveTargets,
  assertNoHorizontalOverflow,
} from './support/layout';
import { handledObserver } from './support/observers';
import { observeRestAuthorization, userJwtSubject } from './support/rest-authorization';

const { Client } = pg;
const runSuffix = `${Date.now()}-${process.pid}`;
const PASSWORD = 'Frase-segura-2026';
const HEX_64 = /\b[0-9a-f]{64}\b/u;

test.beforeEach(async ({ page }) => {
  await applyCpuThrottling(page, process.env.COLETE_E2E_CPU_THROTTLE_RATE);
});

type CapturedRequest = {
  body: string | null;
  headers: Record<string, string>;
  method: string;
  url: string;
};

function captureApiRequests(page: Page): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.includes('/functions/v1/') && !url.includes('/rest/v1/')) return;
    captured.push({
      body: request.postData(),
      headers: request.headers(),
      method: request.method(),
      url,
    });
  });
  return captured;
}

function fingerprint(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function requestLabel(request: Pick<CapturedRequest, 'method' | 'url'>) {
  return `${request.method} ${new URL(request.url).pathname}`;
}

async function storedAccessToken(page: Page) {
  return page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === null || !key.endsWith('-auth-token')) continue;
      const stored = JSON.parse(localStorage.getItem(key) ?? 'null') as {
        access_token?: unknown;
      } | null;
      if (typeof stored?.access_token === 'string' && stored.access_token !== '') {
        return stored.access_token;
      }
    }
    throw new Error('the browser has no persisted access token');
  });
}

async function refreshBrowserSession(page: Page, env: LocalEnvironment) {
  const previousToken = await storedAccessToken(page);
  const nextSecond = await page.evaluate(() => (Math.floor(Date.now() / 1_000) + 1) * 1_000);
  await page.waitForFunction((deadline) => Date.now() >= deadline, nextSecond);
  await page.addScriptTag({ url: '/__test__/supabase.js' });
  const currentToken = await page.evaluate(
    async ({ apiUrl, publishableKey }) => {
      type RefreshResult = {
        data: { session: { access_token: string } | null };
        error: { message: string } | null;
      };
      type RefreshClient = { auth: { refreshSession: () => Promise<RefreshResult> } };
      const browserWindow = window as typeof window & {
        supabase?: {
          createClient: (
            url: string,
            key: string,
            options: {
              auth: {
                autoRefreshToken: boolean;
                detectSessionInUrl: boolean;
                persistSession: boolean;
              };
            },
          ) => RefreshClient;
        };
      };
      if (browserWindow.supabase === undefined) {
        throw new Error('the browser Supabase SDK did not load');
      }
      const client = browserWindow.supabase.createClient(apiUrl, publishableKey, {
        auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: true },
      });
      const result = await client.auth.refreshSession();
      if (result.error !== null) throw new Error(result.error.message);
      const accessToken = result.data.session?.access_token;
      if (accessToken === undefined || accessToken === '') {
        throw new Error('refreshSession returned no access token');
      }
      return accessToken;
    },
    { apiUrl: env.apiUrl, publishableKey: env.publishableKey },
  );
  expect(fingerprint(currentToken), 'refreshSession must rotate the access token').not.toBe(
    fingerprint(previousToken),
  );
  await expect
    .poll(async () => fingerprint(await storedAccessToken(page)))
    .toBe(fingerprint(currentToken));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  return { currentToken, previousToken };
}

function assertRequestUsesRefreshedToken(
  request: Request,
  tokens: { currentToken: string; previousToken: string },
) {
  const authorization = request.headers()['authorization'] ?? '';
  const label = `${request.method()} ${new URL(request.url()).pathname}`;
  expect(
    /^Bearer [^.]+\.[^.]+\.[^.]+$/u.test(authorization),
    `${label} must carry one access token exclusively as Authorization: Bearer`,
  ).toBe(true);
  const token = authorization.slice('Bearer '.length);
  expect(fingerprint(token), `${label} must carry the refreshed access token`).toBe(
    fingerprint(tokens.currentToken),
  );
  expect(
    fingerprint(token),
    `${label} must not carry the access token from before refresh`,
  ).not.toBe(fingerprint(tokens.previousToken));
}

function assertAccessTokensOnlyInAuthorization(
  captured: CapturedRequest[],
  accessTokens: string[],
  expectedBearerTokens: string[],
) {
  const distinctTokens = [...new Set(accessTokens)];
  expect(distinctTokens.length).toBeGreaterThan(0);
  const tokensSeenAsBearer = new Set<string>();
  for (const request of captured) {
    const label = requestLabel(request);
    for (const token of distinctTokens) {
      expect(request.url.includes(token), `${label} must not put an access token in its URL`).toBe(
        false,
      );
      expect(
        (request.body ?? '').includes(token),
        `${label} must not put an access token in its body`,
      ).toBe(false);
      for (const [name, value] of Object.entries(request.headers)) {
        if (name.toLowerCase() === 'authorization') {
          if (value.includes(token)) {
            expect(
              value === `Bearer ${token}`,
              `${label} must put an access token exclusively in Authorization: Bearer`,
            ).toBe(true);
            tokensSeenAsBearer.add(token);
          }
        } else {
          expect(
            value.includes(token),
            `${label} must not put an access token in the ${name} header`,
          ).toBe(false);
        }
      }
    }
  }
  expect(
    [...tokensSeenAsBearer].map(fingerprint).sort(),
    'the journey must send each expected access token as Bearer',
  ).toEqual([...new Set(expectedBearerTokens)].map(fingerprint).sort());
}

/**
 * docs/22 section 6, first browser proof: no body ever carries the Auth ID,
 * profile data, session ID, HMAC or Storage path. The identity gateway only
 * ever receives `request_id`, projections receive an empty body, and no
 * captured URL or body mentions any of the identifiers the server holds.
 */
function assertBodiesNeverLeakIdentity(
  captured: CapturedRequest[],
  secrets: {
    authUserId: string;
    email: string;
    name: string;
    profileId: string;
    sessionIds: string[];
  },
) {
  expect(captured.length).toBeGreaterThan(0);
  const forbidden = [
    secrets.authUserId,
    secrets.profileId,
    secrets.email,
    secrets.name,
    ...secrets.sessionIds,
    `exports/${secrets.profileId}`,
    '.zip',
    'input_hmac',
    'storage_path',
    'content_digest',
  ];
  for (const request of captured) {
    const haystack = `${request.url}\n${request.body ?? ''}`.toLowerCase();
    for (const value of forbidden) expect(haystack).not.toContain(value.toLowerCase());
    expect(request.body ?? '').not.toMatch(HEX_64);
    if (request.url.includes('/functions/v1/identity/')) {
      const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
      const businessKeys = Object.keys(body).filter((key) => key !== 'request_id');
      if (request.url.endsWith('/request_data_export') || request.url.endsWith('/delete_account')) {
        expect(businessKeys).toEqual([]);
      }
    }
    if (request.url.includes('/rest/v1/rpc/')) {
      expect(['{}', '', null]).toContain(request.body);
    }
    if (request.url.includes('/functions/v1/data-exports/')) {
      expect(request.method).toBe('GET');
      expect(request.body).toBeNull();
    }
  }
}

async function signInAndCompleteProfile(page: Page, email: string) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Complete seu perfil' })).toBeVisible();
  await page.getByRole('button', { name: 'Concluir perfil' }).click();
  // First access ends on Grupos (decisão humana de 14/10/2026); the profile is one tab away.
  await expect(page.getByRole('heading', { level: 1, name: 'Grupos' })).toBeVisible();
  await page.getByRole('link', { name: 'Perfil', exact: true }).click();
  await expect(page.getByTestId('profile-data-card')).toBeVisible();
}

/** Export, sign-in method and deletion live on "Privacidade e conta", linked from the profile. */
async function openPrivacyAndAccount(page: Page) {
  await page.getByRole('link', { name: 'Privacidade e conta' }).click();
  await expect(page).toHaveURL(/\/perfil\/privacidade$/u);
  await expect(page.getByRole('heading', { level: 1, name: 'Privacidade e conta' })).toBeVisible();
  await expect(page.getByTestId('export-state-title')).toBeVisible();
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

/**
 * Makes the next call-time session read of a private query find no session,
 * once, after the test arms it. Private queries read Auth through
 * `auth.getSession()` right before the request; the supabase-js transport
 * reads it through `_getSessionToken`, which the regression of #31 already
 * covers, so that path is left alone here.
 */
async function installCallTimeSessionReadFailure(page: Page) {
  await page.addInitScript(() => {
    const state = { armed: false, denied: false };
    Object.defineProperty(window, '__coleteCallTimeSessionRead', { value: state });
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function getItem(key: string) {
      const stack = new Error().stack ?? '';
      const callTimeRead = stack.includes('getSession') && !stack.includes('_getSessionToken');
      if (state.armed && !state.denied && callTimeRead && key.includes('-auth-token')) {
        state.denied = true;
        return null;
      }
      return originalGetItem.call(this, key);
    };
  });
}

async function armCallTimeSessionReadFailure(page: Page) {
  await page.evaluate(() => {
    (
      window as typeof window & { __coleteCallTimeSessionRead: { armed: boolean } }
    ).__coleteCallTimeSessionRead.armed = true;
  });
}

async function callTimeSessionReadWasDenied(page: Page) {
  return page.evaluate(
    () =>
      (window as typeof window & { __coleteCallTimeSessionRead: { denied: boolean } })
        .__coleteCallTimeSessionRead.denied,
  );
}

async function identifiers(db: pg.Client, email: string) {
  const row = await db.query<{ auth_user_id: string; profile_id: string; session_ids: string[] }>(
    `select users.id as auth_user_id,
            profile.id as profile_id,
            coalesce(array_agg(session.id::text) filter (where session.id is not null), '{}')
              as session_ids
       from auth.users as users
       join public.profiles as profile on profile.auth_user_id = users.id
       left join auth.sessions as session on session.user_id = users.id
      where lower(users.email) = lower($1)
      group by users.id, profile.id`,
    [email],
  );
  const first = row.rows[0];
  if (first === undefined) throw new Error('the account has no profile yet');
  return first;
}

async function cleanupAccount(
  db: pg.Client,
  env: LocalEnvironment,
  request: Parameters<typeof deleteAuthUser>[0],
  account: { authUserId: string | undefined; email: string; profileId: string | undefined },
) {
  const lookup = await db.query<{ id: string }>(
    'select id from auth.users where lower(email) = lower($1)',
    [account.email],
  );
  const authUserId = lookup.rows[0]?.id ?? account.authUserId;
  const profiles = await db.query<{ id: string }>(
    `select id from public.profiles
      where ($1::uuid is not null and auth_user_id = $1::uuid)
         or ($2::uuid is not null and id = $2::uuid)`,
    [authUserId ?? null, account.profileId ?? null],
  );
  const profileIds = profiles.rows.map((row) => row.id);
  if (profileIds.length > 0) {
    const exports = await db.query<{ id: string; profile_id: string }>(
      'select id, profile_id from private.data_exports where profile_id = any($1::uuid[])',
      [profileIds],
    );
    for (const row of exports.rows) {
      await removeStorageObject(
        request,
        env,
        'data-exports',
        `exports/${row.profile_id}/${row.id}.zip`,
      );
    }
    await db.query(
      `delete from private.external_effects
        where resource_id = any($1::uuid[])
           or resource_id in (select id from private.data_exports where profile_id = any($1::uuid[]))
           or resource_id in (select id from private.deletion_requests where profile_id = any($1::uuid[]))`,
      [profileIds],
    );
    await db.query('delete from private.data_exports where profile_id = any($1::uuid[])', [
      profileIds,
    ]);
    await db.query('delete from public.privacy_requests where profile_id = any($1::uuid[])', [
      profileIds,
    ]);
    await db.query('delete from private.deletion_requests where profile_id = any($1::uuid[])', [
      profileIds,
    ]);
    await db.query('delete from private.idempotency_records where actor_id = any($1::uuid[])', [
      profileIds,
    ]);
    await db.query('delete from private.revoked_auth_sessions where profile_id = any($1::uuid[])', [
      profileIds,
    ]);
    await db.query('delete from public.profiles where id = any($1::uuid[])', [profileIds]);
  }
  if (authUserId !== undefined) await deleteAuthUser(request, env, authUserId);
  await db.query(
    `delete from auth.audit_log_entries
      where payload->>'actor_id' = $1 or lower(payload->>'actor_username') = lower($2)`,
    [authUserId ?? '', account.email],
  );
  await db.query("delete from private.job_runs where triggered_by = 'cron'");
  const residual = await db.query<Record<string, number>>(
    `select
       (select count(*)::int from auth.users where lower(email) = lower($1)) as users,
       (select count(*)::int from public.profiles where id = any($2::uuid[])) as profiles,
       (select count(*)::int from private.data_exports where profile_id = any($2::uuid[])) as exports,
       (select count(*)::int from private.deletion_requests where profile_id = any($2::uuid[])) as deletions,
       (select count(*)::int from public.privacy_requests where profile_id = any($2::uuid[])) as privacy_requests,
       (select count(*)::int from private.idempotency_records where actor_id = any($2::uuid[])) as idempotency,
       (select count(*)::int from storage.objects where bucket_id = 'data-exports'
          and name like any(select 'exports/' || id::text || '/%' from unnest($2::uuid[]) as id)) as objects`,
    [account.email, profileIds],
  );
  expect(residual.rows).toEqual([
    {
      deletions: 0,
      exports: 0,
      idempotency: 0,
      objects: 0,
      privacy_requests: 0,
      profiles: 0,
      users: 0,
    },
  ]);
}

test.describe('M1-B screen 13 privacy controls', () => {
  test('exports data once, needs fresh authentication and never resumes a dropped download', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium');
    test.setTimeout(150_000);
    const env = localEnvironment();
    const db = new Client({ connectionString: env.dbUrl });
    await db.connect();
    const account = {
      email: `export-e2e-${runSuffix}@colete.test`,
      name: 'Eva Exportação',
      password: PASSWORD,
    };
    let authUserId: string | undefined;
    let profileId: string | undefined;
    const captured = captureApiRequests(page);
    let downloadEvents = 0;
    page.on('download', () => {
      downloadEvents += 1;
    });

    try {
      authUserId = (await createVerifiedUser(request, env, account)).id;
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      await signInAndCompleteProfile(page, account.email);
      await expect(page).toHaveTitle('Perfil · Colete');
      const ids = await identifiers(db, account.email);
      profileId = ids.profile_id;
      const refreshedTokens = await refreshBrowserSession(page, env);
      const refreshedProfileRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return request.method() === 'GET' && url.pathname === '/rest/v1/profiles';
      });
      await page.getByRole('button', { name: 'Editar' }).click();
      await page.getByRole('button', { name: 'Salvar', exact: true }).click();
      assertRequestUsesRefreshedToken(await refreshedProfileRequest, refreshedTokens);
      await openPrivacyAndAccount(page);
      // The proof covers the privacy journeys; profile completion legitimately
      // carried the name as its business input. The deliberate profile save
      // above exists only to prove the post-refresh gate request.
      captured.length = 0;

      const card = page.getByTestId('profile-export-card');
      const title = card.getByTestId('export-state-title');
      await expect(
        card.getByRole('heading', { level: 2, name: 'Baixar meus dados' }),
      ).toBeVisible();
      await expect(title).toHaveText('Nenhum export ativo');
      await expect(card).toContainText('Ficam de fora: senha, chaves');
      await expect(card.getByRole('button', { name: 'Baixar agora' })).toHaveCount(0);

      // A transport failure keeps the same request_id; the retry is the same intent.
      await page.route('**/functions/v1/identity/request_data_export', (route) =>
        route.abort('connectionfailed'),
      );
      await card.getByRole('button', { name: 'Gerar export' }).click();
      await expect(card.getByTestId('export-request-error')).toContainText('Confira sua conexão');
      await expect(card.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
      await page.unroute('**/functions/v1/identity/request_data_export');
      await card.getByRole('button', { name: 'Tentar de novo' }).click();
      await expect(title).toHaveText('Preparando seus dados');
      await expect(card).toContainText('nada é baixado automaticamente');
      await expect(card.getByRole('button', { name: 'Baixar agora' })).toHaveCount(0);
      const exportRequestBodies = captured
        .filter((entry) => entry.url.endsWith('/identity/request_data_export'))
        .map((entry) => JSON.parse(entry.body ?? '{}') as { request_id: string });
      expect(exportRequestBodies.length).toBeGreaterThanOrEqual(2);
      expect(new Set(exportRequestBodies.map((body) => body.request_id)).size).toBe(1);
      const firstRequestId = exportRequestBodies[0]?.request_id;

      const queued = await db.query<{ id: string; status: string }>(
        'select id, status from private.data_exports where profile_id = $1',
        [ids.profile_id],
      );
      expect(queued.rows).toHaveLength(1);
      expect(queued.rows[0]?.status).toBe('queued');
      const firstExportId = queued.rows[0]?.id ?? '';

      // The real scheduled worker builds and publishes the artifact.
      expect(await runWorker(request, env, db)).toBe('succeeded');
      const built = await db.query<{ status: string }>(
        'select status from private.data_exports where id = $1',
        [firstExportId],
      );
      expect(built.rows[0]?.status).toBe('ready');

      await card.getByRole('button', { name: 'Atualizar status' }).click();
      await expect(title).toHaveText('Pronto para baixar');
      await expect(card).toContainText(/Válido até \d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}\./u);
      await expect(card).toContainText('Tentativa única');
      await assertAccessible(page);

      await page.evaluate(() => {
        document.body.style.zoom = '2';
      });
      await expect(card.getByRole('button', { name: 'Baixar agora' })).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await assertMinimumInteractiveTargets(
        page,
        'a:visible, button:visible, input:visible, [role="button"]:visible, [role="link"]:visible, [role="checkbox"]:visible',
      );
      await page.evaluate(() => {
        document.body.style.zoom = '1';
      });

      // Stale authentication: the real endpoint refuses before the CAS, the
      // screen asks for the password and returns to the same download.
      await ageAuthentication(page, db, env, account.email);
      await expect(title).toHaveText('Pronto para baixar');
      await card.getByRole('button', { name: 'Baixar agora' }).click();
      const reauthForm = card.getByTestId('export-reauth');
      const reauthPassword = card.getByTestId('export-reauth-password');
      await expect(reauthForm).toBeVisible();
      await expect(reauthPassword).toBeFocused();
      const stillReady = await db.query<{ status: string }>(
        'select status from private.data_exports where id = $1',
        [firstExportId],
      );
      expect(stillReady.rows[0]?.status).toBe('ready');
      expect(
        captured.filter((entry) => entry.url.includes(`/data-exports/${firstExportId}/content`)),
      ).toHaveLength(1);

      await reauthForm.getByRole('button', { name: 'Confirmar e baixar' }).click();
      const passwordAlert = reauthForm.getByRole('alert');
      await expect(passwordAlert).toHaveCount(1);
      await expect(passwordAlert).toHaveText('Digite sua senha para confirmar e baixar o arquivo.');
      const passwordAlertId = await passwordAlert.getAttribute('id');
      expect(passwordAlertId).not.toBeNull();
      await expect(reauthPassword).toBeFocused();
      await expect(reauthPassword).toHaveAttribute('aria-invalid', 'true');
      await expect(reauthPassword).toHaveAttribute(
        'aria-describedby',
        passwordAlertId ?? 'missing-password-alert-id',
      );

      // The field error remains associated after blur, and after the first
      // error validation updates in real time without a second live region.
      await page.keyboard.press('Tab');
      await expect(reauthForm.getByRole('button', { name: 'Mostrar senha' })).toBeFocused();
      await expect(reauthPassword).toHaveAttribute(
        'aria-describedby',
        passwordAlertId ?? 'missing-password-alert-id',
      );
      await reauthPassword.fill('temporária');
      await expect(passwordAlert).toHaveCount(0);
      await reauthPassword.fill('');
      await expect(reauthForm.getByRole('alert')).toHaveText(
        'Digite sua senha para confirmar e baixar o arquivo.',
      );
      await reauthPassword.fill(account.password);
      await page.keyboard.press('Tab');
      await expect(reauthForm.getByRole('button', { name: 'Mostrar senha' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(reauthForm.getByRole('button', { name: 'Confirmar e baixar' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(reauthForm.getByRole('button', { name: 'Cancelar download' })).toBeFocused();

      await reauthPassword.fill('senha-incorreta');
      await reauthForm.getByRole('button', { name: 'Confirmar e baixar' }).click();
      await expect(reauthPassword).toBeFocused();
      await expect(reauthPassword).toHaveAttribute('aria-invalid', 'true');
      const credentialsAlert = reauthForm.getByRole('alert');
      await expect(credentialsAlert).toHaveCount(1);
      await expect(credentialsAlert).toHaveText('Entre novamente para continuar com segurança.');
      const credentialsAlertId = await credentialsAlert.getAttribute('id');
      await expect(reauthPassword).toHaveAttribute(
        'aria-describedby',
        credentialsAlertId ?? 'missing-credentials-alert-id',
      );
      await reauthPassword.fill(account.password);
      await expect(credentialsAlert).toHaveCount(0);

      const downloadPromise = page.waitForEvent('download');
      await card.getByRole('button', { name: 'Confirmar e baixar' }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(`colete-${firstExportId}.zip`);
      const downloadedPath = await download.path();
      const bytes = await readFile(downloadedPath);
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
      await expect(title).toHaveText('Download já consumido');
      await expect(card).toContainText('Download entregue ao navegador');
      await expect(card.getByRole('button', { name: 'Baixar agora' })).toHaveCount(0);
      const consumed = await db.query<{ downloaded: boolean; status: string }>(
        'select status, downloaded_at is not null as downloaded from private.data_exports where id = $1',
        [firstExportId],
      );
      expect(consumed.rows[0]).toEqual({ downloaded: true, status: 'downloaded' });
      expect(
        captured.filter((entry) => entry.url.includes(`/data-exports/${firstExportId}/content`)),
      ).toHaveLength(2);

      // The file never enters a cache, the service worker or local storage.
      const storedTraces = await page.evaluate(async (exportId) => {
        const cacheNames = await caches.keys();
        const cachedUrls: string[] = [];
        for (const name of cacheNames) {
          for (const cachedRequest of await (await caches.open(name)).keys()) {
            cachedUrls.push(cachedRequest.url);
          }
        }
        const localValues: string[] = [];
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index) ?? '';
          localValues.push(`${key}=${localStorage.getItem(key) ?? ''}`);
        }
        return {
          cachedFunctionUrls: cachedUrls.filter((url) => url.includes('/functions/')),
          localMentionsExport: localValues.some((value) => value.includes(exportId)),
        };
      }, firstExportId);
      expect(storedTraces).toEqual({ cachedFunctionUrls: [], localMentionsExport: false });

      // Purge, then a conscious new export gets a new request_id.
      expect(await runWorker(request, env, db)).toBe('succeeded');
      await card.getByRole('button', { name: 'Atualizar status' }).click();
      await expect(card).toContainText('A limpeza terminou');
      await card.getByRole('button', { name: 'Gerar novo export' }).click();
      await expect(title).toHaveText('Preparando seus dados');
      const secondRequestBodies = captured
        .filter((entry) => entry.url.endsWith('/identity/request_data_export'))
        .map((entry) => JSON.parse(entry.body ?? '{}') as { request_id: string });
      const secondRequestId = secondRequestBodies.at(-1)?.request_id;
      expect(secondRequestId).toBeDefined();
      expect(secondRequestId).not.toBe(firstRequestId);
      const secondExport = await db.query<{ id: string }>(
        `select id from private.data_exports where profile_id = $1 and id <> $2`,
        [ids.profile_id, firstExportId],
      );
      const secondExportId = secondExport.rows[0]?.id ?? '';
      expect(secondExportId).not.toBe('');
      expect(await runWorker(request, env, db)).toBe('succeeded');
      await card.getByRole('button', { name: 'Atualizar status' }).click();
      await expect(title).toHaveText('Pronto para baixar');

      // Second browser proof: the connection drops after the server started
      // the stream. The one-shot is consumed and the client never retries.
      const downloadEventsBeforeDrop = downloadEvents;
      await page.route(`**/data-exports/${secondExportId}/content`, async (route) => {
        const response = await route.fetch();
        await response.body();
        await route.abort('connectionreset');
      });
      await card.getByRole('button', { name: 'Baixar agora' }).click();
      await expect(card).toContainText('A transferência foi interrompida');
      await expect(title).toHaveText('Download já consumido');
      await expect(card.getByRole('button', { name: 'Baixar agora' })).toHaveCount(0);
      await page.unroute(`**/data-exports/${secondExportId}/content`);
      await page.waitForTimeout(1_500);
      expect(
        captured.filter((entry) => entry.url.includes(`/data-exports/${secondExportId}/content`)),
      ).toHaveLength(1);
      expect(downloadEvents).toBe(downloadEventsBeforeDrop);
      const dropped = await db.query<{ status: string }>(
        'select status from private.data_exports where id = $1',
        [secondExportId],
      );
      expect(dropped.rows[0]?.status).toBe('downloaded');
      await page.reload();
      await expect(title).toHaveText('Download já consumido');
      await expect(card.getByRole('button', { name: 'Baixar agora' })).toHaveCount(0);

      const finalAccessToken = await storedAccessToken(page);
      assertAccessTokensOnlyInAuthorization(
        captured,
        [refreshedTokens.previousToken, refreshedTokens.currentToken, finalAccessToken],
        [refreshedTokens.currentToken, finalAccessToken],
      );
      const sessions = await identifiers(db, account.email);
      assertBodiesNeverLeakIdentity(captured, {
        authUserId: ids.auth_user_id,
        email: account.email,
        name: account.name,
        profileId: ids.profile_id,
        sessionIds: [...ids.session_ids, ...sessions.session_ids],
      });
    } finally {
      await cleanupAccount(db, env, request, { authUserId, email: account.email, profileId });
      await db.end();
    }
  });

  test('deletes the account behind a double confirmation and keeps the protocol after Auth is gone', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium');
    test.setTimeout(150_000);
    const env = localEnvironment();
    const db = new Client({ connectionString: env.dbUrl });
    await db.connect();
    const account = {
      email: `deletion-e2e-${runSuffix}@colete.test`,
      name: 'Davi Exclusão',
      password: PASSWORD,
    };
    let authUserId: string | undefined;
    let profileId: string | undefined;
    const captured = captureApiRequests(page);
    const passwordGrants: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/auth/v1/token?grant_type=password')) {
        passwordGrants.push(request.url());
      }
    });

    try {
      authUserId = (await createVerifiedUser(request, env, account)).id;
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      await signInAndCompleteProfile(page, account.email);
      await expect(page).toHaveTitle('Perfil · Colete');
      const ids = await identifiers(db, account.email);
      profileId = ids.profile_id;
      expect(passwordGrants).toHaveLength(1);
      const refreshedTokens = await refreshBrowserSession(page, env);
      captured.length = 0;
      await openPrivacyAndAccount(page);

      const card = page.getByTestId('profile-deletion-card');
      await expect(card).toContainText('anonimizados');
      await expect(card).toContainText('bloqueado imediatamente');
      await expect(card).toContainText('limpeza de arquivos');
      await expect(card).toContainText('titular de grupo');
      await expect(card.getByRole('button', { name: 'Excluir minha conta' })).toHaveCount(0);

      await card.getByRole('button', { name: 'Excluir conta' }).click();
      await expect(card.getByTestId('deletion-summary')).toBeFocused();
      await expect(card.getByRole('heading', { level: 3, name: 'Resumo final' })).toBeVisible();
      const checkbox = card.getByRole('checkbox');
      await expect(checkbox).toHaveAttribute('aria-checked', 'false');
      const confirm = card.getByRole('button', { name: 'Excluir minha conta' });
      const requirementId = await confirm.getAttribute('aria-describedby');
      expect(requirementId).toMatch(/^deletion-requirement-/u);
      await expect(page.locator(`[id="${requirementId ?? ''}"]`)).toHaveText(
        'O botão só conclui a exclusão com a caixa de confirmação marcada.',
      );
      await confirm.click();
      const checkboxAlert = card.getByRole('alert');
      await expect(checkboxAlert).toHaveCount(1);
      await expect(checkboxAlert).toHaveText('Marque a caixa de confirmação para excluir a conta.');
      const checkboxAlertId = await checkboxAlert.getAttribute('id');
      expect(checkboxAlertId).not.toBeNull();
      await expect(checkbox).toBeFocused();
      await expect(checkbox).toHaveAttribute('aria-invalid', 'true');
      await expect(checkbox).toHaveAttribute(
        'aria-describedby',
        checkboxAlertId ?? 'missing-checkbox-alert-id',
      );
      expect(captured.filter((entry) => entry.url.endsWith('/identity/delete_account'))).toEqual(
        [],
      );
      await assertAccessible(page);

      // Keyboard order is complete and logical; the error association remains
      // stable through blur/focus before Space toggles the checkbox.
      await page.keyboard.press('Tab');
      await expect(confirm).toBeFocused();
      await expect(checkbox).toHaveAttribute(
        'aria-describedby',
        checkboxAlertId ?? 'missing-checkbox-alert-id',
      );
      await page.keyboard.press('Tab');
      await expect(card.getByRole('button', { name: 'Voltar' })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(confirm).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(checkbox).toBeFocused();
      await page.keyboard.press('Space');
      await expect(checkbox).toHaveAttribute('aria-checked', 'true');
      await expect(checkbox).toHaveAttribute('aria-invalid', 'false');
      await expect(checkbox).not.toHaveAttribute('aria-describedby', /.+/u);

      await page.evaluate(() => {
        document.body.style.zoom = '2';
      });
      await expect(confirm).toBeVisible();
      await assertNoHorizontalOverflow(page);
      await assertMinimumInteractiveTargets(
        page,
        'a:visible, button:visible, input:visible, [role="button"]:visible, [role="link"]:visible, [role="checkbox"]:visible',
      );
      await page.evaluate(() => {
        document.body.style.zoom = '1';
      });

      // Transport retry keeps the request_id.
      await page.route('**/functions/v1/identity/delete_account', (route) =>
        route.abort('connectionfailed'),
      );
      await confirm.click();
      await expect(card.getByTestId('deletion-error')).toContainText('Confira sua conexão');
      await page.unroute('**/functions/v1/identity/delete_account');

      // The normative refusal shows the action to take and offers no way around.
      await page.route('**/functions/v1/identity/delete_account', (route) =>
        route.fulfill({
          body: JSON.stringify({
            error: {
              code: 'FINANCIAL_SUBSTITUTE_REQUIRED',
              message: 'Account deletion requires a financial substitute before it can continue.',
            },
            request_id: (JSON.parse(route.request().postData() ?? '{}') as { request_id: string })
              .request_id,
          }),
          contentType: 'application/json',
          status: 403,
        }),
      );
      await card.getByRole('button', { name: 'Tentar de novo' }).click();
      await expect(card.getByTestId('deletion-error')).toContainText(
        'transfira a titularidade do grupo ou o caso financeiro',
      );
      await expect(card.getByRole('button', { name: 'Tentar de novo' })).toHaveCount(0);
      await page.unroute('**/functions/v1/identity/delete_account');
      const refusedBodies = captured
        .filter((entry) => entry.url.endsWith('/identity/delete_account'))
        .map((entry) => JSON.parse(entry.body ?? '{}') as { request_id: string });
      expect(refusedBodies.length).toBeGreaterThanOrEqual(2);
      expect(new Set(refusedBodies.map((body) => body.request_id)).size).toBe(1);
      const stillActive = await db.query<{ account_status: string }>(
        'select account_status from public.profiles where id = $1',
        [ids.profile_id],
      );
      expect(stillActive.rows[0]?.account_status).toBe('active');

      // The real deletion: a new intent after a refusal carries a new request_id.
      const refreshedDeletionRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return (
          request.method() === 'POST' && url.pathname === '/rest/v1/rpc/get_own_deletion_request'
        );
      });
      await confirm.click();
      assertRequestUsesRefreshedToken(await refreshedDeletionRequest, refreshedTokens);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Exclusão em andamento' }),
      ).toBeVisible();
      const deletionBodies = captured
        .filter((entry) => entry.url.endsWith('/identity/delete_account'))
        .map((entry) => JSON.parse(entry.body ?? '{}') as { request_id: string });
      expect(deletionBodies.at(-1)?.request_id).not.toBe(refusedBodies[0]?.request_id);

      const requested = await db.query<{ account_status: string; id: string; status: string }>(
        `select request.id, request.status, profile.account_status
           from private.deletion_requests as request
           join public.profiles as profile on profile.id = request.profile_id
          where request.profile_id = $1`,
        [ids.profile_id],
      );
      expect(requested.rows).toHaveLength(1);
      expect(requested.rows[0]?.status).toBe('requested');
      expect(requested.rows[0]?.account_status).toBe('deletion_pending');
      const protocol = requested.rows[0]?.id ?? '';

      // Grupos, Perfil and this screen are all still in the navigation history, and
      // every one of them is behind the gate, so each now renders the shell; only
      // the current one is visible. No card of the profile or of this screen survives.
      const shell = page.getByRole('main').getByTestId('deletion-shell-card');
      await expect(shell.getByTestId('deletion-shell-protocol')).toHaveText(protocol);
      await expect(shell).toContainText(/Pedido feito em \d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}\./u);
      await expect(page.getByTestId('profile-export-card')).toHaveCount(0);
      await expect(page.getByTestId('profile-provider-card')).toHaveCount(0);
      await expect(page.getByTestId('profile-deletion-card')).toHaveCount(0);
      await expect(shell.getByTestId('deletion-shell-support')).toHaveCount(0);
      await assertAccessible(page);

      const storedProtocol = await page.evaluate(() =>
        localStorage.getItem('colete.deletion-protocol.v1'),
      );
      expect(JSON.parse(storedProtocol ?? 'null')).toEqual({
        id: protocol,
        requested_at: expect.any(String),
      });

      await page.reload();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Exclusão em andamento' }),
      ).toBeVisible();
      await expect(page.getByTestId('deletion-shell-protocol')).toHaveText(protocol);
      // The profile itself is behind the same gate: no data, no edit, only the shell.
      await page.goto('/perfil');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Exclusão em andamento' }),
      ).toBeVisible();
      await expect(page.getByTestId('deletion-shell-protocol')).toHaveText(protocol);
      await expect(page.getByTestId('profile-data-card')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Editar' })).toHaveCount(0);

      // An operational delay is shown as delay, without any internal detail.
      await db.query(
        'update private.deletion_requests set has_operational_failure = true where id = $1',
        [protocol],
      );
      await page.getByRole('button', { name: 'Atualizar status' }).click();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Exclusão com atraso' }),
      ).toBeVisible();
      await expect(page.getByTestId('deletion-shell-support')).toContainText('canal de suporte');
      await expect(page.getByTestId('deletion-shell-card')).not.toContainText('STORAGE');
      await db.query(
        'update private.deletion_requests set has_operational_failure = false where id = $1',
        [protocol],
      );

      // The real worker removes Auth and finalizes; the JWT still in the browser
      // can no longer verify anything, and the shell says so without recreating
      // a session.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await runWorker(request, env, db);
        const state = await db.query<{ status: string }>(
          'select status from private.deletion_requests where id = $1',
          [protocol],
        );
        if (state.rows[0]?.status === 'completed') break;
      }
      const finalized = await db.query<{ account_status: string; status: string }>(
        `select request.status, profile.account_status
           from private.deletion_requests as request
           join public.profiles as profile on profile.id = request.profile_id
          where request.id = $1`,
        [protocol],
      );
      expect(finalized.rows[0]).toEqual({ account_status: 'deleted', status: 'completed' });
      const authGone = await db.query<{ count: number }>(
        'select count(*)::int as count from auth.users where id = $1',
        [ids.auth_user_id],
      );
      expect(authGone.rows[0]?.count).toBe(0);

      await page.getByRole('button', { name: 'Atualizar status' }).click();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Pedido registrado' }),
      ).toBeVisible();
      await expect(page.getByTestId('deletion-shell-protocol')).toHaveText(protocol);
      await expect(page.getByTestId('deletion-shell-support')).toContainText('canal de suporte');
      await page.reload();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Pedido registrado' }),
      ).toBeVisible();
      await expect(page.getByTestId('deletion-shell-protocol')).toHaveText(protocol);
      expect(passwordGrants).toHaveLength(1);

      await page.getByRole('button', { name: 'Sair deste dispositivo' }).click();
      await expect(page).toHaveURL(/\/entrar$/u);
      expect(
        await page.evaluate(() => localStorage.getItem('colete.deletion-protocol.v1')),
      ).toBeNull();

      assertAccessTokensOnlyInAuthorization(
        captured,
        [refreshedTokens.previousToken, refreshedTokens.currentToken],
        [refreshedTokens.currentToken],
      );
      assertBodiesNeverLeakIdentity(captured, {
        authUserId: ids.auth_user_id,
        email: account.email,
        name: account.name,
        profileId: ids.profile_id,
        sessionIds: ids.session_ids,
      });
    } finally {
      await cleanupAccount(db, env, request, { authUserId, email: account.email, profileId });
      await db.end();
    }
  });

  test('a sign-out in another tab leaves nothing of the previous account to the next one', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium');
    test.setTimeout(90_000);
    const env = localEnvironment();
    const db = new Client({ connectionString: env.dbUrl });
    await db.connect();
    const first = {
      email: `cache-first-${runSuffix}@colete.test`,
      name: 'Fábia Primeira',
      password: PASSWORD,
    };
    const second = {
      email: `cache-second-${runSuffix}@colete.test`,
      name: 'Sofia Segunda',
      password: PASSWORD,
    };
    let firstAuthUserId: string | undefined;
    let secondAuthUserId: string | undefined;
    const restAuthorization = observeRestAuthorization(page);

    try {
      firstAuthUserId = (await createVerifiedUser(request, env, first)).id;
      secondAuthUserId = (await createVerifiedUser(request, env, second)).id;
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      await signInAndCompleteProfile(page, first.email);
      await openPrivacyAndAccount(page);
      const card = page.getByTestId('profile-export-card');
      const title = card.getByTestId('export-state-title');
      await card.getByRole('button', { name: 'Gerar export' }).click();
      await expect(title).toHaveText('Preparando seus dados');

      // The first account leaves from another tab of the same browser. This
      // tab only learns it through Auth, not through its own logout handler.
      const otherTab = await page.context().newPage();
      await otherTab.goto('/perfil');
      await expect(otherTab.getByRole('heading', { level: 1, name: 'Perfil' })).toBeVisible();
      const documentsByTab: string[][] = [[], []];
      for (const [index, tab] of [page, otherTab].entries()) {
        tab.on('request', (sent) => {
          if (sent.isNavigationRequest() && sent.frame() === tab.mainFrame())
            documentsByTab[index]!.push(new URL(sent.url()).pathname);
        });
      }
      restAuthorization.markLogout();
      await otherTab.getByRole('button', { name: 'Sair da conta' }).click();
      await expect(otherTab).toHaveURL(/\/entrar$/u);
      await expect(page).toHaveURL(/\/entrar$/u);
      for (const tab of [page, otherTab]) {
        await tab.waitForLoadState('networkidle');
        await expect(tab.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
      }
      expect(documentsByTab).toEqual([['/entrar'], ['/entrar']]);
      await otherTab.close();

      // The second account's own export projection is held at the network, so
      // whatever the card shows meanwhile can only come from the query cache.
      let releaseSecondProjection: () => void = () => undefined;
      const secondProjectionReleased = new Promise<void>((resolve) => {
        releaseSecondProjection = resolve;
      });
      // Only whether the JWT belongs to the second account is kept, never the `sub`.
      const heldProjections: boolean[] = [];
      await page.route('**/rest/v1/rpc/get_own_data_exports', async (route) => {
        const subject = userJwtSubject(route.request().headers()['authorization']);
        heldProjections.push(subject !== null && subject === secondAuthUserId);
        await secondProjectionReleased;
        await route.continue();
      });

      // Same document, no reload: a reload would empty the cache and hide the leak.
      await page.getByLabel('E-mail').fill(second.email);
      await page.getByLabel('Senha', { exact: true }).fill(PASSWORD);
      await page.getByRole('button', { name: 'Entrar', exact: true }).click();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Complete seu perfil' }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Concluir perfil' }).click();
      // Client-side navigation only: the same document, so the same query cache.
      await expect(page.getByRole('heading', { level: 1, name: 'Grupos' })).toBeVisible();
      await page.getByRole('link', { name: 'Perfil', exact: true }).click();
      await expect(page.getByTestId('profile-data-card')).toBeVisible();
      await page.getByRole('link', { name: 'Privacidade e conta' }).click();
      await expect(card).toBeVisible();
      await expect(card.getByText('Carregando com segurança…')).toBeVisible();
      await expect(title).toHaveCount(0);
      await expect.poll(() => heldProjections).toEqual([true]);

      releaseSecondProjection();
      await expect(title).toHaveText('Nenhum export ativo');
      await page.unroute('**/rest/v1/rpc/get_own_data_exports');
      restAuthorization.assertNoAnonymousRequestAfterLogout(testInfo);
    } finally {
      await cleanupAccount(db, env, request, {
        authUserId: firstAuthUserId,
        email: first.email,
        profileId: undefined,
      });
      await cleanupAccount(db, env, request, {
        authUserId: secondAuthUserId,
        email: second.email,
        profileId: undefined,
      });
      await db.end();
    }
  });
  test('a private query whose call-time session read fails sends nothing and recovers', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium');
    test.setTimeout(60_000);
    const env = localEnvironment();
    const db = new Client({ connectionString: env.dbUrl });
    await db.connect();
    const owner = {
      email: `session-read-${runSuffix}@colete.test`,
      name: 'Rita Releitura',
      password: PASSWORD,
    };
    let authUserId: string | undefined;

    try {
      authUserId = (await createVerifiedUser(request, env, owner)).id;
      await installCallTimeSessionReadFailure(page);
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      await signInAndCompleteProfile(page, owner.email);
      await openPrivacyAndAccount(page);
      const card = page.getByTestId('profile-export-card');
      const title = card.getByTestId('export-state-title');
      // The request's own success refetches the projection; that read must
      // finish before the failure is armed.
      const projectionAfterRequest = handledObserver(
        page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/rest/v1/rpc/get_own_data_exports',
        ),
      );
      await card.getByRole('button', { name: 'Gerar export' }).click();
      await projectionAfterRequest;
      await expect(title).toHaveText('Preparando seus dados');

      // From here on, only whether each projection carried this account's JWT is kept.
      const projections: boolean[] = [];
      page.on('request', (sent) => {
        if (new URL(sent.url()).pathname !== '/rest/v1/rpc/get_own_data_exports') return;
        const subject = userJwtSubject(sent.headers()['authorization']);
        projections.push(subject !== null && subject === authUserId);
      });

      // "Atualizar status" refetches only the export projection, so the one
      // session read that fails is the call-time read of that query.
      await armCallTimeSessionReadFailure(page);
      await card.getByRole('button', { name: 'Atualizar status' }).click();
      const notice = card.getByRole('alert');
      await expect(notice).toContainText('Não foi possível confirmar sua sessão');
      await expect(notice).toContainText('entre novamente para continuar com segurança');
      await expect(notice).not.toContainText('Confira sua conexão');
      expect(await callTimeSessionReadWasDenied(page)).toBe(true);
      expect(projections).toEqual([]);

      await notice.getByRole('button', { name: 'Tentar de novo' }).click();
      await expect(title).toHaveText('Preparando seus dados');
      await expect(card.getByRole('alert')).toHaveCount(0);
      expect(projections).toEqual([true]);
    } finally {
      await cleanupAccount(db, env, request, {
        authUserId,
        email: owner.email,
        profileId: undefined,
      });
      await db.end();
    }
  });
  test('Voltar ao perfil keeps one profile and one tab bar, by navigation and by direct URL', async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium');
    const env = localEnvironment();
    const db = new Client({ connectionString: env.dbUrl });
    await db.connect();
    const owner = {
      email: `profile-back-${runSuffix}@colete.test`,
      name: 'Paula Volta',
      password: PASSWORD,
    };
    let authUserId: string | undefined;
    try {
      authUserId = (await createVerifiedUser(request, env, owner)).id;
      await signInAndCompleteProfile(page, owner.email);
      for (const [link, child] of [
        ['Privacidade e conta', 'profile-export-card'],
        ['Trocar senha', 'profile-back-link'],
      ] as const) {
        // Normal navigation, twice: each round trip pops back to the same profile.
        for (let round = 0; round < 2; round += 1) {
          await page.getByRole('link', { name: link }).click();
          await expect(page.getByTestId('profile-back-link')).toBeVisible();
          await page.getByRole('link', { name: 'Voltar ao perfil' }).click();
          await expect(page).toHaveURL(/\/perfil$/u);
          await expectOneParent(page, 'profile-data-card', child);
        }
      }
      // Direct URL: no profile in the stack, so the back replaces the child.
      for (const [route, child] of [
        ['/perfil/privacidade', 'profile-export-card'],
        ['/perfil/senha', 'profile-back-link'],
      ] as const) {
        await page.goto(route);
        await expect(page.getByTestId('profile-back-link')).toBeVisible();
        await page.getByRole('link', { name: 'Voltar ao perfil' }).click();
        await expect(page).toHaveURL(/\/perfil$/u);
        await expectOneParent(page, 'profile-data-card', child);
      }
    } finally {
      await cleanupAccount(db, env, request, {
        authUserId,
        email: owner.email,
        profileId: undefined,
      });
      await db.end();
    }
  });
});
