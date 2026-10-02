import { defineConfig } from 'tsup'

/**
 * Build for `@hermesihq/element`.
 *
 * `@hermesihq/js` is a regular dependency and stays external, for the reason the React package
 * gives: a page that also imports it directly must get the same `HermsClient` class. The private
 * `@hermesihq/inbox-ui` is not listed anywhere, so tsup bundles it; the declarations are
 * inlined because `tsconfig.build.json` maps it to its source. `verify:package` fails if either
 * stops being true.
 *
 * The stylesheets are imported as text and handed to the shadow root, not extracted: the
 * element carries its own CSS, there is no `styles.css` to forget.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  tsconfig: 'tsconfig.build.json',
  external: ['@hermesihq/js'],
  loader: { '.css': 'text' },
})
