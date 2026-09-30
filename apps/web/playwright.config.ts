/**
 * Playwright configuration for the browser E2E suite.
 *
 * Sized for the VM this repository develops on: two ARM64 cores, so parallelism buys
 * nothing and costs flake. Workers are pinned to one and retries are disabled outside
 * CI as well, because a retried browser test hides a real failure rather than fixing
 * it (TESTING.md: do not replay until green). The only place retries are enabled is
 * CI, where the run is not watched.
 *
 * The browser is NOT installed by this configuration. Playwright 1.63.0 pins Chromium
 * revision 1243, which is already present in this host's `~/.cache/ms-playwright` and
 * has been proved to launch headless on this ARM64 CPU. There is deliberately no
 * `webServer` block and no browser-download step, so a run cannot silently reach the
 * network or attach to a server this worktree does not own; `e2e/fixtures.ts` starts an
 * isolated server on an operating-system-assigned port instead.
 *
 * `--no-sandbox` is required on this host: the Chromium sandbox needs privileges the
 * development VM does not grant, and without the flag the browser exits before it opens
 * a page.
 */

import { defineConfig, devices } from '@playwright/test';

/** True in CI, where a run is unattended and a transient flake is worth one retry. */
const IS_CI = process.env['CI'] === 'true';

/**
 * Base URL for `page.goto` with a relative path. Inside this suite the `baseURL` fixture
 * replaces it with the origin the isolated server actually bound; the value here is the
 * development-server default for running the same specs against `pnpm dev`.
 */
const DEV_SERVER_BASE_URL = process.env['SHIPLOOP_DEV_BASE_URL'] ?? 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './e2e',
  // Two cores: one worker, no parallelism, and no retries on a watched machine.
  fullyParallel: false,
  workers: 1,
  retries: IS_CI ? 2 : 0,
  forbidOnly: IS_CI,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL: DEV_SERVER_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    headless: true,
    launchOptions: { args: ['--no-sandbox'] },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});