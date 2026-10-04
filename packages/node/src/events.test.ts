import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AuthenticationError,
  ForbiddenError,
  Hermesi,
  HermesiAPIError,
  HermesiError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} from './index.ts'
import { ACCEPTED, errorBody, startServer, type TestServer } from './testServer.ts'

const KEY = 'hm_sk_test_0123456789'
let server: TestServer
let hermesi: Hermesi

beforeEach(async () => {
  server = await startServer()
  hermesi = new Hermesi({ apiKey: KEY, baseUrl: server.url, retry: { maxRetries: 0 } })
})
afterEach(() => server.close())

const lastBody = (): Record<string, unknown> => JSON.parse(server.requests.at(-1)?.body ?? 'null')

describe('publishing an event', () => {
  it('goes out with the secret key and a JSON body, and the answer is read', async () => {
    const result = await hermesi.events.trigger('order.shipped', 'user_8821', { orderId: '4821' })

    const request = server.requests[0]!
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/v1/events')
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.headers['user-agent']).toMatch(/^hermesi-node\/\d+\.\d+\.\d+/)
    expect(lastBody()).toEqual({ name: 'order.shipped', recipient: 'user_8821', payload: { orderId: '4821' } })
    expect(result).toMatchObject({
      eventId: 'evt_01K2QH8F3T7Y0RJ4N5V6WX8ZQD',
      status: 'accepted',
      notifications: [{ id: 'not_1', subscriberId: 'sub_1', workflow: 'order-shipped' }],
      warnings: [],
    })
  })

  it('generates an idempotency key when none is given, and reports it', async () => {
    const result = await hermesi.events.trigger('order.shipped', 'user_1')

    const sent = server.requests[0]!.headers['idempotency-key']
    expect(sent).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(result.idempotencyKey).toBe(sent)
  })

  it("uses the caller's idempotency key as is", async () => {
    const result = await hermesi.events.trigger('order.shipped', 'user_1', {}, { idempotencyKey: 'order-4821-shipped' })

    expect(server.requests[0]!.headers['idempotency-key']).toBe('order-4821-shipped')
    expect(result.idempotencyKey).toBe('order-4821-shipped')
  })

  it('gives two events two different generated keys', async () => {
    await hermesi.events.trigger('order.shipped', 'user_1')
    await hermesi.events.trigger('order.shipped', 'user_1')

    expect(new Set(server.requests.map((r) => r.headers['idempotency-key'])).size).toBe(2)
  })

  it('says when the server replayed an earlier answer, and not otherwise', async () => {
    server.enqueue({ status: 202, body: ACCEPTED, headers: { 'Idempotency-Replayed': 'true' } })

    expect((await hermesi.events.trigger('order.shipped', 'user_1', {}, { idempotencyKey: 'k' })).replayed).toBe(true)
    expect((await hermesi.events.trigger('order.shipped', 'user_1')).replayed).toBe(false)
  })

  it('sends a subscriber described inline, with the wire names, and leaves out what is not set', async () => {
    await hermesi.events.trigger('order.shipped', {
      externalId: 'cust_1',
      email: 'a@example.test',
      locale: 'fr',
      data: { plan: 'pro' },
    })

    expect(lastBody().recipient).toEqual({
      external_id: 'cust_1',
      email: 'a@example.test',
      locale: 'fr',
      data: { plan: 'pro' },
    })
  })

  it('sends a list of recipients of either kind', async () => {
    await hermesi.events.trigger('order.shipped', ['user_1', { externalId: 'user_2', phoneE164: '+237670000001' }])

    expect(lastBody().recipient).toEqual(['user_1', { external_id: 'user_2', phone_e164: '+237670000001' }])
  })

  it('sends the optional fields only when given', async () => {
    await hermesi.events.trigger('order.shipped', 'user_1')
    expect(Object.keys(lastBody()).sort()).toEqual(['name', 'payload', 'recipient'])

    await hermesi.events.trigger(
      'order.shipped',
      'user_1',
      {},
      {
        actor: { externalId: 'user_9', name: 'Ada' },
        delay: '15m',
        override: { email: { subject: 'Hi' } },
        tenant: 'acme',
      },
    )
    expect(lastBody()).toEqual({
      name: 'order.shipped',
      recipient: 'user_1',
      payload: {},
      actor: { external_id: 'user_9', name: 'Ada' },
      delay: '15m',
      override: { email: { subject: 'Hi' } },
      tenant: 'acme',
    })
  })

  it('takes sendAt as a Date or a string, and refuses an invalid Date', async () => {
    await hermesi.events.trigger('order.shipped', 'user_1', {}, { sendAt: new Date('2026-12-01T09:30:00Z') })
    expect(lastBody().send_at).toBe('2026-12-01T09:30:00.000Z')

    await hermesi.events.trigger('order.shipped', 'user_1', {}, { sendAt: '2026-12-01T10:30:00+01:00' })
    expect(lastBody().send_at).toBe('2026-12-01T10:30:00+01:00')

    const sent = server.requests.length
    await expect(hermesi.events.trigger('order.shipped', 'user_1', {}, { sendAt: new Date('nope') })).rejects.toThrow(TypeError)
    expect(server.requests).toHaveLength(sent)
  })

  it('serialises what a payload commonly holds: dates, bigints, nesting, and drops undefined like JSON does', async () => {
    await hermesi.events.trigger('order.shipped', 'user_1', {
      at: new Date('2026-10-04T12:00:00Z'),
      big: 12345678901234567890n,
      nested: { list: [1, 'two', null, { three: 3 }] },
      skipped: undefined,
    })

    expect((lastBody().payload as Record<string, unknown>)).toEqual({
      at: '2026-10-04T12:00:00.000Z',
      big: '12345678901234567890',
      nested: { list: [1, 'two', null, { three: 3 }] },
    })
  })

  it.each([
    ['a Map', { m: new Map([['a', 1]]) }],
    ['a Set', { s: new Set([1]) }],
    ['NaN', { n: Number.NaN }],
    ['Infinity', { n: Number.POSITIVE_INFINITY }],
    ['a function', { f: () => 1 }],
    ['a symbol', { s: Symbol('x') }],
    ['an invalid Date', { d: new Date('nope') }],
    ['a nested Map', { deep: { list: [{ m: new Map() }] } }],
  ])('refuses %s before sending anything, because JSON would lose it silently', async (_name, payload) => {
    await expect(hermesi.events.trigger('order.shipped', 'user_1', payload)).rejects.toThrow(TypeError)
    expect(server.requests).toHaveLength(0)
  })

  it('refuses a circular payload before sending anything', async () => {
    const payload: Record<string, unknown> = {}
    payload.self = payload

    await expect(hermesi.events.trigger('order.shipped', 'user_1', payload)).rejects.toThrow(TypeError)
    expect(server.requests).toHaveLength(0)
  })

  it('requires a name', async () => {
    await expect(hermesi.events.trigger('', 'user_1')).rejects.toThrow(/name is required/)
    expect(server.requests).toHaveLength(0)
  })
})

