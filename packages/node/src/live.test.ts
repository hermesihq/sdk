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
 * The subscriber must already exist in that environment. The tests that send a direct message or write preferences also need, in that
 * environment, a published `sms` template whose key is HERMESI_LIVE_SMS_TEMPLATE (its text may use `{{ payload.code }}`) and a
 * non-critical category whose key is HERMESI_LIVE_CATEGORY; without them those tests are skipped.
 */

import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { AuthenticationError, ConflictError, Hermesi, HermesiConnectionError, NotFoundError, ValidationError } from './index.ts'

const env = process.env
const URL = env.HERMESI_LIVE_URL ?? ''
const SECRET = env.HERMESI_LIVE_SECRET_KEY ?? ''
const PUBLIC = env.HERMESI_LIVE_PUBLIC_KEY ?? ''
const ENVIRONMENT = env.HERMESI_LIVE_ENVIRONMENT_ID ?? ''
const SUBSCRIBER = env.HERMESI_LIVE_SUBSCRIBER ?? ''
const SMS_TEMPLATE = env.HERMESI_LIVE_SMS_TEMPLATE ?? ''
const CATEGORY = env.HERMESI_LIVE_CATEGORY ?? ''

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

  it('reads an event back with its notification', async () => {
    const sent = await live.events.trigger('order.shipped', SUBSCRIBER, { orderId: 'live' })

    const run = await live.events.get(sent.eventId)

    expect(run.eventId).toBe(sent.eventId)
    expect(run.name).toBe('order.shipped')
    expect(run.payload).toEqual({ orderId: 'live' })
    expect(run.notifications.map((n) => n.externalId)).toEqual([SUBSCRIBER])
  })

  it('an event that does not exist is not found', async () => {
    const error = (await live.events.get('evt_01DOESNOTEXIST00000000000').catch((e: unknown) => e)) as NotFoundError

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('event_not_found')
  })

  it('creates, reads, updates and deletes a subscriber', async () => {
    const id = unique()

    const created = await live.subscribers.put(id, { email: 'Live@Example.test', firstName: 'Live', locale: 'fr', data: { plan: 'pro', seats: 3 } })
    expect(created.externalId).toBe(id)
    expect(created.id).toMatch(/^sub_/)
    expect(created.email, 'stored lower-cased').toBe('live@example.test')
    expect(created.data).toEqual({ plan: 'pro', seats: 3 })

    const unchanged = await live.subscribers.put(id, { locale: 'en' })
    expect([unchanged.locale, unchanged.firstName, unchanged.email], 'a field left out is left alone').toEqual(['en', 'Live', 'live@example.test'])

    const cleared = await live.subscribers.put(id, { firstName: null })
    expect([cleared.firstName, cleared.email], 'null clears one field and only that').toEqual([null, 'live@example.test'])

    expect((await live.subscribers.put(id, { data: { plan: 'free' } })).data, 'data replaces').toEqual({ plan: 'free' })
    expect((await live.subscribers.get(id)).data).toEqual({ plan: 'free' })
    expect((await live.subscribers.patch(id, { phoneE164: '+237690000000' })).phoneE164).toBe('+237690000000')

    await live.subscribers.delete(id)
    await live.subscribers.delete(id)
    await expect(live.subscribers.get(id)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('a value of the wrong shape is a ValidationError naming the field', async () => {
    const error = (await live.subscribers.put(unique(), { phoneE164: '690000000' }).catch((e: unknown) => e)) as ValidationError

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.detail.some((d) => (d.field ?? '').includes('phone_e164'))).toBe(true)
  })

  it('patching a subscriber that does not exist is not found', async () => {
    const error = (await live.subscribers.patch(unique(), { locale: 'en' }).catch((e: unknown) => e)) as NotFoundError

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('subscriber_not_found')
  })

  it('works for every subscriber call with an id a path treats specially', async () => {
    const id = `team/${unique()} é?#`

    await live.subscribers.put(id, { locale: 'fr' })

    expect((await live.subscribers.get(id)).externalId).toBe(id)
    await live.subscribers.registerChannel(id, 'push', 'tok-1')
    expect((await live.subscribers.get(id)).channels.map((c) => c.identifier)).toEqual(['tok-1'])
    await live.subscribers.delete(id)
  })

  it('registers, lists and removes a device token', async () => {
    const id = unique()
    await live.subscribers.put(id)

    const first = await live.subscribers.registerChannel(id, 'push', 'fcm-token-1', { platform: 'android' })
    const again = await live.subscribers.registerChannel(id, 'push', 'fcm-token-1', { platform: 'android' })

    expect([first.state, again.state]).toEqual(['active', 'active'])
    expect((await live.subscribers.get(id)).channels.map((c) => [c.channel, c.identifier, c.metadata])).toEqual([
      ['push', 'fcm-token-1', { platform: 'android' }],
    ])
    await live.subscribers.removeChannel(id, 'push', 'fcm-token-1')
    await live.subscribers.removeChannel(id, 'push', 'fcm-token-1')
    expect((await live.subscribers.get(id)).channels).toEqual([])
    await live.subscribers.delete(id)
  })

  it('an identifier that is a URL survives the round trip', async () => {
    // A Web Push endpoint is a URL: it has slashes, which a path segment can only carry percent-encoded.
    const id = unique()
    await live.subscribers.put(id)
    const identifier = 'https://fcm.googleapis.com/fcm/send/abc:APA91b/def'

    await live.subscribers.registerChannel(id, 'push', identifier, { transport: 'fcm' })
    await live.subscribers.removeChannel(id, 'push', identifier)

    expect((await live.subscribers.get(id)).channels).toEqual([])
    await live.subscribers.delete(id)
  })

  it.skipIf(!CATEGORY)('writes, reads and removes preferences', async () => {
    const id = unique()
    await live.subscribers.put(id)

    const after = await live.subscribers.updatePreferences(id, { global: { sms: false }, categories: { [CATEGORY]: { email: false, push: false } } })
    expect(after).toEqual({ global: { sms: false }, categories: { [CATEGORY]: { email: false, push: false } } })

    const removed = await live.subscribers.updatePreferences(id, { global: { sms: null }, categories: { [CATEGORY]: { email: null } } })
    expect(removed).toEqual({ global: {}, categories: { [CATEGORY]: { push: false } } })
    expect(await live.subscribers.preferences(id)).toEqual(removed)
    await live.subscribers.delete(id)
  })

  it('an unknown category refuses the whole preference update', async () => {
    const id = unique()
    await live.subscribers.put(id)

    const error = (await live.subscribers
      .updatePreferences(id, { global: { sms: false }, categories: { no_such_category: { email: false } } })
      .catch((e: unknown) => e)) as NotFoundError

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('category_not_found')
    expect((await live.subscribers.preferences(id)).global, 'nothing was applied').toEqual({})
    await live.subscribers.delete(id)
  })

  it.skipIf(!SMS_TEMPLATE)('sends a direct message, replays it and reads it back', async () => {
    const id = unique()
    await live.subscribers.put(id, { phoneE164: '+237690000001' })
    const idempotencyKey = `live-${randomUUID()}`
    const input = { channel: 'sms', recipient: id, template: SMS_TEMPLATE, data: { code: '480219' } }

    const first = await live.messages.send(input, { idempotencyKey })
    const second = await live.messages.send(input, { idempotencyKey })

    expect(first.status).toBe('queued')
    expect(first.replayed).toBe(false)
    expect(first.messageId).toMatch(/^msg_/)
    expect(second.replayed).toBe(true)
    expect(second.messageId).toBe(first.messageId)
    const message = await live.messages.get(first.messageId)
    expect([message.id, message.channel]).toEqual([first.messageId, 'sms'])
    await expect(live.messages.send({ ...input, data: { code: '111111' } }, { idempotencyKey })).rejects.toBeInstanceOf(ConflictError)
    await live.subscribers.delete(id)
  })

  it.skipIf(!SMS_TEMPLATE)('reports a direct message to someone with no phone, instead of throwing', async () => {
    const id = unique()
    await live.subscribers.put(id, { email: 'nophone@example.test' })

    const result = await live.messages.send({ channel: 'sms', recipient: id, template: SMS_TEMPLATE, data: { code: '1' } })

    expect(result.status).toBe('skipped')
    expect(result.messages[0]!.reason).toBe('no_channel_identity')
    await live.subscribers.delete(id)
  })

  it('a direct message with an unknown template is not found', async () => {
    const error = (await live.messages.send({ channel: 'sms', recipient: SUBSCRIBER, template: 'no-such-template' }).catch((e: unknown) => e)) as NotFoundError

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('template_not_found')
  })

  it('the server refuses inline content instead of ignoring it', async () => {
    // The SDK has no `content` option at all, so this is asserted against the server directly.
    const response = await fetch(`${URL}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'sms', recipient: SUBSCRIBER, template: 'x', content: { body: 'hi' } }),
    })

    expect(response.status).toBe(422)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('inline_content_not_supported')
  })

  it('imports a batch, updates it, and each row means what a put would', async () => {
    const [a, b, c] = [unique(), unique(), unique()] as [string, string, string]

    const first = await live.subscribers.bulk([
      { externalId: a, email: 'Bulk.A@Example.test', firstName: 'Aa', data: { plan: 'pro' } },
      { externalId: b, phoneE164: '+237690000010', locale: 'fr' },
    ])

    expect([first.created, first.updated]).toEqual([2, 0])
    expect(first.subscribers.map((r) => [r.externalId, r.status])).toEqual([[a, 'created'], [b, 'created']])
    expect((await live.subscribers.get(a)).email, 'lower-cased, as a put does').toBe('bulk.a@example.test')

    const second = await live.subscribers.bulk([{ externalId: a, firstName: null, data: { seats: 3 } }, { externalId: b, locale: 'en' }, { externalId: c }])

    expect(second.subscribers.map((r) => r.status)).toEqual(['updated', 'updated', 'created'])
    const afterA = await live.subscribers.get(a)
    const afterB = await live.subscribers.get(b)
    expect([afterA.email, afterA.firstName, afterA.data], 'left out kept, null cleared, data replaced').toEqual(['bulk.a@example.test', null, { seats: 3 }])
    expect([afterB.phoneE164, afterB.locale]).toEqual(['+237690000010', 'en'])
    for (const id of [a, b, c]) await live.subscribers.delete(id)
  })

  it('one invalid row refuses the whole batch and writes nothing', async () => {
    const [good, bad] = [unique(), unique()] as [string, string]

    const error = (await live.subscribers
      .bulk([{ externalId: good, email: 'good@example.test' }, { externalId: bad, phoneE164: '690000000' }])
      .catch((e: unknown) => e)) as ValidationError

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.detail.some((d) => (d.field ?? '').includes('subscribers.1.phone_e164'))).toBe(true)
    await expect(live.subscribers.get(good)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('refuses the same id twice in a batch', async () => {
    const id = unique()

    const error = (await live.subscribers.bulk([{ externalId: id }, { externalId: id }]).catch((e: unknown) => e)) as ValidationError

    expect(error).toBeInstanceOf(ValidationError)
    expect(JSON.stringify(error.detail) + error.message).toContain('more than once')
  })

  it('takes an id a path treats specially as an ordinary value in a bulk body', async () => {
    const id = `team/${unique()} é?#`

    await live.subscribers.bulk([{ externalId: id, locale: 'fr' }])

    expect((await live.subscribers.get(id)).locale).toBe('fr')
    await live.subscribers.delete(id)
  })
})
