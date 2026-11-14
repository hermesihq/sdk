/**
 * The one place the server talks to Relay. Thin on purpose: it adds the bearer key, turns the API's error envelope into a
 * value, and turns everything that is not that envelope (a proxy's HTML 502, a refused connection, a timeout) into one too, so a
 * tool never throws at the agent.
 */

export interface ApiError {
  code: string
  type: string
  message: string
  requestId?: string
  status?: number
}

export type ApiResult = { ok: true; status: number; data: unknown } | { ok: false; error: ApiError }

export interface ApiOptions {
  /** Where Hermesi runs, for example `https://go.hermesi.app`. A trailing slash is ignored; a path prefix is kept. */
  baseUrl: string
  /** A management key (`hm_mk_...`) or an access token: sent as `Authorization: Bearer`. */
  apiKey: string
  /** A secret key (`hm_sk_...`), only for `send_test_event`. */
  secretKey?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  headers?: Record<string, string>
  /** Authenticate with the secret key instead of the management key (the ingest API). */
  useSecretKey?: boolean
}

export interface Api {
  readonly hasSecretKey: boolean
  request(method: string, path: string, options?: RequestOptions): Promise<ApiResult>
}

export function createApi(options: ApiOptions): Api {
  const base = options.baseUrl.replace(/\/+$/, '')
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000

  return {
    hasSecretKey: Boolean(options.secretKey),
    async request(method, path, request = {}) {
      const url = new URL(base + path)
      for (const [name, value] of Object.entries(request.query ?? {})) {
        if (value !== undefined) url.searchParams.set(name, String(value))
      }
      const key = request.useSecretKey ? options.secretKey : options.apiKey
      const headers: Record<string, string> = { Authorization: `Bearer ${key ?? ''}`, Accept: 'application/json', ...request.headers }
      if (request.body !== undefined) headers['Content-Type'] = 'application/json'

      let response: Response
      try {
        response = await doFetch(url, {
          method,
          headers,
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        return { ok: false, error: { code: 'upstream_error', type: 'internal_error', message: `Could not reach Hermesi at ${base}: ${message}` } }
      }

      const text = await response.text()
      let json: unknown
      try {
        json = text === '' ? null : JSON.parse(text)
      } catch {
        return {
          ok: false,
          error: {
            code: 'upstream_error',
            type: 'internal_error',
            status: response.status,
            message: `Hermesi answered ${response.status} with something that is not JSON (a proxy or the wrong base URL?): ${text.slice(0, 120)}`,
          },
        }
      }
      if (response.ok) return { ok: true, status: response.status, data: json }

      const envelope = (json as { error?: Record<string, unknown> } | null)?.error
      return {
        ok: false,
        error: {
          code: typeof envelope?.code === 'string' ? envelope.code : 'upstream_error',
          type: typeof envelope?.type === 'string' ? envelope.type : 'internal_error',
          message: typeof envelope?.message === 'string' ? envelope.message : `Hermesi answered ${response.status}.`,
          requestId: typeof envelope?.request_id === 'string' ? envelope.request_id : undefined,
          status: response.status,
        },
      }
    },
  }
}
