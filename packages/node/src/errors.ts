/**
 * What can go wrong, as classes a caller can branch on.
 *
 * Branch on the class or on `code`, never on `message`: the message is prose that the API rewrites
 * without notice.
 */

/** One thing wrong with a request, as the API describes it. */
export interface ErrorDetail {
  field: string | null
  issue: string | null
}

/** Base class for everything this package rejects with on purpose. */
export class HermesiError extends Error {
  override name = 'HermesiError'
}

/** Hermesi could not be reached: DNS, a refused or dropped connection, or a timeout, after the retries were used up. */
export class HermesiConnectionError extends HermesiError {
  override name = 'HermesiConnectionError'
}

export interface HermesiAPIErrorInit {
  status: number
  type: string
  code: string
  message: string
  requestId?: string
  detail?: ErrorDetail[]
  docUrl?: string
  retryAfter?: number | null
}

/**
 * Hermesi answered, and the answer was a refusal.
 *
 * `code` is stable and meant to be branched on. `requestId` is what to quote to whoever runs Hermesi.
 */
export class HermesiAPIError extends HermesiError {
  override name = 'HermesiAPIError'
  readonly status: number
  readonly type: string
  readonly code: string
  readonly requestId: string
  readonly detail: ErrorDetail[]
  readonly docUrl: string
  /** Seconds the server asked to wait, from `Retry-After`; only on a 429. */
  readonly retryAfter: number | null

  constructor(init: HermesiAPIErrorInit) {
    super(`${init.code}: ${init.message} (HTTP ${init.status}, request ${init.requestId || 'unknown'})`)
    this.status = init.status
    this.type = init.type
    this.code = init.code
    this.requestId = init.requestId ?? ''
    this.detail = init.detail ?? []
    this.docUrl = init.docUrl ?? ''
    this.retryAfter = init.retryAfter ?? null
  }

  /** True for a failure that sending the same request again later can fix. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500
  }
}

/** 401: the API key is missing, malformed, invalid or revoked. */
export class AuthenticationError extends HermesiAPIError {
  override name = 'AuthenticationError'
}

/** 403: the key is valid but may not do this. */
export class ForbiddenError extends HermesiAPIError {
  override name = 'ForbiddenError'
}

/** 404: for an event, a `recipient` that is not a subscriber in this environment. */
export class NotFoundError extends HermesiAPIError {
  override name = 'NotFoundError'
}

/** 400 or 422: the request was refused as malformed; `detail` names the fields. */
export class ValidationError extends HermesiAPIError {
  override name = 'ValidationError'
}

/** 429: the environment is publishing faster than Hermesi accepts. Nothing was recorded. */
export class RateLimitError extends HermesiAPIError {
  override name = 'RateLimitError'
}

/** 5xx: Hermesi failed. For an event, retrying with the same idempotency key is safe. */
export class ServerError extends HermesiAPIError {
  override name = 'ServerError'
}

type ErrorClass = new (init: HermesiAPIErrorInit) => HermesiAPIError

const BY_STATUS: Record<number, ErrorClass> = {
  400: ValidationError,
  401: AuthenticationError,
  403: ForbiddenError,
  404: NotFoundError,
  422: ValidationError,
  429: RateLimitError,
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/**
 * The error for a non-2xx response. Anything that is not the API's error envelope is reported as
 * such, with `type` `sdk_error` (the API never sends it), so a caller can tell a refusal from a
 * response the SDK could not read.
 */
export function errorFromResponse(status: number, body: unknown, retryAfter: number | null): HermesiAPIError {
  const envelope = record(record(body).error)
  const text = (key: string): string => {
    const value = envelope[key]
    return typeof value === 'string' ? value : ''
  }
  const detail: ErrorDetail[] = (Array.isArray(envelope.detail) ? envelope.detail : [])
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      field: typeof item.field === 'string' && item.field ? item.field : null,
      issue: typeof item.issue === 'string' && item.issue ? item.issue : null,
    }))
  const Class = BY_STATUS[status] ?? (status >= 500 ? ServerError : HermesiAPIError)
  return new Class({
    status,
    type: text('type') || 'sdk_error',
    code: text('code') || 'unexpected_response',
    message: text('message') || `Hermesi answered HTTP ${status}.`,
    requestId: text('request_id'),
    detail,
    docUrl: text('doc_url'),
    retryAfter,
  })
}
