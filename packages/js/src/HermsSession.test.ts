// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { HermsClient } from './HermsClient'
import { HermsSession } from './HermsSession'
import type { HermsEventListener } from './types'

/**
 * `HermsSession` is the piece `<HermsProvider>` used to be, without React: it owns the
 * one real-time connection and hands its events to everybody. What is asserted is what a
 * host pays for when it is wrong, a connection per store or a connection per navigation
 * that nobody closes.
 *
 * `client.subscribe` is spied on rather than driven through a fake `EventSource`: the
 * wire is `realtime.test.ts`'s subject.
 */

function makeClient(): HermsClient {
  return new HermsClient({
    apiBaseUrl: 'https://api.example.test/v1/client',
    publicKey: 'hm_pk_test_abc',
    getSubscriberToken: () => 'st_test',
  })
}

function wire(client: HermsClient) {
  let emit: HermsEventListener = () => {}
  const closeStream = vi.fn()
  const subscribe = vi.spyOn(client, 'subscribe').mockImplementation((listener) => {
    emit = listener
    return closeStream
  })
  const destroy = vi.spyOn(client, 'destroy')
  return { subscribe, closeStream, destroy, emit: (event: Parameters<HermsEventListener>[0]) => emit(event) }
}

const COUNTS = { type: 'counts.changed', data: { unread: 1, unseen: 1 } } as const

describe('the shared connection', () => {
  it('opens nothing until connected', () => {
    const client = makeClient()
    const { subscribe } = wire(client)

    new HermsSession(client)

    expect(subscribe).not.toHaveBeenCalled()
  })

  it('opens exactly one connection however many stores listen', () => {
    const client = makeClient()
    const { subscribe } = wire(client)
    const session = new HermsSession(client)

    // Three consumers each connecting, which is what a bell, an open panel and a
    // page-level counter do. Each holds a claim; none opens a connection of its own.
    session.connect()
    session.connect()
    session.connect()

    // The reason the session owns the subscription at all: three `EventSource`
    // connections would be three of the browser's six per-origin sockets, plus three
    // server-side subscribers, for one person's inbox.
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('fans a single event out to every listener', () => {
    const client = makeClient()
    const { emit } = wire(client)
    const session = new HermsSession(client)
    session.connect()
    const a = vi.fn()
    const b = vi.fn()
    session.addEventListener(a)
    session.addEventListener(b)

    emit(COUNTS)

    // Both, not just the first registered: a badge and an open panel have to agree.
    expect(a).toHaveBeenCalledWith(COUNTS)
    expect(b).toHaveBeenCalledWith(COUNTS)
  })

  it('stops delivering to a listener that has unregistered', () => {
    const client = makeClient()
    const { emit } = wire(client)
    const session = new HermsSession(client)
    session.connect()
    const gone = vi.fn()
    const stays = vi.fn()
    const unregister = session.addEventListener(gone)
    session.addEventListener(stays)

    unregister()
    emit(COUNTS)

    // The way out is the only way a consumer leaves the set. If it removed nothing, the
    // set would grow for the life of the page.
    expect(gone).not.toHaveBeenCalled()
    expect(stays).toHaveBeenCalledTimes(1)
  })

  it('does not deliver to a listener an earlier one unregistered', () => {
    const client = makeClient()
    const { emit } = wire(client)
    const session = new HermsSession(client)
    session.connect()
    const second = vi.fn()
    let unregisterSecond: () => void = () => {}
    session.addEventListener(() => unregisterSecond())
    unregisterSecond = session.addEventListener(second)

    emit(COUNTS)

    // A store disposed in response to an event has already asked not to hear the next.
    expect(second).not.toHaveBeenCalled()
  })

  it('keeps delivering to the rest when one listener throws', () => {
    vi.stubGlobal('queueMicrotask', () => {})
    const client = makeClient()
    const { emit } = wire(client)
    const session = new HermsSession(client)
    session.connect()
    const after = vi.fn()
    session.addEventListener(() => {
      throw new Error('one store is broken')
    })
    session.addEventListener(after)

    emit(COUNTS)

    expect(after).toHaveBeenCalledTimes(1)
  })
})

describe('closing it', () => {
  it('closes the connection and destroys the client on the last release', () => {
    const client = makeClient()
    const { closeStream, destroy } = wire(client)
    const session = new HermsSession(client)

    session.connect()()

    // A SPA drops this on every route change that drops the layout. Both halves matter:
    // the connection is a socket, and `destroy()` clears the pending `onTokenExpiring`
    // timer that would otherwise call back into a page that has gone.
    expect(closeStream).toHaveBeenCalledTimes(1)
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('stays open while anyone still holds it', () => {
    const client = makeClient()
    const { closeStream, destroy } = wire(client)
    const session = new HermsSession(client)

    const releaseFirst = session.connect()
    const releaseSecond = session.connect()
    releaseFirst()

    // Two providers over one client: the first to unmount must not cut off the other.
    expect(closeStream).not.toHaveBeenCalled()
    expect(destroy).not.toHaveBeenCalled()
    releaseSecond()
    expect(closeStream).toHaveBeenCalledTimes(1)
  })

  it('releases once however many times the release is called', () => {
    const client = makeClient()
    const { closeStream } = wire(client)
    const session = new HermsSession(client)
    const holdsOpen = session.connect()
    const release = session.connect()

    release()
    release()
    release()

    // A defensive double call must not release somebody else's claim.
    expect(closeStream).not.toHaveBeenCalled()
    holdsOpen()
    expect(closeStream).toHaveBeenCalledTimes(1)
  })

  it('reopens after being fully released', () => {
    const client = makeClient()
    const { subscribe } = wire(client)
    const session = new HermsSession(client)

    // Connect, release, connect: what a framework's development-mode double mount does
    // on every mount.
    session.connect()()
    session.connect()

    expect(subscribe).toHaveBeenCalledTimes(2)
  })
})
