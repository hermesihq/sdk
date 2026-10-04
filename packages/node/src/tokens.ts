/**
 * Subscriber tokens: what lets a browser or a phone talk to Hermesi's client API as one subscriber.
 *
 * Minted on your server with your **secret** key, and handed to the app, which sends it with its
 * public key. The format is the one Hermesi's integration guide gives:
 * `base64url(payload) + "." + base64url(hmac_sha256(keyHash, base64url(payload)))` where the HMAC key
 * is the SHA-256 hex digest of the raw secret key, **not the key itself**. Hermesi stores only that
 * digest, never your key, which is what lets it verify a signature without ever having the key.
 * Signing with the raw key is the mistake that makes every token be rejected.
 *
 * Uses Web Crypto, which every Node release this package supports has as a global, so there is no
 * import from `node:crypto` and the function is asynchronous.
 */

/** The longest a token may live, in seconds. The API refuses a later expiry. */
export const MAX_TTL_SECONDS = 3600

export interface MintOptions {
  /** How long the token is valid, in seconds: 1 to 3600. Default 3600. */
  ttlSeconds?: number
  /** The current time in milliseconds since the epoch. For tests. */
  now?: number
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * A token for `externalId` in `environmentId`, valid for `ttlSeconds` (at most an hour).
 *
 * `environmentId` is the `env_...` id of the environment the key belongs to, shown in the
 * dashboard: the key itself does not carry it.
 */
export async function mintSubscriberToken(
  secretKey: string,
  externalId: string,
  environmentId: string,
  options: MintOptions = {},
): Promise<string> {
  const ttlSeconds = options.ttlSeconds ?? MAX_TTL_SECONDS
  if (!secretKey.startsWith('hm_sk_')) {
    throw new TypeError('secretKey must be a secret key (hm_sk_...), not a public key')
  }
  if (!externalId) throw new TypeError('externalId is required')
  if (!environmentId) throw new TypeError('environmentId is required')
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new RangeError(`ttlSeconds must be a whole number between 1 and ${MAX_TTL_SECONDS}`)
  }
  const issued = Math.floor((options.now ?? Date.now()) / 1000)
  const payload = base64Url(
    new TextEncoder().encode(JSON.stringify({ sub: externalId, env: environmentId, exp: issued + ttlSeconds })),
  )
  const { subtle } = globalThis.crypto
  const keyHash = hex(await subtle.digest('SHA-256', new TextEncoder().encode(secretKey)))
  const hmacKey = await subtle.importKey('raw', new TextEncoder().encode(keyHash), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const signature = await subtle.sign('HMAC', hmacKey, new TextEncoder().encode(payload))
  return `${payload}.${base64Url(new Uint8Array(signature))}`
}
