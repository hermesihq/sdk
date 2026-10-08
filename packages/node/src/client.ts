/**
 * The client.
 *
 * Thin on purpose. It builds a request, sends it with retries, and turns the answer into a typed
 * result or an error. It makes no decision about notifications: that is the platform's job, and an
 * SDK that decides is a second implementation of it.
 */

import { HermesiAPIError, HermesiConnectionError, HermesiSimulationError, errorFromResponse } from './errors.ts'
import {
  isRecord,
  parseBulkResult,
  parseChannelIdentity,
  parseEventRun,
  parseJson,
  parseMessage,
  parseMessageResult,
  parsePreferences,
  parseProfile,
} from './read.ts'
import {
  type RetryOptions,
  type RetryPolicy,
  isRetryableStatus,
  parseRetryAfter,
  resolveRetry,
  retryDelay,
} from './retry.ts'
import { encodeJson } from './serialize.ts'
import { type MintOptions, mintSubscriberToken } from './tokens.ts'
import type {
  BulkSubscriberRow,
  BulkSubscribersResult,
  ChannelIdentity,
  EventResult,
  EventRun,
  FetchLike,
  Message,
  MessageResult,
  NotificationSummary,
  PreferenceChanges,
  PreferenceLink,
  Preferences,
  Recipient,
  SendMessageInput,
  SendMessageOptions,
  SimulatedCall,
  SimulatedEvent,
  SubscriberFields,
  SubscriberProfile,
  TriggerOptions,
} from './types.ts'
import { VERSION } from './version.ts'

const DEFAULT_TIMEOUT_MS = 30_000
const ENV_KEY = 'HERMESI_SECRET_KEY'
const ENV_URL = 'HERMESI_BASE_URL'

export interface HermesiOptions {
  /** Your secret key, `hm_sk_...`, server side only. Read from `HERMESI_SECRET_KEY` if not given. */
  apiKey?: string
  /** Where Hermesi runs, for example `https://your-hermesi-host`. Read from `HERMESI_BASE_URL` if not given. */
  baseUrl?: string
  /** How long one attempt may take, in milliseconds. Default 30000. Each retry gets its own. */
  timeoutMs?: number
  retry?: RetryOptions
  /**
   * Send nothing: record the events in `hermesi.simulated` and every other write in `hermesi.simulatedCalls`. No key or URL needed.
   * A read (`events.get`, `subscribers.get`, `messages.get`...) throws `HermesiSimulationError`: there is nothing to read.
   */
  simulate?: boolean
  /** A `fetch` of your own. Default: the global one. */
  fetch?: FetchLike
  /** How retries wait, in milliseconds. For tests. */
  sleep?: (ms: number) => Promise<void>
}

interface Received {
  status: number
  ok: boolean
  text: string
  retryAfter: string | null
  replayed: boolean
}

function environment(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.[name]
}

function describe(cause: unknown, timeoutMs: number): string {
  if (cause instanceof Error && cause.name === 'TimeoutError') return `no answer within ${timeoutMs} ms`
  const inner = cause instanceof Error ? (cause as { cause?: unknown }).cause : undefined
  const code = typeof inner === 'object' && inner !== null ? (inner as { code?: unknown }).code : undefined
  const message = cause instanceof Error ? cause.message : String(cause)
  return typeof code === 'string' ? `${message} (${code})` : message
}

function recipientWire(recipient: Recipient | Recipient[]): unknown {
  if (Array.isArray(recipient)) return recipient.map(recipientWire)
  if (typeof recipient === 'string') return recipient
  const wire: Record<string, unknown> = { external_id: recipient.externalId }
  if (recipient.email !== undefined) wire.email = recipient.email
  if (recipient.phoneE164 !== undefined) wire.phone_e164 = recipient.phoneE164
  if (recipient.name !== undefined) wire.name = recipient.name
  if (recipient.locale !== undefined) wire.locale = recipient.locale
  if (recipient.data !== undefined) wire.data = recipient.data
  return wire
}

function instant(value: Date | string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('sendAt is an invalid Date')
    return value.toISOString()
  }
  return value
}

/** A path segment for an id. `.` and `..` are refused: a URL parser resolves them (even as `%2e`), which would aim the request at another endpoint. */
function pathSegment(value: string, name = 'externalId'): string {
  if (!value) throw new TypeError(`${name} is required`)
  if (value === '.' || value === '..') throw new TypeError(`${name} cannot be "${value}"`)
  return encodeURIComponent(value)
}

