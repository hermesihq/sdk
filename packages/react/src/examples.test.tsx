import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppHeader } from '../examples/app-header'

/**
 * The example in the README, rendered.
 *
 * The integration guide this package used to be documented by gave it a base URL that made
 * every request a 404, and showed the component without the stylesheet import it needs
 * (the bundle never loads its own CSS), so an integrator following it got a widget with no
 * styling. Nothing ever ran that code. So the README embeds `examples/app-header.tsx`
 * verbatim, this test fails if the two drift apart, and the example is rendered here.
 */

afterEach(cleanup)

describe('examples/app-header.tsx', () => {
  it('renders a bell that reports the unread count, from the documented base URL', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requested.push(String(input))
      // The example's own token fetch, then the counts and the list.
      if (String(input) === '/api/hermesi-token') return new Response('st_test', { status: 200 })
      if (String(input).endsWith('/inbox/counts')) return new Response(JSON.stringify({ unread: 2, unseen: 2 }), { status: 200 })
      return new Response(JSON.stringify({ data: [], has_more: false, next_cursor: null }), { status: 200 })
    })

    render(<AppHeader />)

    // The accessible name carries the count, so a screen reader hears it.
    expect(await screen.findByRole('button', { name: /2/ })).toBeTruthy()
    expect(requested).toContain('https://your-hermesi-host/v1/client/inbox/counts')
    // And the example asked *its own backend* for the token, which is the whole security
    // model: the browser never holds a key that can mint one.
    expect(requested).toContain('/api/hermesi-token')
  })
})

describe('the README', () => {
  it('embeds the example exactly as it is on disk', () => {
    // Line endings are normalised on both sides: a Windows checkout with `autocrlf` gives
    // the two files different ones, and that is not drift.
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
    const example = read('../examples/app-header.tsx').trim()
    const readme = read('../README.md')

    expect(readme).toContain(example)
  })

  it('shows the stylesheet import, because the bundle does not load its own CSS', () => {
    // Not observable by rendering: jsdom applies no layout, so a component with no
    // stylesheet looks exactly like one with it. The line is asserted instead, because it
    // is the one an integrator drops when they trim an example, and the result is a panel
    // with no styling and no error to say why.
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

    expect(read('../examples/app-header.tsx')).toContain("import '@hermesihq/react/styles.css'")
  })
})
