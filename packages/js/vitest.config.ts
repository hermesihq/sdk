import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Most suites here run under `node`, not a browser environment, and that is
 * deliberate: this package promises to work on a page with no framework and on a server
 * with no DOM, and a test that runs under jsdom cannot tell you the difference. The few
 * that need a DOM ask for one in their own file.
 *
 * `globals: false`, so every test imports what it uses.
 */
export default defineConfig({
  // The examples import this package by its published name, exactly as a reader copying
  // them would, and that resolves to the source here.
  resolve: {
    alias: { '@hermesihq/js': fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
  },
  test: {
    environment: 'node',
    globals: false,
    restoreMocks: true,
    // `HermsClient` calls the global `fetch` directly, and adding an injection point to
    // the public API to make a test easier is the wrong trade. So the tests stub the
    // global, and this undoes it between them.
    unstubGlobals: true,
  },
})
