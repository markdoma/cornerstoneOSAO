import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'bridge.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: 'http://localhost:3100',
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node --import tsx tests/bridge-e2e-server.ts',
      url: 'http://127.0.0.1:4100/test/fixture',
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: 'npm run dev -w @orchestrator/web -- --port 3100',
      env: {
        AO_NEXT_DIST_DIR: '.next/mcp-test',
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
