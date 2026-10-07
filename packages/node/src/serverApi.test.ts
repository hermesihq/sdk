import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConflictError,
  Hermesi,
  HermesiSimulationError,
  NotFoundError,
  ValidationError,
  type EventRun,
} from './index.ts'
import { errorBody, startServer, type TestServer } from './testServer.ts'

const KEY = 'hm_sk_test_0123456789'
let server: TestServer
let hermesi: Hermesi

beforeEach(async () => {
  server = await startServer({ status: 200, body: {} })
  hermesi = new Hermesi({ apiKey: KEY, baseUrl: server.url, retry: { maxRetries: 0 } })
})
afterEach(() => server.close())

const PROFILE = {
  id: 'sub_1',
  external_id: 'user_8821',
  email: 'amina@example.cm',
  phone_e164: '+237690000000',
  first_name: 'Amina',
  last_name: null,
  locale: 'fr',
  timezone: 'Africa/Douala',
  avatar_url: null,
  data: { plan: 'pro' },
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-02T10:00:00Z',
  channels: [
    {
      channel: 'push',
      identifier: 'tok_1',
      state: 'active',
      state_reason: null,
      metadata: { platform: 'android' },
      verified_at: null,
      last_used_at: null,
    },
  ],
  preferences: { global: { sms: false }, categories: { marketing: { email: false } } },
}

const RUN = {
  event_id: 'evt_1',
  name: 'order.shipped',
  status: 'processed',
  payload: { orderId: '4821' },
  actor: null,
  idempotency_key: 'k1',
  error: null,
  received_at: '2026-10-01T10:00:00Z',
  processed_at: '2026-10-01T10:00:01Z',
  notifications: [
    {
      id: 'not_1',
      subscriber_id: 'sub_1',
      external_id: 'user_8821',
      workflow: 'order-shipped',
      workflow_version: 3,
      status: 'waiting',
      created_at: '2026-10-01T10:00:00Z',
      started_at: '2026-10-01T10:00:01Z',
      completed_at: null,
      resume_at: '2026-10-01T10:15:00Z',
      messages: [
        {
          id: 'msg_1',
          channel: 'sms',
          status: 'delivered',
          step_key: 'sms',
          provider: 'twilio',
          failure_code: null,
          failure_message: null,
          created_at: '2026-10-01T10:00:02Z',
          terminal_at: '2026-10-01T10:00:09Z',
        },
        {
          id: 'msg_2',
          channel: 'email',
          status: 'queued',
          step_key: 'email',
          provider: null,
          failure_code: null,
          failure_message: null,
          created_at: '2026-10-01T10:00:02Z',
          terminal_at: null,
        },
      ],
    },
  ],
}

