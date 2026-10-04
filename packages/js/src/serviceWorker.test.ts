import { describe, expect, it, vi } from 'vitest'
import { installHermesiPush, notificationFor, parsePushPayload, resolveClickTarget } from './serviceWorker'
import type { ServiceWorkerScopeLike } from './serviceWorker'

/**
 * The worker half, driven through a fake worker scope. What these pin is the contract with
 * Hermesi's payload (`title`, `body`, `image`, `url`, `data`) and what a click is allowed to do,
 * because the link comes from a template and a service worker runs with the site's authority.
 */

const SCOPE = 'https://app.example.test/'

describe('parsePushPayload', () => {
  it('keeps the fields Hermesi sends', () => {
    expect(
      parsePushPayload({ title: 'Shipped', body: 'Tomorrow', image: 'https://cdn.example.test/a.png', url: '/orders/1', data: { order: '1' } }),
    ).toEqual({ title: 'Shipped', body: 'Tomorrow', image: 'https://cdn.example.test/a.png', url: '/orders/1', data: { order: '1' } })
  })

  it('leaves out what is not there, rather than carrying empty values', () => {
    expect(parsePushPayload({ title: 'Only a title' })).toEqual({ title: 'Only a title' })
    expect(parsePushPayload({ title: 'T', body: '', image: '', url: '', data: {} })).toEqual({ title: 'T' })
  })

  it.each([[null], [undefined], ['text'], [42], [[]], [true]])('gives an empty payload for %j', (raw) => {
    expect(parsePushPayload(raw)).toEqual({})
  })

  it('drops a field of the wrong type instead of showing it', () => {
    expect(parsePushPayload({ title: 7, body: { a: 1 }, image: [], url: false, data: 'x' })).toEqual({})
  })

  it('keeps only the string values of data', () => {
    expect(parsePushPayload({ data: { a: '1', b: 2, c: null, d: { x: 1 } } })).toEqual({ data: { a: '1' } })
  })
})

describe('notificationFor', () => {
  it('builds the notification, with the link in data.url beside the custom data', () => {
    expect(notificationFor({ title: 'Shipped', body: 'Tomorrow', image: 'https://cdn.example.test/a.png', url: '/orders/1', data: { order: '1' } })).toEqual({
      title: 'Shipped',
      options: { body: 'Tomorrow', image: 'https://cdn.example.test/a.png', data: { order: '1', url: '/orders/1' } },
    })
  })

  it('adds the site-wide icon and badge, which Hermesi does not send', () => {
    const { options } = notificationFor({ title: 'T' }, { icon: '/icon.png', badge: '/badge.png' })
    expect(options).toMatchObject({ icon: '/icon.png', badge: '/badge.png' })
  })

  it('has a title when the payload has none, and lets the site choose it', () => {
    expect(notificationFor({}).title).toBe('Notification')
    expect(notificationFor({}, { fallbackTitle: 'Acme' }).title).toBe('Acme')
  })

  it('lets the link win over a data key of the same name', () => {
    expect(notificationFor({ url: '/real', data: { url: '/spoofed' } }).options.data.url).toBe('/real')
  })
})

describe('resolveClickTarget', () => {
  it.each([
    ['/orders/1', 'https://app.example.test/orders/1'],
    ['orders/1', 'https://app.example.test/orders/1'],
    ['https://other.example.test/x', 'https://other.example.test/x'],
    ['http://other.example.test/x', 'http://other.example.test/x'],
  ])('opens %s as %s', (url, expected) => {
    expect(resolveClickTarget(url, SCOPE)).toBe(expected)
  })

  it.each([['javascript:alert(1)'], ['data:text/html,<script>1</script>'], ['file:///etc/passwd'], ['blob:https://x/1'], ['ftp://x/y']])(
    'refuses %s, because a template author is not the site',
    (url) => {
      expect(resolveClickTarget(url, SCOPE)).toBeNull()
    },
  )

  it.each([[undefined], [null], [''], [7], [{}]])('has no target for %j', (url) => {
    expect(resolveClickTarget(url, SCOPE)).toBeNull()
  })
})

function fakeScope(windows: { url: string; focus: () => Promise<unknown> }[] = []) {
  const listeners: Record<string, (event: never) => void> = {}
  const showNotification = vi.fn(async () => undefined)
  const openWindow = vi.fn(async () => undefined)
  const scope = {
    addEventListener: (type: string, listener: (event: never) => void) => {
      listeners[type] = listener
    },
    registration: { scope: SCOPE, showNotification },
    clients: { matchAll: vi.fn(async () => windows), openWindow },
  } as unknown as ServiceWorkerScopeLike
  return { scope, listeners, showNotification, openWindow }
}

