/**
 * Build, pack, install elsewhere, and import: the only check that exercises what npm will
 * actually serve. Run from a package directory (`npm run verify:package -w <package>`).
 *
 * **Why this exists.** Every test and typecheck in this repository resolves a package
 * through the repository's own module graph, so they prove the *source* works and say
 * nothing about the artefact. The entry points in `package.json` (`main`, `module`,
 * `types`, the `exports` map, the `files` list) are only ever resolved by a consumer, on
 * publish day: a `main` pointing at a file `files` does not ship, an `exports` map that
 * forbids a subpath the README documents, declarations that resolve under one
 * `moduleResolution` and not the one the consumer uses. Each installs without a word and
 * fails at `import`.
 *
 * So this runs the real sequence: `npm pack`, a throwaway consumer that installs the
 * tarball, and then the things a consumer does. A package that depends on another package
 * in this repository has that one packed and installed beside it, because that is the only
 * way to test it before the dependency exists on the registry, and it is what a consumer's
 * resolver will be doing after.
 *
 * Deliberately not a vitest file. Vitest resolves through this workspace's own module
 * graph, which is exactly the resolution being distrusted.
 *
 * Per-package input lives next to the package, not here, so a change to what a package
 * promises shows up in that package's own diff:
 *   scripts/expected-exports.json   the runtime names it must export, and no others
 *   scripts/consumer-smoke.ts       a file a TypeScript consumer compiles against it
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PACKAGE_DIR = process.cwd()
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..')
const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'))
const expected = JSON.parse(readFileSync(join(PACKAGE_DIR, 'scripts', 'expected-exports.json'), 'utf8')).runtime
const smoke = readFileSync(join(PACKAGE_DIR, 'scripts', 'consumer-smoke.ts'), 'utf8')

/** Where the package's metadata has to point. A private repository here would ship three
 *  dead links to every consumer, which the first release did. */
const PUBLIC_REPOSITORY = 'git+https://github.com/hermesihq/sdk.git'
const PUBLIC_URL_PREFIX = 'https://github.com/hermesihq/sdk'

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
}

/** Every file in a directory tree, so nothing is checked by a list. */
function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? walkFiles(full) : [full]
  })
}

/** Packages in this repository, by name, so a dependency on one can be found and packed. */
function workspacePackages() {
  const found = new Map()
  for (const name of readdirSync(join(REPO_ROOT, 'packages'))) {
    const file = join(REPO_ROOT, 'packages', name, 'package.json')
    if (existsSync(file)) found.set(JSON.parse(readFileSync(file, 'utf8')).name, join(REPO_ROOT, 'packages', name))
  }
  return found
}

