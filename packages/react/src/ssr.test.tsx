// @vitest-environment node
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The server-rendering claim for the React package, on a runtime with no DOM.
 *
 * Two things can break it, and they are different. One is an import that evaluates a DOM
 * global at load time, which takes down the host's page before any of their code runs.
 * The other is specific to how the hooks are built: `useSyncExternalStore` is required to
 * be given a server snapshot, and a hook that forgot would not fail in the browser, where
 * every test in this package runs, but would throw during the first server render.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('on a server runtime', () => {
  it('imports the package entry point, stylesheet import included, without touching the DOM', async () => {
    expect(typeof window).toBe('undefined')
    expect(typeof document).toBe('undefined')

    const module = await import('./index')

    expect(typeof module.HermsClient).toBe('function')
    expect(typeof module.HermsProvider).toBe('function')
    expect(typeof module.HermsInbox).toBe('function')
  })

  it('renders a component that uses the hooks, showing the loading state', async () => {
    const { HermsClient, HermsProvider, useUnreadCount, useInbox } = await import('./index')
    // A stub is installed so that any request a server render makes would be visible as a
    // failure of the assertion below, instead of as a hang.
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const client = new HermsClient({
      apiBaseUrl: 'https://api.example.test/v1/client',
      publicKey: 'hm_pk_test_abc',
      getSubscriberToken: () => 'st_test',
    })

    function Probe() {
      const { unread, isLoading } = useUnreadCount()
      const { items, isLoading: listLoading } = useInbox()
      return (
        <p>
          {String(isLoading)}:{unread}:{String(listLoading)}:{items.length}
        </p>
      )
    }

    const html = renderToString(
      <HermsProvider client={client}>
        <Probe />
      </HermsProvider>,
    )

    // The initial state, which is also what the client renders first, so hydration matches.
    // React separates adjacent text nodes with comment markers, hence the stripping.
    expect(html.replace(/<!-- -->/g, '')).toBe('<p>true:0:true:0</p>')
    // Effects do not run on the server, so nothing connected and nothing was requested.
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