const PROFILE_FIELDS = {
  email: 'email',
  phoneE164: 'phone_e164',
  firstName: 'first_name',
  lastName: 'last_name',
  locale: 'locale',
  timezone: 'timezone',
  avatarUrl: 'avatar_url',
  data: 'data',
} as const

/** What was given: a value sets, `null` clears, `undefined` is left out of the body so the server leaves the field alone. An unknown name is a typo that would otherwise be silently dropped. */
function profileBody(fields: SubscriberFields): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(fields)) {
    if (!Object.hasOwn(PROFILE_FIELDS, name)) {
      throw new TypeError(`unknown subscriber field "${name}"; expected ${Object.keys(PROFILE_FIELDS).join(', ')}`)
    }
    if (value !== undefined) body[PROFILE_FIELDS[name as keyof typeof PROFILE_FIELDS]] = value
  }
  return body
}

/** Everything the resources share: the key, the retries, the wire. Not exported, and the key never leaves it. */
class Core {
  readonly simulate: boolean
  readonly simulated: SimulatedEvent[] = []
  readonly simulatedCalls: SimulatedCall[] = []
  readonly #key: string
  readonly #baseUrl: string
  readonly #timeoutMs: number
  readonly #retry: RetryPolicy
  readonly #fetch: FetchLike
  readonly #sleep: (ms: number) => Promise<void>
  #counter = 0

