/**
 * Bundles the test pages with the packages' BUILT output.
 *
 * The pages import `@hermesihq/react` and `@hermesihq/element` by their published names, which resolves through the
 * workspace to each package's `dist`: the artefact, not the source. That is the point. The
 * source is already covered by unit tests, and the defects worth a real browser (a panel with no
 * styling, a stylesheet that is not loaded) live in what ships. Run `npm run build` at the root
 * first; `npm run e2e` there does it for you.
 */
import { build } from 'esbuild'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const dists = [
  fileURLToPath(new URL('../packages/react/dist/index.js', import.meta.url)),
  fileURLToPath(new URL('../packages/element/dist/index.js', import.meta.url)),
]

for (const dist of dists) {
  if (!existsSync(dist)) {
    console.error(`${dist} is missing. Run \`npm run build\` at the repository root first.`)
    process.exit(1)
  }
}

// The `<script>`-tag build is served as the file it is: copied, not bundled again.
const script = fileURLToPath(new URL('../packages/element/dist/hermes-inbox.global.js', import.meta.url))
if (!existsSync(script)) {
  console.error(`${script} is missing. Run \`npm run build\` at the repository root first.`)
  process.exit(1)
}
mkdirSync(`${root}dist`, { recursive: true })
copyFileSync(script, `${root}dist/hermes-inbox.global.js`)

await build({
  absWorkingDir: root,
  entryPoints: { 'react-inbox': 'pages/react-inbox.tsx', 'element-inbox': 'pages/element-inbox.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: true,
  logLevel: 'info',
})
