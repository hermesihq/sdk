import { afterEach, describe, expect, it, vi } from 'vitest'
import { HermsClient } from './HermsClient'
import { HermsApiError, type HermsClientOptions } from './types'

/**
 * The transport contract: what leaves the browser for every method on `HermsClient`, and
 * what a consumer gets back — including when the response is not what the API promised.
 *
 * `channels.test.ts` covers the two defects that were already found here. This file
 * covers the rest of the surface by the same rule: assert what an integrator or the
 * server can observe (URL, method, headers, body, resolved value, thrown error), never
 * how the class arranges itself internally.
 *
 * The global `fetch` is stubbed rather than injected — `HermsClient` calls it directly
 * and takes no implementation, and adding one to the public API to make these tests
 * easier would be changing the product to suit the test. `vitest.config.ts` sets
 * `unstubGlobals`, so each case starts clean.
 */

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

function stubFetch(respond: (request: Recorded) => Response): Recorded[] {
  const calls: Recorded[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    // `Headers` lower-cases names, which is also how a server sees them.
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    const recorded: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    }
    calls.push(recorded)
    return respond(recorded)
  })
  return calls
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** The one request the case made, or a failure that says so rather than a deref of undefined. */
function onlyCall(calls: Recorded[]): Recorded {
  const call = calls[0]
  if (!call) throw new Error('no request was made')
  return call
}

function client(options: Partial<HermsClientOptions> = {}): HermsClient {
  return new HermsClient({
    apiBaseUrl: 'https://api.example.test/v1/client',
    publicKey: 'hm_pk_test_abc',
    getSubscriberToken: () => 'st_test',
    ...options,
  })
}

const WIRE_ITEM = {
  id: 'inb_01K2QH8F44MEQ5NPX3E1FQJZR9',
  title: 'Your order has shipped',
  body: 'Order #4821 is on its way.',
  action_url: 'https://track.example.cm/4821',
  category: { key: 'shipping', name: 'Shipping' },
  seen_at: '2026-09-01T10:00:00Z',
  read_at: null,
  created_at: '2026-09-01T09:59:00Z',
}

