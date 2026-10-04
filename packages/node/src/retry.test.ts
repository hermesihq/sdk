import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hermesi, HermesiAPIError, HermesiConnectionError, ServerError, ValidationError } from './index.ts'
import { DEFAULT_RETRY, parseRetryAfter, resolveRetry, retryDelay } from './retry.ts'
import { ACCEPTED, deadUrl, errorBody, startServer, type TestServer } from './testServer.ts'

const KEY = 'hm_sk_test_0123456789'
let server: TestServer
let waits: number[]

const client = (retry: Parameters<typeof resolveRetry>[0] = {}, extra: { baseUrl?: string; timeoutMs?: number } = {}): Hermesi =>
  new Hermesi({
    apiKey: KEY,
    baseUrl: extra.baseUrl ?? server.url,
    timeoutMs: extra.timeoutMs,
    retry,
    sleep: async (ms) => void waits.push(ms),
  })

beforeEach(async () => {
  server = await startServer()
  waits = []
})
afterEach(() => server.close())

describe('retrying a call', () => {
  it('retries a 5xx and succeeds, with the same idempotency key every time', async () => {
    server.enqueue({ status: 503, body: errorBody('unavailable') }, { status: 500, body: errorBody('boom') })

    const result = await client().events.trigger('order.shipped', 'user_1')

    expect(result.eventId).toBe(ACCEPTED.event_id)
    expect(server.requests).toHaveLength(3)
    expect(new Set(server.requests.map((r) => r.headers['idempotency-key'])).size).toBe(1)
    expect(result.idempotencyKey).toBe(server.requests[0]!.headers['idempotency-key'])
    expect(waits).toHaveLength(2)
  })

  it('waits exactly as long as the server asks on a 429', async () => {
    server.enqueue({ status: 429, body: errorBody('rate_limited'), headers: { 'Retry-After': '2' } })

    await client().events.trigger('order.shipped', 'user_1')

    expect(waits).toEqual([2000])
  })

  it('does not sleep through a Retry-After longer than it is willing to wait', async () => {
    server.enqueue({ status: 429, body: errorBody('rate_limited'), headers: { 'Retry-After': '600' } })

    const error = await client().events.trigger('order.shipped', 'user_1').catch((e: unknown) => e)

    expect(error).toMatchObject({ status: 429, retryAfter: 600 })
    expect(waits).toEqual([])
    expect(server.requests).toHaveLength(1)
  })

  it('gives up after the configured retries and rejects with the last answer', async () => {
    server.enqueue(
      ...[1, 2, 3, 4, 5].map((n) => ({ status: 503, body: errorBody(`unavailable_${n}`) })),
    )

    const error = await client({ maxRetries: 2 }).events.trigger('order.shipped', 'user_1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ServerError)
    expect((error as ServerError).code).toBe('unavailable_3')
    expect(server.requests).toHaveLength(3)
  })

  it('maxRetries 0 turns retrying off', async () => {
    server.enqueue({ status: 503, body: errorBody('unavailable') })

    await expect(client({ maxRetries: 0 }).events.trigger('order.shipped', 'user_1')).rejects.toBeInstanceOf(ServerError)
    expect(server.requests).toHaveLength(1)
    expect(waits).toEqual([])
  })

  it.each([400, 401, 403, 404, 409, 422])('never retries a %i, which the same request would get again', async (status) => {
    server.enqueue({ status, body: errorBody('refused') })

    await expect(client().events.trigger('order.shipped', 'user_1')).rejects.toBeInstanceOf(HermesiAPIError)
    expect(server.requests).toHaveLength(1)
  })

  it('a validation error after a retry is still raised as one', async () => {
    server.enqueue({ status: 503, body: errorBody('unavailable') }, { status: 422, body: errorBody('validation_error') })

    await expect(client().events.trigger('order.shipped', 'user_1')).rejects.toBeInstanceOf(ValidationError)
    expect(server.requests).toHaveLength(2)
  })

  it('retries a connection the server drops', async () => {
    server.enqueue({ destroy: true })

    const result = await client().events.trigger('order.shipped', 'user_1')

    expect(result.status).toBe('accepted')
    expect(server.requests).toHaveLength(2)
    expect(new Set(server.requests.map((r) => r.headers['idempotency-key'])).size).toBe(1)
  })

  it('retries an answer cut off halfway through its body', async () => {
    server.enqueue({ status: 202, body: ACCEPTED, truncate: true })

    const result = await client().events.trigger('order.shipped', 'user_1')

    expect(result.eventId).toBe(ACCEPTED.event_id)
    expect(server.requests).toHaveLength(2)
  })

  it('retries a timeout, and each attempt gets its own', async () => {
    server.enqueue({ hang: true })

    const result = await client({}, { timeoutMs: 150 }).events.trigger('order.shipped', 'user_1')

    expect(result.status).toBe('accepted')
    expect(server.requests).toHaveLength(2)
  })

  it('a server that never answers is a connection error naming the timeout, not an API error', async () => {
    server.enqueue({ hang: true }, { hang: true })

    const error = await client({ maxRetries: 1 }, { timeoutMs: 100 }).events.trigger('order.shipped', 'user_1').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HermesiConnectionError)
    expect(error).not.toBeInstanceOf(HermesiAPIError)
    expect((error as Error).message).toContain('no answer within 100 ms')
  })

  it('a connection that never comes back is a connection error carrying its cause', async () => {
    const error = await client({ maxRetries: 2 }, { baseUrl: await deadUrl() })
      .events.trigger('order.shipped', 'user_1')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HermesiConnectionError)
    expect((error as Error).message).toContain('ECONNREFUSED')
    expect((error as Error).cause).toBeInstanceOf(Error)
    expect(waits).toHaveLength(2)
  })

  it('backoff grows and stays inside its bounds', async () => {
    server.enqueue(...Array.from({ length: 5 }, () => ({ status: 503, body: errorBody('unavailable') })))

    await client({ maxRetries: 4, baseDelayMs: 100, maxDelayMs: 300 }).events.trigger('order.shipped', 'user_1').catch(() => {})

    // Ceilings 100, 200, 300, 300 (capped); each wait is between half the ceiling and all of it.
    const ceilings = [100, 200, 300, 300]
    expect(waits).toHaveLength(4)
    waits.forEach((wait, i) => {
      expect(wait).toBeGreaterThanOrEqual(ceilings[i]! / 2)
      expect(wait).toBeLessThanOrEqual(ceilings[i]!)
    })
  })

  it('retries a preference link too', async () => {
    server.enqueue({ status: 503, body: errorBody('unavailable') }, { status: 200, body: { url: 'https://h.example/preferences/abc' } })

    const link = await client().subscribers.preferenceLink('user_1')

    expect(link.url).toBe('https://h.example/preferences/abc')
    expect(server.requests).toHaveLength(2)
  })
})

