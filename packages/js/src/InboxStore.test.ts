// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { InboxStore } from './InboxStore'
import { HermsApiError } from './types'
import { deferred, flush, harness, json, page, recordSnapshots, until, wireItem } from './storeHarness'

/**
 * `InboxStore` is the list state a host builds its inbox UI on, and it runs here on a
 * runtime with no DOM at all: this file overrides the environment for itself (the
 * docblock above) so a store that quietly reached for `window` would fail loudly rather
 * than pass under jsdom and take down a Vue or vanilla page.
 *
 * Most of these cases are the ones the React hook was specified by, moved down a layer
 * unchanged in what they assert. The generation cases at the end are new: they pin a
 * defect the hook had (a further page for the *old* filter landing in the *new* list),
 * which the store fixes by construction.
 *
 * The rule under all of it is the SDK's: it reflects server decisions, it does not make
 * them. Every mutation goes to the server first and patches local state with what came
 * back, because an optimistic-only update is a UI that disagrees with the inbox on the
 * next page load.
 */

const ids = (store: InboxStore): string[] => store.getSnapshot().items.map((item) => item.id)

describe('loading the list', () => {
  it('starts loading, then holds what the server returned', async () => {
    const { session } = harness(() => page([wireItem('inb_1'), wireItem('inb_2')]))
    const store = new InboxStore(session)

    // `isLoading` is true before anything has been asked, so a skeleton renders on the
    // first paint rather than an empty state that flashes into a list.
    expect(store.getSnapshot().isLoading).toBe(true)
    store.connect()
    await until(store, (s) => !s.isLoading)

    expect(ids(store)).toEqual(['inb_1', 'inb_2'])
    expect(store.getSnapshot().error).toBeNull()
  })

  it('passes the status and category filters to the API', async () => {
    const { session, calls } = harness(() => page([]))
    const store = new InboxStore(session, { status: 'unread', category: 'billing' })

    store.connect()
    await until(store, (s) => !s.isLoading)

    // A filter dropped on the way to the server produces a list that looks right and is
    // wrong: the consumer asked for unread and got everything.
    expect(calls[0]?.query.get('read')).toBe('false')
    expect(calls[0]?.query.get('category')).toBe('billing')
  })

  it('reloads when the filter changes, keeping the old rows until the new ones land', async () => {
    const { session, calls } = harness((call) =>
      page([wireItem(call.query.get('read') === 'false' ? 'inb_unread' : 'inb_any')]),
    )
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => !s.isLoading)

    store.setFilter({ status: 'unread' })

    // What a tab switcher wants: the panel does not blank between tabs. The rows shown
    // are the previous tab's until the new first page arrives, flagged as loading.
    expect(store.getSnapshot().isLoading).toBe(true)
    expect(ids(store)).toEqual(['inb_any'])

    await until(store, (s) => !s.isLoading)
    expect(ids(store)).toEqual(['inb_unread'])
    expect(calls).toHaveLength(2)
  })

  it('does not reload for a filter that has not changed', async () => {
    const { session, calls } = harness(() => page([wireItem('inb_1')]))
    const store = new InboxStore(session, { status: 'unread' })
    store.connect()
    await until(store, (s) => !s.isLoading)

    // A binding calls this on every render. Paying a request for each would turn a
    // re-render into a network call.
    store.setFilter({ status: 'unread' })
    await flush()

    expect(calls).toHaveLength(1)
  })

  it('uses a filter set before it connected, and asks only once', async () => {
    const { session, calls } = harness(() => page([]))
    const store = new InboxStore(session)

    store.setFilter({ status: 'read' })
    store.connect()
    await until(store, (s) => !s.isLoading)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.query.get('read')).toBe('true')
  })

  it('surfaces a failed load as an error the consumer can render', async () => {
    const { session } = harness(() =>
      json({ error: { code: 'subscriber_token_invalid', message: 'Token rejected.' } }, 401),
    )
    const store = new InboxStore(session)

    store.connect()
    await until(store, (s) => s.error !== null)

    expect(store.getSnapshot().isLoading).toBe(false)
    // Passed through as-is rather than flattened to a string: a host that wants to
    // re-mint a token on `subscriber_token_invalid` needs the code.
    expect(store.getSnapshot().error).toBeInstanceOf(HermsApiError)
    expect(ids(store)).toEqual([])
  })

  it('clears the error when a retry succeeds', async () => {
    let attempt = 0
    const { session } = harness(() => {
      attempt += 1
      return attempt === 1 ? new Response(null, { status: 500 }) : page([wireItem('inb_1')])
    })
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.error !== null)

    // What the panel's Retry button calls. A stale error left behind would keep the
    // error state on screen over a list that had loaded fine.
    store.refetch()

    await until(store, (s) => s.items.length === 1)
    expect(store.getSnapshot().error).toBeNull()
  })
})

