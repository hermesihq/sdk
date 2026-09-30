import { defineConfig } from 'tsup'

/**
 * Real build for `@hermesihq/react`.
 *
 * `react` and `react-dom` are peer dependencies and must stay external: bundling them in
 * would both bloat the package and risk a second React instance in the consumer's tree.
 * `@hermesihq/js` and `@radix-ui/react-popover` are regular dependencies and are left
 * external too, so npm installs one shared copy of each rather than this bundle
 * vendoring a second one. That matters most for `@hermesihq/js`: a host that also
 * imports it directly must get the same `HermsClient` class, or `instanceof` and the
 * shared real-time connection quietly stop working across the two.
 *
 * CSS: `HermsInbox.tsx` imports its stylesheet as a side effect, which esbuild extracts
 * into `dist/index.css`, the file the `./styles.css` export points at.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  tsconfig: 'tsconfig.build.json',
  external: ['react', 'react-dom', '@hermesihq/js', '@radix-ui/react-popover'],
})
