import { describe, expect, it } from 'vitest'
import { HermsApiError } from './types'

/**
 * `HermsApiError` is the only error type this SDK throws for a non-2xx response, and it
 * is constructed from whatever came back on the wire, which is frequently *not* the documented
 * `{error: {type, code, message, request_id}}` envelope, because the thing that failed
 * the request was frequently not Hermesi:
 *
 *  - a reverse proxy or CDN in front of the API returning its own HTML error page,
 *  - a load balancer 502 with an empty body,
 *  - a host app's dev proxy answering `{"detail": "Not Found"}` for a path it doesn't
 *    know about (the SDK is routinely pointed at `/v1/client` on the host's own origin),
 *  - a 401 from an auth gateway that never reached Hermesi at all.
 *
 * In every one of those the consumer's `catch` block must still get a usable error with
 * the real status on it. An SDK that throws a `TypeError` while constructing the error
 * for a 502 has replaced a diagnosable failure with an undiagnosable one, and the stack
 * points at the SDK rather than at the proxy that actually broke.
 */

describe('HermsApiError, given the API error envelope', () => {
  it('lifts type, code, message and request_id off it', () => {
    const error = new HermsApiError(422, {
      error: {
        type: 'validation_error',
        code: 'invalid_cursor',
        message: 'The cursor is not valid.',
        request_id: 'req_01K2QH8F44MEQ5NPX3E1FQJZR9',
        detail: [],
        doc_url: 'https://docs.example.test/errors/invalid_cursor',
      },
    })

    expect(error.status).toBe(422)
    expect(error.type).toBe('validation_error')
    // The API is explicit that `code` is the contract and `message` is not: a consumer
    // branching on the failure branches on this.
    expect(error.code).toBe('invalid_cursor')
    expect(error.message).toBe('The cursor is not valid.')
    // Carried so a consumer can quote it in a support ticket; this is the only way the
    // id reaches them, since the SDK owns the response object.
    expect(error.requestId).toBe('req_01K2QH8F44MEQ5NPX3E1FQJZR9')
  })

  it('is a real Error subclass a consumer can catch and identify', () => {
    const error = new HermsApiError(401, { error: { code: 'unauthorized', message: 'Nope.' } })

    // `instanceof` both ways: hosts write `catch (e) { if (e instanceof HermsApiError) }`,
    // and generic error reporters test `instanceof Error` before serialising.
    expect(error).toBeInstanceOf(HermsApiError)
    expect(error).toBeInstanceOf(Error)
    // A reporter that logs `error.name` must not log 'Error'.
    expect(error.name).toBe('HermsApiError')
  })
})

describe('HermsApiError, given a body that is not the envelope', () => {
  /** Everything an SDK pointed at a URL can actually be handed. */
  const notEnvelopes: Array<[label: string, body: unknown]> = [
    ['an HTML error page from a proxy (unparsed, so null)', null],
    ['a 204 or empty body', undefined],
    ["a dev proxy's FastAPI-style detail", { detail: 'Not Found' }],
    ['a bare JSON string', 'Bad Gateway'],
    ['a JSON array', [{ msg: 'nope' }]],
    ['an envelope whose error key is null', { error: null }],
    ['an envelope whose error key is a string', { error: 'boom' }],
    ['an envelope with the right keys at the wrong types', { error: { code: 7, message: { en: 'no' }, type: [], request_id: false } }],
  ]

  it.each(notEnvelopes)('survives %s', (_label, body) => {
    // Constructing must not throw — this runs inside the SDK's own error path, where a
    // second failure has nothing left to report it.
    const error = new HermsApiError(502, body)

    expect(error.status).toBe(502)
    // The status is the one fact always available, so the fallback message carries it.
    expect(error.message).toContain('502')
    expect(error.code).toBe('unknown_error')
    expect(error.type).toBe('unknown_error')
    // Empty string, not undefined: consumers interpolate this into a support message.
    expect(error.requestId).toBe('')
  })

  it('still prefers a usable message when only some of the envelope is present', () => {
    // Partial envelopes happen at the edges of the API — an error raised before the
    // handler that fills in `request_id`, for instance. Take what is there.
    const error = new HermsApiError(429, { error: { message: 'Slow down.' } })

    expect(error.message).toBe('Slow down.')
    expect(error.code).toBe('unknown_error')
    expect(error.requestId).toBe('')
  })
})
