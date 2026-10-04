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
  sourcemap: true,
  clean: true,
  splitting: false,
  tsconfig: 'tsconfig.build.json',
  external: ['react', 'react-dom', '@hermesihq/js', '@radix-ui/react-popover'],
  // Everything this package exports that is not a type is a hook, a component, or a thing a component
  // uses, so the whole entry is a client module. Without the directive a Next.js Server Component that
  // imports it dies in the build with `createContext is not a function`: the package is correct in the
  // client graph and unusable in the server one. A banner and not a line in the source, because esbuild
  // drops a module-level directive when it bundles. `verify:package` checks the published files start
  // with it, and `npm run smoke:next` builds a real application that depends on it.
  banner: { js: "'use client';" },
  // `@hermesihq/inbox-ui` is a private workspace package and is not listed above, so tsup bundles
  // it: the code by default, the declarations because `tsconfig.build.json` maps it to its source.
  // `verify:package` fails if either stops being true, since npm has no such package to install.
  dts: true,
})
