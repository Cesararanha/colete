import { expect, type Locator, type Page } from '@playwright/test';

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

/**
 * docs/29 §0, phantom scroll: on a screen whose content fits, neither the
 * document nor any scroll container can move, and the page never bounces.
 */
export async function assertNoPhantomScroll(page: Page) {
  await waitForStableLayout(page);
  const state = () =>
    page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      const scrollable = [...document.querySelectorAll<HTMLElement>('*')].filter(
        (element) =>
          /(auto|scroll)/u.test(getComputedStyle(element).overflowY) &&
          element.scrollHeight > element.clientHeight + 1,
      );
      return {
        documentOverflow: root.scrollHeight - root.clientHeight,
        htmlOverscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
        bodyOverscroll: getComputedStyle(document.body).overscrollBehaviorY,
        scrollable: scrollable.length,
        scrolled: window.scrollY + scrollable.reduce((sum, element) => sum + element.scrollTop, 0),
      };
    });
  const before = await state();
  expect(before).toEqual({
    documentOverflow: 0,
    htmlOverscroll: 'none',
    bodyOverscroll: 'none',
    scrollable: 0,
    scrolled: 0,
  });
  const viewport = page.viewportSize();
  await page.mouse.move((viewport?.width ?? 0) / 2, (viewport?.height ?? 0) / 2);
  await page.mouse.wheel(0, 600);
  await waitForStableLayout(page);
  expect((await state()).scrolled).toBe(0);
}

/**
 * Every visible piece of text stays inside the screen and inside each ancestor
 * that clips it. Polimento final: a long name without spaces ran off the card
 * or was cut by the header, which neither the page width nor axe detects.
 * Returns the offending texts (shortened) so that a failure names them.
 */
export async function textOutsideItsBox(page: Page): Promise<string[]> {
  await waitForStableLayout(page);
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const clips = (element: Element) => {
      const style = getComputedStyle(element);
      return style.overflowX !== 'visible' || style.overflow !== 'visible';
    };
    const bad = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? '';
      const parent = node.parentElement;
      if (text === '' || parent === null) continue;
      // aria-hidden text (a card's body under its link label) is still drawn.
      if (parent.closest('script, style, [hidden]')) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
      if (rects.length === 0) continue;
      // Hidden screens of the tab stacks stay mounted with no size.
      if (parent.getClientRects().length === 0) continue;
      const boxes: { left: number; right: number }[] = [{ left: 0, right: width }];
      for (let element = parent.parentElement; element; element = element.parentElement) {
        if (element === document.body || element === document.documentElement) break;
        if (!clips(element)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0) continue;
        boxes.push({ left: rect.left, right: rect.right });
      }
      // A text cut on purpose by its own box (one line with an ellipsis) counts
      // only for the part its box shows.
      const own = clips(parent) ? parent.getBoundingClientRect() : null;
      for (const rect of rects) {
        const left = own ? Math.max(rect.left, own.left) : rect.left;
        const right = own ? Math.min(rect.right, own.right) : rect.right;
        if (right <= left) continue;
        if (boxes.some((box) => left < box.left - 1 || right > box.right + 1))
          bad.add(text.slice(0, 24));
      }
    }
    return [...bad];
  });
}

/** Moves the keyboard focus forward with Tab until it lands on `target`. */
export async function tabTo(page: Page, target: Locator, maxPresses = 60) {
  for (let press = 0; press < maxPresses; press += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab did not reach the target in ${maxPresses} presses.`);
}

/**
 * The sides of the focused element's ring that an ancestor cuts off, empty when
 * the whole ring shows (WCAG 2.4.7, UX-002). The computed outline alone cannot
 * tell this: a ring drawn outside the element is still "there" when a parent
 * with overflow hidden hides it. The element is centred first, so a scroller's
 * own edge is not mistaken for a clip.
 */
export async function focusRingClipped(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || !element.matches(':focus-visible'))
      return ['no visible focus'];
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const style = getComputedStyle(element);
    const width = parseFloat(style.outlineWidth);
    if (style.outlineStyle === 'none' || !(width > 0)) return ['no outline'];
    const reach = width + parseFloat(style.outlineOffset || '0');
    const rect = element.getBoundingClientRect();
    const ring = {
      bottom: rect.bottom + reach,
      left: rect.left - reach,
      right: rect.right + reach,
      top: rect.top - reach,
    };
    const cut = new Set<string>();
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent === document.body || parent === document.documentElement) break;
      const clip = getComputedStyle(parent);
      if (clip.overflowX === 'visible' && clip.overflowY === 'visible') continue;
      const box = parent.getBoundingClientRect();
      if (ring.top < box.top - 0.5) cut.add('top');
      if (ring.bottom > box.bottom + 0.5) cut.add('bottom');
      if (ring.left < box.left - 0.5) cut.add('left');
      if (ring.right > box.right + 0.5) cut.add('right');
    }
    return [...cut].sort();
  });
}
