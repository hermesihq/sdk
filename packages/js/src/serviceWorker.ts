/**
 * The service worker half of Web Push: show what Hermesi sent, and open the link when it is clicked.
 *
 * A push service carries bytes and nothing else, so what appears on screen is decided by code on
 * your site, and this is that code. Hermesi sends one JSON object: `title` and `body`, and `image`,
 * `url` and `data` when the template has them. This turns it into a notification and handles the
 * click. Nothing here runs on a page; it is for a service worker script, either imported:
 *
 *   import { installHermesiPush } from '@hermesihq/js/service-worker'
 *   installHermesiPush(self)
 *
 * or loaded as a plain script when there is no build step:
 *
 *   importScripts('https://cdn.jsdelivr.net/npm/@hermesihq/js/dist/service-worker.global.js')
 *
 * Set `self.HERMESI_PUSH_OPTIONS = { icon: '/icon.png' }` before `importScripts` to pass options.
 */

export interface HermesiPushOptions {
  /** An image shown beside every notification, usually your logo. Hermesi does not send one. */
  icon?: string
  /** A small monochrome image for the status bar on Android. */
  badge?: string
  /** The title used when a push arrives with none, or with something that is not JSON. */
  fallbackTitle?: string
}

/** What Hermesi sends, after validation: every field is optional because the payload is untrusted. */
export interface HermesiPushPayload {
  title?: string
  body?: string
  image?: string
  url?: string
  data?: Record<string, string>
}

export interface HermesiNotification {
  title: string
  options: {
    body?: string
    image?: string
    icon?: string
    badge?: string
    data: Record<string, string>
  }
}

const DEFAULT_TITLE = 'Notification'

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The fields of a push payload that are usable, from whatever arrived. Anything that is not an
 * object gives an empty payload; a field of the wrong type is dropped rather than shown.
 */
export function parsePushPayload(raw: unknown): HermesiPushPayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const payload: HermesiPushPayload = {}
  const title = text(source.title)
  const body = text(source.body)
  const image = text(source.image)
  const url = text(source.url)
  if (title) payload.title = title
  if (body) payload.body = body
  if (image) payload.image = image
  if (url) payload.url = url
  if (typeof source.data === 'object' && source.data !== null && !Array.isArray(source.data)) {
    const data: Record<string, string> = {}
    for (const [key, value] of Object.entries(source.data)) if (typeof value === 'string') data[key] = value
    if (Object.keys(data).length > 0) payload.data = data
  }
  return payload
}

/** The arguments for `showNotification`. The link travels in the notification's `data.url`. */
export function notificationFor(payload: HermesiPushPayload, options: HermesiPushOptions = {}): HermesiNotification {
  const data: Record<string, string> = { ...payload.data }
  if (payload.url) data.url = payload.url
  return {
    title: payload.title ?? options.fallbackTitle ?? DEFAULT_TITLE,
    options: {
      ...(payload.body ? { body: payload.body } : {}),
      ...(payload.image ? { image: payload.image } : {}),
      ...(options.icon ? { icon: options.icon } : {}),
      ...(options.badge ? { badge: options.badge } : {}),
      data,
    },
  }
}

/**
 * Where a click should go, as an absolute `http` or `https` URL, or `null`. The link comes from a
 * template, so it is resolved against the worker's scope and anything that is not a web address
 * (`javascript:`, `data:`) is refused rather than opened.
 */
export function resolveClickTarget(url: unknown, scope: string): string | null {
  if (typeof url !== 'string' || url === '') return null
  try {
    const target = new URL(url, scope)
    return target.protocol === 'https:' || target.protocol === 'http:' ? target.href : null
  } catch {
    return null
  }
}

interface PushEventLike {
  data: { json(): unknown; text(): string } | null
  waitUntil(promise: Promise<unknown>): void
}

interface ClickEventLike {
  notification: { data: unknown; close(): void }
  waitUntil(promise: Promise<unknown>): void
}

interface WindowClientLike {
  url: string
  focus(): Promise<unknown>
}

/** The parts of a service worker's global scope this uses, so it can be driven by a test or typed
 *  without the `webworker` library, which cannot be loaded beside `DOM`. */
export interface ServiceWorkerScopeLike {
  addEventListener(type: 'push', listener: (event: PushEventLike) => void): void
  addEventListener(type: 'notificationclick', listener: (event: ClickEventLike) => void): void
  registration: {
    scope: string
    showNotification(title: string, options?: HermesiNotification['options']): Promise<void>
  }
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>
    openWindow(url: string): Promise<unknown>
  }
}

function payloadOf(event: PushEventLike): HermesiPushPayload {
  if (!event.data) return {}
  try {
    return parsePushPayload(event.data.json())
  } catch {
    // Not JSON: a sender that is not Hermesi, or a test push from a developer console. Show the
    // text rather than nothing, because a push that shows nothing makes some browsers show their
    // own "this site was updated in the background" notice instead.
    try {
      const body = text(event.data.text())
      return body ? { body } : {}
    } catch {
      return {}
    }
  }
}

/**
 * Wires a service worker to show Hermesi's notifications and handle their clicks. Call it once at
 * the top level of the worker script, because the browser only delivers events to listeners added
 * during the first run of the script.
 *
 * A click opens the notification's link in a tab already showing it if there is one, and in a new
 * tab otherwise. A notification with no link focuses a tab of your site, or opens its start page.
 */
export function installHermesiPush(scope: ServiceWorkerScopeLike, options: HermesiPushOptions = {}): void {
  scope.addEventListener('push', (event) => {
    const { title, options: shown } = notificationFor(payloadOf(event), options)
    event.waitUntil(scope.registration.showNotification(title, shown))
  })

  scope.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const data = event.notification.data as { url?: unknown } | null
    const target = resolveClickTarget(data?.url, scope.registration.scope)
    event.waitUntil(
      scope.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
        const open = target ? windows.find((client) => client.url === target) : windows[0]
        if (open) return open.focus()
        return scope.clients.openWindow(target ?? scope.registration.scope)
      }),
    )
  })
}
