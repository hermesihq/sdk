import { readFileSync, readdirSync } from 'node:fs'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hermesi, NotFoundError, VERSION } from './index.ts'
import { errorBody, startServer, type TestServer } from './testServer.ts'

const KEY = 'hm_sk_test_0123456789'
let server: TestServer
let hermesi: Hermesi

beforeEach(async () => {
  server = await startServer({ status: 200, body: { url: 'https://hermesi.example/preferences/tok_1' } })
  hermesi = new Hermesi({ apiKey: KEY, baseUrl: server.url, retry: { maxRetries: 0 } })
})
afterEach(() => server.close())

describe('preference links', () => {
  it('mints one, with the secret key and no idempotency key', async () => {
    const link = await hermesi.subscribers.preferenceLink('user_8821')

    const request = server.requests[0]!
    expect(link.url).toBe('https://hermesi.example/preferences/tok_1')
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/v1/subscribers/user_8821/preference-link')
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(request.headers['idempotency-key']).toBeUndefined()
    expect(request.body).toBe('{}')
  })

  it('escapes the id in the path, so it cannot reach another endpoint', async () => {
    await hermesi.subscribers.preferenceLink('a/b c?d#e%f')

    expect(server.requests[0]!.url).toBe('/v1/subscribers/a%2Fb%20c%3Fd%23e%25f/preference-link')
  })

  it.each(['.', '..'])('refuses %j, which a URL parser would resolve into another path even when escaped', async (id) => {
    await expect(hermesi.subscribers.preferenceLink(id)).rejects.toThrow(TypeError)
    expect(server.requests).toHaveLength(0)
  })

  it('requires an id', async () => {
    await expect(hermesi.subscribers.preferenceLink('')).rejects.toThrow(/externalId is required/)
  })

  it('an unknown subscriber is a NotFoundError', async () => {
    server.enqueue({ status: 404, body: errorBody('subscriber_not_found') })

    await expect(hermesi.subscribers.preferenceLink('nobody')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('an answer without a url is an error', async () => {
    server.enqueue({ status: 200, body: { nope: true } })

    await expect(hermesi.subscribers.preferenceLink('user_1')).rejects.toMatchObject({ code: 'unexpected_response' })
  })
})

describe('simulate', () => {
  it('sends nothing and records the event as it would have gone out', async () => {
    const test = new Hermesi({ simulate: true })

    const result = await test.events.trigger(
      'order.shipped',
      { externalId: 'user_1', email: 'a@example.test' },
      { orderId: '4821', at: new Date('2026-10-04T12:00:00Z') },
      { idempotencyKey: 'k1', delay: '5m' },
    )

    expect(result).toMatchObject({ status: 'simulated', idempotencyKey: 'k1', replayed: false })
    expect(test.simulated).toHaveLength(1)
    expect(test.simulated[0]).toMatchObject({
      name: 'order.shipped',
      recipient: { externalId: 'user_1', email: 'a@example.test' },
      payload: { orderId: '4821', at: '2026-10-04T12:00:00.000Z' },
      idempotencyKey: 'k1',
    })
    expect(test.simulated[0]!.body).toMatchObject({ delay: '5m', recipient: { external_id: 'user_1', email: 'a@example.test' } })
  })

  it('still validates what a real call would, so a bad payload fails in the test and not in production', async () => {
    const test = new Hermesi({ simulate: true })

    await expect(test.events.trigger('order.shipped', 'user_1', { m: new Map() })).rejects.toThrow(TypeError)
    await expect(test.events.trigger('', 'user_1')).rejects.toThrow(/name is required/)
    await expect(test.events.trigger('order.shipped', 'user_1', {}, { sendAt: new Date('x') })).rejects.toThrow(TypeError)
    expect(test.simulated).toHaveLength(0)
  })

  it('numbers its events, makes a preference link, and mints a token', async () => {
    const test = new Hermesi({ simulate: true })

    expect((await test.events.trigger('a.b', 'u')).eventId).toBe('evt_simulated_1')
    expect((await test.events.trigger('a.b', 'u')).eventId).toBe('evt_simulated_2')
    expect((await test.subscribers.preferenceLink('user 1')).url).toBe('https://simulated.invalid/preferences/user%201')
    expect(await test.tokens.mint('user_1', { environmentId: 'env_1' })).toMatch(/^[\w-]+\.[\w-]+$/)
    expect(test.simulate).toBe(true)
  })

  it('records a copy of the payload, so changing it afterwards does not change the record', async () => {
    const test = new Hermesi({ simulate: true })
    const payload = { items: [1] }

    await test.events.trigger('a.b', 'u', payload)
    payload.items.push(2)

    expect(test.simulated[0]!.payload).toEqual({ items: [1] })
  })
})

describe('configuration', () => {
  it('requires a key and a base URL', () => {
    const before = { key: process.env.HERMESI_SECRET_KEY, url: process.env.HERMESI_BASE_URL }
    delete process.env.HERMESI_SECRET_KEY
    delete process.env.HERMESI_BASE_URL
    try {
      expect(() => new Hermesi({ baseUrl: 'https://h.example' })).toThrow(/apiKey is required/)
      expect(() => new Hermesi({ apiKey: KEY })).toThrow(/baseUrl is required/)
    } finally {
      if (before.key !== undefined) process.env.HERMESI_SECRET_KEY = before.key
      if (before.url !== undefined) process.env.HERMESI_BASE_URL = before.url
    }
  })

  it('reads the key and the base URL from the environment', async () => {
    process.env.HERMESI_SECRET_KEY = KEY
    process.env.HERMESI_BASE_URL = `${server.url}/`
    try {
      server.enqueue({ status: 202, body: { event_id: 'evt_1' } })
      const fromEnv = new Hermesi()

      await fromEnv.events.trigger('order.shipped', 'user_1')

      expect(server.requests[0]!.url).toBe('/v1/events')
      expect(server.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`)
    } finally {
      delete process.env.HERMESI_SECRET_KEY
      delete process.env.HERMESI_BASE_URL
    }
  })

  it('refuses a public key, and says why', () => {
    expect(() => new Hermesi({ apiKey: 'hm_pk_abc', baseUrl: 'https://h.example' })).toThrow(/secret key.*public key/s)
  })

  it('refuses a base URL that is not http(s), and settings that make no sense', () => {
    expect(() => new Hermesi({ apiKey: KEY, baseUrl: 'hermesi.example' })).toThrow(/http/)
    expect(() => new Hermesi({ apiKey: KEY, baseUrl: 'https://h.example', timeoutMs: 0 })).toThrow(RangeError)
    expect(() => new Hermesi({ apiKey: KEY, baseUrl: 'https://h.example', retry: { maxRetries: -1 } })).toThrow(RangeError)
  })

  it('never shows the key, however the client is printed or serialised', () => {
    const shown = [inspect(hermesi, { depth: 6, showHidden: true }), JSON.stringify(hermesi), String(hermesi), inspect(hermesi.events)]

    for (const text of shown) expect(text).not.toContain(KEY)
  })

  it('reports a version equal to the one in package.json', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(VERSION).toBe(manifest.version)
  })

  it('imports nothing from node: in its published source, so it runs where fetch and Web Crypto do', () => {
    const sources = readdirSync(new URL('.', import.meta.url)).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'testServer.ts',
    )
    expect(sources.length).toBeGreaterThan(5)
    for (const file of sources) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(text, file).not.toMatch(/from\s+['"]node:|require\(|from\s+['"](fs|http|https|crypto|buffer)['"]/)
      expect(text, file).not.toMatch(/\bBuffer\b/)
    }
  })
})
