// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HermsClient } from './HermsClient'
import type { HermsRealtimeEvent } from './types'

/**
 * `client.subscribe(...)` — the live half of the SDK, and the half a consumer can least
 * easily debug from the outside. Three things are worth pinning, none of which need a
 * network:
 *
 *  1. **Nothing opens until a consumer asks.** The SDK claims SSR-safety in as many words,
 *     and the only way that claim breaks is a `new EventSource(...)`/`window` read at
 *     module or constructor time. That is a `ReferenceError` on the server during SSR —
 *     a white page for the *host's* app, caused by an import.
 *  2. **The subscribe/unsubscribe lifecycle.** React double-invokes effects in
 *     StrictMode, so mount/unmount/mount is the normal case, not the edge case: an
 *     unsubscribe that leaves a connection or an interval behind leaks one per mount.
 *  3. **The degraded mode**, polling `/counts` every 60s when SSE is
 *     unavailable, actually engaging, and standing down again when SSE recovers.
 *
 * `EventSource` is faked through the global rather than injected, for the same reason
 * `fetch` is: the public API takes neither, and widening it for a test would be changing
 * the product to suit the test. jsdom has no `EventSource` of its own, which is why the
 * polling cases below need no stub at all.
 */

type Frame = MessageEvent<string>

/** The parts of `EventSource` this client uses, plus the handles a test needs to drive
 * it. Deliberately not a full implementation — a fuller fake would only be re-testing
 * the browser. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  readonly listeners = new Map<string, Array<(event: Frame) => void>>()
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: Frame) => void): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  close(): void {
    this.closed = true
  }

  /** A server frame: `event: <type>` / `data: <raw>`. */
  emit(type: string, raw: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: raw }))
  }

  static latest(): FakeEventSource {
    const instance = FakeEventSource.instances.at(-1)
    if (!instance) throw new Error('no EventSource was opened')
    return instance
  }

  static reset(): void {
    FakeEventSource.instances = []
  }
}

function stubEventSource(): void {
  FakeEventSource.reset()
  vi.stubGlobal('EventSource', FakeEventSource)
}

function client(getSubscriberToken: () => string | Promise<string> = () => 'st_test'): HermsClient {
  return new HermsClient({
    apiBaseUrl: 'https://api.example.test/v1/client',
    publicKey: 'hm_pk_test_abc',
    getSubscriberToken,
  })
}

afterEach(() => {
  vi.useRealTimers()
  FakeEventSource.reset()
})