/**
 * The error a call rejected with, or a failure saying it did not reject at all.
 * `rejects.toBeInstanceOf` on its own cannot be followed by assertions on the error's
 * own fields, and the status/code are the fields that matter here.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the call to reject, but it resolved')
}

describe('the subscriber token', () => {
  it('is fetched from the host before every single request', async () => {
    // The contract in `HermsClientOptions`, and the reason it is a *function* and not a
    // string: the host rotates the token (its TTL is capped at an hour), and an SDK that
    // cached one past the call it was handed for would produce 401s that look like the
    // host app's bug. Three calls, three asks.
    let issued = 0
    const getSubscriberToken = vi.fn(() => `st_${++issued}`)
    stubFetch(() => json({ data: [], has_more: false, next_cursor: null, unread: 0, unseen: 0, updated: 0 }))

    const subject = client({ getSubscriberToken })
    await subject.listInbox()
    await subject.getCounts()
    await subject.markAllRead()

    expect(getSubscriberToken).toHaveBeenCalledTimes(3)
  })

  it('sends the token the host issued for that request, not the first one', async () => {
    let issued = 0
    const calls = stubFetch(() => json({ unread: 0, unseen: 0 }))
    const subject = client({ getSubscriberToken: () => `st_${++issued}` })

    await subject.getCounts()
    await subject.getCounts()

    expect(calls.map((call) => call.headers['x-hermesi-subscriber-token'])).toEqual(['st_1', 'st_2'])
  })

  it('awaits a host that returns a promise', async () => {
    // The realistic implementation: the host fetches the token from its own backend. A
    // missing await would put '[object Promise]' in the header and 401 everything.
    const calls = stubFetch(() => json({ unread: 0, unseen: 0 }))

    await client({
      getSubscriberToken: async () => {
        await Promise.resolve()
        return 'st_from_backend'
      },
    }).getCounts()

    expect(onlyCall(calls).headers['x-hermesi-subscriber-token']).toBe('st_from_backend')
  })

  it('travels beside the public key, in the two headers the API reads', async () => {
    const calls = stubFetch(() => json({ unread: 0, unseen: 0 }))

    await client().getCounts()

    const { headers } = onlyCall(calls)
    // Both are required by `/v1/client/*`: the public key identifies the environment,
    // the token identifies the subscriber. Neither is sufficient alone.
    expect(headers.authorization).toBe('Bearer hm_pk_test_abc')
    expect(headers['x-hermesi-subscriber-token']).toBe('st_test')
    expect(headers.accept).toBe('application/json')
  })
})

describe('onTokenExpiring', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** `base64url(payload) + "." + signature`, the format Hermesi mints. */
  function tokenExpiringAt(unixSeconds: number): string {
    const payload = btoa(JSON.stringify({ sub: 'usr_1', env: 'env_live', exp: unixSeconds }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    return `${payload}.c2ln`
  }

  it('warns the host ahead of expiry, not after the first 401', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'))
    const onTokenExpiring = vi.fn()
    stubFetch(() => json({ unread: 0, unseen: 0 }))
    const expSeconds = Math.floor(Date.parse('2026-09-01T12:05:00Z') / 1000)

    await client({ getSubscriberToken: () => tokenExpiringAt(expSeconds), onTokenExpiring }).getCounts()

    // The whole value of the hook is the window *before* exp: at 3m50s the token is
    // still good, and the host gets a minute to mint a replacement with no failed
    // request in between. Firing at or after exp would make this hook pointless.
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 50_000)
    expect(onTokenExpiring).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(20_000)
    expect(onTokenExpiring).toHaveBeenCalledTimes(1)
  })

  it('is simply never scheduled for a token it cannot read', async () => {
    vi.useFakeTimers()
    const onTokenExpiring = vi.fn()
    stubFetch(() => json({ unread: 0, unseen: 0 }))

    // A host wiring things up with a placeholder, or minting a format this SDK does not
    // recognise. Best-effort by design (`HermsClientOptions`): the request still goes
    // out, nothing throws, only the hook is skipped.
    await client({ getSubscriberToken: () => 'not-a-token', onTokenExpiring }).getCounts()

    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    expect(onTokenExpiring).not.toHaveBeenCalled()
  })

  it('stops firing once the client is destroyed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'))
    const onTokenExpiring = vi.fn()
    stubFetch(() => json({ unread: 0, unseen: 0 }))
    const expSeconds = Math.floor(Date.parse('2026-09-01T12:05:00Z') / 1000)
    const subject = client({ getSubscriberToken: () => tokenExpiringAt(expSeconds), onTokenExpiring })

    await subject.getCounts()
    // What `HermsProvider` calls on unmount. A timer that outlives the component calls
    // back into an app that has already torn down whatever the callback touches.
    subject.destroy()

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(onTokenExpiring).not.toHaveBeenCalled()
  })
})