describe('when Hermesi refuses', () => {
  it.each([
    [400, ValidationError, 'validation_error'],
    [422, ValidationError, 'validation_error'],
    [401, AuthenticationError, 'invalid_api_key'],
    [403, ForbiddenError, 'forbidden'],
    [404, NotFoundError, 'subscriber_not_found'],
    [429, RateLimitError, 'rate_limited'],
    [500, ServerError, 'internal_error'],
    [503, ServerError, 'unavailable'],
    [409, HermesiAPIError, 'conflict'],
  ])('HTTP %i is a %o', async (status, Class, code) => {
    server.enqueue({ status, body: errorBody(code) })

    const error = await hermesi.events.trigger('order.shipped', 'user_1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Class)
    expect(error).toBeInstanceOf(HermesiAPIError)
    expect(error).toMatchObject({ status, code, requestId: 'req_abc123' })
  })

  it('names the code and the request to quote in the message, and keeps the field details', async () => {
    server.enqueue({
      status: 422,
      body: errorBody('validation_error', { detail: [{ field: 'recipient', issue: 'required' }, 'junk', { field: '', issue: 'x' }] }),
    })

    const error = (await hermesi.events.trigger('order.shipped', 'user_1').catch((e: unknown) => e)) as ValidationError

    expect(error.message).toContain('validation_error')
    expect(error.message).toContain('req_abc123')
    expect(error.message).toContain('HTTP 422')
    expect(error.detail).toEqual([
      { field: 'recipient', issue: 'required' },
      { field: null, issue: 'x' },
    ])
    expect(error.docUrl).toBe('https://docs.example/errors/validation_error')
    expect(error.name).toBe('ValidationError')
  })

  it('a 429 carries what the server asked for in retryAfter, in seconds', async () => {
    server.enqueue({ status: 429, body: errorBody('rate_limited'), headers: { 'Retry-After': '7' } })

    const error = (await hermesi.events.trigger('order.shipped', 'user_1').catch((e: unknown) => e)) as RateLimitError

    expect(error.retryAfter).toBe(7)
    expect(error.isRetryable).toBe(true)
  })

  it('an answer that is not the error envelope is reported as such, not guessed at', async () => {
    server.enqueue({ status: 502, body: '<html>Bad gateway</html>' })

    const error = (await hermesi.events.trigger('order.shipped', 'user_1').catch((e: unknown) => e)) as ServerError

    expect(error).toBeInstanceOf(ServerError)
    expect(error.type).toBe('sdk_error')
    expect(error.code).toBe('unexpected_response')
    expect(error.requestId).toBe('')
  })

  it('a success that is not an event is an error, not a made-up result', async () => {
    server.enqueue({ status: 202, body: { hello: 'world' } })

    const error = (await hermesi.events.trigger('order.shipped', 'user_1').catch((e: unknown) => e)) as HermesiAPIError

    expect(error).toBeInstanceOf(HermesiAPIError)
    expect(error.code).toBe('unexpected_response')
  })

  it('a success that is not JSON is an error', async () => {
    server.enqueue({ status: 200, body: 'OK' })

    await expect(hermesi.events.trigger('order.shipped', 'user_1')).rejects.toMatchObject({ code: 'unexpected_response' })
  })

  it('does not follow a redirect, which would turn the POST into a GET and lose the event', async () => {
    server.enqueue({ status: 301, headers: { Location: '/elsewhere' }, body: '' })

    const error = (await hermesi.events.trigger('order.shipped', 'user_1').catch((e: unknown) => e)) as HermesiAPIError

    expect(error).toBeInstanceOf(HermesiAPIError)
    expect(error.status).toBe(301)
    expect(server.requests).toHaveLength(1)
  })

  it('every error shares one base a caller can catch', async () => {
    server.enqueue({ status: 404, body: errorBody('subscriber_not_found') }, { status: 404, body: errorBody('subscriber_not_found') })

    await expect(hermesi.events.trigger('order.shipped', 'user_1')).rejects.toBeInstanceOf(HermesiError)
    await expect(hermesi.events.trigger('order.shipped', 'user_1')).rejects.toBeInstanceOf(Error)
  })
})

describe('the fetch option', () => {
  it('uses the fetch it was given', async () => {
    const calls: string[] = []
    const own = new Hermesi({
      apiKey: KEY,
      baseUrl: 'https://hermesi.example/',
      fetch: async (url, init) => {
        calls.push(`${init.method} ${url}`)
        return { status: 202, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(ACCEPTED) }
      },
    })

    const result = await own.events.trigger('order.shipped', 'user_1')

    expect(calls).toEqual(['POST https://hermesi.example/v1/events'])
    expect(result.eventId).toBe(ACCEPTED.event_id)
  })
})
