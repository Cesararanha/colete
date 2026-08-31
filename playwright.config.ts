import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: '.expo/playwright-results',
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'pt-BR',
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'wide-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: 'npm run serve:web',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
});