describe('the policy', () => {
  const policy = { ...DEFAULT_RETRY, maxRetries: 10, baseDelayMs: 100, maxDelayMs: 1000, maxRetryAfterMs: 5000 }

  it('stops at maxRetries', () => {
    expect(retryDelay({ ...policy, maxRetries: 2 }, 1, null)).not.toBeNull()
    expect(retryDelay({ ...policy, maxRetries: 2 }, 2, null)).toBeNull()
    expect(retryDelay({ ...policy, maxRetries: 0 }, 0, null)).toBeNull()
  })

  it('honours Retry-After exactly and without jitter, whatever the random draw is', () => {
    expect(retryDelay(policy, 0, 3000, () => 0)).toBe(3000)
    expect(retryDelay(policy, 0, 3000, () => 0.999)).toBe(3000)
    expect(retryDelay(policy, 0, 0)).toBe(0)
  })

  it('refuses a Retry-After over its limit, and takes one at the limit', () => {
    expect(retryDelay(policy, 0, 5001)).toBeNull()
    expect(retryDelay(policy, 0, 5000)).toBe(5000)
  })

  it('never waits less than half the ceiling, and never more than all of it', () => {
    expect(retryDelay(policy, 0, null, () => 0)).toBe(50)
    expect(retryDelay(policy, 0, null, () => 1)).toBe(100)
    expect(retryDelay(policy, 3, null, () => 0)).toBe(400)
    expect(retryDelay(policy, 9, null, () => 1)).toBe(1000)
  })

  it('reads Retry-After as seconds and nothing else', () => {
    expect(parseRetryAfter('5')).toBe(5)
    expect(parseRetryAfter(' 1.5 ')).toBe(1.5)
    expect(parseRetryAfter('0')).toBe(0)
    for (const bad of ['', '   ', 'abc', '-1', '1e3', 'Infinity', 'NaN', '0x10', 'Wed, 21 Oct 2026 07:28:00 GMT', null, undefined]) {
      expect(parseRetryAfter(bad), `${String(bad)}`).toBeNull()
    }
  })

  it('rejects settings that make no sense', () => {
    expect(() => resolveRetry({ maxRetries: -1 })).toThrow(RangeError)
    expect(() => resolveRetry({ maxRetries: 1.5 })).toThrow(RangeError)
    expect(() => resolveRetry({ baseDelayMs: -1 })).toThrow(RangeError)
    expect(() => resolveRetry({ maxRetryAfterMs: Number.NaN })).toThrow(RangeError)
    expect(resolveRetry({ maxRetries: 0 }).baseDelayMs).toBe(DEFAULT_RETRY.baseDelayMs)
  })
})
