import type { ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HermsClient } from '@hermesihq/js'
import { HermsApiError, type HermsEventListener } from '@hermesihq/js'
import { HermsProvider } from './HermsProvider'
import { useInbox } from './useInbox'

/**
 * `useInbox` is the headless list a host builds its own inbox UI on, and the part of
 * this package that holds state rather than reflecting it. The rule it has to keep is
 * that the SDK reflects server decisions, it does not make them. So every
 * mutation here goes to the server first and patches local state with what came back —
 * these cases assert that order, because an optimistic-only update is a UI that
 * disagrees with the inbox on the next page load.
 *
 * Requests go through a real `HermsClient` against a stubbed global `fetch`, so the
 * snake_case-to-camelCase mapping and the cursor round-trip are exercised on the way,
 * rather than a mock client that would agree with whatever the hook expects.
 */

afterEach(cleanup)

interface WireItem {
  id: string
  title: string
  body: string
  action_url: string | null
  category: { key: string; name: string } | null
  seen_at: string | null
  read_at: string | null
  created_at: string
}

function wireItem(id: string, overrides: Partial<WireItem> = {}): WireItem {
  return {
    id,
    title: `Notification ${id}`,
    body: `Body of ${id}`,
    action_url: null,
    category: null,
    seen_at: null,
    read_at: null,
    created_at: '2026-09-01T09:00:00Z',
    ...overrides,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function page(items: WireItem[], nextCursor: string | null = null): Response {
  return json({ data: items, has_more: nextCursor !== null, next_cursor: nextCursor })
}

interface Recorded {
  route: string
  query: URLSearchParams
  body: unknown
}

interface Harness {
  wrapper: ({ children }: { children: ReactNode }) => ReactNode
  emit: (event: Parameters<HermsEventListener>[0]) => void
  calls: Recorded[]
}

/** `respond` is keyed on `"<METHOD> <pathname>"`, which is how the API documents itself. */
function harness(respond: (call: Recorded) => Response): Harness {
  const calls: Recorded[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const call: Recorded = {
      route: `${init?.method ?? 'GET'} ${url.pathname}`,
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    }
    calls.push(call)
    return respond(call)
  })

  const client = new HermsClient({
    apiBaseUrl: 'https://api.example.test/v1/client',
    publicKey: 'hm_pk_test_abc',
    getSubscriberToken: () => 'st_test',
  })
  let listener: HermsEventListener = () => {}
  vi.spyOn(client, 'subscribe').mockImplementation((incoming) => {
    listener = incoming
    return () => {}
  })

  return {
    wrapper: ({ children }) => <HermsProvider client={client}>{children}</HermsProvider>,
    emit: (event) => {
      act(() => listener(event))
    },
    calls,
  }
}

describe('loading the list', () => {
  it('loads the first page on mount', async () => {
    const { wrapper } = harness(() => page([wireItem('inb_1'), wireItem('inb_2')]))

    const { result } = renderHook(() => useInbox(), { wrapper })

    // `isLoading` starts true so a consumer's skeleton renders on the first paint
    // rather than an empty state that flashes into a list.
    expect(result.current.isLoading).toBe(true)
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.items.map((item) => item.id)).toEqual(['inb_1', 'inb_2'])
    expect(result.current.error).toBeNull()
  })

  it('passes the status and category filters to the API', async () => {
    const { wrapper, calls } = harness(() => page([]))

    renderHook(() => useInbox({ status: 'unread', category: 'billing' }), { wrapper })

    await waitFor(() => expect(calls).toHaveLength(1))
    // A filter dropped on the way to the server produces a list that looks right and is
    // wrong — the consumer asked for unread and got everything.
    expect(calls[0]?.query.get('read')).toBe('false')
    expect(calls[0]?.query.get('category')).toBe('billing')
  })

  it('reloads when the filter changes', async () => {
    const { wrapper, calls } = harness((call) => page([wireItem(call.query.get('read') === 'false' ? 'inb_unread' : 'inb_any')]))

    const { result, rerender } = renderHook(({ status }: { status?: 'read' | 'unread' }) => useInbox({ status }), {
      wrapper,
      initialProps: {} as { status?: 'read' | 'unread' },
    })
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    rerender({ status: 'unread' })

    // A consumer's tab switcher changes the options object, not the component — if the
    // hook ignored that, the tabs would all show the first tab's rows.
    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['inb_unread']))
    expect(calls).toHaveLength(2)
  })

  it('surfaces a failed load as an error the consumer can render', async () => {
    const { wrapper } = harness(() => json({ error: { code: 'subscriber_token_invalid', message: 'Token rejected.' } }, 401))

    const { result } = renderHook(() => useInbox(), { wrapper })

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.isLoading).toBe(false)
    // Passed through as-is rather than flattened to a string: a host that wants to
    // re-mint a token on `subscriber_token_invalid` needs the code, and `<HermsInbox />`
    // only needs to know that it is non-null.
    expect(result.current.error).toBeInstanceOf(HermsApiError)
    expect(result.current.items).toEqual([])
  })

  it('clears the error when a retry succeeds', async () => {
    let attempt = 0
    const { wrapper } = harness(() => {
      attempt += 1
      return attempt === 1 ? new Response(null, { status: 500 }) : page([wireItem('inb_1')])
    })
    const { result } = renderHook(() => useInbox(), { wrapper })
    await waitFor(() => expect(result.current.error).not.toBeNull())

    // What the panel's Retry button calls. A stale error left behind would keep the
    // error state on screen over a list that had loaded fine.
    act(() => result.current.refetch())

    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['inb_1']))
    expect(result.current.error).toBeNull()
  })
})

