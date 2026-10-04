/**
 * The client.
 *
 * Thin on purpose. It builds a request, sends it with retries, and turns the answer into a typed
 * result or an error. It makes no decision about notifications: that is the platform's job, and an
 * SDK that decides is a second implementation of it.
 */

import { HermesiAPIError, HermesiConnectionError, errorFromResponse } from './errors.ts'
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
  EventResult,
  FetchLike,
  NotificationSummary,
  PreferenceLink,
  Recipient,
  SimulatedEvent,
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
  /** Send nothing: record the events in `hermesi.simulated`. No key or URL needed. */
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

/** A path segment for a subscriber's id. `.` and `..` are refused: a URL parser resolves them (even as `%2e`), which would aim the request at another endpoint. */
function pathSegment(externalId: string): string {
  if (!externalId) throw new TypeError('externalId is required')
  if (externalId === '.' || externalId === '..') throw new TypeError(`externalId cannot be "${externalId}"`)
  return encodeURIComponent(externalId)
}

/** Everything the resources share: the key, the retries, the wire. Not exported, and the key never leaves it. */
class Core {
  readonly simulate: boolean
  readonly simulated: SimulatedEvent[] = []
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

  async #attempt(method: string, path: string, body: string, idempotencyKey: string | null): Promise<Received> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#key}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': `hermesi-node/${VERSION}`,
    }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
    const response = await this.#fetch(this.#baseUrl + path, {
      method,
      headers,
      body,
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
  async send(method: string, path: string, body: string, idempotencyKey: string | null): Promise<Received> {
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

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function refusal(received: Received, retryAfter: number | null): HermesiAPIError {
  return errorFromResponse(received.status, parse(received.text), retryAfter)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
}

function eventResult(received: Received, key: string): EventResult {
  const body = parse(received.text)
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

  /** A link to the hosted preference page for one subscriber. It needs no login and works for about a year. */
  async preferenceLink(externalId: string): Promise<PreferenceLink> {
    const core = this.#core
    const segment = pathSegment(externalId)
    if (core.simulate) return { url: `https://simulated.invalid/preferences/${segment}` }
    const received = await core.send('POST', `/v1/subscribers/${segment}/preference-link`, '{}', null)
    const body = parse(received.text)
    if (!isRecord(body) || typeof body.url !== 'string') throw errorFromResponse(received.status, null, null)
    return { url: body.url }
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
  readonly tokens: Tokens
  readonly #core: Core

  constructor(options: HermesiOptions = {}) {
    this.#core = new Core(options)
    this.events = new Events(this.#core)
    this.subscribers = new Subscribers(this.#core)
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
}