describe('URL building', () => {
  it('tolerates a base URL with a trailing slash', async () => {
    // `apiBaseUrl` gets copy-pasted out of a dashboard or an env var, and half the world
    // stores it with the slash. `//inbox/counts` is a different path to most routers.
    const calls = stubFetch(() => json({ unread: 0, unseen: 0 }))

    await client({ apiBaseUrl: 'https://api.example.test/v1/client/' }).getCounts()

    expect(onlyCall(calls).url).toBe('https://api.example.test/v1/client/inbox/counts')
  })

  it('supports a same-origin relative base', async () => {
    // Documented in `HermsClientOptions`: behind a dev proxy the base is just
    // `/v1/client`. Anything that ran the base through `new URL()` would throw here.
    const calls = stubFetch(() => json({ unread: 0, unseen: 0 }))

    await client({ apiBaseUrl: '/v1/client' }).getCounts()

    expect(onlyCall(calls).url).toBe('/v1/client/inbox/counts')
  })

  it('sends no query string at all when nothing is filtered', async () => {
    const calls = stubFetch(() => json({ data: [], has_more: false, next_cursor: null }))

    await client().listInbox()

    // Not a bare `?`, and above all not `?limit=undefined` — `limit` has a server-side
    // default (50) that a stringified `undefined` would turn into a 422.
    expect(onlyCall(calls).url).toBe('https://api.example.test/v1/client/inbox')
  })

  it('maps the read filter to the boolean the API takes', async () => {
    const calls = stubFetch(() => json({ data: [], has_more: false, next_cursor: null }))
    const subject = client()

    await subject.listInbox({ status: 'unread' })
    await subject.listInbox({ status: 'read' })

    // `status: 'unread'` reads as "the unread ones", the API's parameter reads as
    // `read=false`. Inverting this returns a plausible-looking wrong list, which is the
    // kind of bug a screenshot does not reveal.
    expect(calls.map((call) => new URL(call.url).searchParams.get('read'))).toEqual(['false', 'true'])
  })

  it('repeats the category parameter for a multi-category filter', async () => {
    const calls = stubFetch(() => json({ data: [], has_more: false, next_cursor: null }))

    await client().listInbox({ category: ['billing', 'security'], limit: 25, cursor: 'cur_abc' })

    const { searchParams } = new URL(onlyCall(calls).url)
    // The API documents `category` as repeatable; a comma-joined single value would
    // filter on a category key that does not exist and quietly return nothing.
    expect(searchParams.getAll('category')).toEqual(['billing', 'security'])
    expect(searchParams.get('limit')).toBe('25')
    expect(searchParams.get('cursor')).toBe('cur_abc')
  })

  it('encodes an item id into the path instead of letting it reshape the URL', async () => {
    const calls = stubFetch(() => json(WIRE_ITEM))

    // Ids are ULIDs in practice, but an id is still server data being put back into a
    // URL — exactly the mistake `deregisterChannel` shipped with.
    await client().markRead('inb_1/../counts?x=1')

    const url = new URL(onlyCall(calls).url)
    expect(url.pathname).toBe('/v1/client/inbox/inb_1%2F..%2Fcounts%3Fx%3D1/read')
    expect(url.search).toBe('')
  })
})

describe('reads', () => {
  it('turns the wire shape into the camelCase one it documents', async () => {
    stubFetch(() => json({ data: [WIRE_ITEM], has_more: true, next_cursor: 'cur_next' }))

    const page = await client().listInbox()

    // This class is the one place snake_case becomes camelCase (`types.ts`). A missed
    // field arrives as `undefined` in a consumer's render, not as an error.
    expect(page).toEqual({
      items: [
        {
          id: WIRE_ITEM.id,
          title: 'Your order has shipped',
          body: 'Order #4821 is on its way.',
          actionUrl: 'https://track.example.cm/4821',
          category: { key: 'shipping', name: 'Shipping' },
          seenAt: '2026-09-01T10:00:00Z',
          readAt: null,
          createdAt: '2026-09-01T09:59:00Z',
        },
      ],
      hasMore: true,
      nextCursor: 'cur_next',
    })
  })

  it('keeps a null category and a null action url as null', async () => {
    // Both are nullable on the wire and both drive rendering decisions in
    // `<HermsInbox />` (`item.actionUrl && …`). Coercing either to `undefined` or `{}`
    // turns "no link" into a link to nowhere.
    stubFetch(() => json({ data: [{ ...WIRE_ITEM, action_url: null, category: null }], has_more: false, next_cursor: null }))

    const [item] = (await client().listInbox()).items

    expect(item?.actionUrl).toBeNull()
    expect(item?.category).toBeNull()
  })

  it('reads both counts', async () => {
    stubFetch(() => json({ unread: 7, unseen: 2 }))

    // Two different numbers on purpose: unread and unseen are distinct (the
    // badge shows unseen, the label announces unread) and returning one for both is an
    // easy, invisible slip.
    expect(await client().getCounts()).toEqual({ unread: 7, unseen: 2 })
  })
})

