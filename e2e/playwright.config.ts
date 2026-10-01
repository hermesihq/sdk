import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 4173)

/**
 * Three engines, because the question this harness exists to answer is "does it behave the same in
 * Chromium, Firefox and WebKit", and everything before it was measured in one.
 *
 * No retries. A test that passes on a second attempt has a bug that is merely hiding, and a retry
 * is how it stays hidden. If one is flaky, it should be seen to be.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server.mjs',
    url: `http://localhost:${PORT}/__health`,
    reuseExistingServer: !process.env.CI,
    env: { E2E_PORT: String(PORT) },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
