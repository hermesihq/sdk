/** The shapes the SDK sends and receives. */

/** A recipient described inline. Sent with an event, it creates or updates the subscriber on the fly. */
export interface Subscriber {
  externalId: string
  email?: string
  phoneE164?: string
  name?: string
  locale?: string
  data?: Record<string, unknown>
}

/** Who did the thing the event reports, for templates that say "Ada commented". */
export interface Actor {
  externalId?: string
  name?: string
}

/** A known subscriber's `externalId`, or one described inline. */
export type Recipient = string | Subscriber

export interface TriggerOptions {
  /**
   * Generated if you give none, and reused across retries. **Pass your own** when your code might run
   * twice for the same thing (a webhook handler, a queue consumer): only your key survives that.
   */
  idempotencyKey?: string
  actor?: Actor
  /** Hold the event back for an ISO 8601 duration such as `"PT15M"` (not `"15m"`). Not with `sendAt`; at most 30 days. */
  delay?: string
  /** Hold the event back until an instant: a `Date`, or an ISO 8601 string with an offset. Not with `delay`; at most 30 days ahead. */
  sendAt?: Date | string
  override?: Record<string, unknown>
  tenant?: string
}

/** One notification an event produced: which subscriber, through which workflow. */
export interface NotificationSummary {
  id: string
  subscriberId: string
  workflow: string
}

/** The answer to publishing an event. `202`: the event is recorded and queued, nothing is delivered yet. */
export interface EventResult {
  eventId: string
  status: string
  notifications: NotificationSummary[]
  warnings: string[]
  /** True when the server recognised the idempotency key and returned the original answer. */
  replayed: boolean
  /** The key the request went out with, generated if you gave none. Quote it to find the event again. */
  idempotencyKey: string
}

/** A hosted preference page for one subscriber. It needs no login and works for about a year. */
export interface PreferenceLink {
  url: string
}

/** What `simulate: true` records instead of sending, so a test can assert on it. */
export interface SimulatedEvent {
  name: string
  recipient: Recipient | Recipient[]
  /** The payload as it would have been sent: dates already text, so what you assert on is what production gets. */
  payload: Record<string, unknown>
  idempotencyKey: string
  /** Exactly the JSON body that would have been posted. */
  body: Record<string, unknown>
}

/** The part of a `Response` this package reads, so a `fetch` of your own (or a test double) only has to provide this much. */
export interface FetchResponse {
  status: number
  ok: boolean
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export interface FetchInit {
  method: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
  /** Always `manual`: a redirect would turn a POST into a GET and lose the event. */
  redirect?: 'manual' | 'follow' | 'error'
}

/** The global `fetch` fits this. */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>
