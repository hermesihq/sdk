import { decodeSubscriberTokenExp } from './subscriberToken'
import {
  HermsApiError,
  type HermsChannel,
  type HermsClientOptions,
  type HermsEventListener,
  type HermsInboxCounts,
  type HermsInboxItem,
  type HermsInboxListParams,
  type HermsInboxPage,
  type HermsPreferences,
  type HermsPreferenceUpdate,
  type HermsRegisterChannelParams,
} from './types'

/**
 * `HermsClient` is the framework-agnostic core of the SDK, so that a Vue, Angular or
 * plain JavaScript page is a thin layer over it and not a second implementation. It has
 * **no import from `react` anywhere in this file**, and the state that sits on top of it
 * (the stores) lives in this package too. `@hermesihq/react` is a binding over both.
 *
 * SSR-safe (no `window` at import time): nothing at module scope or
 * in the constructor touches `window`/`EventSource`/`document`. Those are only
 * ever read inside `subscribe()`, and only once it actually runs (i.e. once a
 * consumer mounts on a real client).
 */

// The sanctioned degraded mode: clients that cannot hold an SSE connection fall
// back to polling `/counts` every 60s.
const POLL_INTERVAL_MS = 60_000

// After this many *consecutive*, immediate (no successful `onopen` in between)
// SSE failures, stop reconnecting into what's very likely a hard failure (an
// invalid/expired public key or subscriber token, a network that blocks SSE
// entirely) and lean on the polling fallback instead, still retrying SSE in
// the background at an increasingly long interval, never fully giving up.
const MAX_FAST_RECONNECT_ATTEMPTS = 3
const BASE_RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 30_000

// `onTokenExpiring` fires this many seconds *before* the currently held
// token's own `exp`, giving a host app a real window to refresh ahead of it
// actually expiring rather than reacting to a `401`.
const TOKEN_EXPIRY_BUFFER_SECONDS = 60

function backoffDelayMs(attempt: number): number {
  const exponential = BASE_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  return Math.min(MAX_RECONNECT_DELAY_MS, exponential)
}

function buildQueryString(params: Record<string, string | string[] | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item)
    } else {
      search.append(key, String(value))
    }
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

interface WireInboxCategory {
  key: string
  name: string
}

interface WireInboxItem {
  id: string
  title: string
  body: string
  action_url: string | null
  category: WireInboxCategory | null
  seen_at: string | null
  read_at: string | null
  created_at: string
}

interface WireInboxListResponse {
  data: WireInboxItem[]
  has_more: boolean
  next_cursor: string | null
}

interface WireInboxCountsResponse {
  unread: number
  unseen: number
}

interface WireUpdatedCountResponse {
  updated: number
}

function fromWireItem(wire: WireInboxItem): HermsInboxItem {
  return {
    id: wire.id,
    title: wire.title,
    body: wire.body,
    actionUrl: wire.action_url,
    category: wire.category ? { key: wire.category.key, name: wire.category.name } : null,
    seenAt: wire.seen_at,
    readAt: wire.read_at,
    createdAt: wire.created_at,
  }
}

interface WireChannelPreference {
  channel: HermsChannel
  enabled: boolean | null
}

interface WireCategoryPreference {
  category_id: string
  key: string
  name: string
  is_critical: boolean
  channels: WireChannelPreference[]
  email_enabled: boolean | null
  in_app_enabled: boolean | null
}

interface WirePreferencesResponse {
  first_name: string | null
  global_channels: WireChannelPreference[]
  global_email_enabled: boolean | null
  global_in_app_enabled: boolean | null
  categories: WireCategoryPreference[]
}

