import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/**
 * `jsdom` because the React bindings render; `globals: false` so every test imports what
 * it uses.
 *
 * Both this package and `@hermesihq/js` resolve to their source here, for the same reason
 * `tsconfig.json` maps them there: a change in either is seen by these tests immediately,
 * and the examples import this package by its published name exactly as a reader copying
 * them would. The published artefact is exercised separately, by `verify:package`.
 *
 * Specific entries come first: the stylesheet is a subpath of this package, and a prefix
 * match on the package name would otherwise send it to the wrong file.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@hermesihq/react/styles.css', replacement: source('../inbox-ui/src/inbox.css') },
      { find: /^@hermesihq\/react$/, replacement: source('./src/index.ts') },
      { find: /^@hermesihq\/js$/, replacement: source('../js/src/index.ts') },
    ],
  },
  test: {
    environment: 'jsdom',
    globals: false,
    restoreMocks: true,
    // The client calls the global `fetch` directly, with no injection point, so tests
    // stub the global and this undoes it between them.
    unstubGlobals: true,
  },
})
