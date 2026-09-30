// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CountsStore } from './CountsStore'
import { deferred, flush, harness, json, recordSnapshots, until } from './storeHarness'

/**
 * The unread badge, on a runtime with no DOM. One `getCounts()` when connected, then
 * replaced wholesale on every `counts.changed`, whether that came over the stream or from
 * the client's own polling fallback. The store does not care which.
 */

describe('CountsStore', () => {
  it('reports loading, then the counts the server returned', async () => {
    const { session } = harness(() => json({ unread: 3, unseen: 2 }))
    const store = new CountsStore(session)

    // Zero and loading, so a badge can render nothing rather than a false "0 unread".
    expect(store.getSnapshot()).toEqual({ unread: 0, unseen: 0, isLoading: true })
    store.connect()
    await until(store, (s) => !s.isLoading)

    expect(store.getSnapshot()).toEqual({ unread: 3, unseen: 2, isLoading: false })
  })

  it('replaces its counts on a counts.changed event', async () => {
    const { session, emit } = harness(() => json({ unread: 3, unseen: 3 }))
    const store = new CountsStore(session)
    store.connect()
    await until(store, (s) => !s.isLoading)

    emit({ type: 'counts.changed', data: { unread: 0, unseen: 0 } })

    expect(store.getSnapshot()).toEqual({ unread: 0, unseen: 0, isLoading: false })
  })

  it('ignores an item.created event, which is not its concern', async () => {
    const { session, emit, calls } = harness(() => json({ unread: 1, unseen: 1 }))
    const store = new CountsStore(session)
    store.connect()
    await until(store, (s) => !s.isLoading)
    const before = calls.length

    // The server follows every `item.created` with a `counts.changed`; reacting to both
    // would count the same notification twice.
    emit({ type: 'item.created', data: { id: 'inb_1', title: 'x', created_at: '2026-09-01T10:00:00Z' } })
    await flush()

    expect(store.getSnapshot().unread).toBe(1)
    expect(calls).toHaveLength(before)
  })

  it('stays at zero and stops loading when the first read fails', async () => {
    const { session } = harness(() => new Response(null, { status: 500 }))
    const store = new CountsStore(session)

    store.connect()
    await until(store, (s) => !s.isLoading)

    // Best-effort: a badge that showed an error would be louder than the thing it
    // counts. The next event or a reconnect corrects it.
    expect(store.getSnapshot()).toEqual({ unread: 0, unseen: 0, isLoading: false })
  })

  it('applies a later event after a failed first read', async () => {
    const { session, emit } = harness(() => new Response(null, { status: 500 }))
    const store = new CountsStore(session)
    store.connect()
    await until(store, (s) => !s.isLoading)

    emit({ type: 'counts.changed', data: { unread: 5, unseen: 5 } })

    expect(store.getSnapshot().unread).toBe(5)
  })

  it('stops listening once disconnected', async () => {
    const { session, emit } = harness(() => json({ unread: 1, unseen: 1 }))
    const store = new CountsStore(session)
    const disconnect = store.connect()
    await until(store, (s) => !s.isLoading)

    disconnect()
    emit({ type: 'counts.changed', data: { unread: 9, unseen: 9 } })

    expect(store.getSnapshot().unread).toBe(1)
  })

  it('discards a read still in flight when disconnected', async () => {
    const slow = deferred()
    const { session } = harness(() => slow.promise)
    const store = new CountsStore(session)
    const disconnect = store.connect()

    disconnect()
    slow.resolve(json({ unread: 7, unseen: 7 }))
    await flush()

    expect(store.getSnapshot().unread).toBe(0)
  })

  it('reads a fresh value when connected again', async () => {
    let reads = 0
    const { session } = harness(() => {
      reads += 1
      return json({ unread: reads, unseen: reads })
    })
    const store = new CountsStore(session)

    store.connect()()
    store.connect()
    await until(store, (s) => !s.isLoading && s.unread === 2)

    expect(store.getSnapshot().unread).toBe(2)
  })

  it('does not touch the inbox list endpoint', async () => {
    const { session, calls } = harness(() => json({ unread: 1, unseen: 1 }))
    const store = new CountsStore(session)

    store.connect()
    await until(store, (s) => !s.isLoading)

    // A badge that fetched the list to count it would be a page of rows per page view.
    expect(calls.map((call) => call.route)).toEqual(['GET /v1/client/inbox/counts'])
  })
})

describe('every published state is one the server put us in', () => {
  it('never shows the counts while still claiming to load', async () => {
    const { session } = harness(() => json({ unread: 4, unseen: 4 }))
    const store = new CountsStore(session)
    const seen = recordSnapshots(store)

    store.connect()
    await until(store, (s) => s.unread === 4)
    await flush()

    // A badge reading "4" beside a loading spinner would be two answers at once.
    expect(seen.filter((s) => s.unread > 0 && s.isLoading)).toEqual([])
  })
})
