import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Hermesi, MAX_TTL_SECONDS, mintSubscriberToken } from './index.ts'

const KEY = 'hm_sk_test_0123456789'
const NOW = 1_760_000_000_000

function parts(token: string): { payload: string; signature: string; claims: { sub: string; env: string; exp: number } } {
  const [payload = '', signature = ''] = token.split('.')
  return { payload, signature, claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) }
}

describe('a subscriber token', () => {
  it('names the subscriber, the environment and an expiry', async () => {
    const { claims } = parts(await mintSubscriberToken(KEY, 'user_8821', 'env_01ABC', { now: NOW, ttlSeconds: 600 }))

    expect(claims).toEqual({ sub: 'user_8821', env: 'env_01ABC', exp: 1_760_000_600 })
  })

  it('is signed with an HMAC keyed by the SHA-256 hex digest of the secret key, not by the key', async () => {
    const token = await mintSubscriberToken(KEY, 'user_8821', 'env_01ABC', { now: NOW })
    const { payload, signature } = parts(token)

    const keyHash = createHash('sha256').update(KEY).digest('hex')
    expect(signature).toBe(createHmac('sha256', keyHash).update(payload).digest('base64url'))
    expect(signature).not.toBe(createHmac('sha256', KEY).update(payload).digest('base64url'))
  })

  it('matches the Python SDK byte for byte, so a token minted by either is one the server accepts', async () => {
    // Produced by hermesi-python 0.1.0 with the same inputs.
    expect(await mintSubscriberToken(KEY, 'user_8821', 'env_01ABC', { now: NOW, ttlSeconds: 3600 })).toBe(
      'eyJzdWIiOiJ1c2VyXzg4MjEiLCJlbnYiOiJlbnZfMDFBQkMiLCJleHAiOjE3NjAwMDM2MDB9.Jh3aTNvGnI9Oig2wXFqwhhqlDg2OG18OU16iEAW6lA0',
    )
    // The Python SDK takes whole seconds and drops the fraction; so does this.
    expect(await mintSubscriberToken(KEY, 'user_8821', 'env_01ABC', { now: NOW + 900, ttlSeconds: 60 })).toBe(
      'eyJzdWIiOiJ1c2VyXzg4MjEiLCJlbnYiOiJlbnZfMDFBQkMiLCJleHAiOjE3NjAwMDAwNjB9.1tSXSD-WfJ7KbF0c-JoxbJJiGvUIUwR7Dqwi_Q-LKu8',
    )
  })

  it('is URL-safe and unpadded, whatever the id', async () => {
    // Ids that push the base64 through every padding length and through `+` and `/` characters.
    const ids = ['a', 'ab', 'abc', 'user_1', '???>>>', '~~~~~', 'é', 'Ünï¢ødé', '日本語', 'x'.repeat(50)]
    for (const id of ids) {
      const { payload, signature, claims } = parts(await mintSubscriberToken(KEY, id, 'env_1', { now: NOW }))
      expect(payload, id).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(signature, id).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(claims.sub, id).toBe(id)
    }
  })

  it('gives the same token for the same inputs, and a different one for a different secret', async () => {
    const a = await mintSubscriberToken(KEY, 'u', 'e', { now: NOW })

    expect(await mintSubscriberToken(KEY, 'u', 'e', { now: NOW })).toBe(a)
    expect(await mintSubscriberToken('hm_sk_other_key', 'u', 'e', { now: NOW })).not.toBe(a)
  })

  it('defaults to an hour and never allows more', async () => {
    expect(parts(await mintSubscriberToken(KEY, 'u', 'e', { now: NOW })).claims.exp).toBe(1_760_000_000 + MAX_TTL_SECONDS)
    await expect(mintSubscriberToken(KEY, 'u', 'e', { ttlSeconds: MAX_TTL_SECONDS + 1 })).rejects.toThrow(RangeError)
  })

  it('refuses what cannot make a token', async () => {
    await expect(mintSubscriberToken('hm_pk_public', 'u', 'e')).rejects.toThrow(/secret key/)
    await expect(mintSubscriberToken(KEY, '', 'e')).rejects.toThrow(/externalId/)
    await expect(mintSubscriberToken(KEY, 'u', '')).rejects.toThrow(/environmentId/)
    for (const ttlSeconds of [0, -1, 1.5, Number.NaN]) {
      await expect(mintSubscriberToken(KEY, 'u', 'e', { ttlSeconds })).rejects.toThrow(RangeError)
    }
  })

  it("is minted by the client with the client's own key, and makes no request", async () => {
    let requests = 0
    const hermesi = new Hermesi({
      apiKey: KEY,
      baseUrl: 'https://h.example',
      fetch: async () => {
        requests += 1
        throw new Error('no request expected')
      },
    })

    const token = await hermesi.tokens.mint('user_8821', { environmentId: 'env_01ABC' })

    const { signature, payload } = parts(token)
    expect(signature).toBe(createHmac('sha256', createHash('sha256').update(KEY).digest('hex')).update(payload).digest('base64url'))
    expect(requests).toBe(0)
  })
})