describe('writes', () => {
  it('marks one item read and hands back the updated row', async () => {
    const calls = stubFetch(() => json({ ...WIRE_ITEM, read_at: '2026-09-01T10:05:00Z' }))

    const updated = await client().markRead(WIRE_ITEM.id)

    expect(onlyCall(calls).method).toBe('POST')
    // `useInbox` patches its list with exactly this row rather than refetching, so it
    // has to come back mapped, not raw.
    expect(updated.readAt).toBe('2026-09-01T10:05:00Z')
  })

  it('reports how many rows mark-all-read touched', async () => {
    stubFetch(() => json({ updated: 12 }))

    expect(await client().markAllRead()).toEqual({ updated: 12 })
  })

  it('sends the seen ids as a JSON body', async () => {
    const calls = stubFetch(() => json({ updated: 2 }))

    await client().markSeen(['inb_1', 'inb_2'])

    const call = onlyCall(calls)
    expect(call.method).toBe('POST')
    expect(call.headers['content-type']).toBe('application/json')
    expect(JSON.parse(call.body ?? 'null')).toEqual({ ids: ['inb_1', 'inb_2'] })
  })

  it('makes no request at all to mark nothing seen', async () => {
    const calls = stubFetch(() => json({ updated: 0 }))

    // `<HermsInbox />` calls this from an effect that reruns on every list change; with
    // an empty list that would be a request per render, and the API answers 422 rather
    // than "fine, nothing to do".
    expect(await client().markSeen([])).toEqual({ updated: 0 })
    expect(calls).toHaveLength(0)
  })

  it('archives and deletes through the routes the API exposes', async () => {
    const calls = stubFetch((request) => (request.method === 'DELETE' ? new Response(null, { status: 204 }) : json(WIRE_ITEM)))
    const subject = client()

    await subject.archive(WIRE_ITEM.id)
    // 204, no body — the response handling must not try to read a row out of it.
    await expect(subject.delete(WIRE_ITEM.id)).resolves.toBeUndefined()

    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      `POST /v1/client/inbox/${WIRE_ITEM.id}/archive`,
      `DELETE /v1/client/inbox/${WIRE_ITEM.id}`,
    ])
  })

  it('registers a channel with its metadata', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }))

    await client().registerChannel({ channel: 'push', identifier: 'fcm_dQw4w9WgXcQ', metadata: { platform: 'android' } })

    const call = onlyCall(calls)
    expect(call.method).toBe('POST')
    expect(new URL(call.url).pathname).toBe('/v1/client/channels')
    expect(JSON.parse(call.body ?? 'null')).toEqual({
      channel: 'push',
      identifier: 'fcm_dQw4w9WgXcQ',
      metadata: { platform: 'android' },
    })
  })
})

describe('failures', () => {
  it('raises the API error envelope as a HermsApiError', async () => {
    stubFetch(() =>
      json(
        { error: { type: 'authentication_error', code: 'subscriber_token_invalid', message: 'Token rejected.', request_id: 'req_9' } },
        401,
      ),
    )

    const error = await rejection(client().getCounts())

    expect(error).toBeInstanceOf(HermsApiError)
    const apiError = error as HermsApiError
    expect(apiError.status).toBe(401)
    // The code a host branches on to re-mint a token and retry.
    expect(apiError.code).toBe('subscriber_token_invalid')
    expect(apiError.requestId).toBe('req_9')
  })

  it("raises a proxy's HTML error page as a HermsApiError too", async () => {
    // The response that breaks naive SDKs: nothing here is JSON, and a bare
    // `response.json()` would reject with a SyntaxError that buries the 502 the
    // consumer actually needed to see.
    stubFetch(
      () => new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    )

    const error = await rejection(client().listInbox())

    expect(error).toBeInstanceOf(HermsApiError)
    expect((error as HermsApiError).status).toBe(502)
    expect((error as Error).message).toContain('502')
  })

  it('raises an empty-bodied 500 as a HermsApiError', async () => {
    stubFetch(() => new Response(null, { status: 500 }))

    const error = await rejection(client().markAllRead())

    expect(error).toBeInstanceOf(HermsApiError)
    expect((error as HermsApiError).status).toBe(500)
  })

  it('lets a network failure through as itself', async () => {
    // Offline, DNS, CORS. Deliberately *not* a `HermsApiError`: there was no API
    // response at all, and a consumer rendering "the server said…" for a dropped Wi-Fi
    // connection is telling its user something false.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })

    const error = await rejection(client().getCounts())

    expect(error).not.toBeInstanceOf(HermsApiError)
    expect((error as Error).message).toBe('Failed to fetch')
  })
})