function fromWirePreferences(wire: WirePreferencesResponse): HermsPreferences {
  return {
    firstName: wire.first_name,
    globalChannels: wire.global_channels.map((c) => ({ channel: c.channel, enabled: c.enabled })),
    globalEmailEnabled: wire.global_email_enabled,
    globalInAppEnabled: wire.global_in_app_enabled,
    categories: wire.categories.map((category) => ({
      categoryId: category.category_id,
      key: category.key,
      name: category.name,
      isCritical: category.is_critical,
      channels: category.channels.map((c) => ({ channel: c.channel, enabled: c.enabled })),
      emailEnabled: category.email_enabled,
      inAppEnabled: category.in_app_enabled,
    })),
  }
}

export class HermsClient {
  private readonly options: HermsClientOptions
  private readonly baseUrl: string
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private lastScheduledExp: number | null = null

  constructor(options: HermsClientOptions) {
    this.options = options
    this.baseUrl = options.apiBaseUrl.replace(/\/+$/, '')
  }

  // --- Token handling ----------------------------------------------------

  /** Every request goes through here: always a *fresh* call to
   * `getSubscriberToken()` (never cached past what the host itself returns,
   * per this class's own contract), which also re-arms `onTokenExpiring`
   * against whatever token comes back. */
  private async getFreshToken(): Promise<string> {
    const token = await this.options.getSubscriberToken()
    this.scheduleExpiryHook(token)
    return token
  }

