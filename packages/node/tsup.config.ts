import { defineConfig } from 'tsup'

/** No runtime dependencies, and no `node:` imports: it needs `fetch` and Web Crypto, which Node 20 and every edge runtime have. */
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'es2022',
})
