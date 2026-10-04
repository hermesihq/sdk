/**
 * When to try again, and how long to wait.
 *
 * Retried: connection failures and timeouts, `429` and `5xx`. Everything else is a refusal that the
 * same request would get again. Every call this SDK makes is safe to repeat: an event carries an
 * idempotency key (generated if the caller gave none, and kept across the retries), so a retry after
 * a lost response cannot send a notification twice, and a preference link is only a link.
 */

export interface RetryOptions {
  /** Retries after the first attempt. `0` turns retrying off. Default 3. */
  maxRetries?: number
  /** The first backoff ceiling, in milliseconds; it doubles with every retry. Default 500. */
  baseDelayMs?: number
  /** No backoff ceiling is ever larger than this, in milliseconds. Default 8000. */
  maxDelayMs?: number
  /**
   * The longest `Retry-After` that is waited out, in milliseconds. A server asking for more than
   * this gets the error rejected instead: a request handler that sleeps for ten minutes is worse
   * than one that fails. Default 30000.
   */
  maxRetryAfterMs?: number
}

export type RetryPolicy = Required<RetryOptions>

export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  maxRetryAfterMs: 30000,
}

export function resolveRetry(options: RetryOptions | undefined): RetryPolicy {
  const policy = { ...DEFAULT_RETRY, ...options }
  if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0) {
    throw new RangeError('retry.maxRetries must be a whole number, 0 or more')
  }
  for (const key of ['baseDelayMs', 'maxDelayMs', 'maxRetryAfterMs'] as const) {
    if (!Number.isFinite(policy[key]) || policy[key] < 0) throw new RangeError(`retry.${key} must be 0 or more`)
  }
  return policy
}

/**
 * Milliseconds to wait before the next attempt, or `null` to stop and reject.
 *
 * `retriesSoFar` is how many retries have already been made. A `Retry-After` from the server is
 * honoured exactly (it is the server's own estimate, and adding jitter would only make it wait
 * longer than it asked); otherwise the wait is exponential with equal jitter, so that a fleet of
 * callers that failed together does not retry together and no retry is near-instant.
 */
export function retryDelay(
  policy: RetryPolicy,
  retriesSoFar: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number | null {
  if (retriesSoFar >= policy.maxRetries) return null
  if (retryAfterMs !== null) return retryAfterMs <= policy.maxRetryAfterMs ? retryAfterMs : null
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retriesSoFar)
  return ceiling / 2 + (random() * ceiling) / 2
}

/**
 * `Retry-After` in seconds. Hermesi sends seconds and never an HTTP date; anything else is ignored.
 * Read with a pattern rather than `Number()`, which turns an empty header into `0` and would have
 * the client retry at once.
 */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return /^\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : null
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}