  constructor(options: HermesiOptions) {
    this.simulate = options.simulate === true
    const key = options.apiKey ?? environment(ENV_KEY)
    const url = options.baseUrl ?? environment(ENV_URL)
    if (key === undefined && !this.simulate) {
      throw new TypeError(`apiKey is required (or set ${ENV_KEY}). It is your secret key, hm_sk_...`)
    }
    if (key !== undefined && !key.startsWith('hm_sk_')) {
      throw new TypeError(
        'apiKey must be a secret key (hm_sk_...). A public key (hm_pk_...) is for browsers and apps and cannot publish events.',
      )
    }
    if (url === undefined && !this.simulate) {
      throw new TypeError(`baseUrl is required (or set ${ENV_URL}), for example https://your-hermesi-host`)
    }
    if (url !== undefined && !/^https?:\/\//i.test(url)) {
      throw new TypeError(`baseUrl must start with http:// or https://, got "${url}"`)
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('timeoutMs must be above 0')
    this.#key = key ?? ''
    this.#baseUrl = (url ?? 'http://simulated.invalid').replace(/\/+$/, '')
    this.#timeoutMs = timeoutMs
    this.#retry = resolveRetry(options.retry)
    // Looked up at call time, not now: a `fetch` installed or stubbed after the client was built is the one used.
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  mint(externalId: string, environmentId: string, options: MintOptions): Promise<string> {
    return mintSubscriberToken(this.#key || 'hm_sk_simulated', externalId, environmentId, options)
  }

  simulateEvent(name: string, recipient: Recipient | Recipient[], key: string, body: Record<string, unknown>): EventResult {
    this.#counter += 1
    this.simulated.push({
      name,
      recipient,
      payload: body.payload as Record<string, unknown>,
      idempotencyKey: key,
      body,
    })
    return {
      eventId: `evt_simulated_${this.#counter}`,
      status: 'simulated',
      notifications: [],
      warnings: [],
      replayed: false,
      idempotencyKey: key,
    }
  }

  /**
   * What `simulate: true` does for a call that is not an event: record it, and answer with `simulated(n)`. A read has no such
   * answer, and an invented one would make a test pass for the wrong reason.
   */
  simulateCall<T>(
    method: string,
    path: string,
    body: string | null,
    idempotencyKey: string | null,
    simulated: ((n: number) => T) | null,
  ): T {
    if (simulated === null) {
      throw new HermesiSimulationError(`${method} ${path} reads from Hermesi and this client is in simulate mode, so there is nothing to read`)
    }
    this.#counter += 1
    this.simulatedCalls.push({
      method,
      path,
      body: body === null ? null : (JSON.parse(body) as Record<string, unknown>),
      idempotencyKey,
    })
    return simulated(this.#counter)
  }

  async #attempt(method: string, path: string, body: string | null, idempotencyKey: string | null): Promise<Received> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#key}`,
      Accept: 'application/json',
      'User-Agent': `hermesi-node/${VERSION}`,
    }
    if (body !== null) headers['Content-Type'] = 'application/json'
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
    const response = await this.#fetch(this.#baseUrl + path, {
      method,
      headers,
      ...(body === null ? {} : { body }),
      // A redirect would turn the POST into a GET and lose the event without a word, so it is reported instead.
      redirect: 'manual',
      signal: AbortSignal.timeout(this.#timeoutMs),
    })
    // Read inside the attempt: a connection that drops halfway through the body is a failed attempt.
    const text = await response.text()
    return {
      status: response.status,
      ok: response.ok,
      text,
      retryAfter: response.headers.get('Retry-After'),
      replayed: (response.headers.get('Idempotency-Replayed') ?? '').toLowerCase() === 'true',
    }
  }

  /** One call, with retries. Resolves with a 2xx answer; rejects with a `HermesiAPIError` or a `HermesiConnectionError` otherwise. */
  async send(method: string, path: string, body: string | null, idempotencyKey: string | null): Promise<Received> {
    let retries = 0
    for (;;) {
      let wait: number | null
      let received: Received
      try {
        received = await this.#attempt(method, path, body, idempotencyKey)
      } catch (cause) {
        wait = retryDelay(this.#retry, retries, null)
        if (wait === null) {
          throw new HermesiConnectionError(`Could not reach Hermesi at ${this.#baseUrl}: ${describe(cause, this.#timeoutMs)}`, {
            cause,
          })
        }
        retries += 1
        await this.#sleep(wait)
        continue
      }
      if (received.ok) return received
      const retryAfter = parseRetryAfter(received.retryAfter)
      if (!isRetryableStatus(received.status)) throw refusal(received, retryAfter)
      wait = retryDelay(this.#retry, retries, retryAfter === null ? null : retryAfter * 1000)
      if (wait === null) throw refusal(received, retryAfter)
      retries += 1
      await this.#sleep(wait)
    }
  }
}

function refusal(received: Received, retryAfter: number | null): HermesiAPIError {
  return errorFromResponse(received.status, parseJson(received.text), retryAfter)
}

export class Events {
  readonly #core: Core

  /** @internal */
  constructor(core: Core) {
    this.#core = core
  }

  /**
   * Tell Hermesi that something happened. `202`: the event is recorded and queued; nothing is
   * delivered yet, so watch the Activity Log in the dashboard.
   *
   * `recipient` is a subscriber's `externalId`, a `Subscriber` (created or updated on the
   * fly), or an array of up to 100 of either.
   */
  async trigger(
    name: string,
    recipient: Recipient | Recipient[],
    payload: Record<string, unknown> = {},
    options: TriggerOptions = {},
  ): Promise<EventResult> {
    const core = this.#core
    if (!name) throw new TypeError('name is required, for example order.shipped')
    const key = options.idempotencyKey || globalThis.crypto.randomUUID()
    const body: Record<string, unknown> = { name, recipient: recipientWire(recipient), payload }
    if (options.actor !== undefined) {
      const actor: Record<string, string> = {}
      if (options.actor.externalId !== undefined) actor.external_id = options.actor.externalId
      if (options.actor.name !== undefined) actor.name = options.actor.name
      body.actor = actor
    }
    if (options.delay !== undefined) body.delay = options.delay
    if (options.sendAt !== undefined) body.send_at = instant(options.sendAt)
    if (options.override !== undefined) body.override = options.override
    if (options.tenant !== undefined) body.tenant = options.tenant
    // Encoded before the simulate branch: a payload that cannot be serialised must fail in a test
    // exactly as it would in production, or simulate mode would hide the bug it exists to catch.
    const encoded = encodeJson(body)
    if (core.simulate) {
      return core.simulateEvent(name, recipient, key, JSON.parse(encoded) as Record<string, unknown>)
    }
    const received = await core.send('POST', '/v1/events', encoded, key)
    return eventResult(received, key)
  }

  /**
   * What became of an event: the notification each recipient got, the messages each produced and how far each got. A message's status
   * moves on after the event was accepted, so poll it (`message.isFinal`) rather than treating the first answer as final. It never
   * returns what was sent or the recipient's address; an event of another environment is a `NotFoundError`.
   */
  async get(eventId: string): Promise<EventRun> {
    const core = this.#core
    const path = `/v1/events/${pathSegment(eventId, 'eventId')}`
    if (core.simulate) return core.simulateCall('GET', path, null, null, null)
    const received = await core.send('GET', path, null, null)
    return parseEventRun(parseJson(received.text), received.status)
  }
}

function eventResult(received: Received, key: string): EventResult {
  const body = parseJson(received.text)
  if (!isRecord(body) || typeof body.event_id !== 'string') throw errorFromResponse(received.status, null, null)
  const notifications: NotificationSummary[] = (Array.isArray(body.notifications) ? body.notifications : [])
    .filter(isRecord)
    .map((item) => ({
      id: String(item.id ?? ''),
      subscriberId: String(item.subscriber_id ?? ''),
      workflow: String(item.workflow ?? ''),
    }))
  return {
    eventId: body.event_id,
    status: typeof body.status === 'string' ? body.status : 'accepted',
    notifications,
    warnings: (Array.isArray(body.warnings) ? body.warnings : []).map(String),
    replayed: received.replayed,
    idempotencyKey: key,
  }
}

export class Subscribers {
  readonly #core: Core

  /** @internal */
  constructor(core: Core) {
    this.#core = core
  }

  /** One call: simulated or sent, then read. `simulated` is `null` for a read. */
  async #call<T>(
    method: string,
    path: string,
    body: Record<string, unknown> | null,
    simulated: ((n: number) => T) | null,
    read: (text: string, status: number) => T,
  ): Promise<T> {
    const core = this.#core
    // Encoded before the simulate branch, so a body that cannot be serialised fails in a test as it would in production.
    const encoded = body === null ? null : encodeJson(body)
    if (core.simulate) return core.simulateCall(method, path, encoded, null, simulated)
    const received = await core.send(method, path, encoded, null)
    return read(received.text, received.status)
  }

  /**
   * Create the subscriber, or update it: **a field you give is set, `null` clears it, and one you leave out is left alone**, so a sync
   * job that knows half a profile does not blank the other half. `data` **replaces** the stored attributes (at most 32 KB) rather than
   * merging. The server checks the shapes (an email looks like one, `phoneE164` is E.164, `locale` a language tag, `timezone` an IANA
   * name) and refuses what it does not know, as a `ValidationError` naming the field.
   */
  async put(externalId: string, fields: SubscriberFields = {}): Promise<SubscriberProfile> {
    return this.#write('PUT', externalId, fields)
  }

  /** Like `put`, but a `NotFoundError` if the subscriber does not exist, instead of creating it. */
  async patch(externalId: string, fields: SubscriberFields = {}): Promise<SubscriberProfile> {
    return this.#write('PATCH', externalId, fields)
  }

  async #write(method: 'PUT' | 'PATCH', externalId: string, fields: SubscriberFields): Promise<SubscriberProfile> {
    const path = `/v1/subscribers/${pathSegment(externalId)}`
    const body = profileBody(fields)
    return this.#call(
      method,
      path,
      body,
      (n) => parseProfile({ id: `sub_simulated_${n}`, external_id: externalId, ...body }, 200),
      (text, status) => parseProfile(parseJson(text), status),
    )
  }

