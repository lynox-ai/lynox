import { defineConfig } from '@playwright/test';

// Minimal Playwright config for the local pre-release smoke test.
// Full e2e coverage is out of scope — see tests/smoke/ for the intended
// footprint. Invoked via scripts/smoke-local.sh which brings up the
// docker-compose.smoke.yml stack before running these tests.

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3333';

export default defineConfig({
  testDir: './tests/smoke',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