describe('pagination', () => {
  it('appends the next page and carries the cursor the server gave it', async () => {
    const { session, calls } = harness((call) =>
      call.query.get('cursor') ? page([wireItem('inb_3')]) : page([wireItem('inb_1')], 'cur_2'),
    )
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.hasMore)

    store.loadMore()
    await until(store, (s) => s.items.length === 2)

    // Appended, never replaced, and the cursor is the server's opaque value rather than
    // an offset this package invents.
    expect(ids(store)).toEqual(['inb_1', 'inb_3'])
    expect(calls[1]?.query.get('cursor')).toBe('cur_2')
    expect(store.getSnapshot().hasMore).toBe(false)
  })

  it('does nothing when there is no next page', async () => {
    // Any second request answers with a *different* row, so a request that should not
    // have happened shows up as a changed list rather than as a race on a counter.
    let listReads = 0
    const { session, calls } = harness(() => {
      listReads += 1
      return page([wireItem(listReads === 1 ? 'inb_1' : 'inb_2')])
    })
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => !s.isLoading)

    store.loadMore()
    await flush()

    // Guards a consumer wiring `loadMore` to a scroll handler, where a cursor-less
    // request would re-fetch page one and duplicate every row.
    expect(calls).toHaveLength(1)
    expect(ids(store)).toEqual(['inb_1'])
  })

  it('does not start a second page request while one is in flight', async () => {
    const held = deferred()
    const { session, calls } = harness((call) =>
      call.query.get('cursor') ? held.promise : page([wireItem('inb_1')], 'cur_2'),
    )
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.hasMore)

    // A scroll handler fires many times a second.
    store.loadMore()
    store.loadMore()
    store.loadMore()
    await flush()

    expect(calls.filter((call) => call.query.get('cursor'))).toHaveLength(1)
    held.resolve(page([wireItem('inb_2')]))
    await until(store, (s) => !s.isLoadingMore)
  })
})

describe('mutations', () => {
  it('patches the row the server returned instead of refetching the list', async () => {
    const { session, calls } = harness((call) =>
      call.route.endsWith('/read')
        ? json(wireItem('inb_1', { read_at: '2026-09-01T10:00:00Z' }))
        : page([wireItem('inb_1'), wireItem('inb_2')]),
    )
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.items.length === 2)
    const untouched = store.getSnapshot().items[1]

    await store.markRead('inb_1')

    // The updated row comes from the response, so `readAt` is the server's timestamp,
    // and the untouched row keeps its identity so a UI does not re-render the world.
    expect(store.getSnapshot().items[0]?.readAt).toBe('2026-09-01T10:00:00Z')
    expect(store.getSnapshot().items[1]).toBe(untouched)
    // One list read, one write. A refetch after every write turns a panel with ten rows
    // into eleven requests.
    expect(calls.filter((call) => call.route === 'GET /v1/client/inbox')).toHaveLength(1)
  })

  it('marks every unread row read at once, leaving read rows as they were', async () => {
    const { session } = harness((call) =>
      call.route.endsWith('/read-all')
        ? json({ updated: 1 })
        : page([wireItem('inb_1'), wireItem('inb_2', { read_at: '2026-08-01T00:00:00Z' })]),
    )
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.items.length === 2)

    await store.markAllRead()

    expect(store.getSnapshot().items[0]?.readAt).not.toBeNull()
    // "Mark the unread ones read", not "restamp everything to now": it is displayed.
    expect(store.getSnapshot().items[1]?.readAt).toBe('2026-08-01T00:00:00Z')
  })

  it('takes an archived row out of the feed', async () => {
    const { session } = harness((call) =>
      call.route.endsWith('/archive') ? json(wireItem('inb_1')) : page([wireItem('inb_1'), wireItem('inb_2')]),
    )
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.items.length === 2)

    await store.archive('inb_1')

    // Archiving is an exit from the default feed, not a flag shown within it.
    expect(ids(store)).toEqual(['inb_2'])
  })

  it('takes a deleted row out of the feed', async () => {
    const { session } = harness((call) =>
      call.route.startsWith('DELETE') ? new Response(null, { status: 204 }) : page([wireItem('inb_1'), wireItem('inb_2')]),
    )
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.items.length === 2)

    await store.remove('inb_2')

    expect(ids(store)).toEqual(['inb_1'])
  })

  it('lets a failed mutation reject instead of lying about it', async () => {
    const { session } = harness((call) =>
      call.route.endsWith('/archive') ? new Response(null, { status: 409 }) : page([wireItem('inb_1')]),
    )
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.items.length === 1)

    // The server decides; the SDK reflects. A mutation that swallowed the failure and
    // removed the row anyway would show an inbox the next page load contradicts.
    await expect(store.archive('inb_1')).rejects.toBeInstanceOf(HermsApiError)
    expect(ids(store)).toEqual(['inb_1'])
  })
})

