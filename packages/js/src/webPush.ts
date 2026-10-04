/**
 * Browser push, from the page: ask for permission, subscribe, and tell Hermesi where to send.
 *
 * A browser subscription is an endpoint URL and two keys. Hermesi stores the endpoint as the
 * device's identifier and the keys beside it, with `transport: 'webpush'`, which is how it knows
 * to send this device through Web Push and not through Firebase. This file does the three steps
 * that go wrong when written by hand: asking for permission in the right order, replacing a
 * subscription made with an older key, and registering what the browser returned.
 *
 * Everything is read at call time, so importing this on a server is safe.
 */
import type { HermsClient } from './HermsClient'

export type HermsWebPushErrorCode =
  /** This browser has no service workers, Push API or Notifications: an old browser, or an iPhone
   *  page that has not been added to the home screen. */
  | 'unsupported'
  /** The person, or their browser settings, refused notifications. Asking again does nothing. */
  | 'permission_denied'
  /** The permission prompt was closed without an answer. Asking again later is fine. */
  | 'permission_dismissed'
  /** `vapidPublicKey` is not a VAPID public key. */
  | 'invalid_key'
  /** There is no service worker to subscribe through, and no `serviceWorkerUrl` to make one. */
  | 'no_service_worker'
  /** The browser returned a subscription without its encryption keys. */
  | 'no_keys'

/**
 * Why a push call could not be completed in the browser, as opposed to `HermsApiError`, which is
 * the server refusing. Branch on `code`; the message is for a developer.
 */
export class HermsWebPushError extends Error {
  readonly code: HermsWebPushErrorCode

  constructor(code: HermsWebPushErrorCode, message: string) {
    super(message)
    this.name = 'HermsWebPushError'
    this.code = code
  }
}

export interface EnableWebPushOptions {
  /**
   * The VAPID public key of the Web Push provider configured in Hermesi, as base64url. The
   * Providers screen shows it with a Copy button. A browser binds each subscription to this exact
   * value, so it must be the one that matches the private key saved in Hermesi.
   */
  vapidPublicKey: string
  /**
   * Where your service worker script is served from. It is registered if no `registration` is
   * given. Without either, a service worker you already registered is used.
   */
  serviceWorkerUrl?: string
  /** A registration you made yourself. Wins over `serviceWorkerUrl`. */
  registration?: ServiceWorkerRegistration
  /**
   * Extra metadata stored with the device, for example `{ appVersion: '3.2.1' }`. `platform` is
   * `web` unless you set it. `transport` and the subscription keys are not yours to override.
   */
  metadata?: Record<string, unknown>
}

export interface DisableWebPushOptions {
  /** A registration you made yourself. Otherwise the one for this page is used. */
  registration?: ServiceWorkerRegistration
}

/** True when this browser can do Web Push at all. */
export function isWebPushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  )
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.trim().replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function applicationServerKey(vapidPublicKey: string): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = decodeBase64Url(vapidPublicKey)
  } catch {
    throw new HermsWebPushError('invalid_key', 'vapidPublicKey is not base64url.')
  }
  // An uncompressed P-256 point. Anything else makes the browser throw an opaque DOMException.
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new HermsWebPushError('invalid_key', 'vapidPublicKey must decode to 65 bytes starting with 0x04.')
  }
  return bytes
}

function sameBytes(left: ArrayBuffer | null | undefined, right: Uint8Array): boolean {
  if (!left) return false
  const a = new Uint8Array(left)
  return a.length === right.length && a.every((byte, index) => byte === right[index])
}

async function ensurePermission(): Promise<void> {
  if (Notification.permission === 'granted') return
  if (Notification.permission === 'denied') {
    throw new HermsWebPushError('permission_denied', 'Notifications are blocked for this site.')
  }
  // Must run inside a click or tap handler: browsers ignore the prompt otherwise.
  const answer = await Notification.requestPermission()
  if (answer === 'denied') throw new HermsWebPushError('permission_denied', 'Notifications were refused.')
  if (answer !== 'granted') throw new HermsWebPushError('permission_dismissed', 'The permission prompt was dismissed.')
}

async function findRegistration(options: { registration?: ServiceWorkerRegistration; serviceWorkerUrl?: string }): Promise<ServiceWorkerRegistration> {
  if (options.registration) return options.registration
  if (options.serviceWorkerUrl) {
    await navigator.serviceWorker.register(options.serviceWorkerUrl)
    // `ready` waits for the worker to be active, which a subscription needs.
    return navigator.serviceWorker.ready
  }
  const existing = await navigator.serviceWorker.getRegistration()
  if (!existing) {
    throw new HermsWebPushError('no_service_worker', 'No service worker is registered. Pass serviceWorkerUrl or registration.')
  }
  return existing
}

/**
 * Subscribes this browser to push and registers it with Hermesi.
 *
 * Call it from a click or tap handler, because it may show the permission prompt. It is safe to
 * call again on every page load: an existing subscription is reused, and the registration is an
 * upsert that also reactivates a device Hermesi had marked invalid. A subscription made with a
 * different VAPID key (you rotated it) is replaced, because the browser would refuse a new one
 * while the old one stands.
 *
 * Resolves with the browser's `PushSubscription`. Rejects with `HermsWebPushError` for what the
 * browser or the person decided, and with `HermsApiError` if Hermesi refused the registration, in
 * which case the browser subscription is kept and calling again retries the registration.
 */
export async function enableWebPush(client: HermsClient, options: EnableWebPushOptions): Promise<PushSubscription> {
  if (!isWebPushSupported()) {
    throw new HermsWebPushError('unsupported', 'This browser does not support Web Push.')
  }
  const key = applicationServerKey(options.vapidPublicKey)
  await ensurePermission()
  const registration = await findRegistration(options)

  let subscription = await registration.pushManager.getSubscription()
  if (subscription && !sameBytes(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource })

  const { endpoint, keys } = subscription.toJSON()
  if (!endpoint || !keys?.p256dh || !keys.auth) {
    throw new HermsWebPushError('no_keys', 'The browser returned a push subscription without its keys.')
  }
  await client.registerChannel({
    channel: 'push',
    identifier: endpoint,
    metadata: { platform: 'web', ...options.metadata, transport: 'webpush', p256dh: keys.p256dh, auth: keys.auth },
  })
  return subscription
}

/**
 * Stops push to this browser: tells Hermesi, then unsubscribes. Use it on sign-out or when the
 * person turns notifications off in your settings. Resolves `false` if there was nothing to stop.
 *
 * Hermesi is told first. If that fails the subscription is left alone, so the error can be
 * retried; the other order could leave Hermesi sending to a subscription the browser dropped,
 * which it would only learn when the push service answers that it is gone.
 */
export async function disableWebPush(client: HermsClient, options: DisableWebPushOptions = {}): Promise<boolean> {
  if (!isWebPushSupported()) return false
  const registration = options.registration ?? (await navigator.serviceWorker.getRegistration())
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return false
  await client.deregisterChannel('push', subscription.endpoint)
  await subscription.unsubscribe()
  return true
}
