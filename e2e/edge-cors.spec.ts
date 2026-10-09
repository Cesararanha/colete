import { expect, test } from '@playwright/test';
import { startDirectEdge } from '../scripts/local-edge-runtime.mjs';
import { corsFixture } from '../scripts/cors-fixture.mjs';
import { handledObserver } from './support/observers';

// Auth/Data API remain on their real local addresses. This client-side test
// adapter selects the directly published Edge port for Functions only; native
// fetch, browser preflight and production handlers are untouched. No proxy,
// Playwright route fulfilment, Kong plugin or fake response serves Functions.
test('the exported app creates a group across origins through the direct production Edge', async ({
  page,
}) => {
  const fixture = await corsFixture();
  const runtime = await startDirectEdge({
    APP_ALLOWED_ORIGINS: 'http://127.0.0.1:4173',
    COLETE_LOCAL_STACK: 'true',
  });
  try {
    const actor = await fixture.actor(runtime.url);
    await page.addInitScript(
      ({ api, direct }) => {
        const original = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.origin === api && url.pathname.startsWith('/functions/v1/')) {
            const target = `${direct}${url.pathname.slice('/functions/v1'.length)}${url.search}`;
            return original(input instanceof Request ? new Request(target, input) : target, init);
          }
          return original(input, init);
        };
      },
      { api: fixture.env.apiUrl, direct: runtime.url },
    );
    await page.goto('/entrar');
    expect(new URL(page.url()).origin).not.toBe(runtime.url);
    await page.getByTestId('login-email').fill(actor.email);
    await page.getByTestId('login-password').fill(actor.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Perfil', level: 1 })).toBeVisible();
    await page.goto('/grupos');
    await page.getByRole('button', { name: 'Criar grupo', exact: true }).click();
    await page.getByTestId('group-name').fill('Direct CORS group');
    const created = handledObserver(
      page.waitForResponse((response) => response.url() === `${runtime.url}/groups/create_group`),
    );
    await page.getByTestId('create-group-submit').click();
    const response = await created;
    expect(response.status()).toBe(200);
    expect(response.headers()['access-control-allow-origin']).toBe('http://127.0.0.1:4173');
    await expect(page.getByTestId('group-invites-card')).toBeVisible();
    const group = await fixture.db.query(
      'select count(*)::integer as count from public.groups where owner_id=$1',
      [actor.profileId],
    );
    expect(group.rows[0].count).toBe(1);
    const refusal = await page.evaluate(async (direct) => {
      const response = await fetch(`${direct}/identity/complete_profile`, {
        method: 'POST',
        headers: {
          apikey: 'public-fixture',
          'content-type': 'application/json',
          'x-client-info': 'cors-browser-fixture',
        },
        body: '{}',
      });
      return { status: response.status, code: (await response.json()).error.code };
    }, runtime.url);
    expect(refusal).toEqual({ status: 401, code: 'UNAUTHENTICATED' });
    const exportRefusal = await page.evaluate(async (direct) => {
      const response = await fetch(
        `${direct}/data-exports/00000000-0000-4000-8000-000000000001/content`,
        { headers: { apikey: 'public-fixture' } },
      );
      return { status: response.status, code: (await response.json()).error.code };
    }, runtime.url);
    expect(exportRefusal).toEqual({ status: 401, code: 'UNAUTHENTICATED' });
  } finally {
    await page.close();
    try {
      await runtime.stop();
    } finally {
      await fixture.close();
    }
  }
});

test('an exported app on a denied origin cannot read Edge and displays the transport error', async ({
  page,
}) => {
  const fixture = await corsFixture();
  const runtime = await startDirectEdge({
    APP_ALLOWED_ORIGINS: 'https://approved.example.invalid',
    COLETE_LOCAL_STACK: undefined,
  });
  try {
    const actor = await fixture.actor(runtime.url);
    await page.addInitScript(
      ({ api, direct }) => {
        const original = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.origin === api && url.pathname.startsWith('/functions/v1/')) {
            const target = `${direct}${url.pathname.slice('/functions/v1'.length)}${url.search}`;
            return original(input instanceof Request ? new Request(target, input) : target, init);
          }
          return original(input, init);
        };
      },
      { api: fixture.env.apiUrl, direct: runtime.url },
    );
    await page.goto('/entrar');
    expect(new URL(page.url()).origin).toBe('http://127.0.0.1:4173');
    await page.getByTestId('login-email').fill(actor.email);
    await page.getByTestId('login-password').fill(actor.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Perfil', level: 1 })).toBeVisible();
    const blocked = await page.evaluate(async (direct) => {
      try {
        const response = await fetch(`${direct}/identity/complete_profile`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        return { status: response.status };
      } catch (error) {
        return { error: error instanceof Error ? error.name : 'unknown' };
      }
    }, runtime.url);
    expect(blocked).toEqual({ error: 'TypeError' });
    await page.goto('/grupos/criar');
    await page.getByTestId('group-name').fill('Blocked CORS group');
    await page.getByTestId('create-group-submit').click();
    await expect(
      page.getByText('A rede não respondeu. Confira a conexão e tente novamente.', { exact: true }),
    ).toBeVisible();
    const groups = await fixture.db.query(
      'select count(*)::integer as count from public.groups where owner_id=$1',
      [actor.profileId],
    );
    expect(groups.rows[0].count).toBe(0);
  } finally {
    await page.close();
    try {
      await runtime.stop();
    } finally {
      await fixture.close();
    }
  }
});
