import { useEffect, useState } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HermsClient } from '@hermesihq/js'
import type { HermsEventListener } from '@hermesihq/js'
import { HermsProvider, useHermsContext } from './HermsProvider'

/**
 * `<HermsProvider>` owns the two things in this package that outlive a render: the one
 * real-time subscription shared by every hook in the subtree, and the client's own
 * `onTokenExpiring` timer. Everything asserted here is something a host app pays for
 * when it is wrong — a connection per hook, or a connection per navigation that nobody
 * ever closes.
 *
 * `client.subscribe` is spied on rather than driven through a fake `EventSource`: the
 * wire itself is `realtime.test.ts`'s subject, and all that matters here is that the
 * provider opens one connection, hands its events to everybody, and closes it.
 *
 * No `@testing-library/jest-dom` in this package, so assertions read text content
 * directly rather than through `toHaveTextContent`.
 */

// `globals: false` means Testing Library's own auto-cleanup (which hooks a global
// `afterEach`) never registers, so every React file in this package unmounts by hand.
// Without it each case renders into the previous case's DOM and the queries below find
// two of everything.
afterEach(cleanup)

function makeClient(): HermsClient {
  return new HermsClient({
    apiBaseUrl: 'https://api.example.test/v1/client',
    publicKey: 'hm_pk_test_abc',
    getSubscriberToken: () => 'st_test',
  })
}

/** Reads the context the way every hook in this package does. */
function ClientProbe({ label }: { label: string }) {
  const { client } = useHermsContext()
  return <span data-testid={label}>{client.constructor.name}</span>
}

/**
 * Registers a listener on the shared subscription while `listening`, and renders what it
 * last received. The `listening` switch exists so a test can unregister *without*
 * unmounting: React 19 makes a `setState` on an unmounted component a silent no-op, so an
 * unsubscribe that did nothing would be invisible if the probe went away with it.
 */
function EventProbe({ label, listening = true }: { label: string; listening?: boolean }) {
  const { addEventListener } = useHermsContext()
  const [seen, setSeen] = useState('none')
  useEffect(() => {
    if (!listening) return
    return addEventListener((event) => setSeen(event.type))
  }, [addEventListener, listening])
  return <span data-testid={label}>{seen}</span>
}

function textOf(testId: string): string {
  return screen.getByTestId(testId).textContent ?? ''
}

describe('HermsProvider', () => {
  it('supplies its client to the whole subtree', () => {
    render(
      <HermsProvider client={makeClient()}>
        <div>
          <ClientProbe label="deep" />
        </div>
      </HermsProvider>,
    )

    expect(textOf('deep')).toBe('HermsClient')
  })

  it('opens exactly one connection no matter how many consumers there are', () => {
    const client = makeClient()
    const subscribe = vi.spyOn(client, 'subscribe').mockReturnValue(() => {})

    render(
      <HermsProvider client={client}>
        <EventProbe label="a" />
        <EventProbe label="b" />
        <EventProbe label="c" />
      </HermsProvider>,
    )

    // The reason the provider owns the subscription at all: a bell, an open panel and a
    // page-level counter on one screen are three hooks, and three `EventSource`
    // connections would be three of the browser's six per-origin sockets plus three
    // server-side subscribers, for one person's inbox.
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('fans a single event out to every listener', () => {
    const client = makeClient()
    let emit: HermsEventListener = () => {}
    vi.spyOn(client, 'subscribe').mockImplementation((listener) => {
      emit = listener
      return () => {}
    })

    render(
      <HermsProvider client={client}>
        <EventProbe label="a" />
        <EventProbe label="b" />
      </HermsProvider>,
    )
    act(() => {
      emit({ type: 'counts.changed', data: { unread: 1, unseen: 1 } })
    })

    // Both, not just the first registered — a badge and an open panel have to agree.
    expect(textOf('a')).toBe('counts.changed')
    expect(textOf('b')).toBe('counts.changed')
  })

  it('stops delivering to a listener that has unregistered', () => {
    const client = makeClient()
    let emit: HermsEventListener = () => {}
    vi.spyOn(client, 'subscribe').mockImplementation((listener) => {
      emit = listener
      return () => {}
    })

    function Tree({ listening }: { listening: boolean }) {
      return (
        <HermsProvider client={client}>
          <EventProbe label="a" listening={listening} />
          <EventProbe label="b" />
        </HermsProvider>
      )
    }
    const { rerender } = render(<Tree listening />)
    rerender(<Tree listening={false} />)

    act(() => {
      emit({ type: 'counts.changed', data: { unread: 1, unseen: 1 } })
    })

    // The unsubscribe `addEventListener` hands back is the only way a consumer can ever
    // get out of the set — closing a panel, or a hook whose dependencies changed. If it
    // does not remove the listener, the set grows for the life of the page and every
    // event is delivered to every hook that ever mounted.
    expect(textOf('a')).toBe('none')
    expect(textOf('b')).toBe('counts.changed')
  })

  it('closes the connection and destroys the client when it unmounts', () => {
    const client = makeClient()
    const unsubscribe = vi.fn()
    vi.spyOn(client, 'subscribe').mockReturnValue(unsubscribe)
    const destroy = vi.spyOn(client, 'destroy')

    const { unmount } = render(
      <HermsProvider client={client}>
        <ClientProbe label="deep" />
      </HermsProvider>,
    )
    unmount()

    // A SPA unmounts this on every route change that drops the layout. Both halves
    // matter: the connection is a socket, and `destroy()` clears the pending
    // `onTokenExpiring` timer that would otherwise call back into a dead tree.
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('moves the subscription when it is handed a different client', () => {
    const first = makeClient()
    const second = makeClient()
    const firstUnsubscribe = vi.fn()
    vi.spyOn(first, 'subscribe').mockReturnValue(firstUnsubscribe)
    const secondSubscribe = vi.spyOn(second, 'subscribe').mockReturnValue(() => {})

    const { rerender } = render(
      <HermsProvider client={first}>
        <ClientProbe label="deep" />
      </HermsProvider>,
    )
    rerender(
      <HermsProvider client={second}>
        <ClientProbe label="deep" />
      </HermsProvider>,
    )

    // Swapping the client is how a host switches subscriber — a login, or an admin
    // impersonating a customer. The old connection must not keep delivering the
    // previous subscriber's notifications into the new session.
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1)
    expect(secondSubscribe).toHaveBeenCalledTimes(1)
  })
})

describe('using this package outside a provider', () => {
  it('fails with a message that names the missing provider', () => {
    // React logs any render-phase throw to the console; silenced so the suite's own
    // output still reads as a pass.
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // The mistake every integrator makes once, usually by rendering `<HermsInbox />` in
    // a layout that sits above the provider. The error has to name the provider,
    // because the symptom (a blank bell) says nothing at all.
    expect(() => render(<ClientProbe label="orphan" />)).toThrow(/HermsProvider/)
  })
})
