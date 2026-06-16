import { defineConfig } from '@playwright/test';

process.env.AIEC_REAL_SITE_URL ??= 'http://127.0.0.1:3998';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'opencode-real.spec.ts',
  timeout: 120_000,
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL: process.env.AIEC_REAL_SITE_URL,
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && node dist/local-server.js --port 3998',
    url: process.env.AIEC_REAL_SITE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
