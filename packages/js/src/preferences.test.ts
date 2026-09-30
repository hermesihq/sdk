import { describe, expect, it, vi } from 'vitest'
import { HermsClient } from './HermsClient'

/**
 * The preferences surface — `GET` and `PATCH /v1/client/preferences`.
 *
 * The package shipped without it while the API published both routes, so a host could
 * render an inbox and had no way to let the subscriber turn anything off. These tests
 * cover the wire mapping, which is where a hand-written shape drifts from the server,
 * and the two decisions in the client that are not obvious from the code.
 */

const WIRE = {
  first_name: 'Amara',
  global_channels: [
    { channel: 'email', enabled: true },
    { channel: 'sms', enabled: null },
  ],
  global_email_enabled: true,
  global_in_app_enabled: null,
  categories: [
    {
      category_id: 'cat_1',
      key: 'shipping',
      name: 'Shipping updates',
      is_critical: false,
      channels: [{ channel: 'email', enabled: false }],
      email_enabled: false,
      in_app_enabled: true,
    },
    {
      category_id: 'cat_2',
      key: 'security',
      name: 'Security alerts',
      is_critical: true,
      channels: [{ channel: 'email', enabled: true }],
      email_enabled: true,
      in_app_enabled: true,
    },
  ],
}

function respond(body: unknown) {
  const requests: Array<{ url: string; method: string; body: unknown }> = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    return new Response(JSON.stringify(body), { status: 200 })
  })
  return requests
}

function client() {
  return new HermsClient({
    apiBaseUrl: 'https://api.example.test/v1/client',
    publicKey: 'hm_pk_test',
    getSubscriberToken: () => 'st_test',
  })
}

describe('getPreferences', () => {
  it('turns the wire shape into the camelCase one it documents', async () => {
    respond(WIRE)

    const prefs = await client().getPreferences()

    expect(prefs.firstName).toBe('Amara')
    expect(prefs.globalChannels).toEqual([
      { channel: 'email', enabled: true },
      { channel: 'sms', enabled: null },
    ])
    expect(prefs.categories[0]).toEqual({
      categoryId: 'cat_1',
      key: 'shipping',
      name: 'Shipping updates',
      isCritical: false,
      channels: [{ channel: 'email', enabled: false }],
      emailEnabled: false,
      inAppEnabled: true,
    })
  })

  it('keeps a null setting distinct from false', async () => {
    // `null` is "no preference expressed, the default applies" and `false` is "turned
    // off". Collapsing them would tell a subscriber they had opted out of something
    // they never declined — and a host rendering a checkbox needs the difference to
    // show an indeterminate state rather than an unchecked one.
    respond(WIRE)

    const prefs = await client().getPreferences()

    expect(prefs.globalChannels[1]?.enabled).toBeNull()
    expect(prefs.globalInAppEnabled).toBeNull()
  })

  it('carries the critical flag, which a host must not render as a control', async () => {
    respond(WIRE)

    const prefs = await client().getPreferences()

    expect(prefs.categories[1]?.isCritical).toBe(true)
  })
})

describe('updatePreference', () => {
  it('sends the channel and the value, with a null category for the global setting', async () => {
    const requests = respond(WIRE)

    await client().updatePreference({ channel: 'email', enabled: false })

    expect(requests[0]?.method).toBe('PATCH')
    expect(requests[0]?.body).toEqual({ channel: 'email', enabled: false, category_id: null })
  })

  it('scopes the change to one category when given one', async () => {
    const requests = respond(WIRE)

    await client().updatePreference({ channel: 'email', enabled: true, categoryId: 'cat_1' })

    expect(requests[0]?.body).toMatchObject({ category_id: 'cat_1' })
  })

  it('returns the whole new state, so a caller never has to refetch', async () => {
    // The server answers PATCH with the full preferences. A client that discarded that
    // and refetched would render a view assembled from its own guess plus whatever else
    // changed in between.
    const requests = respond(WIRE)

    const prefs = await client().updatePreference({ channel: 'email', enabled: false })

    expect(prefs.categories).toHaveLength(2)
    expect(requests).toHaveLength(1)
  })
})

describe('what is deliberately absent', () => {
  it('exposes no unsubscribe method', () => {
    // `POST /v1/client/unsubscribe` exists, and the API's own description says why this
    // must not wrap it: it is the target of a `List-Unsubscribe` one-click link (RFC
    // 8058) whose token Hermesi mints into an outgoing email's headers, invoked by a
    // mail client rather than by application code. A method here would invite a host to
    // build a button on a token it cannot obtain. The equivalent is
    // `updatePreference({ channel: 'email', enabled: false })`.
    expect('unsubscribe' in client()).toBe(false)
  })
})
