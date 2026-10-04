import { describe, expect, it, vi } from 'vitest'
import { HermsApiError } from './types'
import type { HermsClient } from './HermsClient'
import { HermsWebPushError, disableWebPush, enableWebPush, isWebPushSupported } from './webPush'

/**
 * Driven with fakes of the browser objects, under `node`, which is the environment this package
 * promises to be importable in. What these tests cannot prove is that a real browser accepts the
 * calls; that is the one thing that needs a push service and a person, and is not faked here.
 */

const KEY_BYTES = Uint8Array.from([0x04, ...Array.from({ length: 64 }, (_, i) => i + 1)])
const KEY = btoa(String.fromCharCode(...KEY_BYTES)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const OTHER_KEY_BYTES = Uint8Array.from([0x04, ...Array.from({ length: 64 }, (_, i) => 200 - i)])

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc'

function fakeSubscription(applicationServerKey: Uint8Array | null = KEY_BYTES, endpoint = ENDPOINT) {
  return {
    endpoint,
    options: { applicationServerKey: applicationServerKey ? applicationServerKey.buffer.slice(0) : null },
    toJSON: () => ({ endpoint, keys: { p256dh: 'BROWSER_P256DH', auth: 'BROWSER_AUTH' } }),
    unsubscribe: vi.fn(async () => true),
  }
}

type FakeSubscription = ReturnType<typeof fakeSubscription>

function fakeRegistration(existing: FakeSubscription | null = null) {
  const created = fakeSubscription()
  return {
    created,
    pushManager: {
      getSubscription: vi.fn(async () => existing),
      subscribe: vi.fn(async () => created),
    },
  }
}

function fakeClient() {
  return {
    registerChannel: vi.fn(async () => undefined),
    deregisterChannel: vi.fn(async () => undefined),
  }
}

function stubBrowser(options: { permission?: NotificationPermission; answer?: NotificationPermission; registration?: unknown } = {}) {
  const requestPermission = vi.fn(async () => options.answer ?? 'granted')
  const notification = { permission: options.permission ?? 'granted', requestPermission }
  vi.stubGlobal('window', { PushManager: class {}, Notification: notification })
  vi.stubGlobal('Notification', notification)
  const serviceWorker = {
    register: vi.fn(async () => undefined),
    ready: Promise.resolve(options.registration),
    getRegistration: vi.fn(async () => options.registration),
  }
  vi.stubGlobal('navigator', { serviceWorker })
  return { requestPermission, serviceWorker }
}

const asClient = (client: ReturnType<typeof fakeClient>) => client as unknown as HermsClient
const asRegistration = (registration: unknown) => registration as ServiceWorkerRegistration

describe('isWebPushSupported', () => {
  it('is false on a server, where there is no navigator at all', () => {
    expect(isWebPushSupported()).toBe(false)
  })

  it('is true only when service workers, the Push API and notifications are all there', () => {
    stubBrowser()
    expect(isWebPushSupported()).toBe(true)

    vi.stubGlobal('window', {})
    expect(isWebPushSupported()).toBe(false)
  })
})

describe('enableWebPush', () => {
  it('subscribes and registers the endpoint with its keys and the webpush transport', async () => {
    const registration = fakeRegistration()
    stubBrowser({ registration })
    const client = fakeClient()

    const subscription = await enableWebPush(asClient(client), { vapidPublicKey: KEY, registration: asRegistration(registration) })

    expect(subscription).toBe(registration.created)
    expect(client.registerChannel).toHaveBeenCalledWith({
      channel: 'push',
      identifier: ENDPOINT,
      metadata: { platform: 'web', transport: 'webpush', p256dh: 'BROWSER_P256DH', auth: 'BROWSER_AUTH' },
    })
  })

  it('subscribes with the decoded key and userVisibleOnly', async () => {
    const registration = fakeRegistration()
    stubBrowser({ registration })

    await enableWebPush(asClient(fakeClient()), { vapidPublicKey: KEY, registration: asRegistration(registration) })

    const [args] = registration.pushManager.subscribe.mock.calls[0] as unknown as [{ userVisibleOnly: boolean; applicationServerKey: Uint8Array }]
    expect(args.userVisibleOnly).toBe(true)
    expect(Array.from(args.applicationServerKey)).toEqual(Array.from(KEY_BYTES))
  })

  it('does not let the caller override the transport or the keys, and lets them add metadata', async () => {
    const registration = fakeRegistration()
    stubBrowser({ registration })
    const client = fakeClient()

    await enableWebPush(asClient(client), {
      vapidPublicKey: KEY,
      registration: asRegistration(registration),
      metadata: { appVersion: '3.2.1', platform: 'pwa', transport: 'fcm', p256dh: 'x', auth: 'y' },
    })

    expect(client.registerChannel).toHaveBeenCalledWith({
      channel: 'push',
      identifier: ENDPOINT,
      metadata: { appVersion: '3.2.1', platform: 'pwa', transport: 'webpush', p256dh: 'BROWSER_P256DH', auth: 'BROWSER_AUTH' },
    })
  })

  it('reuses a subscription made with the same key, and registers it again', async () => {
    const existing = fakeSubscription(KEY_BYTES)
    const registration = fakeRegistration(existing)
    stubBrowser({ registration })
    const client = fakeClient()

    const subscription = await enableWebPush(asClient(client), { vapidPublicKey: KEY, registration: asRegistration(registration) })

    expect(subscription).toBe(existing)
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled()
    expect(existing.unsubscribe).not.toHaveBeenCalled()
    // Every call registers: it is an upsert, and it is what reactivates a device Hermesi had pruned.
    expect(client.registerChannel).toHaveBeenCalledTimes(1)
  })

  it('replaces a subscription made with a different key, which the browser would otherwise refuse to replace', async () => {
    const stale = fakeSubscription(OTHER_KEY_BYTES, 'https://fcm.googleapis.com/fcm/send/old')
    const registration = fakeRegistration(stale)
    stubBrowser({ registration })
    const client = fakeClient()

    const subscription = await enableWebPush(asClient(client), { vapidPublicKey: KEY, registration: asRegistration(registration) })

    expect(stale.unsubscribe).toHaveBeenCalledTimes(1)
    expect(subscription).toBe(registration.created)
    expect(client.registerChannel).toHaveBeenCalledWith(expect.objectContaining({ identifier: ENDPOINT }))
  })

  it('treats a subscription that reports no key as stale rather than reusing it', async () => {
    const unknown = fakeSubscription(null)
    const registration = fakeRegistration(unknown)
    stubBrowser({ registration })

    await enableWebPush(asClient(fakeClient()), { vapidPublicKey: KEY, registration: asRegistration(registration) })

    expect(unknown.unsubscribe).toHaveBeenCalled()
    expect(registration.pushManager.subscribe).toHaveBeenCalled()
  })

  describe('permission', () => {
    it('asks when it has not been decided, then goes on', async () => {
      const registration = fakeRegistration()
      const { requestPermission } = stubBrowser({ permission: 'default', answer: 'granted', registration })

      await enableWebPush(asClient(fakeClient()), { vapidPublicKey: KEY, registration: asRegistration(registration) })

      expect(requestPermission).toHaveBeenCalledTimes(1)
      expect(registration.pushManager.subscribe).toHaveBeenCalled()
    })

    it('does not ask again once it is granted', async () => {
      const registration = fakeRegistration()
      const { requestPermission } = stubBrowser({ permission: 'granted', registration })

      await enableWebPush(asClient(fakeClient()), { vapidPublicKey: KEY, registration: asRegistration(registration) })

      expect(requestPermission).not.toHaveBeenCalled()
    })

    it('does not ask when it is blocked, because asking does nothing', async () => {
      const registration = fakeRegistration()
      const { requestPermission } = stubBrowser({ permission: 'denied', registration })
      const client = fakeClient()

      await expect(enableWebPush(asClient(client), { vapidPublicKey: KEY, registration: asRegistration(registration) })).rejects.toMatchObject({
        name: 'HermsWebPushError',
        code: 'permission_denied',
      })
      expect(requestPermission).not.toHaveBeenCalled()
      expect(registration.pushManager.subscribe).not.toHaveBeenCalled()
      expect(client.registerChannel).not.toHaveBeenCalled()
    })

    it('says denied when the person refuses the prompt, and dismissed when they close it', async () => {
      const registration = fakeRegistration()
      stubBrowser({ permission: 'default', answer: 'denied', registration })
      await expect(
        enableWebPush(asClient(fakeClient()), { vapidPublicKey: KEY, registration: asRegistration(registration) }),
      ).rejects.toMatchObject({ code: 'permission_denied' })

      stubBrowser({ permission: 'default', answer: 'default', registration })
      await expect(
        enableWebPush(asClient(fakeClient()), { vapidPublicKey: KEY, registration: asRegistration(registration) }),
      ).rejects.toMatchObject({ code: 'permission_dismissed' })
    })

    it('is asked before anything is registered or subscribed, so a refusal leaves no trace', async () => {
      const registration = fakeRegistration()
      const { serviceWorker } = stubBrowser({ permission: 'denied', registration })

      await expect(enableWebPush(asClient(fakeClient()), { vapidPublicKey: KEY, serviceWorkerUrl: '/sw.js' })).rejects.toBeInstanceOf(
        HermsWebPushError,
      )
      expect(serviceWorker.register).not.toHaveBeenCalled()
    })
  })

  describe('the service worker', () => {
    it('registers serviceWorkerUrl and subscribes through the ready registration', async () => {
      const registration = fakeRegistration()
      const { serviceWorker } = stubBrowser({ registration })

      await enableWebPush(asClient(fakeClient()), { vapidPublicKey: KEY, serviceWorkerUrl: '/sw.js' })

      expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js')
      expect(registration.pushManager.subscribe).toHaveBeenCalled()
    })

    it('uses a service worker already registered when given neither', async () => {
      const registration = fakeRegistration()
      const { serviceWorker } = stubBrowser({ registration })

      await enableWebPush(asClient(fakeClient()), { vapidPublicKey: KEY })

      expect(serviceWorker.register).not.toHaveBeenCalled()
      expect(registration.pushManager.subscribe).toHaveBeenCalled()
    })

    it('says so when there is none to use, rather than waiting for one that never comes', async () => {
      stubBrowser({ registration: undefined })

      await expect(enableWebPush(asClient(fakeClient()), { vapidPublicKey: KEY })).rejects.toMatchObject({ code: 'no_service_worker' })
    })

    it('prefers an explicit registration over serviceWorkerUrl', async () => {
      const mine = fakeRegistration()
      const { serviceWorker } = stubBrowser({ registration: fakeRegistration() })

      await enableWebPush(asClient(fakeClient()), { vapidPublicKey: KEY, serviceWorkerUrl: '/sw.js', registration: asRegistration(mine) })

      expect(serviceWorker.register).not.toHaveBeenCalled()
      expect(mine.pushManager.subscribe).toHaveBeenCalled()
    })
  })

  describe('the key', () => {
    it.each([
      ['not base64', '***'],
      ['too short', 'AAAA'],
      ['a compressed point', btoa(String.fromCharCode(0x02, ...Array.from({ length: 32 }, () => 1))).replace(/=+$/, '')],
      ['empty', ''],
    ])('refuses %s before touching the browser', async (_name, key) => {
      const registration = fakeRegistration()
      const { requestPermission } = stubBrowser({ permission: 'default', registration })

      await expect(enableWebPush(asClient(fakeClient()), { vapidPublicKey: key, registration: asRegistration(registration) })).rejects.toMatchObject({
        code: 'invalid_key',
      })
      expect(requestPermission).not.toHaveBeenCalled()
    })

    it('accepts base64 padding, which some tools print', async () => {
      const registration = fakeRegistration()
      stubBrowser({ registration })

      await enableWebPush(asClient(fakeClient()), { vapidPublicKey: `${KEY}=`, registration: asRegistration(registration) })

      expect(registration.pushManager.subscribe).toHaveBeenCalled()
    })
  })

  it('says unsupported where there is no Push API', async () => {
    vi.stubGlobal('navigator', {})

    await expect(enableWebPush(asClient(fakeClient()), { vapidPublicKey: KEY })).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('refuses a subscription that comes back without its keys', async () => {
    const registration = fakeRegistration()
    registration.created.toJSON = () => ({ endpoint: ENDPOINT, keys: { p256dh: 'x' } }) as never
    stubBrowser({ registration })
    const client = fakeClient()

    await expect(
      enableWebPush(asClient(client), { vapidPublicKey: KEY, registration: asRegistration(registration) }),
    ).rejects.toMatchObject({ code: 'no_keys' })
    expect(client.registerChannel).not.toHaveBeenCalled()
  })

  it('keeps the browser subscription when Hermesi refuses the registration, so calling again retries', async () => {
    const registration = fakeRegistration()
    stubBrowser({ registration })
    const client = fakeClient()
    client.registerChannel.mockRejectedValueOnce(new HermsApiError(503, { error: { type: 'internal_error', code: 'unavailable', message: 'down' } }))

    await expect(enableWebPush(asClient(client), { vapidPublicKey: KEY, registration: asRegistration(registration) })).rejects.toBeInstanceOf(
      HermsApiError,
    )
    expect(registration.created.unsubscribe).not.toHaveBeenCalled()
  })
})

describe('disableWebPush', () => {
  it('tells Hermesi, then unsubscribes the browser', async () => {
    const existing = fakeSubscription()
    const registration = fakeRegistration(existing)
    stubBrowser({ registration })
    const client = fakeClient()
    const order: string[] = []
    client.deregisterChannel.mockImplementation(async () => void order.push('hermesi'))
    existing.unsubscribe.mockImplementation(async () => (order.push('browser'), true))

    const stopped = await disableWebPush(asClient(client), { registration: asRegistration(registration) })

    expect(stopped).toBe(true)
    expect(client.deregisterChannel).toHaveBeenCalledWith('push', ENDPOINT)
    expect(order).toEqual(['hermesi', 'browser'])
  })

  it('leaves the subscription alone when Hermesi could not be told, so it can be retried', async () => {
    const existing = fakeSubscription()
    const registration = fakeRegistration(existing)
    stubBrowser({ registration })
    const client = fakeClient()
    client.deregisterChannel.mockRejectedValueOnce(new Error('offline'))

    await expect(disableWebPush(asClient(client), { registration: asRegistration(registration) })).rejects.toThrow('offline')
    expect(existing.unsubscribe).not.toHaveBeenCalled()
  })

  it('does nothing, and says so, when there is no subscription', async () => {
    const registration = fakeRegistration(null)
    stubBrowser({ registration })
    const client = fakeClient()

    expect(await disableWebPush(asClient(client), { registration: asRegistration(registration) })).toBe(false)
    expect(client.deregisterChannel).not.toHaveBeenCalled()
  })

  it('finds this page’s registration when none is given', async () => {
    const existing = fakeSubscription()
    const registration = fakeRegistration(existing)
    stubBrowser({ registration })
    const client = fakeClient()

    expect(await disableWebPush(asClient(client))).toBe(true)
    expect(client.deregisterChannel).toHaveBeenCalledWith('push', ENDPOINT)
  })

  it('is a quiet false where Web Push does not exist', async () => {
    expect(await disableWebPush(asClient(fakeClient()))).toBe(false)
  })
})
