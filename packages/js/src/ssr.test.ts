// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The server-rendering claim, tested on a runtime that actually has no DOM.
 *
 * This package's whole default environment is `node` (see `vitest.config.ts`), and this
 * file states the environment again for itself so it cannot be changed by accident: the
 * imports below have to happen somewhere `window`, `document` and `EventSource` are all
 * genuinely undefined, which is Next.js's server render, Remix's loader pass, an Astro
 * island's server half.
 *
 * The failure this prevents is not subtle and not ours to recover from: a
 * `ReferenceError: window is not defined` thrown from an import takes down the *host's*
 * page, before any of their code that uses this package has run.
 */

afterEach(() => {
  vi.useRealTimers()
})

describe('on a server runtime', () => {
  it('imports the whole package entry point without touching the DOM', async () => {
    expect(typeof window).toBe('undefined')
    expect(typeof document).toBe('undefined')
    expect(typeof EventSource).toBe('undefined')

    // The package entry, not just the client: the session and every store are in the same
    // module graph a host pulls in, and any one of them evaluating a DOM global at import
    // time breaks the same way.
    const module = await import('./index')

    expect(typeof module.HermsClient).toBe('function')
    expect(typeof module.HermsSession).toBe('function')
    expect(typeof module.InboxStore).toBe('function')
    expect(typeof module.CountsStore).toBe('function')
    expect(typeof module.PreferencesStore).toBe('function')
  })

  it('constructs a client and subscribes without a DOM, falling back to polling', async () => {
    const { HermsClient } = await import('./HermsClient')
    vi.useFakeTimers()
    const counts: unknown[] = []
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ unread: 1, unseen: 1 }), { status: 200 }))

    const client = new HermsClient({
      apiBaseUrl: 'https://api.example.test/v1/client',
      publicKey: 'hm_pk_test_abc',
      getSubscriberToken: () => 'st_test',
    })
    // A host that constructs its client in a module-scope `const` (the documented
    // pattern, since the client is supposed to be a stable reference) constructs it on
    // the server too. Subscribing is the one call that is allowed to look for a DOM, and
    // with none it must degrade to polling rather than throw.
    const unsubscribe = client.subscribe((event) => counts.push(event))
    await vi.advanceTimersByTimeAsync(60_000)

    expect(counts).toEqual([{ type: 'counts.changed', data: { unread: 1, unseen: 1 } }])
    unsubscribe()
  })

  it('builds, connects and disconnects a store without a DOM', async () => {
    const { HermsClient, HermsSession, CountsStore } = await import('./index')
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ unread: 3, unseen: 2 }), { status: 200 }))
    const client = new HermsClient({
      apiBaseUrl: 'https://api.example.test/v1/client',
      publicKey: 'hm_pk_test_abc',
      getSubscriberToken: () => 'st_test',
    })

    // A store constructed at module scope, or in a server component that renders once, is
    // the ordinary case. Connecting it on a runtime with no `EventSource` must fall back
    // to polling and release cleanly, or a server render leaks a timer per request.
    const session = new HermsSession(client)
    const release = session.connect()
    const store = new CountsStore(session)
    const disconnect = store.connect()
    await vi.advanceTimersByTimeAsync(0)

    expect(store.getSnapshot()).toEqual({ unread: 3, unseen: 2, isLoading: false })
    disconnect()
    release()
    expect(vi.getTimerCount()).toBe(0)
  })
})
