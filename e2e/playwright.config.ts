import { defineConfig, devices } from '@playwright/test'
import type { Flavor } from './tests/fixtures'

const PORT = Number(process.env.E2E_PORT ?? 4173)

const ENGINES = [
  ['chromium', devices['Desktop Chrome']],
  ['firefox', devices['Desktop Firefox']],
  ['webkit', devices['Desktop Safari']],
] as const
const FLAVORS = ['react', 'element'] as const

/**
 * Three engines, because the question this harness exists to answer is "does it behave the same in
 * Chromium, Firefox and WebKit", and everything before it was measured in one.
 *
 * No retries. A test that passes on a second attempt has a bug that is merely hiding, and a retry
 * is how it stays hidden. If one is flaky, it should be seen to be.
 */
export default defineConfig<{ flavor: Flavor }>({
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
  projects: ENGINES.flatMap(([engine, device]) =>
    FLAVORS.map((flavor) => ({
      name: `${engine}-${flavor}`,
      use: { ...device, flavor },
      // The platform probes measure the browser, not our code: once per engine is enough. The
      // element's own cases make no sense for React.
      testIgnore: flavor === 'element' ? /platform\.spec/ : /element\.spec/,
    })),
  ),
})
