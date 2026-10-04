import { defineConfig } from 'vitest/config'

/** `node`, with `globals: false` so every test imports what it uses. The tests talk to a real HTTP server on localhost, not a stub of `fetch`. */
export default defineConfig({
  test: { environment: 'node', globals: false, restoreMocks: true, unstubGlobals: true },
})