describe('pagination', () => {
  it('appends the next page and carries the cursor the server gave it', async () => {
    const { wrapper, calls } = harness((call) => (call.query.get('cursor') ? page([wireItem('inb_3')]) : page([wireItem('inb_1')], 'cur_2')))
    const { result } = renderHook(() => useInbox(), { wrapper })
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    act(() => result.current.loadMore())

    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['inb_1', 'inb_3']))
    // Appended, never replaced, and the cursor is the server's opaque value rather than
    // an offset this package invents.
    expect(calls[1]?.query.get('cursor')).toBe('cur_2')
    // The last page said there is nothing after it, so the consumer's button goes away.
    expect(result.current.hasMore).toBe(false)
  })

  it('does nothing when there is no next page', async () => {
    // Any second request answers with a *different* row, so a request that should not
    // have happened shows up as a duplicated list rather than as a race on a counter.
    let listReads = 0
    const { wrapper, calls } = harness(() => {
      listReads += 1
      return page([wireItem(listReads === 1 ? 'inb_1' : 'inb_2')])
    })
    const { result } = renderHook(() => useInbox(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // Long enough for a request to have been made and answered, had one been made.
    await act(async () => {
      result.current.loadMore()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    // Guards against a consumer wiring `loadMore` to a scroll handler, where a
    // cursor-less request would re-fetch page one and duplicate every row.
    expect(calls).toHaveLength(1)
    expect(result.current.items.map((item) => item.id)).toEqual(['inb_1'])
  })
})

describe('mutations', () => {
  it('patches the row the server returned instead of refetching the list', async () => {
    const { wrapper, calls } = harness((call) =>
      call.route.endsWith('/read')
        ? json(wireItem('inb_1', { read_at: '2026-09-01T10:00:00Z' }))
        : page([wireItem('inb_1'), wireItem('inb_2')]),
    )
    const { result } = renderHook(() => useInbox(), { wrapper })
    await waitFor(() => expect(result.current.items).toHaveLength(2))

    await act(async () => {
      await result.current.markRead('inb_1')
    })

    // The updated row comes from the response, so `readAt` is the server's timestamp —
    // and the untouched row keeps its identity, so React does not re-render the world.
    expect(result.current.items[0]?.readAt).toBe('2026-09-01T10:00:00Z')
    expect(result.current.items[1]?.readAt).toBeNull()
    // One list read, one write. A refetch-after-every-write hook turns a panel with ten
    // rows into eleven requests.
    expect(calls.filter((call) => call.route === 'GET /v1/client/inbox')).toHaveLength(1)
  })

  it('marks every unread row read at once', async () => {
    const { wrapper } = harness((call) =>
      call.route.endsWith('/read-all')
        ? json({ updated: 1 })
        : page([wireItem('inb_1'), wireItem('inb_2', { read_at: '2026-08-01T00:00:00Z' })]),
    )
    const { result } = renderHook(() => useInbox(), { wrapper })
    await waitFor(() => expect(result.current.items).toHaveLength(2))

    await act(async () => {
      await result.current.markAllRead()
    })

    expect(result.current.items[0]?.readAt).not.toBeNull()
    // The already-read row keeps its original timestamp: this is "mark the unread ones
    // read", not "restamp everything to now", and the timestamp is displayed.
    expect(result.current.items[1]?.readAt).toBe('2026-08-01T00:00:00Z')
  })

  it('takes an archived row out of the feed', async () => {
    const { wrapper } = harness((call) => (call.route.endsWith('/archive') ? json(wireItem('inb_1')) : page([wireItem('inb_1'), wireItem('inb_2')])))
    const { result } = renderHook(() => useInbox(), { wrapper })
    await waitFor(() => expect(result.current.items).toHaveLength(2))

    await act(async () => {
      await result.current.archive('inb_1')
    })

    // Archiving is an exit from the default feed, not a flag shown within it.
    // Leaving the row visible would make the button look broken until a reload.
    expect(result.current.items.map((item) => item.id)).toEqual(['inb_2'])
  })

  it('takes a deleted row out of the feed', async () => {
    const { wrapper } = harness((call) => (call.route.startsWith('DELETE') ? new Response(null, { status: 204 }) : page([wireItem('inb_1'), wireItem('inb_2')])))
    const { result } = renderHook(() => useInbox(), { wrapper })
    await waitFor(() => expect(result.current.items).toHaveLength(2))

    await act(async () => {
      await result.current.remove('inb_2')
    })

    expect(result.current.items.map((item) => item.id)).toEqual(['inb_1'])
  })

  it('lets a failed mutation reject instead of lying about it', async () => {
    const { wrapper } = harness((call) => (call.route.endsWith('/archive') ? new Response(null, { status: 409 }) : page([wireItem('inb_1')])))
    const { result } = renderHook(() => useInbox(), { wrapper })
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    // The server decides; the SDK reflects. A mutation that swallowed the failure and
    // removed the row anyway would show an inbox that the next page load contradicts.
    await expect(result.current.archive('inb_1')).rejects.toBeInstanceOf(HermsApiError)
    expect(result.current.items).toHaveLength(1)
  })
})

describe('live updates', () => {
  it('shows a new notification immediately, then replaces it with the full row', async () => {
    let listReads = 0
    const { wrapper, emit } = harness(() => {
      listReads += 1
      return listReads === 1 ? page([wireItem('inb_old')]) : page([wireItem('inb_new', { body: 'The authoritative body.' }), wireItem('inb_old')])
    })
    const { result } = renderHook(() => useInbox(), { wrapper })
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    emit({ type: 'item.created', data: { id: 'inb_new', title: 'Shipped', created_at: '2026-09-01T10:00:00Z' } })

    // Instantly, from the frame alone: the `item.created` payload is deliberately
    // minimal, so the row is real but partial (no body, no category, no action url).
    expect(result.current.items[0]?.id).toBe('inb_new')
    expect(result.current.items[0]?.body).toBe('')

    // Then reconciled against a fresh first page, in place: no spinner, no reordering,
    // and the rows below it are not disturbed.
    await waitFor(() => expect(result.current.items[0]?.body).toBe('The authoritative body.'))
    expect(result.current.items.map((item) => item.id)).toEqual(['inb_new', 'inb_old'])
  })

  it('does not duplicate a row it already has', async () => {
    const { wrapper, emit } = harness(() => page([wireItem('inb_1')]))
    const { result } = renderHook(() => useInbox(), { wrapper })
    await waitFor(() => expect(result.current.items).toHaveLength(1))

    // Redelivery is normal on a reconnecting stream, and the reconciliation refetch can
    // race the frame that triggered it. Either would otherwise render the same
    // notification twice, with duplicate React keys.
    emit({ type: 'item.created', data: { id: 'inb_1', title: 'Notification inb_1', created_at: '2026-09-01T09:00:00Z' } })

    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['inb_1']))
  })

  it('ignores a counts.changed frame, which is not its concern', async () => {
    const { wrapper, emit, calls } = harness(() => page([wireItem('inb_1')]))
    const { result } = renderHook(() => useInbox(), { wrapper })
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    const before = calls.length

    // The server sends `counts.changed` after every `item.created` (and on reads
    // elsewhere). Refetching the list on it too would double the request cost of every
    // notification, for a frame that carries nothing this hook renders.
    emit({ type: 'counts.changed', data: { unread: 4, unseen: 4 } })

    expect(calls).toHaveLength(before)
    expect(result.current.items).toHaveLength(1)
  })
})
