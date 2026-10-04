/**
 * The SDK against a real Hermesi, not a fake of one.
 *
 * Skipped unless the variables below are set. These exist because tests written against a fake of
 * the server prove the client and not the contract: a client can pass hundreds of them and still
 * disagree with the server about a path, a header or a format. Run them against a development
 * instance of Hermesi (never production: they publish events):
 *
 *     HERMESI_LIVE_URL=http://localhost:8010 \
 *     HERMESI_LIVE_SECRET_KEY=hm_sk_... \
 *     HERMESI_LIVE_PUBLIC_KEY=hm_pk_... \
 *     HERMESI_LIVE_ENVIRONMENT_ID=env_... \
 *     HERMESI_LIVE_SUBSCRIBER=user_1 \
 *     npx vitest run src/live.test.ts
 *
 * The subscriber must already exist in that environment.
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { AuthenticationError, Hermesi, HermesiConnectionError, NotFoundError, ValidationError } from './index.ts'

const env = process.env
const URL = env.HERMESI_LIVE_URL ?? ''
const SECRET = env.HERMESI_LIVE_SECRET_KEY ?? ''
const PUBLIC = env.HERMESI_LIVE_PUBLIC_KEY ?? ''
const ENVIRONMENT = env.HERMESI_LIVE_ENVIRONMENT_ID ?? ''
const SUBSCRIBER = env.HERMESI_LIVE_SUBSCRIBER ?? ''

describe.skipIf(!(URL && SECRET && PUBLIC && ENVIRONMENT && SUBSCRIBER))('against a real Hermesi', () => {
  // Built in a hook: the body of a skipped `describe` still runs, and a client with no key throws.
  let live: Hermesi
  beforeAll(() => {
    live = new Hermesi({ apiKey: SECRET, baseUrl: URL, retry: { maxRetries: 0 } })
  })
  const unique = (): string => `live_${randomUUID().slice(0, 8)}`

  it('publishes an event and the server accepts it', async () => {
    const result = await live.events.trigger('order.shipped', SUBSCRIBER, { orderId: '4821' })

    expect(result.eventId).toMatch(/^evt_/)
    expect(result.status).toBe('accepted')
    expect(result.replayed).toBe(false)
  })

  it('recognises the same idempotency key as a replay', async () => {
    const idempotencyKey = `live-${randomUUID()}`

    const first = await live.events.trigger('order.shipped', SUBSCRIBER, { orderId: '1' }, { idempotencyKey })
    const second = await live.events.trigger('order.shipped', SUBSCRIBER, { orderId: '1' }, { idempotencyKey })

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    expect(second.eventId).toBe(first.eventId)
  })

  it('creates a subscriber described inline, on the fly', async () => {
    const result = await live.events.trigger('order.shipped', { externalId: unique(), email: 'live@example.test', locale: 'fr' })

    expect(result.eventId).toMatch(/^evt_/)
  })

  it('accepts a list of recipients', async () => {
    const result = await live.events.trigger('order.shipped', [SUBSCRIBER, { externalId: unique() }])

    expect(result.eventId).toMatch(/^evt_/)
  })

  it('accepts the scheduling and actor fields', async () => {
    const result = await live.events.trigger(
      'order.shipped',
      SUBSCRIBER,
      { when: new Date() },
      { actor: { externalId: SUBSCRIBER, name: 'Ada' }, sendAt: new Date(Date.now() + 3_600_000) },
    )

    expect(result.eventId).toMatch(/^evt_/)
  })

  it('answers a recipient that is not a subscriber with a NotFoundError', async () => {
    const error = (await live.events.trigger('order.shipped', `nobody_${randomUUID()}`).catch((e: unknown) => e)) as NotFoundError

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('subscriber_not_found')
    expect(error.requestId).toMatch(/^req_/)
  })

  it('answers an event name it does not accept with a ValidationError', async () => {
    const error = (await live.events.trigger('notadottedname', SUBSCRIBER).catch((e: unknown) => e)) as ValidationError

    expect(error).toBeInstanceOf(ValidationError)
    expect([400, 422]).toContain(error.status)
  })

  it('answers a wrong key with an AuthenticationError', async () => {
    const wrong = new Hermesi({ apiKey: 'hm_sk_prod_not_a_real_key', baseUrl: URL, retry: { maxRetries: 0 } })

    const error = (await wrong.events.trigger('order.shipped', SUBSCRIBER).catch((e: unknown) => e)) as AuthenticationError

    expect(error).toBeInstanceOf(AuthenticationError)
    expect(error.status).toBe(401)
  })

  it('mints a preference link', async () => {
    const link = await live.subscribers.preferenceLink(SUBSCRIBER)

    expect(link.url).toMatch(/^http/)
    expect(link.url).toContain('/preferences/')
  })

  it('mints a preference link for a subscriber whose id contains characters a path treats specially', async () => {
    // The same class of id once made the client API answer 404 for a subscriber that exists.
    const id = `team/${unique()} é?#`
    await live.events.trigger('order.shipped', { externalId: id })

    const link = await live.subscribers.preferenceLink(id)

    expect(link.url).toContain('/preferences/')
  })

  it('mints a token the client API accepts, and one for another environment is refused', async () => {
    // The token format is the one thing the server verifies cryptographically, so only the real server can say it is right.
    const counts = (token: string) =>
      fetch(`${URL}/v1/client/inbox/counts`, { headers: { Authorization: `Bearer ${PUBLIC}`, 'X-Hermesi-Subscriber-Token': token } })

    const good = await counts(await live.tokens.mint(SUBSCRIBER, { environmentId: ENVIRONMENT }))
    expect(good.status, await good.clone().text()).toBe(200)
    expect(Object.keys((await good.json()) as object)).toEqual(expect.arrayContaining(['unread', 'unseen']))

    const wrongEnvironment = await counts(await live.tokens.mint(SUBSCRIBER, { environmentId: 'env_not_this_one' }))
    expect(wrongEnvironment.status).toBe(401)
  })

  it('reports an unreachable server as a connection error', async () => {
    const lost = new Hermesi({ apiKey: SECRET, baseUrl: 'http://127.0.0.1:9', retry: { maxRetries: 0 }, timeoutMs: 2000 })

    await expect(lost.events.trigger('order.shipped', SUBSCRIBER)).rejects.toBeInstanceOf(HermesiConnectionError)
  })
})
