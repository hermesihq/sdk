/**
 * A real HTTP server on localhost standing in for Relay, so the tests prove the tools against the wire: the headers the API
 * receives, the paths it is asked for, a body that is not JSON. Records every request.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Recorded {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: unknown
}

export interface Reply {
  status?: number
  /** Sent as JSON unless it is a string. */
  body?: unknown
  contentType?: string
}

export type Handler = (request: Recorded) => Reply | undefined

export interface TestRelay {
  url: string
  requests: Recorded[]
  /** Replace how the relay answers; the default knows `key-context` only. */
  respond(handler: Handler): void
  close(): Promise<void>
}

export const KEY_CONTEXT = {
  organization_id: 'org_1',
  project_id: 'prj_1',
  project_slug: 'shop',
  project_name: 'Shop',
  environment_id: 'env_1',
  environment: 'development',
  simulate_sends: true,
  key_id: 'key_1',
  key_name: 'agent',
  scopes: ['content:write', 'audience:write', 'activity:read'],
}

export async function startTestRelay(): Promise<TestRelay> {
  const requests: Recorded[] = []
  let handler: Handler = () => undefined

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = raw
      try {
        body = raw === '' ? undefined : JSON.parse(raw)
      } catch {
        // keep the raw text
      }
      const recorded: Recorded = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body }
      requests.push(recorded)
      const reply: Reply = handler(recorded) ?? (recorded.url === '/v1/manage/key-context' ? { body: KEY_CONTEXT } : { body: { data: [] } })
      const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? null)
      res.writeHead(reply.status ?? 200, { 'Content-Type': reply.contentType ?? 'application/json' })
      res.end(payload)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respond: (next) => {
      handler = next
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
