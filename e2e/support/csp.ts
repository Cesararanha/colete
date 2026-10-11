import { expect, test as base, type BrowserContext } from '@playwright/test';
export * from '@playwright/test';

export const test = base.extend<{ cspGuard: void }>({
  cspGuard: [
    async ({ context, browser }, use, testInfo) => {
      const violations: string[] = [];
      const functionCalls: number[] = [];
      const install = async (target: BrowserContext) => {
        await target.exposeBinding('__coleteCspViolation', (_, directive: string) => {
          violations.push(directive);
        });
        await target.exposeBinding('__coleteFunctionCall', () => {
          functionCalls.push(1);
        });
        await target.addInitScript(() => {
          const reports = window as unknown as {
            __coleteCspViolation: (directive: string) => Promise<void>;
            __coleteFunctionCall: () => Promise<void>;
          };
          document.addEventListener('securitypolicyviolation', (event) => {
            void reports.__coleteCspViolation(`${event.effectiveDirective} / ${event.blockedURI}`);
          });
          // Call through unchanged: observe the production app's initialization and schemas.
          const original = window.Function;
          window.Function = new Proxy(original, {
            apply(target, thisArg, args) {
              void reports.__coleteFunctionCall();
              return Reflect.apply(target, thisArg, args);
            },
            construct(target, args, newTarget) {
              void reports.__coleteFunctionCall();
              return Reflect.construct(target, args, newTarget);
            },
          });
        });
        target.on('console', (message) => {
          if (
            /content security policy|violates.*(?:script-src|style-src|connect-src)|refused to.*(?:load|execute|apply|connect)/i.test(
              message.text(),
            )
          )
            violations.push('console CSP violation');
        });
      };
      await install(context);
      // Auth tests create extra contexts; install before their first navigation too.
      const original = browser.newContext;
      browser.newContext = async (...args) => {
        const next = await original.apply(browser, args);
        await install(next);
        return next;
      };
      try {
        await use();
      } finally {
        browser.newContext = original;
      }
      await testInfo.attach('csp-violations', {
        body: JSON.stringify({ violations, functionCalls: functionCalls.length }),
        contentType: 'application/json',
      });
      expect(violations, 'CSP violations across all browser contexts').toEqual([]);
      expect(
        functionCalls,
        'Function constructor calls during app initialization and schema use',
      ).toHaveLength(0);
    },
    { auto: true },
  ],
});
