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

// --- the rest of the server API: events read back, subscribers, direct messages ---------------------

/**
 * The profile fields of `subscribers.put` and `patch`. **A value you give is set, `null` clears the field, and a field you leave out
 * (or set to `undefined`) is left alone**, so a sync job that knows half a profile does not blank the other half.
 */
export interface SubscriberFields {
  email?: string | null
  phoneE164?: string | null
  firstName?: string | null
  lastName?: string | null
  locale?: string | null
  timezone?: string | null
  avatarUrl?: string | null
  /** Attributes for template variables, at most 32 KB. **Replaces** what is stored; it is not merged. */
  data?: Record<string, unknown> | null
}

/** One row of `subscribers.bulk`: an `externalId` and any of the fields `put` takes, with the same meaning. */
export interface BulkSubscriberRow extends SubscriberFields {
  externalId: string
}

/** One row of a bulk import, as it came out. */
export interface BulkSubscriberResult {
  externalId: string
  id: string
  /** `created`: a subscriber that did not exist (or had been deleted, which comes back empty). `updated`: one that did. */
  status: string
}

/** The answer to `subscribers.bulk`: one entry per row you sent, in the same order. */
export interface BulkSubscribersResult {
  created: number
  updated: number
  subscribers: BulkSubscriberResult[]
}

/** A destination registered for a subscriber: a device token, a chat id, a Web Push endpoint. */
export interface ChannelIdentity {
  channel: string
  identifier: string
  /** `active`, or `invalid` / `unsubscribed` once a provider or the person said so. */
  state: string
  stateReason: string | null
  metadata: Record<string, unknown>
  verifiedAt: string | null
  lastUsedAt: string | null
}

/** The overrides a subscriber has stored. A channel or category that is absent has none and follows the category's default. */
export interface Preferences {
  /** Per channel, for every category: `{ sms: false }`. */
  global: Record<string, boolean>
  /** Per category key, then per channel: `{ marketing: { email: false } }`. */
  categories: Record<string, Record<string, boolean>>
}

/** What `subscribers.updatePreferences` takes. `true` or `false` sets an override; `null` removes it. */
export interface PreferenceChanges {
  global?: Record<string, boolean | null>
  categories?: Record<string, Record<string, boolean | null>>
}

/** What Hermesi holds about a subscriber. (`Subscriber` is the shape you *send* inline with an event.) */
export interface SubscriberProfile {
  id: string
  externalId: string
  email: string | null
  phoneE164: string | null
  firstName: string | null
  lastName: string | null
  locale: string | null
  timezone: string | null
  avatarUrl: string | null
  data: Record<string, unknown>
  createdAt: string | null
  updatedAt: string | null
  channels: ChannelIdentity[]
  preferences: Preferences
}

/** A message and how far it got. */
export interface Message {
  id: string
  channel: string
  /** `queued`, `routing`, `sent`, `delivered`, `opened`, `clicked`, or a refusal: `failed`, `bounced`, `suppressed`, `skipped`, `cancelled`. */
  status: string
  stepKey: string | null
  provider: string | null
  failureCode: string | null
  failureMessage: string | null
  createdAt: string | null
  terminalAt: string | null
  /** True once nothing more will happen to this message. */
  isFinal: boolean
}

/** One run of one workflow for one recipient, with the messages it produced. */
export interface RunNotification {
  id: string
  subscriberId: string
  externalId: string
  workflow: string | null
  workflowVersion: number | null
  status: string
  createdAt: string | null
  startedAt: string | null
  completedAt: string | null
  /** While `waiting`: when the run goes on (a delay, a schedule, or a fallback window). */
  resumeAt: string | null
  messages: Message[]
}

/** An event and everything it caused: `events.get(eventId)`. */
export interface EventRun {
  eventId: string
  name: string
  /** `processed`, `no_workflow` (no active workflow matched), or `invalid` (a strict payload schema refused it). */
  status: string
  payload: Record<string, unknown>
  actor: Record<string, unknown> | null
  idempotencyKey: string | null
  error: Record<string, unknown> | null
  receivedAt: string | null
  processedAt: string | null
  notifications: RunNotification[]
  /** Every message of every notification, flattened. */
  messages: Message[]
}

/** What `messages.send` takes. */
export interface SendMessageInput {
  /** The channel to send on. This is the one thing an event leaves to Hermesi. */
  channel: string
  recipient: Recipient
  /** The key of a published template with a variant for the channel. There is no inline content: it would put copy back in your code. */
  template: string
  /** A category key. Its preference matrix applies; a critical category bypasses preferences but never a suppression. */
  category?: string
  /** Variables for the template, available there as `payload.*`. Not kept once a provider has the message. */
  data?: Record<string, unknown>
  priority?: 'critical' | 'default' | 'bulk'
}

export interface SendMessageOptions {
  /**
   * Generated if you give none, and reused across retries. **Pass your own** when your code might run twice for the same thing:
   * for an OTP the difference is one SMS or two.
   */
  idempotencyKey?: string
}

/** One message a direct send created. */
export interface MessageCreated {
  id: string
  channel: string
  /** `queued` when it will be sent; `skipped` or `suppressed` when preferences or the suppression list refused it. */
  status: string
  reason: string | null
}

/** The answer to `messages.send`. `202`: recorded and queued, nothing is delivered yet. */
export interface MessageResult {
  messageId: string
  status: string
  messages: MessageCreated[]
  /** True when the server recognised the idempotency key and returned the original answer instead of sending again. */
  replayed: boolean
  idempotencyKey: string
}

/** What `simulate: true` records for every call that is not an event, so a test can assert on it. */
export interface SimulatedCall {
  method: string
  path: string
  /** Exactly the JSON body that would have been sent, if there is one. */
  body: Record<string, unknown> | null
  idempotencyKey: string | null
}