describe('events.get', () => {
  it('reads the run, with the messages flattened and final ones marked', async () => {
    server.enqueue({ body: RUN })

    const run: EventRun = await hermesi.events.get('evt_1')

    const request = server.requests[0]!
    expect(request.method).toBe('GET')
    expect(request.url).toBe('/v1/events/evt_1')
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(request.headers['idempotency-key']).toBeUndefined()
    expect(request.headers['content-type']).toBeUndefined()
    expect(request.body).toBe('')
    expect(run.status).toBe('processed')
    expect(run.notifications[0]).toMatchObject({ externalId: 'user_8821', workflow: 'order-shipped', workflowVersion: 3, status: 'waiting' })
    expect(run.notifications[0]!.resumeAt).toBe('2026-10-01T10:15:00Z')
    expect(run.messages.map((m) => [m.id, m.isFinal])).toEqual([
      ['msg_1', true],
      ['msg_2', false],
    ])
    expect(run.messages[0]).toMatchObject({ channel: 'sms', status: 'delivered', provider: 'twilio', stepKey: 'sms' })
  })

  it('escapes the id and refuses . and ..', async () => {
    server.enqueue({ body: RUN })
    await hermesi.events.get('a/b?c')
    expect(server.requests[0]!.url).toBe('/v1/events/a%2Fb%3Fc')
    await expect(hermesi.events.get('..')).rejects.toThrow(TypeError)
    await expect(hermesi.events.get('')).rejects.toThrow(/eventId is required/)
    expect(server.requests).toHaveLength(1)
  })

  it('an event of another environment is a NotFoundError', async () => {
    server.enqueue({ status: 404, body: errorBody('event_not_found') })
    await expect(hermesi.events.get('evt_x')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('an answer that is not an event is an unexpected_response error', async () => {
    server.enqueue({ body: { nope: true } })
    await expect(hermesi.events.get('evt_1')).rejects.toMatchObject({ code: 'unexpected_response' })
  })

  it('is retried on a 503, being a read', async () => {
    const retrying = new Hermesi({ apiKey: KEY, baseUrl: server.url, retry: { maxRetries: 2 }, sleep: async () => {} })
    server.enqueue({ status: 503, body: errorBody('unavailable') }, { body: RUN })

    const run = await retrying.events.get('evt_1')

    expect(run.eventId).toBe('evt_1')
    expect(server.requests).toHaveLength(2)
  })
})

describe('subscribers.put and patch', () => {
  it('sends what was given, in snake case, and reads the profile', async () => {
    server.enqueue({ body: PROFILE })

    const profile = await hermesi.subscribers.put('user_8821', {
      email: 'amina@example.cm',
      phoneE164: '+237690000000',
      firstName: 'Amina',
      avatarUrl: 'https://example.cm/a.png',
      data: { plan: 'pro' },
    })

    const request = server.requests[0]!
    expect(request.method).toBe('PUT')
    expect(request.url).toBe('/v1/subscribers/user_8821')
    expect(request.headers['content-type']).toBe('application/json')
    expect(JSON.parse(request.body)).toEqual({
      email: 'amina@example.cm',
      phone_e164: '+237690000000',
      first_name: 'Amina',
      avatar_url: 'https://example.cm/a.png',
      data: { plan: 'pro' },
    })
    expect(profile).toMatchObject({ externalId: 'user_8821', phoneE164: '+237690000000', firstName: 'Amina', lastName: null, timezone: 'Africa/Douala' })
    expect(profile.channels[0]).toMatchObject({ channel: 'push', identifier: 'tok_1', state: 'active', metadata: { platform: 'android' } })
    expect(profile.preferences).toEqual({ global: { sms: false }, categories: { marketing: { email: false } } })
  })

  it('a field left out is not sent, undefined included, and null is sent to clear', async () => {
    server.enqueue({ body: PROFILE })

    await hermesi.subscribers.put('user_8821', { locale: 'en', email: undefined, phoneE164: null })

    expect(JSON.parse(server.requests[0]!.body)).toEqual({ locale: 'en', phone_e164: null })
  })

  it('with no field at all it sends an empty object', async () => {
    server.enqueue({ body: PROFILE })
    await hermesi.subscribers.put('user_8821')
    expect(server.requests[0]!.body).toBe('{}')
  })

  it('patch uses PATCH', async () => {
    server.enqueue({ body: PROFILE })
    await hermesi.subscribers.patch('user_8821', { locale: 'fr' })
    expect(server.requests[0]!.method).toBe('PATCH')
  })

  it('rejects a field name it does not know, rather than dropping it silently', async () => {
    await expect(hermesi.subscribers.put('user_8821', { phone_e164: '+1' } as never)).rejects.toThrow(/unknown subscriber field "phone_e164"/)
    expect(server.requests).toHaveLength(0)
  })

  it('an id with a slash goes in as one segment', async () => {
    server.enqueue({ body: PROFILE })
    await hermesi.subscribers.put('team/42 é?#', {})
    expect(server.requests[0]!.url).toBe('/v1/subscribers/team%2F42%20%C3%A9%3F%23')
  })

  it('a refused field is a ValidationError carrying the detail', async () => {
    server.enqueue({ status: 422, body: errorBody('validation_error', { detail: [{ loc: ['body', 'email'] }] }) })
    await expect(hermesi.subscribers.put('user_8821', { email: 'nope' })).rejects.toBeInstanceOf(ValidationError)
  })

  it('patch on an unknown subscriber is a NotFoundError', async () => {
    server.enqueue({ status: 404, body: errorBody('subscriber_not_found') })
    await expect(hermesi.subscribers.patch('nobody', { locale: 'fr' })).rejects.toBeInstanceOf(NotFoundError)
  })

  it('a PUT is retried: it is idempotent', async () => {
    const retrying = new Hermesi({ apiKey: KEY, baseUrl: server.url, retry: { maxRetries: 2 }, sleep: async () => {} })
    server.enqueue({ status: 502, body: {} }, { body: PROFILE })

    await retrying.subscribers.put('user_8821', { locale: 'fr' })

    expect(server.requests).toHaveLength(2)
  })

  it('a body that cannot be serialised fails before anything is sent', async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(hermesi.subscribers.put('user_8821', { data: cyclic })).rejects.toThrow()
    expect(server.requests).toHaveLength(0)
  })
})

describe('subscribers.get and delete', () => {
  it('get reads the profile', async () => {
    server.enqueue({ body: PROFILE })
    const profile = await hermesi.subscribers.get('user_8821')
    expect(server.requests[0]).toMatchObject({ method: 'GET', url: '/v1/subscribers/user_8821', body: '' })
    expect(profile.data).toEqual({ plan: 'pro' })
  })

  it('get of an unknown subscriber is a NotFoundError', async () => {
    server.enqueue({ status: 404, body: errorBody('subscriber_not_found') })
    await expect(hermesi.subscribers.get('nobody')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('delete answers 204 with no body and resolves with nothing', async () => {
    server.enqueue({ status: 204, body: '' })
    await expect(hermesi.subscribers.delete('user_8821')).resolves.toBeUndefined()
    expect(server.requests[0]).toMatchObject({ method: 'DELETE', url: '/v1/subscribers/user_8821', body: '' })
  })
})

describe('channels', () => {
  it('registers a destination', async () => {
    server.enqueue({ status: 201, body: PROFILE.channels[0] })

    const identity = await hermesi.subscribers.registerChannel('user_8821', 'push', 'tok_1', { platform: 'android' })

    const request = server.requests[0]!
    expect(request).toMatchObject({ method: 'POST', url: '/v1/subscribers/user_8821/channels' })
    expect(JSON.parse(request.body)).toEqual({ channel: 'push', identifier: 'tok_1', metadata: { platform: 'android' } })
    expect(identity).toMatchObject({ channel: 'push', identifier: 'tok_1', state: 'active' })
  })

  it('leaves metadata out of the body when there is none', async () => {
    server.enqueue({ body: PROFILE.channels[0] })
    await hermesi.subscribers.registerChannel('user_8821', 'push', 'tok_1')
    expect(JSON.parse(server.requests[0]!.body)).toEqual({ channel: 'push', identifier: 'tok_1' })
  })

  it('requires a channel and an identifier', async () => {
    await expect(hermesi.subscribers.registerChannel('user_8821', '', 'tok')).rejects.toThrow(/channel is required/)
    await expect(hermesi.subscribers.registerChannel('user_8821', 'push', '')).rejects.toThrow(/identifier is required/)
    expect(server.requests).toHaveLength(0)
  })

  it('removes one, the identifier going in as a single escaped segment', async () => {
    server.enqueue({ status: 204, body: '' })
    await hermesi.subscribers.removeChannel('user_8821', 'webpush', 'https://push.example/send/abc?x=1#y')
    expect(server.requests[0]).toMatchObject({
      method: 'DELETE',
      url: '/v1/subscribers/user_8821/channels/webpush/https%3A%2F%2Fpush.example%2Fsend%2Fabc%3Fx%3D1%23y',
    })
  })

  it.each(['.', '..'])('refuses %j as an identifier', async (identifier) => {
    await expect(hermesi.subscribers.removeChannel('user_8821', 'push', identifier)).rejects.toThrow(TypeError)
    expect(server.requests).toHaveLength(0)
  })
})

describe('preferences', () => {
  it('reads the overrides', async () => {
    server.enqueue({ body: PROFILE.preferences })
    const preferences = await hermesi.subscribers.preferences('user_8821')
    expect(server.requests[0]).toMatchObject({ method: 'GET', url: '/v1/subscribers/user_8821/preferences' })
    expect(preferences.categories.marketing).toEqual({ email: false })
  })

  it('updates them with PATCH, null going out to remove an override', async () => {
    server.enqueue({ body: { global: { sms: false }, categories: { marketing: { email: false } } } })

    await hermesi.subscribers.updatePreferences('user_8821', {
      global: { sms: false },
      categories: { marketing: { email: false, push: null } },
    })

    const request = server.requests[0]!
    expect(request).toMatchObject({ method: 'PATCH', url: '/v1/subscribers/user_8821/preferences' })
    expect(JSON.parse(request.body)).toEqual({
      global: { sms: false },
      categories: { marketing: { email: false, push: null } },
    })
  })

  it('sends only the group that was given', async () => {
    server.enqueue({ body: { global: {}, categories: {} } })
    await hermesi.subscribers.updatePreferences('user_8821', { global: { sms: true } })
    expect(JSON.parse(server.requests[0]!.body)).toEqual({ global: { sms: true } })
  })

  it('refuses an empty change and an unknown group before sending', async () => {
    await expect(hermesi.subscribers.updatePreferences('user_8821', {})).rejects.toThrow(/nothing to change/)
    await expect(hermesi.subscribers.updatePreferences('user_8821', { categorie: {} } as never)).rejects.toThrow(/unknown preference group/)
    expect(server.requests).toHaveLength(0)
  })

  it('a critical category is a ValidationError', async () => {
    server.enqueue({ status: 422, body: errorBody('category_not_overridable') })
    await expect(hermesi.subscribers.updatePreferences('user_8821', { categories: { security: { sms: false } } })).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('messages.send', () => {
  const ANSWER = { message_id: 'msg_1', status: 'queued', messages: [{ id: 'msg_1', channel: 'sms', status: 'queued', reason: null }] }

  it('posts the message with one idempotency key and reads the result', async () => {
    server.enqueue({ status: 202, body: ANSWER })

    const result = await hermesi.messages.send(
      { channel: 'sms', recipient: 'user_8821', template: 'otp-code', data: { code: '480219' }, category: 'security', priority: 'critical' },
      { idempotencyKey: 'otp-user_8821-482' },
    )

    const request = server.requests[0]!
    expect(request).toMatchObject({ method: 'POST', url: '/v1/messages' })
    expect(request.headers['idempotency-key']).toBe('otp-user_8821-482')
    expect(JSON.parse(request.body)).toEqual({
      channel: 'sms',
      recipient: 'user_8821',
      template: 'otp-code',
      category: 'security',
      data: { code: '480219' },
      priority: 'critical',
    })
    expect(result).toMatchObject({ messageId: 'msg_1', status: 'queued', replayed: false, idempotencyKey: 'otp-user_8821-482' })
    expect(result.messages).toEqual([{ id: 'msg_1', channel: 'sms', status: 'queued', reason: null }])
  })

  it('describes an inline recipient on the wire in snake case', async () => {
    server.enqueue({ status: 202, body: ANSWER })
    await hermesi.messages.send({ channel: 'sms', recipient: { externalId: 'u1', phoneE164: '+237690000000' }, template: 'otp-code' })
    expect(JSON.parse(server.requests[0]!.body).recipient).toEqual({ external_id: 'u1', phone_e164: '+237690000000' })
  })

  it('generates a key when none is given, and keeps it across a retry', async () => {
    const retrying = new Hermesi({ apiKey: KEY, baseUrl: server.url, retry: { maxRetries: 2 }, sleep: async () => {} })
    server.enqueue({ status: 503, body: errorBody('unavailable') }, { status: 202, body: ANSWER })

    const result = await retrying.messages.send({ channel: 'sms', recipient: 'u1', template: 'otp-code' })

    const keys = server.requests.map((r) => r.headers['idempotency-key'])
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBeTruthy()
    expect(keys[0]).toBe(keys[1])
    expect(result.idempotencyKey).toBe(keys[0])
  })

  it('flags a replayed answer', async () => {
    server.enqueue({ status: 202, body: ANSWER, headers: { 'Idempotency-Replayed': 'true' } })
    const result = await hermesi.messages.send({ channel: 'sms', recipient: 'u1', template: 'otp-code' })
    expect(result.replayed).toBe(true)
  })

  it('a refused message is a result, not an exception', async () => {
    server.enqueue({ status: 202, body: { message_id: 'msg_1', status: 'skipped', messages: [{ id: 'msg_1', channel: 'sms', status: 'skipped', reason: 'preference_off' }] } })
    const result = await hermesi.messages.send({ channel: 'sms', recipient: 'u1', template: 'promo' })
    expect(result.status).toBe('skipped')
    expect(result.messages[0]!.reason).toBe('preference_off')
  })

  it('reusing a key with another body is a ConflictError', async () => {
    server.enqueue({ status: 409, body: errorBody('idempotency_key_reused') })
    await expect(hermesi.messages.send({ channel: 'sms', recipient: 'u1', template: 'otp-code' }, { idempotencyKey: 'k' })).rejects.toBeInstanceOf(ConflictError)
  })

  it('an unknown template is a NotFoundError and nothing is retried', async () => {
    server.enqueue({ status: 404, body: errorBody('template_not_found') })
    await expect(hermesi.messages.send({ channel: 'sms', recipient: 'u1', template: 'nope' })).rejects.toBeInstanceOf(NotFoundError)
    expect(server.requests).toHaveLength(1)
  })

  it('requires a channel and a template', async () => {
    await expect(hermesi.messages.send({ channel: '', recipient: 'u1', template: 't' })).rejects.toThrow(/channel is required/)
    await expect(hermesi.messages.send({ channel: 'sms', recipient: 'u1', template: '' })).rejects.toThrow(/template is required/)
    expect(server.requests).toHaveLength(0)
  })

  it('an answer without a message_id is an unexpected_response error', async () => {
    server.enqueue({ status: 202, body: { nope: 1 } })
    await expect(hermesi.messages.send({ channel: 'sms', recipient: 'u1', template: 't' })).rejects.toMatchObject({ code: 'unexpected_response' })
  })
})

describe('messages.get', () => {
  it('reads one message', async () => {
    server.enqueue({ body: RUN.notifications[0]!.messages[0] })
    const message = await hermesi.messages.get('msg_1')
    expect(server.requests[0]).toMatchObject({ method: 'GET', url: '/v1/messages/msg_1' })
    expect(message).toMatchObject({ id: 'msg_1', status: 'delivered', isFinal: true })
  })

  it('an unknown message is a NotFoundError', async () => {
    server.enqueue({ status: 404, body: errorBody('message_not_found') })
    await expect(hermesi.messages.get('msg_x')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('simulate', () => {
  const test = new Hermesi({ simulate: true })

  it('records the writes with the body that would have gone out, and answers plausibly', async () => {
    const simulating = new Hermesi({ simulate: true })

    const profile = await simulating.subscribers.put('user_8821', { email: 'a@example.cm', phoneE164: null })
    const message = await simulating.messages.send({ channel: 'sms', recipient: 'user_8821', template: 'otp-code' }, { idempotencyKey: 'k1' })
    const identity = await simulating.subscribers.registerChannel('user_8821', 'push', 'tok', { platform: 'ios' })
    const preferences = await simulating.subscribers.updatePreferences('user_8821', { categories: { marketing: { email: false, push: null } } })
    await simulating.subscribers.delete('user_8821')

    expect(profile).toMatchObject({ externalId: 'user_8821', email: 'a@example.cm' })
    expect(message).toMatchObject({ status: 'simulated', idempotencyKey: 'k1' })
    expect(identity).toMatchObject({ channel: 'push', identifier: 'tok', metadata: { platform: 'ios' } })
    expect(preferences.categories).toEqual({ marketing: { email: false } })
    expect(simulating.simulatedCalls.map((c) => [c.method, c.path])).toEqual([
      ['PUT', '/v1/subscribers/user_8821'],
      ['POST', '/v1/messages'],
      ['POST', '/v1/subscribers/user_8821/channels'],
      ['PATCH', '/v1/subscribers/user_8821/preferences'],
      ['DELETE', '/v1/subscribers/user_8821'],
    ])
    expect(simulating.simulatedCalls[0]!.body).toEqual({ email: 'a@example.cm', phone_e164: null })
    expect(simulating.simulatedCalls[1]!.idempotencyKey).toBe('k1')
    expect(simulating.simulatedCalls[4]!.body).toBeNull()
    expect(simulating.simulated).toHaveLength(0)
  })

  it('a read throws, and records nothing', async () => {
    await expect(test.events.get('evt_1')).rejects.toBeInstanceOf(HermesiSimulationError)
    await expect(test.subscribers.get('u')).rejects.toBeInstanceOf(HermesiSimulationError)
    await expect(test.subscribers.preferences('u')).rejects.toBeInstanceOf(HermesiSimulationError)
    await expect(test.messages.get('m')).rejects.toBeInstanceOf(HermesiSimulationError)
    expect(test.simulatedCalls).toHaveLength(0)
  })

  it('validates exactly as a real call does', async () => {
    await expect(test.subscribers.put('user_8821', { nope: 1 } as never)).rejects.toThrow(/unknown subscriber field/)
    await expect(test.subscribers.put('..')).rejects.toThrow(TypeError)
    await expect(test.messages.send({ channel: 'sms', recipient: 'u', template: '' })).rejects.toThrow(/template is required/)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(test.messages.send({ channel: 'sms', recipient: 'u', template: 't', data: cyclic })).rejects.toThrow()
  })
})
