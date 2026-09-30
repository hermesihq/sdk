import { describe, expect, it } from 'vitest'
import { decodeSubscriberTokenExp } from './subscriberToken'

/**
 * `decodeSubscriberTokenExp` reads the `exp` claim back out of a token the *host app*
 * minted and handed to `HermsClient`. Two properties matter to a consumer, and they
 * pull in opposite directions:
 *
 *  1. It must never throw. Its only caller is `scheduleExpiryHook`, which runs inside
 *     `getFreshToken()` — i.e. on the path of *every* request this SDK makes. A throw
 *     here would turn "the host passed an odd token" into "every call fails", and the
 *     failure would be attributed to the request, not to the token.
 *  2. It must never be mistaken for verification. It decodes a segment; it does not,
 *     and cannot, check the HMAC: the SDK has no secret key (the signing key
 *     is the host backend's, and Hermesi's server is the only verifier). The test below
 *     hands it a token with a garbage signature on purpose and expects the claim back,
 *     because a "safer" version that rejected bad signatures would be lying about a
 *     guarantee it can't provide.
 *
 * Token format is `base64url(payload) + "." + base64url(hmac)`: two segments, payload
 * first, **no JOSE header segment**. That is why the payload is `token.split('.')[0]` and not `[1]`.
 */

/** base64url, the way the API produces it: `+/` mapped
 * to `-_`, padding stripped. ASCII-only payloads, which is all `btoa` accepts. */
function base64Url(json: string): string {
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function token(payload: unknown, signature = 'c2lnbmF0dXJl'): string {
  return `${base64Url(JSON.stringify(payload))}.${signature}`
}

describe('decodeSubscriberTokenExp', () => {
  it('reads exp out of the two-segment token the backend mints', () => {
    expect(decodeSubscriberTokenExp(token({ sub: 'usr_42', env: 'env_live', exp: 1_700_000_000 }))).toBe(1_700_000_000)
  })

  it('decodes the base64url alphabet, not plain base64', () => {
    // `sub` chosen so the payload's standard base64 contains both `+` and `/` and needs
    // two padding characters — i.e. the segment the backend actually sends carries `-`,
    // `_` and no `=`. A decoder that forgot either the alphabet swap or the re-padding
    // fails here and nowhere else.
    const value = token({ sub: '???>?', env: 'env_live', exp: 1_699_999_999 })
    const [payloadSegment = ''] = value.split('.')
    expect(payloadSegment).toMatch(/-/)
    expect(payloadSegment).toMatch(/_/)
    expect(payloadSegment).not.toMatch(/=/)

    expect(decodeSubscriberTokenExp(value)).toBe(1_699_999_999)
  })

  it('does not verify the signature', () => {
    // Deliberate: the claim comes back even though the signature is nonsense. This
    // function exists to schedule `onTokenExpiring`, not to authenticate — the server
    // is the only party that can, and pretending otherwise here would invite a host to
    // trust a client-side check.
    expect(decodeSubscriberTokenExp(token({ sub: 'usr_42', env: 'env_live', exp: 123 }, 'not-a-real-signature'))).toBe(123)
  })

  it('returns null rather than throwing for anything malformed', () => {
    // Every one of these is something a host app really does hand an SDK: a literal
    // placeholder during wiring-up, a token that never got minted, a truncated copy
    // out of a log, an opaque session cookie that is not this scheme at all. Each must
    // cost nothing more than a missing expiry hook — see the header note on why a throw
    // here breaks every request rather than one.
    const malformed = [
      '',
      'TODO',
      'undefined',
      '.',
      '...',
      'not base64!!.sig',
      // Valid base64url, decodes to bytes that are not JSON.
      `${base64Url('plain text, not json')}.sig`,
      // Valid JSON, but not an object — `JSON.parse('12')` succeeds and has no claims.
      `${base64Url('12')}.sig`,
      `${base64Url('null')}.sig`,
    ]
    for (const value of malformed) {
      expect(() => decodeSubscriberTokenExp(value)).not.toThrow()
      expect(decodeSubscriberTokenExp(value)).toBeNull()
    }
  })

  it('returns null for a payload whose exp is absent or not a number', () => {
    expect(decodeSubscriberTokenExp(token({ sub: 'usr_42', env: 'env_live' }))).toBeNull()
    // A host minting `exp` as an ISO string or a stringified epoch is the realistic
    // near-miss. `setTimeout` on `'1700000000' * 1000` would be silently wrong, so this
    // is treated as "no usable exp" rather than coerced.
    expect(decodeSubscriberTokenExp(token({ sub: 'usr_42', exp: '1700000000' }))).toBeNull()
    expect(decodeSubscriberTokenExp(token({ sub: 'usr_42', exp: null }))).toBeNull()
  })

  it('accepts a signature-less value, since reading a claim never needed one', () => {
    // `HermsClient` only ever gets whole tokens, but the payload segment alone is
    // well-defined input and the function splits before it decodes. Pinned so that a
    // future "require two segments" tightening is a deliberate choice, not a surprise.
    expect(decodeSubscriberTokenExp(base64Url(JSON.stringify({ exp: 42 })))).toBe(42)
  })
})
