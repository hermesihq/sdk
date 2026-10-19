import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'
import type { Plugin } from 'esbuild'
import { defineConfig } from 'tsup'

/**
 * The stylesheets as text, minified. Imported with the plain `text` loader they ship byte for byte, comments and all, and the comments
 * in a stylesheet are explanation for whoever maintains it, not for a page that loads the script. Minified here, in the script build
 * only: the module build hands the stylesheet to the consumer's own bundler, which does the same.
 */
const minifiedCssAsText: Plugin = {
  name: 'minified-css-as-text',
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async ({ path }) => {
      const { code } = await transform(await readFile(path, 'utf8'), { loader: 'css', minify: true })
      return { contents: code, loader: 'text' }
    })
  },
}

/**
 * Two builds of `@hermesihq/element`.
 *
 * **The module** (`index.js`, `index.cjs`): for a bundler. `@hermesihq/js` is a regular dependency
 * and stays external, for the reason the React package gives: a page that also imports it directly
 * must get the same `HermsClient` class. The private `@hermesihq/inbox-ui` is not listed anywhere,
 * so tsup bundles it; the declarations are inlined because `tsconfig.build.json` maps it to its
 * source. `verify:package` fails if either stops being true.
 *
 * **The script** (`hermes-inbox.global.js`): for a `<script>` tag, a CDN, a CMS. One minified
 * classic script with everything in it, `@hermesihq/js` included, that registers `<hermes-inbox>`
 * when it runs and exposes `HermesInbox.defineHermesInbox` for another tag name. There is nothing
 * for a page to resolve, so nothing may stay external. `verify:package` holds its size to the
 * budget in `scripts/size-budget.json`.
 *
 * The stylesheets are imported as text and handed to the shadow root, not extracted: the element
 * carries its own CSS, there is no `styles.css` to forget.
 *
 * Neither config cleans `dist/`: they run together and the second would delete the first's output.
 * `scripts/clean.mjs` empties it once before both.
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: false,
    tsconfig: 'tsconfig.build.json',
    external: ['@hermesihq/js'],
    loader: { '.css': 'text' },
  },
  {
    entry: { 'hermes-inbox': 'src/index.ts' },
    format: ['iife'],
    globalName: 'HermesInbox',
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    minify: true,
    tsconfig: 'tsconfig.build.json',
    noExternal: ['@hermesihq/js'],
    esbuildPlugins: [minifiedCssAsText],
  },
])
