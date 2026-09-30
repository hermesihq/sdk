/**
 * Shared, framework-agnostic shapes for `HermsClient`, the stores, and every binding
 * built on top of them. Camel-cased on purpose. The wire (`/v1/client/inbox/*`)
 * is snake_case; `HermsClient` is the one place that translation happens.
 */

export interface HermsClientOptions {
  /** `hm_pk_<env>_<random>`, safe to embed in a browser bundle (it grants
   * nothing by itself). */
  publicKey: string
  /** Base URL of the client API, e.g. `https://api.hermesi.dev/v1/client` or,
   * same-origin behind a dev proxy, `/v1/client`. No trailing slash required:
   * normalised internally. */
  apiBaseUrl: string
  /**
   * Host-app-supplied. This SDK never has the secret key and never could
   * (a subscriber token is minted server-side, by the host's own
   * backend). Called fresh before *every* request; never cached past what the
   * host itself returns, since refreshing ahead of expiry is explicitly the
   * host's job, not this client's (see `onTokenExpiring`).
   */
  getSubscriberToken: () => string | Promise<string>
  /**
   * Called proactively, once, some seconds before the *currently held* token's
   * own `exp` claim (read back out of the token's payload segment client-side:
   * it's HMAC-signed, not encrypted, so this never requires verifying the
   * signature). This is a hook for the host app to refresh ahead of expiry rather
   * than reactively after a `401`. Best-effort: a token whose payload can't be
   * decoded (malformed, or a host app testing with a garbage string) simply
   * never schedules a call.
   */
  onTokenExpiring?: () => void
}

export type HermsInboxReadStatus = 'read' | 'unread'

export interface HermsInboxCategory {
  key: string
  name: string
}

export interface HermsInboxItem {
  id: string
  title: string
  body: string
  actionUrl: string | null
  category: HermsInboxCategory | null
  seenAt: string | null
  readAt: string | null
  createdAt: string
}

export interface HermsInboxCounts {
  unread: number
  unseen: number
}

export interface HermsInboxPage {
  items: HermsInboxItem[]
  hasMore: boolean
  nextCursor: string | null
}

export interface HermsInboxListParams {
  /** Maps to `GET /inbox?read=<bool>`: `'read'` -> `read=true`, `'unread'` ->
   * `read=false`, omitted -> both. */
  status?: HermsInboxReadStatus
  /** Category key(s), `?category=` (repeatable server-side). */
  category?: string | string[]
  cursor?: string
  limit?: number
}

/**
 * Every channel Hermesi can hold an identity for.
 *
 * **Written out, and checked against the API by a test rather than trusted.** This
 * union said `'push' | 'sms' | 'email' | 'in_app'` while the platform had grown to
 * nine, so an integrator could not register a Telegram or Slack identity at all:
 * TypeScript refused it at their call site, and nothing had any reason to notice,
 * because no example registered a channel.
 *
 * It cannot be generated: this package is published standalone and has no API schema
 * to read at build time. So a check that lives with the API compares it to the API's
 * published `Channel` enum on every change. The list stays hand-written, and drifting
 * from the server is what fails.
 *
 * `push` is included because the API accepts it. No adapter delivers it today, which is
 * a deployment fact rather than a reason to refuse the identity.
 *
 * Exported as a value, not only a type: a host building a preference centre needs to
 * iterate the channels at runtime, and deriving the type from the array means the two
 * cannot disagree.
 */
export const HERMS_CHANNELS = [
  'in_app',
  'email',
  'push',
  'sms',
  'whatsapp',
  'telegram',
  'slack',
  'teams',
  'discord',
] as const

export type HermsChannel = (typeof HERMS_CHANNELS)[number]

export interface HermsRegisterChannelParams {
  channel: HermsChannel
  identifier: string
  metadata?: Record<string, unknown>
}

/** One channel's setting, either globally or inside a category. `null` means the
 *  subscriber has expressed no preference and the category's or platform's default
 *  applies. It is not the same as `false`, and collapsing the two would silently
 *  opt somebody out of something they never declined. */
export interface HermsChannelPreference {
  channel: HermsChannel
  enabled: boolean | null
}

