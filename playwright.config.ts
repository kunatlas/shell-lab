import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:3001',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:3001/api/bootstrap',
    reuseExistingServer: false,
    env: { SHELL_LAB_RUNTIME: 'local' },
  },
});
