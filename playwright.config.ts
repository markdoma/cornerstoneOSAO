import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  testIgnore: 'bridge.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 12000 },
  use: {
    baseURL: 'http://localhost:3100',
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node --import tsx tests/e2e-server.ts',
      url: 'http://127.0.0.1:4100/test/fixture',
      env: {
        TEST_WEB_ORIGIN: 'http://localhost:3100',
        TEST_WIDGET_ORIGIN: 'http://localhost:4100',
        TEST_LOCAL_API: 'http://127.0.0.1:3102/api',
      },
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: 'npm run dev -w @orchestrator/web -- --port 3100',
      env: {
        AO_NEXT_DIST_DIR: '.next/browser-test',
        API_URL: 'http://127.0.0.1:4100',
        WIDGET_ORIGIN: 'http://localhost:4100',
      },
      url: 'http://localhost:3100',
      reuseExistingServer: false,
      timeout: 90000,
    },
  ],
  reporter: 'list',
});
