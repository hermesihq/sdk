import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hermesi, HermesiSimulationError, ValidationError } from './index.ts'
import { errorBody, startServer, type TestServer } from './testServer.ts'

/**
 * `subscribers.bulk`: up to 1 000 upserts in one request (`POST /v1/subscribers/bulk`).
 *
 * Each row has to mean what the same `put` would, which for a sync job comes down to one distinction: a field set to `null` clears
 * it and a field left out (or `undefined`) leaves it alone. And a typo is refused naming its row instead of being dropped, which in a
 * bulk import is a column of the file that is silently never applied.
 */

const KEY = 'hm_sk_test_0123456789'
let server: TestServer
let hermesi: Hermesi

beforeEach(async () => {
  server = await startServer({ status: 200, body: {} })
  hermesi = new Hermesi({ apiKey: KEY, baseUrl: server.url, retry: { maxRetries: 0 } })
})
afterEach(() => server.close())

const ANSWER = {
  created: 2,
  updated: 1,
  subscribers: [
    { external_id: 'user_1', id: 'sub_1', status: 'created' },
    { external_id: 'user_2', id: 'sub_2', status: 'updated' },
    { external_id: 'user_3', id: 'sub_3', status: 'created' },
  ],
}

const sent = (): { subscribers: Record<string, unknown>[] } => JSON.parse(server.requests.at(-1)!.body)

describe('subscribers.bulk', () => {
  it('is one POST, in snake case, and the result says what happened to each row', async () => {
    server.enqueue({ body: ANSWER })

    const result = await hermesi.subscribers.bulk([
      { externalId: 'user_1', email: 'a@example.cm', phoneE164: '+237690000000', firstName: 'A' },
      { externalId: 'user_2', locale: 'fr', data: { plan: 'pro' } },
    ])

    const request = server.requests[0]!
    expect([request.method, request.url]).toEqual(['POST', '/v1/subscribers/bulk'])
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(request.headers['idempotency-key']).toBeUndefined()
    expect(sent()).toEqual({
      subscribers: [
        { external_id: 'user_1', email: 'a@example.cm', phone_e164: '+237690000000', first_name: 'A' },
        { external_id: 'user_2', locale: 'fr', data: { plan: 'pro' } },
      ],
    })
    expect([result.created, result.updated]).toEqual([2, 1])
    expect(result.subscribers).toEqual([
      { externalId: 'user_1', id: 'sub_1', status: 'created' },
      { externalId: 'user_2', id: 'sub_2', status: 'updated' },
      { externalId: 'user_3', id: 'sub_3', status: 'created' },
    ])
  })

  it('sends null to clear a field and leaves out one that is undefined or absent', async () => {
    server.enqueue({ body: ANSWER })

    await hermesi.subscribers.bulk([
      { externalId: 'u', phoneE164: null, data: null },
      { externalId: 'v', email: undefined },
      { externalId: 'w' },
    ])

    expect(sent().subscribers).toEqual([{ external_id: 'u', phone_e164: null, data: null }, { external_id: 'v' }, { external_id: 'w' }])
  })

  it('takes any iterable, a generator included', async () => {
    server.enqueue({ body: ANSWER })

    function* rows() {
      for (const i of [0, 1, 2]) yield { externalId: `u${i}` }
    }
    await hermesi.subscribers.bulk(rows())

    expect(sent().subscribers.map((row) => row.external_id)).toEqual(['u0', 'u1', 'u2'])
  })

  it.each([
    [[], /at least one subscriber/],
    [[{ email: 'a@example.cm' }], /row 0: externalId is required/],
    [[{ externalId: 'a' }, { externalId: '' }], /row 1: externalId is required/],
    [[{ externalId: 'a' }, { externalId: 7 }], /row 1: externalId is required/],
    [[{ externalId: 'a', phone_e164: '+1' }], /row 0: unknown subscriber field "phone_e164"/],
    [[{ externalId: 'a' }, { externalId: 'b', phone: '+1' }], /row 1: unknown subscriber field "phone"/],
    [[{ externalId: 'a' }, 'user_2'], /row 1 must be an object/],
    [[{ externalId: 'a' }, null], /row 1 must be an object/],
  ])('refuses %j naming the row, before any request', async (rows, message) => {
    await expect(hermesi.subscribers.bulk(rows as never)).rejects.toThrow(message)
    expect(server.requests).toHaveLength(0)
  })

  it('surfaces the server refusal with every problem and its row', async () => {
    server.enqueue({
      status: 422,
      body: errorBody('validation_error', {
        detail: [
          { field: 'body.subscribers.0.phone_e164', issue: 'Value error, not an E.164 phone number' },
          { field: 'body.subscribers.2.locale', issue: 'Value error, not a language tag' },
        ],
      }),
    })

    const error = (await hermesi.subscribers.bulk([{ externalId: 'a' }, { externalId: 'b' }, { externalId: 'c' }]).catch((e: unknown) => e)) as ValidationError

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.detail.map((d) => d.field)).toEqual(['body.subscribers.0.phone_e164', 'body.subscribers.2.locale'])
  })

  it('is retried on a 503 like any idempotent write', async () => {
    const retrying = new Hermesi({ apiKey: KEY, baseUrl: server.url, retry: { maxRetries: 2 }, sleep: async () => {} })
    server.enqueue({ status: 503, body: errorBody('unavailable') }, { body: ANSWER })

    const result = await retrying.subscribers.bulk([{ externalId: 'user_1' }])

    expect(server.requests).toHaveLength(2)
    expect(result.created).toBe(2)
  })

  it('does not believe an answer without the list of rows', async () => {
    server.enqueue({ body: { created: 3 } })

    await expect(hermesi.subscribers.bulk([{ externalId: 'user_1' }])).rejects.toMatchObject({ code: 'unexpected_response' })
  })

  it('in simulate mode records the call, answers plausibly and validates as a real call does', async () => {
    const test = new Hermesi({ simulate: true })

    const result = await test.subscribers.bulk([{ externalId: 'a', email: 'a@example.cm' }, { externalId: 'b' }])

    expect([result.created, result.updated]).toEqual([2, 0])
    expect(result.subscribers.map((r) => [r.externalId, r.status])).toEqual([
      ['a', 'created'],
      ['b', 'created'],
    ])
    expect(test.simulatedCalls[0]).toMatchObject({
      method: 'POST',
      path: '/v1/subscribers/bulk',
      body: { subscribers: [{ external_id: 'a', email: 'a@example.cm' }, { external_id: 'b' }] },
    })
    await expect(test.subscribers.bulk([{ externalId: 'a', phone: '+1' } as never])).rejects.toThrow(/unknown subscriber field "phone"/)
    expect(test.simulatedCalls).toHaveLength(1)
    expect(HermesiSimulationError.name).toBe('HermesiSimulationError')
  })
})