function pushEvent(data: { json?: () => unknown; text?: () => string } | null) {
  const waits: Promise<unknown>[] = []
  return {
    event: {
      data: data && { json: data.json ?? (() => JSON.parse(data.text?.() ?? 'null')), text: data.text ?? (() => '') },
      waitUntil: (promise: Promise<unknown>) => void waits.push(promise),
    },
    settled: () => Promise.all(waits),
  }
}

function clickEvent(data: unknown) {
  const waits: Promise<unknown>[] = []
  const close = vi.fn()
  return {
    event: { notification: { data, close }, waitUntil: (promise: Promise<unknown>) => void waits.push(promise) },
    close,
    settled: () => Promise.all(waits),
  }
}

describe('installHermesiPush: push', () => {
  it('shows the notification Hermesi described, and keeps the worker alive until it is shown', async () => {
    const { scope, listeners, showNotification } = fakeScope()
    installHermesiPush(scope, { icon: '/icon.png' })
    const push = pushEvent({ json: () => ({ title: 'Shipped', body: 'Tomorrow', url: '/orders/1' }) })

    listeners.push!(push.event as never)
    await push.settled()

    expect(showNotification).toHaveBeenCalledWith('Shipped', { body: 'Tomorrow', icon: '/icon.png', data: { url: '/orders/1' } })
  })

  it('shows plain text as the body when the payload is not JSON', async () => {
    const { scope, listeners, showNotification } = fakeScope()
    installHermesiPush(scope)
    const push = pushEvent({
      json: () => {
        throw new SyntaxError('not json')
      },
      text: () => 'Hello from a console',
    })

    listeners.push!(push.event as never)
    await push.settled()

    expect(showNotification).toHaveBeenCalledWith('Notification', { body: 'Hello from a console', data: {} })
  })

  it('still shows something for an empty push, because a browser shows its own notice for none', async () => {
    const { scope, listeners, showNotification } = fakeScope()
    installHermesiPush(scope, { fallbackTitle: 'Acme' })
    const push = pushEvent(null)

    listeners.push!(push.event as never)
    await push.settled()

    expect(showNotification).toHaveBeenCalledWith('Acme', { data: {} })
  })
})

describe('installHermesiPush: click', () => {
  it('closes the notification and opens the link in a new tab when none shows it', async () => {
    const { scope, listeners, openWindow } = fakeScope([{ url: 'https://app.example.test/other', focus: vi.fn(async () => undefined) }])
    installHermesiPush(scope)
    const click = clickEvent({ url: '/orders/1' })

    listeners.notificationclick!(click.event as never)
    await click.settled()

    expect(click.close).toHaveBeenCalled()
    expect(openWindow).toHaveBeenCalledWith('https://app.example.test/orders/1')
  })

  it('focuses a tab already showing the link instead of opening a second', async () => {
    const focus = vi.fn(async () => undefined)
    const { scope, listeners, openWindow } = fakeScope([
      { url: 'https://app.example.test/other', focus: vi.fn(async () => undefined) },
      { url: 'https://app.example.test/orders/1', focus },
    ])
    installHermesiPush(scope)
    const click = clickEvent({ url: '/orders/1' })

    listeners.notificationclick!(click.event as never)
    await click.settled()

    expect(focus).toHaveBeenCalledTimes(1)
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('never opens a link that is not a web address', async () => {
    const { scope, listeners, openWindow } = fakeScope()
    installHermesiPush(scope)
    const click = clickEvent({ url: 'javascript:alert(1)' })

    listeners.notificationclick!(click.event as never)
    await click.settled()

    expect(openWindow).toHaveBeenCalledTimes(1)
    expect(openWindow).toHaveBeenCalledWith(SCOPE)
  })

  it('focuses a tab of the site for a notification with no link', async () => {
    const focus = vi.fn(async () => undefined)
    const { scope, listeners, openWindow } = fakeScope([{ url: 'https://app.example.test/anything', focus }])
    installHermesiPush(scope)
    const click = clickEvent({})

    listeners.notificationclick!(click.event as never)
    await click.settled()

    expect(focus).toHaveBeenCalled()
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('opens the start page for a notification with no link when no tab is open', async () => {
    const { scope, listeners, openWindow } = fakeScope()
    installHermesiPush(scope)
    const click = clickEvent(null)

    listeners.notificationclick!(click.event as never)
    await click.settled()

    expect(openWindow).toHaveBeenCalledWith(SCOPE)
  })

  it('looks at every tab of the site, including ones this worker does not control yet', async () => {
    const { scope, listeners } = fakeScope()
    installHermesiPush(scope)
    const click = clickEvent({})

    listeners.notificationclick!(click.event as never)
    await click.settled()

    expect(scope.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true })
  })
})
