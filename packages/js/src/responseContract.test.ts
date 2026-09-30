import { describe, expect, it, vi } from 'vitest'
import { HermsClient } from './HermsClient'
import { HermsApiError } from './types'

/**
 * The two defects the first pass of tests found and deliberately did not fix.
 *
 * Both are about the same thing: this SDK sits between a customer's application and a
 * network it does not control, and what it does when the network surprises it is part
 * of its contract. The error path already took that seriously — a proxy's HTML page
 * became a `HermsApiError` with a legible message. The success path did not look at
 * all, and the published error dropped two fields the API declares as required.
 */

function respondWith(response: Response) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return response
  })
  return calls
}

/** The error a call rejected with, narrowed — `.catch()` alone widens to the union of
 *  the resolved value and the error, which is not what any of these cases mean. */
async function rejection(promise: Promise<unknown>): Promise<HermsApiError> {
  try {
    await promise
  } catch (error) {
    return error as HermsApiError
  }
  throw new Error('expected the call to reject')
}

function client() {
  return new HermsClient({
    apiBaseUrl: 'https://api.example.test/v1/client',
    publicKey: 'hm_pk_test',
    getSubscriberToken: () => 'st_test',
  })
}

describe('a 2xx that carries nothing usable', () => {
  it('raises a proxy HTML page on a 200 as a HermsApiError, not a TypeError', async () => {
    // The exact shape reported: a captive portal or a mis-deployed route answers 200
    // with HTML. Before this, `parsed` stayed null and was returned as the payload, so
    // the failure surfaced as `TypeError: Cannot read properties of null (reading
    // 'data')` — a stack pointing at this SDK for something entirely outside it.
    respondWith(new Response('<html><body>Gateway</body></html>', { status: 200 }))

    await expect(client().listInbox()).rejects.toBeInstanceOf(HermsApiError)
  })

  it('raises a 204 where a body was expected', async () => {
    // `getCounts()` reads `.unread` off whatever it is given. A 204 short-circuited to
    // `undefined` and produced `TypeError: Cannot read properties of undefined`.
    respondWith(new Response(null, { status: 204 }))

    await expect(client().getCounts()).rejects.toBeInstanceOf(HermsApiError)
  })

  it('still resolves a 204 for a call that never wanted a body', async () => {
    // The half a blanket fix would have broken. `DELETE /inbox/{id}` answering 204 is
    // the documented success, not a fault, and the same is true of channel
    // registration — which is why `expectsBody` exists rather than a rule about status
    // codes.
    respondWith(new Response(null, { status: 204 }))

    await expect(client().delete('itm_1')).resolves.toBeUndefined()
    await expect(
      client().registerChannel({ channel: 'telegram', identifier: '1755765234' }),
    ).resolves.toBeUndefined()
  })

  it('carries the status it actually saw', async () => {
    // Not flattened to a generic failure: an operator reading a report needs to know
    // whether this was a 200 with a wrong body or a 204 with none.
    respondWith(new Response('not json', { status: 200 }))

    await expect(client().getCounts()).rejects.toMatchObject({ status: 200 })
  })
})

describe('HermsApiError and the envelope the API publishes', () => {
  const envelope = {
    error: {
      type: 'validation_error',
      code: 'invalid_request',
      message: 'identifier is not a valid E.164 number',
      request_id: 'req_7f3c9a12',
      detail: [{ field: 'identifier', issue: 'must start with +' }],
      doc_url: 'https://docs.example.test/errors/invalid_request',
    },
  }

  it('carries detail and docUrl, which it used to drop', async () => {
    respondWith(new Response(JSON.stringify(envelope), { status: 422 }))

    // `detail` is what turns "invalid request" into a form a consumer can point at the
    // offending field, and `doc_url` is the one thing that lets an integrator resolve
    // an error without asking anybody. Both were published as required by the API and
    // neither reached the consumer.
    await expect(client().getCounts()).rejects.toMatchObject({
      detail: [{ field: 'identifier', issue: 'must start with +' }],
      docUrl: 'https://docs.example.test/errors/invalid_request',
    })
  })

  it('gives an empty detail rather than undefined when the server sent none', async () => {
    // The API's own words are "possibly empty, never absent", so a consumer should be
    // able to iterate it without a guard whatever actually arrived.
    respondWith(
      new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), {
        status: 429,
      }),
    )

    const error = await rejection(client().getCounts())

    expect(error.detail).toEqual([])
    expect(error.docUrl).toBe('')
  })

  it('drops a detail entry that is not an object instead of handing it on', async () => {
    // An SDK that throws while handling an error is worse than the error. A server
    // — or something pretending to be one — sending `detail: ['oops', null]` must not
    // reach a consumer iterating entries and reading `.field`.
    respondWith(
      new Response(JSON.stringify({ error: { code: 'x', detail: ['oops', null, { field: 'a' }] } }), {
        status: 400,
      }),
    )

    const error = await rejection(client().getCounts())

    expect(error.detail).toEqual([{ field: 'a' }])
  })
})
