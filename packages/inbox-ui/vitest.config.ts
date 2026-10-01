import { defineConfig } from 'vitest/config'

/**
 * `node`, not a browser environment, and that is the point of this package: nothing in it may
 * touch the DOM, because it is shared by a React component and a custom element and must run
 * under either. A test that needs `document` is a test of the wrong package.
 */
export default defineConfig({
  test: { environment: 'node', globals: false, restoreMocks: true },
})
