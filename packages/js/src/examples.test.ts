// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountUnreadBadge } from '../examples/unread-badge'

/**
 * The example in the README, run.
 *
 * Documentation that shows code nobody has executed is the defect this repository keeps
 * finding: the API guide gave this package a base URL that made every request a 404, and
 * nothing ever ran it. So the README embeds `examples/unread-badge.ts` verbatim, this test
 * fails if the two drift apart, and the example is driven here against a stubbed network.
 *
 * It runs under `node` with no DOM, which is the claim: a page with no framework is
 * exactly a page with no framework, and a runtime with no `EventSource` takes the polling
 * path.
 */

afterEach(() => {
  vi.useRealTimers()
})

function stubCounts(counts: { unread: number; unseen: number }[]) {
  const requested: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    requested.push(String(input))
    const next = counts.shift() ?? { unread: 0, unseen: 0 }
    return new Response(JSON.stringify(next), { status: 200 })
  })
  return requested
}

describe('examples/unread-badge.ts', () => {
  it('shows the count, keeps it live, and stops cleanly', async () => {
    vi.useFakeTimers()
    const requested = stubCounts([{ unread: 3, unseen: 3 }, { unread: 5, unseen: 5 }])
    const badge: { textContent: string | null } = { textContent: null }

    const stop = mountUnreadBadge(badge, async () => 'st_test')
    await vi.advanceTimersByTimeAsync(0)

    // The first read, from the base URL the example documents. A base URL missing its
    // `/v1/client` suffix was the mistake the API guide made.
    expect(requested[0]).toBe('https://your-hermesi-host/v1/client/inbox/counts')
    expect(badge.textContent).toBe('3')

    // No `EventSource` here, so the client polls, and the badge follows.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(badge.textContent).toBe('5')

    stop()
    // Stopping releases the connection and the timer, or a page that mounts and
    // unmounts a badge on every route change leaks one of each per visit.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows nothing for a count of zero', async () => {
    vi.useFakeTimers()
    stubCounts([{ unread: 0, unseen: 0 }])
    const badge: { textContent: string | null } = { textContent: 'stale' }

    const stop = mountUnreadBadge(badge, async () => 'st_test')
    await vi.advanceTimersByTimeAsync(0)

    // An empty badge, not a "0" that says nothing is waiting in a red circle.
    expect(badge.textContent).toBe('')
    stop()
  })
})

describe('the README', () => {
  it('embeds the example exactly as it is on disk', () => {
    // The README is a copy of a file that is run by the test above. If somebody edits one,
    // this fails until the other is brought back into line, so the code a reader copies
    // out of the README is always code that was executed.
    // Line endings are normalised on both sides: a Windows checkout with `autocrlf` gives
    // the two files different ones, and that is not drift.
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
    const example = read('../examples/unread-badge.ts').trim()
    const readme = read('../README.md')

    expect(readme).toContain(example)
  })
})
