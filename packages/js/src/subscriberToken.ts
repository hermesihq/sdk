/**
 * Pure, dependency-free helpers for the *reading* half of the subscriber
 * token. `HermsClient` never mints or verifies a signature (it never has
 * the secret key hash to do either), it only needs to read the `exp` claim back
 * out of a token the host app already handed it, to drive `onTokenExpiring`.
 *
 * Token shape: `base64url(payload) + "." + base64url(hmac_sha256(...))`, where
 * `payload` is a plain JSON object `{sub, env, exp}`. No JOSE/JWT header segment.
 */

/** `atob`/`TextDecoder` are DOM/web-platform globals, also present in every
 * modern Node runtime (≥16). They are never touched at module-eval time, only from
 * inside this function when a caller actually decodes a token, so this stays
 * SSR-safe without any `typeof window` guard needed here specifically. */
function base64UrlDecodeToString(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/**
 * Returns the token's `exp` claim (unix seconds) or `null` for anything that
 * isn't a well-formed `<payload>.<signature>` token with a numeric `exp`. A
 * malformed value never throws, it just means `onTokenExpiring` won't be
 * scheduled for this particular token.
 */
export function decodeSubscriberTokenExp(token: string): number | null {
  const [payloadSegment] = token.split('.')
  if (!payloadSegment) return null
  try {
    const parsed: unknown = JSON.parse(base64UrlDecodeToString(payloadSegment))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'exp' in parsed &&
      typeof (parsed as { exp: unknown }).exp === 'number'
    ) {
      return (parsed as { exp: number }).exp
    }
    return null
  } catch {
    return null
  }
}