describe('live updates', () => {
  it('shows a new notification immediately, then replaces it with the full row', async () => {
    let listReads = 0
    const { session, emit } = harness(() => {
      listReads += 1
      return listReads === 1
        ? page([wireItem('inb_old')])
        : page([wireItem('inb_new', { body: 'The authoritative body.' }), wireItem('inb_old')])
    })
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.items.length === 1)

    emit({ type: 'item.created', data: { id: 'inb_new', title: 'Shipped', created_at: '2026-09-01T10:00:00Z' } })

    // Instantly, from the frame alone: the payload is deliberately minimal, so the row
    // is real but partial (no body, no category, no action url).
    expect(store.getSnapshot().items[0]?.id).toBe('inb_new')
    expect(store.getSnapshot().items[0]?.body).toBe('')

    // Then reconciled against a fresh first page, in place: no spinner, no reordering.
    await until(store, (s) => s.items[0]?.body === 'The authoritative body.')
    expect(ids(store)).toEqual(['inb_new', 'inb_old'])
    expect(store.getSnapshot().isLoading).toBe(false)
  })

  it('does not duplicate a row it already has', async () => {
    const { session, emit } = harness(() => page([wireItem('inb_1')]))
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.items.length === 1)

    // Redelivery is normal on a reconnecting stream, and the reconciliation fetch can
    // race the frame that triggered it.
    emit({ type: 'item.created', data: { id: 'inb_1', title: 'Notification inb_1', created_at: '2026-09-01T09:00:00Z' } })
    await flush()

    expect(ids(store)).toEqual(['inb_1'])
  })

  it('ignores a counts.changed frame, which is not its concern', async () => {
    const { session, emit, calls } = harness(() => page([wireItem('inb_1')]))
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.items.length === 1)
    const before = calls.length

    // The server sends `counts.changed` after every `item.created`. Refetching the list
    // on it too would double the request cost of every notification, for a frame that
    // carries nothing this store renders.
    emit({ type: 'counts.changed', data: { unread: 4, unseen: 4 } })
    await flush()

    expect(calls).toHaveLength(before)
  })
})

describe('a response that arrives after the world has moved on', () => {
  it('drops a further page requested under the previous filter', async () => {
    // The defect the hook had. Page two of the *old* view is in flight when the user
    // switches tabs; without a generation it lands and is appended to the new tab's
    // list, so rows from one view render under another with nothing to say so.
    const stalePage = deferred()
    const { session } = harness((call) => {
      if (call.query.get('cursor')) return stalePage.promise
      return call.query.get('read') === 'false'
        ? page([wireItem('inb_unread')])
        : page([wireItem('inb_any')], 'cur_2')
    })
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.hasMore)

    store.loadMore()
    await until(store, (s) => s.isLoadingMore)
    store.setFilter({ status: 'unread' })
    await until(store, (s) => !s.isLoading && s.items[0]?.id === 'inb_unread')

    stalePage.resolve(page([wireItem('inb_stale')]))
    await flush()

    expect(ids(store)).toEqual(['inb_unread'])
    // And the flag is not left stuck: the reload that superseded it cleared it, so a
    // scroll handler can page the new view.
    expect(store.getSnapshot().isLoadingMore).toBe(false)
  })

  it('keeps the newest first page when two arrive out of order', async () => {
    const slow = deferred()
    let reads = 0
    const { session } = harness(() => {
      reads += 1
      return reads === 1 ? slow.promise : page([wireItem('inb_newest')])
    })
    const store = new InboxStore(session)
    store.connect()
    await flush()

    store.refetch()
    await until(store, (s) => s.items[0]?.id === 'inb_newest')
    slow.resolve(page([wireItem('inb_oldest')]))
    await flush()

    expect(ids(store)).toEqual(['inb_newest'])
    expect(store.getSnapshot().isLoading).toBe(false)
  })

  it('does not merge a reconciliation that a reload has superseded', async () => {
    const reconcile = deferred()
    let reads = 0
    const { session, emit } = harness((call) => {
      reads += 1
      if (reads === 2) return reconcile.promise
      return call.query.get('read') === 'false' ? page([wireItem('inb_unread')]) : page([wireItem('inb_any')])
    })
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.items.length === 1)

    emit({ type: 'item.created', data: { id: 'inb_new', title: 'x', created_at: '2026-09-01T10:00:00Z' } })
    store.setFilter({ status: 'unread' })
    await until(store, (s) => !s.isLoading && s.items[0]?.id === 'inb_unread')
    reconcile.resolve(page([wireItem('inb_from_old_filter')]))
    await flush()

    expect(ids(store)).not.toContain('inb_from_old_filter')
  })
})