  /**
   * Create or update up to 1 000 subscribers in one request: a first import of your user table, or a nightly sync.
   *
   * Each row is an `externalId` and any of the fields `put` takes, and **means exactly what the same `put` would**: a field you give
   * is set, `null` clears it, one you leave out (or set to `undefined`) is left alone, `data` replaces. A field name the SDK does not
   * know is a `TypeError` naming the row.
   *
   * **All or nothing**: if the server finds any row invalid, a `ValidationError` lists every problem with the row it is on
   * (`body.subscribers.17.email`) and nothing was written. The same `externalId` twice, more than 1 000 rows, or more than 5 MB of
   * `data` in total are refused too: split a larger import into batches. Every row is an idempotent upsert, so sending the same batch
   * again after a timeout is safe, and there is no idempotency key to manage. A full batch takes a few seconds: do not set a very
   * short `timeoutMs`.
   *
   * The result has one entry per row, in the order you sent them, saying whether each was `created` or `updated`.
   */
  async bulk(subscribers: Iterable<BulkSubscriberRow>): Promise<BulkSubscribersResult> {
    const rows: Record<string, unknown>[] = []
    for (const row of subscribers) {
      const index = rows.length
      if (typeof row !== 'object' || row === null) throw new TypeError(`row ${index} must be an object with an externalId`)
      const { externalId, ...fields } = row
      if (typeof externalId !== 'string' || !externalId) throw new TypeError(`row ${index}: externalId is required`)
      let body: Record<string, unknown>
      try {
        body = profileBody(fields)
      } catch (error) {
        throw new TypeError(`row ${index}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
      rows.push({ external_id: externalId, ...body })
    }
    if (rows.length === 0) throw new TypeError('give at least one subscriber')
    return this.#call(
      'POST',
      '/v1/subscribers/bulk',
      { subscribers: rows },
      (n) => ({
        created: rows.length,
        updated: 0,
        subscribers: rows.map((row, index) => ({ externalId: String(row.external_id), id: `sub_simulated_${n}_${index}`, status: 'created' })),
      }),
      (text, status) => parseBulkResult(parseJson(text), status),
    )
  }

  /** The profile, the channel identities and the stored preference overrides. A `NotFoundError` for an unknown or erased subscriber. */
  async get(externalId: string): Promise<SubscriberProfile> {
    const path = `/v1/subscribers/${pathSegment(externalId)}`
    return this.#call('GET', path, null, null, (text, status) => parseProfile(parseJson(text), status))
  }

  /**
   * Erase the personal data (email, phone, names, attributes, channel identities, preferences) and replace the address on every message
   * the person received by `[deleted]`, keeping the messages and their status for your statistics. Idempotent: deleting twice, or an
   * unknown subscriber, is not an error. Inbox items, the stored text of messages and event payloads are **not** erased yet.
   */
  async delete(externalId: string): Promise<void> {
    const path = `/v1/subscribers/${pathSegment(externalId)}`
    await this.#call('DELETE', path, null, () => undefined, () => undefined)
  }

  /**
   * Register where to reach the subscriber on a channel: a device token, a chat id, a Web Push endpoint. Safe to call on every app
   * start: it refreshes the identity and makes it active again if a provider had marked it invalid, and never duplicates it.
   */
  async registerChannel(
    externalId: string,
    channel: string,
    identifier: string,
    metadata?: Record<string, unknown>,
  ): Promise<ChannelIdentity> {
    const path = `/v1/subscribers/${pathSegment(externalId)}/channels`
    if (!channel) throw new TypeError('channel is required, for example push')
    if (!identifier) throw new TypeError('identifier is required: a device token, a chat id or a Web Push endpoint')
    const body: Record<string, unknown> = { channel, identifier }
    if (metadata !== undefined) body.metadata = metadata
    return this.#call(
      'POST',
      path,
      body,
      () => parseChannelIdentity({ channel, identifier, state: 'active', metadata: metadata ?? {} }, 200),
      (text, status) => parseChannelIdentity(parseJson(text), status),
    )
  }

  /** Forget a destination. Idempotent. */
  async removeChannel(externalId: string, channel: string, identifier: string): Promise<void> {
    // `identifier` is the rest of the path on the server, so a Web Push endpoint URL goes in percent-encoded as one segment.
    const path = `/v1/subscribers/${pathSegment(externalId)}/channels/${pathSegment(channel, 'channel')}/${pathSegment(identifier, 'identifier')}`
    await this.#call('DELETE', path, null, () => undefined, () => undefined)
  }

  /** The stored overrides. A channel or category that is absent has none and follows the category's default. */
  async preferences(externalId: string): Promise<Preferences> {
    const path = `/v1/subscribers/${pathSegment(externalId)}/preferences`
    return this.#call('GET', path, null, null, (text, status) => parsePreferences(parseJson(text), status))
  }

  /**
   * Change overrides: `true` or `false` sets one, `null` removes it so the category's default applies again, and what you leave out is
   * untouched. All or nothing: an unknown category (`NotFoundError`) or a critical one (`ValidationError`) refuses the whole update.
   */
  async updatePreferences(externalId: string, changes: PreferenceChanges): Promise<Preferences> {
    const path = `/v1/subscribers/${pathSegment(externalId)}/preferences`
    for (const name of Object.keys(changes)) {
      if (name !== 'global' && name !== 'categories') {
        throw new TypeError(`unknown preference group "${name}"; expected global or categories`)
      }
    }
    const body: Record<string, unknown> = {}
    if (changes.global !== undefined) body.global = changes.global
    if (changes.categories !== undefined) body.categories = changes.categories
    if (Object.keys(body).length === 0) throw new TypeError('give global or categories: there is nothing to change')
    const kept = (flags: Record<string, boolean | null> | undefined): Record<string, boolean> =>
      Object.fromEntries(Object.entries(flags ?? {}).filter((entry): entry is [string, boolean] => entry[1] !== null))
    return this.#call(
      'PATCH',
      path,
      body,
      () =>
        parsePreferences(
          {
            global: kept(changes.global),
            categories: Object.fromEntries(Object.entries(changes.categories ?? {}).map(([category, flags]) => [category, kept(flags)])),
          },
          200,
        ),
      (text, status) => parsePreferences(parseJson(text), status),
    )
  }

  /** A link to the hosted preference page for one subscriber. It needs no login and works for about a year. */
  async preferenceLink(externalId: string): Promise<PreferenceLink> {
    const core = this.#core
    const segment = pathSegment(externalId)
    if (core.simulate) return { url: `https://simulated.invalid/preferences/${segment}` }
    const received = await core.send('POST', `/v1/subscribers/${segment}/preference-link`, '{}', null)
    const body = parseJson(received.text)
    if (!isRecord(body) || typeof body.url !== 'string') throw errorFromResponse(received.status, null, null)
    return { url: body.url }
  }
}

export class Messages {
  readonly #core: Core

  /** @internal */
  constructor(core: Core) {
    this.#core = core
  }

  /**
   * Send one message on one channel, through one published template. Almost everything should be an event: you say what happened and
   * Hermesi decides the channels. Use this when the channel is a requirement instead (an OTP that must be an SMS).
   *
   * It skips the workflow and nothing else: preferences, suppressions and the audit trail still apply, and a refused message is a
   * result you can read (`status` is `skipped` or `suppressed`), not an exception. A mistake (an unknown template, a template with no
   * variant for the channel, an unknown recipient) is thrown and creates nothing. There is no inline content: it would put copy back
   * in your code.
   *
   * **Pass your own `idempotencyKey` when your code can run twice.** One is generated and kept across the retries if you give none,
   * so a timeout cannot send a second SMS, but only your own key survives your code running again.
   */
  async send(input: SendMessageInput, options: SendMessageOptions = {}): Promise<MessageResult> {
    const core = this.#core
    if (!input.channel) throw new TypeError('channel is required, for example sms')
    if (!input.template) throw new TypeError('template is required: the key of a published template')
    const key = options.idempotencyKey || globalThis.crypto.randomUUID()
    const body: Record<string, unknown> = {
      channel: input.channel,
      recipient: recipientWire(input.recipient),
      template: input.template,
    }
    if (input.category !== undefined) body.category = input.category
    if (input.data !== undefined) body.data = input.data
    if (input.priority !== undefined) body.priority = input.priority
    const encoded = encodeJson(body)
    if (core.simulate) {
      return core.simulateCall('POST', '/v1/messages', encoded, key, (n) => ({
        messageId: `msg_simulated_${n}`,
        status: 'simulated',
        messages: [],
        replayed: false,
        idempotencyKey: key,
      }))
    }
    const received = await core.send('POST', '/v1/messages', encoded, key)
    return parseMessageResult(parseJson(received.text), received.status, received.replayed, key)
  }

  /** A message and how far it got. A `NotFoundError` for an unknown id or one of another environment. */
  async get(messageId: string): Promise<Message> {
    const core = this.#core
    const path = `/v1/messages/${pathSegment(messageId, 'messageId')}`
    if (core.simulate) return core.simulateCall('GET', path, null, null, null)
    const received = await core.send('GET', path, null, null)
    return parseMessage(parseJson(received.text), received.status)
  }
}

export class Tokens {
  readonly #core: Core

  /** @internal */
  constructor(core: Core) {
    this.#core = core
  }

  /**
   * A token that lets a browser or an app act as `externalId`. Valid for at most an hour: mint a
   * fresh one when asked. Minted here, with no request; `environmentId` is the `env_...` id shown in
   * the dashboard.
   */
  mint(externalId: string, options: { environmentId: string; ttlSeconds?: number }): Promise<string> {
    return this.#core.mint(externalId, options.environmentId, { ttlSeconds: options.ttlSeconds })
  }
}

export class Hermesi {
  readonly events: Events
  readonly subscribers: Subscribers
  readonly messages: Messages
  readonly tokens: Tokens
  readonly #core: Core

  constructor(options: HermesiOptions = {}) {
    this.#core = new Core(options)
    this.events = new Events(this.#core)
    this.subscribers = new Subscribers(this.#core)
    this.messages = new Messages(this.#core)
    this.tokens = new Tokens(this.#core)
  }

  /** True when nothing is sent. */
  get simulate(): boolean {
    return this.#core.simulate
  }

  /** The events recorded by `simulate: true`, oldest first. */
  get simulated(): readonly SimulatedEvent[] {
    return this.#core.simulated
  }

  /** Every other write recorded by `simulate: true` (subscribers, channels, preferences, messages), oldest first. */
  get simulatedCalls(): readonly SimulatedCall[] {
    return this.#core.simulatedCalls
  }
}
