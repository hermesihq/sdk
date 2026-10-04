import { defineConfig } from 'tsup'

/**
 * Two builds of `@hermesihq/js`. No runtime dependencies at all, which is the point of the
 * package: a page that wants an inbox should not have to take React, or anything else, to get one.
 *
 * **The modules** (`index`, and `service-worker` for the worker half of Web Push): for a bundler.
 * `service-worker` is a separate entry because a service worker is a different program from the
 * page, and the page's code has no business in it.
 *
 * **The script** (`service-worker.global.js`): for a service worker that has no build step and
 * loads it with `importScripts`. One minified classic script that installs the push handlers when
 * it runs. `verify:package` holds its size to the budget in `scripts/size-budget.json`.
 *
 * Neither config cleans `dist/`: they run together and the second would delete the first's output.
 * `scripts/clean.mjs` empties it once before both.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'service-worker': 'src/serviceWorker.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: false,
  },
  {
    entry: { 'service-worker': 'src/serviceWorkerGlobal.ts' },
    format: ['iife'],
    globalName: 'HermesiServiceWorker',
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    minify: true,
  },
])
