/**
 * Builds and runs a real Next.js App Router application against the packages as npm would serve
 * them (packed tarballs, not this repository's module graph).
 *
 * **Why this exists.** The React package is only ever exercised here under Vitest and in plain
 * Vite pages. Next.js splits an application into a server graph and a client graph, and a package
 * that is correct in both of those can still be unusable in the third thing: a Server Component
 * that imports it. The only check that can tell is a real `next build`, so this is one.
 *
 * The application is the shape most integrations take:
 *   app/providers.tsx        'use client'. Makes the client and the provider (a client holds
 *                            functions, so it can only be made on the client side).
 *   app/layout.tsx           a Server Component that wraps the page in the provider.
 *   app/page.tsx             a Server Component that renders <HermsInbox /> directly, with no
 *                            'use client' of its own. This is what fails without the directive.
 *   app/api/token/route.ts   a Route Handler that mints a subscriber token with @hermesihq/node.
 *   app/api/edge-token/...   the same on Next's Edge runtime, which has Web Crypto and no node:.
 *
 * Run: `npm run smoke:next` (needs network, for next). `--next=14` picks the Next.js major (default 16);
 * 14 runs on React 18, 15 and 16 on React 19. `--bundler=webpack` builds a Next 16 application with
 * webpack instead of Turbopack, its default; earlier majors build with webpack, the only bundler
 * their production build has.
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split('=')[1]
const NEXT_MAJOR = Number(arg('next', '16'))
const REACT_MAJOR = NEXT_MAJOR >= 15 ? 19 : 18
const PORT = 3217
const bundler = NEXT_MAJOR >= 16 ? arg('bundler', 'turbopack') : 'webpack'

const shell = process.platform === 'win32'
function run(command, args, cwd, env = {}) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', shell, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const workspace = mkdtempSync(join(tmpdir(), 'hermesi-next-'))
const app = join(workspace, 'app-under-test')
let server

function files(map) {
  for (const [path, content] of Object.entries(map)) {
    const full = join(app, path)
    mkdirSync(resolve(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
}

try {
  console.log('building the packages…')
  run('npm', ['run', 'build'], ROOT)

  console.log('packing…')
  const tarballs = ['js', 'react', 'node'].map((name) => {
    const [{ filename }] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', workspace], join(ROOT, 'packages', name)))
    return join(workspace, filename)
  })

  mkdirSync(app)
  files({
    'package.json': JSON.stringify({ name: 'app-under-test', private: true, version: '1.0.0' }, null, 2),
    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2017', lib: ['dom', 'dom.iterable', 'esnext'], allowJs: true, skipLibCheck: true, strict: true, noEmit: true,
          esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', resolveJsonModule: true, isolatedModules: true,
          jsx: 'react-jsx', incremental: true, plugins: [{ name: 'next' }],
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts', '.next/dev/types/**/*.ts'],
        exclude: ['node_modules'],
      },
      null, 2,
    ),
    'app/providers.tsx': `'use client'
import { useMemo, type ReactNode } from 'react'
import { HermsClient, HermsProvider } from '@hermesihq/react'

export function Providers({ children }: { children: ReactNode }) {
  const client = useMemo(
    () =>
      new HermsClient({
        apiBaseUrl: '/api/hermesi',
        publicKey: 'hm_pk_smoke',
        getSubscriberToken: async () => (await (await fetch('/api/token')).json()).token,
      }),
    [],
  )
  return <HermsProvider client={client}>{children}</HermsProvider>
}
`,
    'app/layout.tsx': `import '@hermesihq/react/styles.css'
import type { ReactNode } from 'react'
import { Providers } from './providers'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
`,
    'app/page.tsx': `import { HermsInbox } from '@hermesihq/react'

// A Server Component: no 'use client' here. Rendering the inbox from it is the point of this app.
export default function Page() {
  return (
    <main>
      <h1>Smoke</h1>
      <HermsInbox />
    </main>
  )
}
`,
    'app/api/token/route.ts': `import { Hermesi } from '@hermesihq/node'

export const dynamic = 'force-dynamic'

export async function GET() {
  const hermesi = new Hermesi({ apiKey: 'hm_sk_smoke_key', baseUrl: 'https://hermesi.invalid' })
  return Response.json({ token: await hermesi.tokens.mint('user_1', { environmentId: 'env_smoke' }) })
}
`,
    'app/api/edge-token/route.ts': `import { Hermesi } from '@hermesihq/node'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

export async function GET() {
  const hermesi = new Hermesi({ apiKey: 'hm_sk_smoke_key', baseUrl: 'https://hermesi.invalid' })
  return Response.json({ token: await hermesi.tokens.mint('user_1', { environmentId: 'env_smoke' }) })
}
`,
  })

  console.log(`installing next@${NEXT_MAJOR} (React ${REACT_MAJOR}) and the tarballs…`)
  run('npm', ['install', '--silent', ...tarballs, `next@${NEXT_MAJOR}`, `react@${REACT_MAJOR}`, `react-dom@${REACT_MAJOR}`, 'typescript@6', `@types/react@${REACT_MAJOR}`, `@types/react-dom@${REACT_MAJOR}`, '@types/node'], app)

  console.log(`next ${NEXT_MAJOR} build (${bundler})…`)
  const nextBin = join(app, 'node_modules', 'next', 'dist', 'bin', 'next')
  try {
    const flags = NEXT_MAJOR >= 16 ? [bundler === 'webpack' ? '--webpack' : '--turbopack'] : []
    run('node', [nextBin, 'build', ...flags], app, { NEXT_TELEMETRY_DISABLED: '1' })
  } catch (error) {
    console.log(String(error.stdout ?? '').split('\n').slice(-40).join('\n'))
    console.log(String(error.stderr ?? '').split('\n').slice(-40).join('\n'))
    throw new Error('next build failed')
  }

  console.log('next start…')
  server = spawn('node', [nextBin, 'start', '-p', String(PORT)], { cwd: app, stdio: 'ignore', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } })
  const base = `http://127.0.0.1:${PORT}`
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(base)).ok) break } catch { /* not up yet */ }
    await sleep(500)
  }

  const failures = []
  const check = async (name, fn) => {
    try { await fn(); console.log(`  ok    ${name}`) } catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message}`) }
  }
  const payloadOf = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))

  console.log('\nchecking the running application:')
  await check('the page, a Server Component, renders the inbox on the server', async () => {
    const html = await (await fetch(base)).text()
    if (!html.includes('herms-inbox')) throw new Error('no herms-inbox markup in the server-rendered HTML')
  })
  await check('a Route Handler mints a subscriber token with @hermesihq/node', async () => {
    const { token } = await (await fetch(`${base}/api/token`)).json()
    const claims = payloadOf(token)
    if (claims.sub !== 'user_1' || claims.env !== 'env_smoke') throw new Error(JSON.stringify(claims))
  })
  await check('the same on the Edge runtime (Web Crypto, no node: modules)', async () => {
    const response = await fetch(`${base}/api/edge-token`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const { token } = await response.json()
    const claims = payloadOf(token)
    if (claims.sub !== 'user_1') throw new Error(JSON.stringify(claims))
  })
  if (failures.length) throw new Error(`${failures.length} check(s) failed: ${failures.join(', ')}`)
  console.log('\nnext smoke ok: a real Next.js application builds and serves the packages as npm would.')
} finally {
  server?.kill()
  await sleep(500)
  try { rmSync(workspace, { recursive: true, force: true }) } catch { /* a still-open file on Windows; it is a temp dir */ }
}
