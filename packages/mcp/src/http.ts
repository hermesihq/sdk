import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createApi } from './api.js'
import { createHermesiServer } from './server.js'

export interface HostedEnv {
  /** Where Hermesi runs. Default `https://go.hermesi.app`. */
  HERMESI_BASE_URL?: string
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

/**
 * The hosted entry point: one stateless Streamable HTTP endpoint. The caller's bearer token is the Hermesi key (a management
 * key today); it is forwarded to the API for this request and kept nowhere. There is no secret-key path here: a secret key is
 * the one that can send, and does not belong in a request to a shared service.
 */
export async function handleMcpRequest(request: Request, env: HostedEnv = {}): Promise<Response> {
  const { pathname } = new URL(request.url)
  if (pathname !== '/mcp' && pathname !== '/') return json(404, { error: 'not_found' })
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' })

  const authorization = request.headers.get('authorization') ?? ''
  const token = /^bearer\s+(\S+)$/i.exec(authorization)?.[1]
  if (!token) {
    return json(401, { error: 'unauthorized', message: 'Send a Hermesi management key as Authorization: Bearer hm_mk_...' }, { 'WWW-Authenticate': 'Bearer' })
  }

  const api = createApi({ baseUrl: env.HERMESI_BASE_URL || 'https://go.hermesi.app', apiKey: token })
  const server = createHermesiServer(api)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  return transport.handleRequest(request)
}