export interface HermsCategoryPreference {
  categoryId: string
  key: string
  name: string
  /** A critical category is always delivered on every live channel and cannot be turned
   *  off. Render it, but not as a control: an affordance that refuses is worse than
   *  none. */
  isCritical: boolean
  channels: HermsChannelPreference[]
  emailEnabled: boolean | null
  inAppEnabled: boolean | null
}

export interface HermsPreferences {
  /** For addressing the subscriber in a preference page's own copy. `null` when the
   *  application never supplied one. */
  firstName: string | null
  /** Settings that apply across every category. */
  globalChannels: HermsChannelPreference[]
  /** `email` and `in_app` again, as scalars.
   *
   *  Carried rather than dropped because the API publishes them, and dropping a
   *  published field is the defect `HermsApiError` had. They are the same values as
   *  the matching entries in `globalChannels`; read whichever suits, but do not treat
   *  a disagreement between them as meaningful. */
  globalEmailEnabled: boolean | null
  globalInAppEnabled: boolean | null
  categories: HermsCategoryPreference[]
}

/** One setting to change. Omit `categoryId` to change the global setting for that
 *  channel; supply it to change the setting inside one category. */
export interface HermsPreferenceUpdate {
  channel: HermsChannel
  enabled: boolean
  categoryId?: string
}

export interface HermsItemCreatedEvent {
  type: 'item.created'
  data: { id: string; title: string; created_at: string }
}

export interface HermsCountsChangedEvent {
  type: 'counts.changed'
  data: HermsInboxCounts
}

export type HermsRealtimeEvent = HermsItemCreatedEvent | HermsCountsChangedEvent

export type HermsEventListener = (event: HermsRealtimeEvent) => void

/**
 * One specific problem inside an error.
 *
 * Open, not closed, because the API says so: most entries name a request field
 * (`field` + `issue`), some name a dependency instead, and its own schema declares
 * `additionalProperties` rather than publishing a shape a client would be right to
 * reject on. Typing it closed here would reintroduce exactly that.
 */
export type HermsErrorDetail = Record<string, unknown>

/** Thrown for any failed request to the client API. It mirrors the server's error
 * envelope where one was returned, and falls back to a generic shape when the body was
 * not JSON at all, which is usually an upstream proxy's own HTML error page.
 *
 * `detail` and `docUrl` were missing for a long time while the API published both as
 * required fields. A 422's per-field `detail` reached a consumer as a bare sentence,
 * and `doc_url` (the one thing that lets an integrator resolve an error without
 * asking anybody) never arrived at all. */
export class HermsApiError extends Error {
  readonly status: number
  readonly code: string
  readonly type: string
  readonly requestId: string
  /** Per-problem specifics. Possibly empty, never absent: the API's own words. */
  readonly detail: readonly HermsErrorDetail[]
  /** Documentation for this `code`, or `''` when the server sent none. */
  readonly docUrl: string

  constructor(status: number, body: unknown) {
    const envelope =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as {
            error?: {
              type?: unknown
              code?: unknown
              message?: unknown
              request_id?: unknown
              detail?: unknown
              doc_url?: unknown
            }
          }).error
        : undefined
    const message = typeof envelope?.message === 'string' ? envelope.message : `Hermesi client API request failed with status ${status}.`
    super(message)
    this.name = 'HermsApiError'
    this.status = status
    this.code = typeof envelope?.code === 'string' ? envelope.code : 'unknown_error'
    this.type = typeof envelope?.type === 'string' ? envelope.type : 'unknown_error'
    this.requestId = typeof envelope?.request_id === 'string' ? envelope.request_id : ''
    // `[]` rather than `undefined` when absent: the API documents this as possibly
    // empty and never absent, so a consumer should be able to iterate it without a
    // guard whatever actually arrived.
    this.detail = Array.isArray(envelope?.detail)
      ? (envelope.detail as HermsErrorDetail[]).filter(
          (entry): entry is HermsErrorDetail => typeof entry === 'object' && entry !== null,
        )
      : []
    this.docUrl = typeof envelope?.doc_url === 'string' ? envelope.doc_url : ''
  }
}
