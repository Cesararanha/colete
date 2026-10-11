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

  await page.getByTestId('theme-toggle').click();
  const syntheticAuthLink = page.getByRole('link', {
    name: 'Simular retorno de autenticação',
  });
  await expect(syntheticAuthLink).toHaveCSS('background-color', 'rgb(121, 229, 169)');
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

test('shell reflows and exposes a working theme control', async ({ page }) => {
  await page.goto('/foundation');
  const wide = (page.viewportSize()?.width ?? 0) >= 768;
  await expect(page.getByTestId(wide ? 'wide-navigation' : 'narrow-navigation')).toBeVisible();
  await expect(page.getByTestId(wide ? 'narrow-navigation' : 'wide-navigation')).toHaveCount(0);

  const brand = page.getByRole('heading', { level: 1, name: 'Colete' });
  const before = await brand.evaluate((element) => getComputedStyle(element).color);
  await page.getByTestId('theme-toggle').click();
  const after = await brand.evaluate((element) => getComputedStyle(element).color);
  expect(after).not.toBe(before);
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
