import { describe, expect, it, vi } from 'vitest'
import { HermsClient } from './HermsClient'
import { HERMS_CHANNELS } from './types'

/**
 * The two ways this package disagreed with the API it talks to.
 *
 * Both shipped, both were invisible, and both are the reason the package has tests at
 * all. Nothing called either method, and nothing had built or installed the published
 * artefact, so nothing could have noticed.
 *
 * 1. `deregisterChannel` sent `DELETE /channels?channel=…&identifier=…`. There is no
 *    `DELETE` on `/v1/client/channels` at all; the route takes path parameters. Every
 *    call 404'd.
 * 2. `HermsChannel` listed four channels while the API accepted nine, so an integrator
 *    could not register a Telegram, Slack, Teams, Discord or WhatsApp identity —
 *    TypeScript refused it at their call site.
 */

/**
 * Records the one call made and answers 204.
 *
 * The global is stubbed because `HermsClient` calls `fetch` directly and takes no
 * implementation. Adding one to the public API purely to make this test easier would be
 * changing the product to suit the test; `vitest.config.ts` unstubs between cases.
 */
function recordingFetch(): Array<{ url: string; method: string }> {
  const calls: Array<{ url: string; method: string }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' })
    return new Response(null, { status: 204 })
  })
  return calls
}

/** The single request the case made, or a failure that says so. */
function onlyCall(calls: Array<{ url: string; method: string }>): { url: string; method: string } {
  const call = calls[0]
  if (!call) throw new Error('no request was made')
  return call
}

function client() {
  return new HermsClient({
    apiBaseUrl: 'https://api.example.test/v1/client',
    publicKey: 'hm_pk_test_abc',
    // The host's job, per `HermsClientOptions` — this SDK never holds a secret key and
    // is handed a fresh subscriber token before every request.
    getSubscriberToken: () => 'st_test',
  })
}

describe('deregisterChannel', () => {
  it('addresses the channel and identifier as path segments', async () => {
    const calls = recordingFetch()

    await client().deregisterChannel('telegram', '1755765234')

    expect(calls).toHaveLength(1)
    const { method, url } = onlyCall(calls)

    expect(method).toBe('DELETE')
    // The assertion that fails against the shipped version, which sent
    // `/channels?channel=telegram&identifier=…` at a route that does not exist.
    expect(new URL(url).pathname).toMatch(/\/channels\/telegram\/1755765234$/)
    expect(new URL(url).search).toBe('')
  })

  it('encodes an identifier that carries URL syntax', async () => {
    const calls = recordingFetch()

    // Real identifiers are addresses: an email, an E.164 number, a Teams conversation.
    // `channel:<teamId>/<channelId>` is the worst of them — an unencoded `/` would
    // silently address a different route.
    await client().deregisterChannel('teams', 'channel:abc/19:xyz@thread.tacv2')

    expect(onlyCall(calls).url).toContain('channel%3Aabc%2F19%3Axyz%40thread.tacv2')
  })
})

describe('the channel list', () => {
  // The comparison between this package and the API's published OpenAPI document does not live
  // here: the document belongs to the API, and this repository does not have it. It lives with
  // the API, which runs it against the published package so that it tests what a consumer
  // installs.

  it('is exported as a value a host can iterate', () => {
    // The reason it is an array and not only a union: a preference centre has to render
    // one row per channel, and deriving the type from the array is what stops the two
    // disagreeing.
    expect(HERMS_CHANNELS).toContain('telegram')
    expect(HERMS_CHANNELS.length).toBeGreaterThanOrEqual(9)
  })
})
