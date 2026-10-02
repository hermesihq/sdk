import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

/**
 * Stylesheets are imported as text, as `tsup` does for the published build. Vite would otherwise
 * treat a `.css` import as a stylesheet to inject, and the element needs the string.
 */
const cssAsText: Plugin = {
  name: 'css-as-text',
  enforce: 'pre',
  transform(code, id) {
    if (!id.endsWith('.css')) return null
    return { code: `export default ${JSON.stringify(code)}`, map: null }
  },
}

/**
 * `jsdom` because the element needs `document`, a shadow root and custom elements. jsdom has no
 * Popover API, no layout and no ResizeObserver, so the Popover methods are stubbed by the tests
 * (`src/test/popover.ts`) and everything that depends on a real engine is the end-to-end
 * suite's job.
 */
export default defineConfig({
  plugins: [cssAsText],
  resolve: {
    alias: [{ find: /^@hermesihq\/js$/, replacement: source('../js/src/index.ts') }],
  },
  test: { environment: 'jsdom', globals: false, restoreMocks: true, unstubGlobals: true },
})