  private scheduleExpiryHook(token: string): void {
    const { onTokenExpiring } = this.options
    if (!onTokenExpiring) return
    const exp = decodeSubscriberTokenExp(token)
    if (exp === null || exp === this.lastScheduledExp) return
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer)
    this.lastScheduledExp = exp
    const delayMs = Math.max(0, exp * 1000 - TOKEN_EXPIRY_BUFFER_SECONDS * 1000 - Date.now())
    this.expiryTimer = setTimeout(() => {
      onTokenExpiring()
    }, delayMs)
  }

  /** Stops the scheduled `onTokenExpiring` timer. Called from
   * `HermsProvider`'s unmount cleanup so a torn-down client never fires the
   * hook after the app has stopped caring. */
  destroy(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
  }

  // --- Transport -----------------------------------------------------------

  /**
   * `expectsBody` is how this knows a missing response body is a failure rather than a
   * normal outcome. It defaults to `true` because most calls here read a payload; the
   * methods that resolve to `void` pass `false`.
   *
   * Without it the success path did no checking at all. A `200` carrying a proxy's HTML
   * page, or a `204` where a body was expected, left `parsed` null and returned it as
   * `T`, so `listInbox()` rejected with `TypeError: Cannot read properties of null
   * (reading 'data')` and the stack pointed at this SDK instead of at whatever was
   * actually in the way. The *error* path already handled exactly that case carefully;
   * only the success path did not.
   */
  private async request<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | string[] | number | undefined>; expectsBody?: boolean } = {}): Promise<T> {
    const token = await this.getFreshToken()
    const qs = init.query ? buildQueryString(init.query) : ''
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.publicKey}`,
      'X-Hermesi-Subscriber-Token': token,
      Accept: 'application/json',
    }
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'

    const response = await fetch(`${this.baseUrl}${path}${qs}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })

    const expectsBody = init.expectsBody ?? true

    if (response.status === 204) {
      if (expectsBody) throw new HermsApiError(response.status, null)
      return undefined as T
    }

    const rawText = await response.text()
    let parsed: unknown = null
    if (rawText) {
      try {
        parsed = JSON.parse(rawText)
      } catch {
        parsed = null
      }
    }

    if (!response.ok) {
      throw new HermsApiError(response.status, parsed)
    }
    // A 2xx that carries nothing usable where something was expected. Reported as a
    // `HermsApiError` like every other failure, so a consumer has one thing to catch.
    // It does not become their problem to distinguish a transport fault from a bug in
    // their own code, which a raw `TypeError` makes it.
    if (expectsBody && parsed === null) {
      throw new HermsApiError(response.status, null)
    }
    return parsed as T
  }

  // --- Inbox reads -----------------------------------------------------------

  async listInbox(params: HermsInboxListParams = {}): Promise<HermsInboxPage> {
    const wire = await this.request<WireInboxListResponse>('/inbox', {
      query: {
        limit: params.limit,
        cursor: params.cursor,
        read: params.status === undefined ? undefined : params.status === 'read' ? 'true' : 'false',
        category: params.category,
      },
    })
    return {
      items: wire.data.map(fromWireItem),
      hasMore: wire.has_more,
      nextCursor: wire.next_cursor,
    }
  }

  async getCounts(): Promise<HermsInboxCounts> {
    const wire = await this.request<WireInboxCountsResponse>('/inbox/counts')
    return { unread: wire.unread, unseen: wire.unseen }
  }

  // --- Inbox writes ------------------------------------------------------

  async markRead(id: string): Promise<HermsInboxItem> {
    const wire = await this.request<WireInboxItem>(`/inbox/${encodeURIComponent(id)}/read`, { method: 'POST' })
    return fromWireItem(wire)
  }

  async markAllRead(): Promise<{ updated: number }> {
    const wire = await this.request<WireUpdatedCountResponse>('/inbox/read-all', { method: 'POST' })
    return { updated: wire.updated }
  }

  async markSeen(ids: string[]): Promise<{ updated: number }> {
    if (ids.length === 0) return { updated: 0 }
    const wire = await this.request<WireUpdatedCountResponse>('/inbox/seen', { method: 'POST', body: { ids } })
    return { updated: wire.updated }
  }

  async archive(id: string): Promise<HermsInboxItem> {
    const wire = await this.request<WireInboxItem>(`/inbox/${encodeURIComponent(id)}/archive`, { method: 'POST' })
    return fromWireItem(wire)
  }

  async delete(id: string): Promise<void> {
    await this.request<void>(`/inbox/${encodeURIComponent(id)}`, { method: 'DELETE', expectsBody: false })
  }

  // --- Channels (device-token self-registration) --------------------------
  //
  // Where a subscriber can be reached on a channel that needs an address: a device
  // token, a chat conversation id. A failure is an ordinary `HermsApiError`, same as
  // any other endpoint.

  async registerChannel(params: HermsRegisterChannelParams): Promise<void> {
    await this.request<void>('/channels', {
      method: 'POST',
      expectsBody: false,
      body: { channel: params.channel, identifier: params.identifier, metadata: params.metadata },
    })
  }

  // --- Preferences -----------------------------------------------------------

  /**
   * The subscriber's own notification settings, for rendering a preference centre.
   *
   * There is deliberately no `unsubscribe()` beside this, although the API exposes
   * `POST /v1/client/unsubscribe`. That route is the target of a `List-Unsubscribe`
   * one-click link (RFC 8058): its token is minted by Hermesi and embedded in an
   * outgoing email's headers, and the API's own description says it is invoked by a
   * mail client rather than by application code. Wrapping it here would invite a host
   * to build an unsubscribe button on a token it cannot obtain. The equivalent here
   * is `updatePreference({ channel: 'email', enabled: false })`.
   */
  async getPreferences(): Promise<HermsPreferences> {
    return fromWirePreferences(await this.request<WirePreferencesResponse>('/preferences'))
  }

  /**
   * Change one setting, and receive the whole updated state back.
   *
   * The server answers `PATCH` with the full preferences rather than an
   * acknowledgement, so a caller never has to refetch, and never renders a view
   * assembled from its own optimistic guess plus whatever else has changed since.
   * Omit `categoryId` for the global setting; supply it to change one category.
   */
  async updatePreference(update: HermsPreferenceUpdate): Promise<HermsPreferences> {
    const wire = await this.request<WirePreferencesResponse>('/preferences', {
      method: 'PATCH',
      body: {
        channel: update.channel,
        enabled: update.enabled,
        // Sent as `null` rather than omitted: the API reads its absence and its null
        // the same way, and being explicit keeps "global" visible in a request log.
        category_id: update.categoryId ?? null,
      },
    })
    return fromWirePreferences(wire)
  }

  /**
   * **Path parameters, not a query string.** This sent
   * `DELETE /channels?channel=...&identifier=...` for as long as the method has existed,
   * and there is no `DELETE` on `/v1/client/channels` at all: the route is
   * `/v1/client/channels/{channel}/{identifier}`, so every call 404'd. Nothing caught
   * it: the reference integration never deregisters, and the package had no tests.
   *
   * `identifier` is encoded because it is somebody's address (an email, a phone
   * number, a chat conversation id), and those carry `@`, `+` and `:`.
   */
  async deregisterChannel(channel: HermsChannel, identifier: string): Promise<void> {
    await this.request<void>(`/channels/${encodeURIComponent(channel)}/${encodeURIComponent(identifier)}`, {
      method: 'DELETE',
      expectsBody: false,
    })
  }

  // --- Real-time -----------------------------------------------------------

  /**
   * Opens a live connection for real-time inbox events and returns an
   * unsubscribe function. SSR-safe: `window`/`EventSource` are only read here,
   * at call time, never at module or constructor time.
   *
   * - Prefers SSE (`GET /inbox/stream`) when `EventSource` exists.
   * - Falls back to polling `getCounts()` every 60s when `EventSource`
   *   doesn't exist at all, or after `MAX_FAST_RECONNECT_ATTEMPTS` consecutive
   *   immediate reconnect failures (an invalid/expired token, or a network
   *   that blocks SSE outright). It still retries SSE in the background with
   *   exponential backoff rather than abandoning it permanently, so a fixed
   *   token/network problem self-heals without a page reload.
   */
  subscribe(onEvent: HermsEventListener): () => void {
    let stopped = false
    let eventSource: InstanceType<typeof EventSource> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let consecutiveFailures = 0

    const hasEventSource = typeof window !== 'undefined' && typeof EventSource !== 'undefined'

    const startPolling = () => {
      if (pollTimer !== null) return
      pollTimer = setInterval(() => {
        this.getCounts()
          .then((counts) => onEvent({ type: 'counts.changed', data: counts }))
          .catch(() => {
            /* best-effort: try again next tick */
          })
      }, POLL_INTERVAL_MS)
    }

    const stopPolling = () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    const scheduleReconnect = () => {
      if (stopped) return
      consecutiveFailures += 1
      if (consecutiveFailures >= MAX_FAST_RECONNECT_ATTEMPTS) startPolling()
      const delay = backoffDelayMs(consecutiveFailures)
      reconnectTimer = setTimeout(() => {
        void connect()
      }, delay)
    }

    const connect = async () => {
      if (stopped || !hasEventSource) return
      let token: string
      try {
        token = await this.getFreshToken()
      } catch {
        scheduleReconnect()
        return
      }
      if (stopped) return

      const qs = buildQueryString({ public_key: this.options.publicKey, subscriber_token: token })
      const source = new EventSource(`${this.baseUrl}/inbox/stream${qs}`)
      eventSource = source

      source.addEventListener('item.created', (evt) => {
        consecutiveFailures = 0
        try {
          const data = JSON.parse((evt as MessageEvent<string>).data) as { id: string; title: string; created_at: string }
          onEvent({ type: 'item.created', data })
        } catch {
          /* malformed frame: ignore, next event still gets through */
        }
      })
      source.addEventListener('counts.changed', (evt) => {
        consecutiveFailures = 0
        try {
          const data = JSON.parse((evt as MessageEvent<string>).data) as HermsInboxCounts
          onEvent({ type: 'counts.changed', data })
        } catch {
          /* malformed frame: ignore */
        }
      })
      source.onopen = () => {
        consecutiveFailures = 0
        stopPolling()
      }
      source.onerror = () => {
        source.close()
        if (eventSource === source) eventSource = null
        if (!stopped) scheduleReconnect()
      }
    }

    if (hasEventSource) {
      void connect()
    } else {
      startPolling()
    }

    return () => {
      stopped = true
      stopPolling()
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      eventSource?.close()
    }
  }
}
