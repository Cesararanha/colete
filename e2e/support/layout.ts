import { expect, type Page } from '@playwright/test';

export async function applyCpuThrottling(page: Page, rateValue: string | undefined) {
  if (rateValue === undefined) return;
  const rate = Number(rateValue);
  if (!Number.isInteger(rate) || rate < 1) {
    throw new Error('COLETE_E2E_CPU_THROTTLE_RATE must be a positive integer.');
  }
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate });
}

export async function waitForStableLayout(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let previous = '';
        let stableFrames = 0;
        const sample = () => {
          const root = document.documentElement;
          const body = document.body.getBoundingClientRect();
          const targets = [
            ...document.querySelectorAll<HTMLElement>(
              'a, button, input, [role="button"], [role="link"], [role="checkbox"]',
            ),
          ].map((element) => {
            const rect = element.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
          });
          return JSON.stringify([
            root.clientWidth,
            root.scrollWidth,
            body.x,
            body.width,
            body.right,
            targets,
          ]);
        };
        const check = () => {
          const current = sample();
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 2) {
            resolve();
            return;
          }
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
  );
}

export async function assertNoHorizontalOverflow(page: Page) {
  await waitForStableLayout(page);
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (process.env.COLETE_E2E_REPORT_LAYOUT === '1') {
    console.log(`stable layout: ${layout.scrollWidth}/${layout.clientWidth}`);
  }
  expect(layout.scrollWidth > layout.clientWidth).toBe(false);
}

export async function assertMinimumInteractiveTargets(page: Page, selector: string) {
  await waitForStableLayout(page);
  const boxes = await page.locator(selector).evaluateAll((elements) =>
    elements.map((element) => {
      const { height, width } = element.getBoundingClientRect();
      return { height, width };
    }),
  );
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
}