const failures = []
function check(name, fn) {
  try {
    fn()
    console.log(`  ok    ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`  FAIL  ${name}`)
    console.log(`        ${String(error.message).split('\n').slice(0, 8).join('\n        ')}`)
  }
}

/** Packs `dir` into `into` and returns the tarball path. */
function pack(dir, into) {
  const [{ filename }] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', into], dir))
  return join(into, filename)
}

const workspace = mkdtempSync(join(tmpdir(), 'hermesi-pack-'))
const consumer = join(workspace, 'consumer')

try {
  const siblings = workspacePackages()
  const dependencyDirs = Object.keys(manifest.dependencies ?? {})
    .filter((name) => siblings.has(name))
    .map((name) => siblings.get(name))

  console.log('building…')
  for (const dir of dependencyDirs) run('npm', ['run', 'build'], dir)
  run('npm', ['run', 'build'], PACKAGE_DIR)

  console.log('packing…')
  const tarballs = [...dependencyDirs.map((dir) => pack(dir, workspace)), pack(PACKAGE_DIR, workspace)]
  console.log(`installing ${tarballs.map((t) => t.split(/[\\/]/).pop()).join(' + ')} into a throwaway consumer…`)

  mkdirSync(consumer)
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, version: '1.0.0', type: 'module' }, null, 2),
  )
  // Peer dependencies are a consumer's to supply. If this package ever starts importing
  // something it forgot to declare, the install below is where that shows up rather than in
  // someone else's build.
  const peers = Object.keys(manifest.peerDependencies ?? {})
  run('npm', ['install', '--silent', ...tarballs, ...peers], consumer)

  const installed = join(consumer, 'node_modules', ...manifest.name.split('/'))
  const surfaceScript = (load) => `${load}
const declared = ${JSON.stringify(expected)}
const actual = Object.keys(sdk).filter((name) => typeof sdk[name] !== 'undefined')
const missing = declared.filter((name) => sdk[name] === undefined)
const undeclared = actual.filter((name) => !declared.includes(name))
if (missing.length) console.error('missing: ' + missing.join(', '))
if (undeclared.length) console.error('exported but not declared in expected-exports.json: ' + undeclared.join(', '))
if (missing.length || undeclared.length) process.exit(1)
`

  console.log('\nchecking what a consumer can actually do:')

  check('the install has no unmet, invalid or missing dependencies', () => {
    // `npm ls` exits non-zero on a dependency whose range the installed version does not
    // satisfy. For a package depending on a sibling this is the check that the range it
    // publishes is one the sibling's version actually meets.
    run('npm', ['ls', '--all'], consumer)
  })

  check('ESM: the surface is exactly what is declared', () => {
    writeFileSync(join(consumer, 'esm.mjs'), surfaceScript(`import * as sdk from '${manifest.name}'`))
    run('node', ['esm.mjs'], consumer)
  })

  check('CJS: require() sees the same surface', () => {
    // `main` points at a CommonJS build and nothing had ever loaded it. A consumer on
    // CommonJS is not exotic: it is every Next.js config file and every Jest setup.
    writeFileSync(join(consumer, 'cjs.cjs'), surfaceScript(`const sdk = require('${manifest.name}')`))
    run('node', ['cjs.cjs'], consumer)
  })

  for (const subpath of Object.keys(manifest.exports).filter((key) => key !== '.')) {
    check(`the ${subpath} subpath resolves`, () => {
      // An `exports` map is a *closed* list: a subpath it does not name is unreachable
      // however present the file is on disk.
      writeFileSync(
        join(consumer, 'subpath.mjs'),
        `import { createRequire } from 'node:module'\ncreateRequire(import.meta.url).resolve('${manifest.name}/${subpath.slice(2)}')\n`,
      )
      run('node', ['subpath.mjs'], consumer)
    })
  }

  writeFileSync(join(consumer, 'types.ts'), smoke)
  const tsconfig = (module, moduleResolution) =>
    JSON.stringify(
      {
        compilerOptions: { strict: true, noEmit: true, module, moduleResolution, target: 'es2022', jsx: 'react-jsx', skipLibCheck: true },
        include: ['types.ts'],
      },
      null,
      2,
    )
  writeFileSync(join(consumer, 'tsconfig.bundler.json'), tsconfig('esnext', 'bundler'))
  writeFileSync(join(consumer, 'tsconfig.node16.json'), tsconfig('node16', 'node16'))
  run('npm', ['install', '--silent', '--no-save', 'typescript', '@types/react', '@types/react-dom'], consumer)

  check('types resolve under bundler resolution', () => {
    run('npx', ['tsc', '-p', 'tsconfig.bundler.json'], consumer)
  })

  check('types resolve under node16 resolution too', () => {
    // The two disagree often, and they disagree precisely about `exports` maps, which is
    // the thing these packages use.
    run('npx', ['tsc', '-p', 'tsconfig.node16.json'], consumer)
  })

  check('ships no internal ticket or section numbers, in any file', () => {
    // Identifiers from this project's own planning documents (a feature code, a section
    // number) mean nothing to an integrator. They reached the README and the npm
    // description of the first release, and had to be removed from several other
    // surfaces before that.
    // Every shipped file is scanned, not the two that were remembered: the declaration
    // files carry doc comments into an integrator's editor on hover, and the source maps
    // carry the sources.
    const SPEC_REFERENCE = /F-[A-Z]{3}-\d+|§\d+(?:\.\d+)*/g
    const offenders = walkFiles(installed)
      .map((file) => [file, (readFileSync(file, 'utf8').match(SPEC_REFERENCE) ?? []).length])
      .filter(([, count]) => count > 0)
      .map(([file, count]) => `${file.slice(installed.length + 1)}  ${count}`)
    if (offenders.length) throw new Error(offenders.join('\n'))
  })

  check('ships no em dashes', () => {
    // Typography, not correctness, and asked for by name: an em dash reads as a tell of
    // machine-written prose, and these packages are published under the maintainer's name.
    // Checked on the *installed* package, which is how the CSS source map turned up:
    // `files` publishes all of `dist/`, and `sourcesContent` inlines the stylesheet's own
    // comments. Em dashes only: an earlier version also banned the single-character
    // ellipsis and failed on a loading label, which is correct typography. A gate that
    // forbids the right answer is a gate somebody disables.
    const offenders = walkFiles(installed)
      .map((file) => [file, (readFileSync(file, 'utf8').match(/—/g) ?? []).length])
      .filter(([, count]) => count > 0)
      .map(([file, count]) => `${file.slice(installed.length + 1)}  ${count}`)
    if (offenders.length) throw new Error(offenders.join('\n'))
  })

  check('ships a changelog that names the version being published', () => {
    // A changelog that only this repository can read is not a changelog, and one that does
    // not mention the tarball's version tells a consumer the release they installed was
    // not written down, at exactly the moment they were looking it up.
    const changelog = readFileSync(join(installed, 'CHANGELOG.md'), 'utf8')
    if (!changelog.includes(manifest.version)) throw new Error(`CHANGELOG.md does not mention ${manifest.version}`)
  })

  check('its metadata points at the public repository', () => {
    // The first release shipped `repository`, `homepage` and `bugs` pointing at a private
    // repository: three links that were a 404 to every consumer, and no way to read the
    // source or open an issue.
    const problems = []
    if (manifest.repository?.url !== PUBLIC_REPOSITORY) problems.push(`repository.url is ${manifest.repository?.url}`)
    if (!String(manifest.homepage).startsWith(PUBLIC_URL_PREFIX)) problems.push(`homepage is ${manifest.homepage}`)
    if (!String(manifest.bugs).startsWith(PUBLIC_URL_PREFIX)) problems.push(`bugs is ${manifest.bugs}`)
    if (problems.length) throw new Error(problems.join('\n'))
  })
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\n${failures.length} packaging check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log(`\n${manifest.name} ok: what npm would serve installs, imports and typechecks.`)
