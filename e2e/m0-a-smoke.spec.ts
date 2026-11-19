import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './support/csp';
import { Buffer } from 'node:buffer';

test('shell supports keyboard, synthetic return, upload and safe caching', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: 'Colete' })).toBeVisible();
  const wide = (page.viewportSize()?.width ?? 0) >= 768;
  await expect(page.getByTestId(wide ? 'wide-navigation' : 'narrow-navigation')).toBeVisible();
  await expect(page.getByTestId(wide ? 'narrow-navigation' : 'wide-navigation')).toHaveCount(0);
  await expect(page.getByTestId('synthetic-smoke-panel')).toBeVisible();

  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBe(false);

  await page.keyboard.press('Tab');
  const focusedOutline = await page.evaluate(() => {
    const focused = document.activeElement;
    return focused ? getComputedStyle(focused).outlineStyle : 'none';
  });
  expect(focusedOutline).not.toBe('none');

  // Dark is the only theme (human decision of 14/10/2026): the primary action is
  // amber without any switch, under Playwright's default light preference.
  const syntheticAuthLink = page.getByRole('link', {
    name: 'Simular retorno de autenticação',
  });
  await expect(syntheticAuthLink).toHaveCSS('background-color', 'rgb(255, 185, 64)');
  await syntheticAuthLink.click();
  await expect(page.getByTestId('synthetic-auth-result')).toContainText('synthetic-user-001');

  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Escolher arquivo sintético' }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'synthetic-proof.png',
    mimeType: 'image/png',
    buffer: Buffer.from('synthetic-only'),
  });
  await expect(page.getByRole('main').getByTestId('synthetic-upload-result')).toContainText(
    'Nenhum byte foi persistido ou enviado.',
  );

  await page.waitForFunction(async () => {
    if (!('serviceWorker' in navigator)) return false;
    await navigator.serviceWorker.ready;
    return true;
  });
  await page.reload();
  await page.evaluate(async () => {
    await fetch('/auth/v1/user').catch(() => undefined);
    await fetch('/storage/v1/object/private-proof').catch(() => undefined);
    await fetch('/pix/instructions').catch(() => undefined);
  });
  const cachedUrls = await page.evaluate(async () => {
    const keys = await caches.keys();
    return (
      await Promise.all(
        keys.map(async (key) =>
          (await caches.open(key)).keys().then((requests) => requests.map((r) => r.url)),
        ),
      )
    ).flat();
  });
  expect(cachedUrls.some((url) => /auth|storage|proof|pix|payment/i.test(url))).toBe(false);

  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((violation) =>
      ['critical', 'serious'].includes(violation.impact ?? ''),
    ),
  ).toEqual([]);
});

test('shell reflows and stays dark with no theme control', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/foundation');
  const wide = (page.viewportSize()?.width ?? 0) >= 768;
  await expect(page.getByTestId(wide ? 'wide-navigation' : 'narrow-navigation')).toBeVisible();
  await expect(page.getByTestId(wide ? 'narrow-navigation' : 'wide-navigation')).toHaveCount(0);

  await expect(page.getByTestId('theme-toggle')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(10, 17, 32)');
  const brand = page.getByRole('heading', { level: 1, name: 'Colete' });
  await expect(brand).toHaveCSS('color', 'rgb(241, 242, 244)');
});

test('reduced motion preference is respected by the web shell', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const transitionDuration = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.transition = 'opacity 2s';
    document.body.append(probe);
    const duration = getComputedStyle(probe).transitionDuration;
    probe.remove();
    return duration;
  });
  const seconds = transitionDuration.endsWith('ms')
    ? Number.parseFloat(transitionDuration) / 1000
    : Number.parseFloat(transitionDuration);
  expect(seconds).toBeLessThanOrEqual(0.00001);
});

// A public route not yet visited must remain available in the cached app bundle.
// Async web routes need an uncached chunk here, regressing SDK 57 behavior.
test('cached app opens an unvisited route while offline', async ({ page, context }) => {
  await page.goto('/entrar');
  await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
  await context.setOffline(true);
  await page.getByRole('link', { name: 'Criar conta', exact: true }).click();
  await expect(page).toHaveURL(/\/criar-conta$/u);
  await expect(page.getByRole('heading', { name: 'Criar conta', exact: true })).toBeVisible();
  await expect(page).toHaveTitle('Criar conta · Colete');
  await page.getByTestId('signup-name').fill('Nome offline');
  await expect(page.getByTestId('signup-name')).toHaveValue('Nome offline');
});

// Substitute browser insets in the emitted rule, retaining its selector and
// cascade order: the later React Native Web padding reset must not erase them.
test('web safe areas win over the React Native Web padding reset', async ({ page }) => {
  await page.goto('/entrar');
  await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const style = [...document.querySelectorAll('style')].find((node) =>
      node.textContent?.includes('[data-safe-area]'),
    );
    if (!style?.textContent) throw new Error('Missing web safe-area CSS');
    const insets = { top: 11, right: 13, bottom: 17, left: 19 };
    for (const [edge, value] of Object.entries(insets)) {
      style.textContent = style.textContent.replace(
        `env(safe-area-inset-${edge}, 0px)`,
        `${value}px`,
      );
    }
  });
  const frame = page.locator('[data-safe-area]').first();
  await expect(frame).toHaveCSS('padding-top', '11px');
  await expect(frame).toHaveCSS('padding-right', '13px');
  await expect(frame).toHaveCSS('padding-bottom', '17px');
  await expect(frame).toHaveCSS('padding-left', '19px');
});
