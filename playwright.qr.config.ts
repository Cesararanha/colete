import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  // Dedicated loopback HTTP harness: WebKit upgrades HTTP assets under the
  // staging server's production upgrade-insecure-requests directive. Production
  // headers stay unchanged; staging tests and cspGuard's Function probe remain.
  webServer: {
    command: 'node_modules/.bin/serve dist --single --listen tcp://127.0.0.1:4173 --no-clipboard',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
  testMatch: 'invite-qr.spec.ts',
  workers: 1,
  use: { ...base.use, trace: 'off', colorScheme: 'dark' },
  projects: [
    { name: 'qr-chromium', use: { ...devices['Pixel 7'], viewport: { width: 320, height: 760 } } },
    { name: 'qr-webkit', use: { ...devices['iPhone 13'], browserName: 'webkit' } },
  ],
});
