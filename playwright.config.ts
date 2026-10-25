import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['Carrom/tests/e2e/**/*.spec.ts', '29_Card/tests/e2e/**/*.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 12_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8877',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node Carrom/tests/server.cjs',
      url: 'http://127.0.0.1:8877/Carrom/carrom.html',
      reuseExistingServer: false,
    },
    {
      command: 'node server.js --production --port=8878',
      url: 'http://127.0.0.1:8878/Carrom/carrom.html',
      reuseExistingServer: false,
    },
    {
      command: 'corepack yarn build:engine && node 29_Card/tests/server.cjs',
      url: 'http://127.0.0.1:8879/healthz',
      reuseExistingServer: false,
    },
  ],
});