describe('before anyone subscribes', () => {
  it('opens no connection at import time or construction time', async () => {
    stubEventSource()
    const getSubscriberToken = vi.fn(() => 'st_test')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    // Imported *after* the stub, with the module registry reset, so anything this module
    // does at evaluation time would be recorded here. This is the SSR claim: a
    // host that imports `@hermesihq/react` in a server-rendered route must get nothing but
    // definitions.
    vi.resetModules()
    const { HermsClient: FreshHermsClient } = await import('./HermsClient')
    new FreshHermsClient({ apiBaseUrl: 'https://api.example.test/v1/client', publicKey: 'hm_pk_test_abc', getSubscriberToken })

    expect(FakeEventSource.instances).toHaveLength(0)
    expect(getSubscriberToken).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('the SSE connection', () => {
  it('carries the credentials in the query string, because a stream cannot send headers', async () => {
    stubEventSource()

    const unsubscribe = client(() => 'st_live').subscribe(() => {})
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))

    const url = new URL(FakeEventSource.latest().url)
    expect(url.pathname).toBe('/v1/client/inbox/stream')
    // `EventSource` has no way to set `Authorization`/`X-Hermesi-Subscriber-Token`,
    // which is exactly why `GET /v1/client/inbox/stream` takes these two as query
    // parameters instead. Sending them as headers here would connect to nothing.
    expect(url.searchParams.get('public_key')).toBe('hm_pk_test_abc')
    expect(url.searchParams.get('subscriber_token')).toBe('st_live')

    unsubscribe()
  })

  it('asks the host for a fresh token for the stream as well', async () => {
    stubEventSource()
    const getSubscriberToken = vi.fn(() => 'st_live')

    const unsubscribe = client(getSubscriberToken).subscribe(() => {})
    await vi.waitFor(() => expect(getSubscriberToken).toHaveBeenCalledTimes(1))

    unsubscribe()
  })

  it('delivers both documented frame types to the listener', async () => {
    stubEventSource()
    const events: HermsRealtimeEvent[] = []

    const unsubscribe = client().subscribe((event) => events.push(event))
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const source = FakeEventSource.latest()

    // The two frames the API documents. `item.created` carries a deliberately minimal
    // payload, which
    // `useInbox` relies on being passed through verbatim rather than reshaped.
    source.emit('item.created', JSON.stringify({ id: 'inb_1', title: 'Shipped', created_at: '2026-09-01T09:59:00Z' }))
    source.emit('counts.changed', JSON.stringify({ unread: 3, unseen: 1 }))

    expect(events).toEqual([
      { type: 'item.created', data: { id: 'inb_1', title: 'Shipped', created_at: '2026-09-01T09:59:00Z' } },
      { type: 'counts.changed', data: { unread: 3, unseen: 1 } },
    ])

    unsubscribe()
  })

  it('drops a malformed frame instead of letting it kill the stream', async () => {
    stubEventSource()
    const events: HermsRealtimeEvent[] = []

    const unsubscribe = client().subscribe((event) => events.push(event))
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const source = FakeEventSource.latest()

    // A truncated frame — what a proxy that buffers and cuts an SSE body produces. An
    // uncaught throw inside the listener would propagate into the browser's event
    // dispatch and the *next*, perfectly good frame would still have to arrive for the
    // UI to recover. One bad frame must cost one bad frame.
    source.emit('counts.changed', '{"unread": 3, "uns')
    source.emit('counts.changed', JSON.stringify({ unread: 4, unseen: 2 }))

    expect(events).toEqual([{ type: 'counts.changed', data: { unread: 4, unseen: 2 } }])

    unsubscribe()
  })

  it('closes the connection when the consumer unsubscribes', async () => {
    stubEventSource()

    const unsubscribe = client().subscribe(() => {})
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const source = FakeEventSource.latest()

    unsubscribe()

    // A left-open `EventSource` holds one of the browser's six per-origin HTTP/1.1
    // connections *and* keeps a server-side subscriber alive; leaking one per mount is
    // how a SPA that navigates for an hour runs out of sockets.
    expect(source.closed).toBe(true)
  })

  it('never opens a connection if the consumer unsubscribed while the token was in flight', async () => {
    stubEventSource()
    let release = () => {}
    const pendingToken = new Promise<string>((resolve) => {
      release = () => resolve('st_late')
    })

    // React StrictMode mounts, unmounts and remounts every effect in development, so
    // "unsubscribed before the async token resolved" is the ordinary path, not an edge
    // case. Without the post-await check this opens a connection nobody holds a handle
    // to and nobody can ever close.
    const unsubscribe = client(() => pendingToken).subscribe(() => {})
    unsubscribe()
    release()
    await pendingToken
    await Promise.resolve()

    expect(FakeEventSource.instances).toHaveLength(0)
  })
})

describe('the polling fallback', () => {
  it('polls the counts endpoint when the runtime has no EventSource at all', async () => {
    // No `EventSource` stub: jsdom has none, which is also the shape of a browser with
    // an extension or a corporate proxy that blocks streaming.
    vi.useFakeTimers()
    const events: HermsRealtimeEvent[] = []
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ unread: 5, unseen: 2 }), { status: 200 }))

    const unsubscribe = client().subscribe((event) => events.push(event))

    // Nothing before the first interval elapses — a fallback that fired immediately on
    // every mount would be a request storm on a page with several widgets.
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(events).toEqual([{ type: 'counts.changed', data: { unread: 5, unseen: 2 } }])

    unsubscribe()
    // The interval has to die with the subscription; a poll every 60s for the life of
    // the tab is the leak this fallback would otherwise introduce.
    await vi.advanceTimersByTimeAsync(180_000)
    expect(events).toHaveLength(1)
  })

  it('keeps a failing counts poll quiet and tries again next tick', async () => {
    vi.useFakeTimers()
    const events: HermsRealtimeEvent[] = []
    let attempt = 0
    vi.stubGlobal('fetch', async () => {
      attempt += 1
      if (attempt === 1) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({ unread: 1, unseen: 1 }), { status: 200 })
    })

    const unsubscribe = client().subscribe((event) => events.push(event))

    // A rejected poll must not become an unhandled rejection in the host's console, and
    // must not stop the interval: offline-for-a-minute is the common case.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(events).toEqual([{ type: 'counts.changed', data: { unread: 1, unseen: 1 } }])

    unsubscribe()
  })

  it('engages after repeated immediate SSE failures, and keeps retrying SSE behind it', async () => {
    vi.useFakeTimers()
    stubEventSource()
    const events: HermsRealtimeEvent[] = []
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ unread: 9, unseen: 4 }), { status: 200 }))

    const unsubscribe = client().subscribe((event) => events.push(event))
    await vi.advanceTimersByTimeAsync(0)

    // Three consecutive failures with no successful open in between — an expired token,
    // or a network that drops the stream on sight. Each retry backs off (1s, 2s), and
    // the third failure is the point at which the client stops assuming SSE will come
    // back on its own and starts the degraded mode instead.
    FakeEventSource.latest().onerror?.()
    await vi.advanceTimersByTimeAsync(1_000)
    FakeEventSource.latest().onerror?.()
    await vi.advanceTimersByTimeAsync(2_000)
    FakeEventSource.latest().onerror?.()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(events).toContainEqual({ type: 'counts.changed', data: { unread: 9, unseen: 4 } })
    // Still reconnecting underneath: the fallback is a fallback, not a surrender, so a
    // token or network that recovers heals without a page reload.
    expect(FakeEventSource.instances.length).toBeGreaterThan(3)

    unsubscribe()
  })

  it('stands down as soon as a stream opens again', async () => {
    vi.useFakeTimers()
    stubEventSource()
    const events: HermsRealtimeEvent[] = []
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ unread: 9, unseen: 4 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const unsubscribe = client().subscribe((event) => events.push(event))
    await vi.advanceTimersByTimeAsync(0)
    for (const delay of [0, 1_000, 2_000]) {
      await vi.advanceTimersByTimeAsync(delay)
      FakeEventSource.latest().onerror?.()
    }
    await vi.advanceTimersByTimeAsync(4_000)

    // The reconnect that succeeds. Leaving the 60s poll running beside a healthy stream
    // would double every count update and quietly keep the request cost of the degraded
    // mode forever.
    FakeEventSource.latest().onopen?.()
    fetchSpy.mockClear()
    await vi.advanceTimersByTimeAsync(180_000)

    expect(fetchSpy).not.toHaveBeenCalled()

    unsubscribe()
  })
})
