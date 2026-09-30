import { defineConfig } from 'tsup'

/**
 * Real build for `@hermesihq/js`. No runtime dependencies at all, which is the point of
 * the package: a page that wants an inbox should not have to take React, or anything
 * else, to get one.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
})
