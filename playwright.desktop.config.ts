import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/desktop',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:3016/api/bootstrap',
    reuseExistingServer: false,
    timeout: 30_000,
    env: { SHELL_LAB_RUNTIME: 'local', PORT: '3016' },
  },
});
