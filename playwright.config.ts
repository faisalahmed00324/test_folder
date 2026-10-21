import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
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
      command: 'node tests/support/server.cjs',
      url: 'http://127.0.0.1:8877/carrom.html',
      reuseExistingServer: false,
    },
    {
      command: 'node server.js --production --port=8878',
      url: 'http://127.0.0.1:8878/carrom.html',
      reuseExistingServer: false,
    },
  ],
});