describe('connecting and disconnecting', () => {
  it('stops applying live events once disconnected', async () => {
    const { session, emit, calls } = harness(() => page([wireItem('inb_1')]))
    const store = new InboxStore(session)
    const disconnect = store.connect()
    await until(store, (s) => s.items.length === 1)

    disconnect()
    const before = calls.length
    emit({ type: 'item.created', data: { id: 'inb_new', title: 'x', created_at: '2026-09-01T10:00:00Z' } })
    await flush()

    // A binding disposed on route change must not keep a page's listener alive, or
    // every event is delivered to every store that ever mounted.
    expect(ids(store)).toEqual(['inb_1'])
    expect(calls).toHaveLength(before)
  })

  it('discards a first page still in flight when disconnected', async () => {
    const slow = deferred()
    const { session } = harness(() => slow.promise)
    const store = new InboxStore(session)
    const disconnect = store.connect()

    disconnect()
    slow.resolve(page([wireItem('inb_late')]))
    await flush()

    expect(ids(store)).toEqual([])
  })

  it('survives a connect, disconnect, connect sequence', async () => {
    // What a framework's development-mode double mount does to every store, on every
    // mount. The first connect's request must not land; the second's must.
    const first = deferred()
    let reads = 0
    const { session } = harness(() => {
      reads += 1
      return reads === 1 ? first.promise : page([wireItem('inb_second')])
    })
    const store = new InboxStore(session)

    store.connect()()
    store.connect()
    await until(store, (s) => s.items[0]?.id === 'inb_second')
    first.resolve(page([wireItem('inb_first')]))
    await flush()

    expect(ids(store)).toEqual(['inb_second'])
    expect(store.getSnapshot().isLoading).toBe(false)
  })
})

describe('every published state is one the server put us in', () => {
  // A subscriber that renders synchronously sees each notification, not the state after a
  // burst of them. So each invariant below is checked against every snapshot published,
  // and a transition made in two steps shows up as a snapshot that is half of each.

  it('never reports a failure while still claiming to load', async () => {
    const { session } = harness(() => new Response(null, { status: 500 }))
    const store = new InboxStore(session)
    const seen = recordSnapshots(store)

    store.connect()
    await until(store, (s) => s.error !== null)
    await flush()

    expect(seen.filter((s) => s.error !== null && s.isLoading)).toEqual([])
  })

  it('never shows the first rows while still claiming to load', async () => {
    const { session } = harness(() => page([wireItem('inb_1')]))
    const store = new InboxStore(session)
    const seen = recordSnapshots(store)

    store.connect()
    await until(store, (s) => s.items.length === 1)
    await flush()

    // A skeleton and a list at once: the panel would flash both.
    expect(seen.filter((s) => s.items.length > 0 && s.isLoading)).toEqual([])
  })

  it('never reports a failed further page while still flagged as loading more', async () => {
    let reads = 0
    const { session } = harness(() => {
      reads += 1
      return reads === 1 ? page([wireItem('inb_1')], 'cur_2') : new Response(null, { status: 500 })
    })
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.hasMore)
    const seen = recordSnapshots(store)

    store.loadMore()
    await until(store, (s) => s.error !== null)
    await flush()

    expect(seen.filter((s) => s.error !== null && s.isLoadingMore)).toEqual([])
  })

  it('never shows a further page while still flagged as loading more', async () => {
    const { session } = harness((call) =>
      call.query.get('cursor') ? page([wireItem('inb_2')]) : page([wireItem('inb_1')], 'cur_2'),
    )
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.hasMore)
    const seen = recordSnapshots(store)

    store.loadMore()
    await until(store, (s) => s.items.length === 2)
    await flush()

    expect(seen.filter((s) => s.items.length === 2 && s.isLoadingMore)).toEqual([])
  })
})
