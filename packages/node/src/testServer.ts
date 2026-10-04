/**
 * A real HTTP server on localhost for the tests to talk to. A stub of `fetch` would prove the client
 * against the stub; this proves it against the wire: headers as they arrive, a body as it is read,
 * a socket that dies, a server that never answers.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Recorded {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

export interface Scripted {
  status?: number
  headers?: Record<string, string>
  /** Sent as JSON unless it is a string. */
  body?: unknown
  /** Drop the connection without answering. */
  destroy?: boolean
  /** Never answer, so the client's timeout is what ends the attempt. */
  hang?: boolean
  /** Send the headers and part of a body, then drop the connection. */
  truncate?: boolean
}

export interface TestServer {
  url: string
  requests: Recorded[]
  /** Answers for the next requests, in order. Once they run out the default answer is used. */
  enqueue(...answers: Scripted[]): void
  close(): Promise<void>
}

export const ACCEPTED = {
  event_id: 'evt_01K2QH8F3T7Y0RJ4N5V6WX8ZQD',
  status: 'accepted',
  notifications: [{ id: 'not_1', subscriber_id: 'sub_1', workflow: 'order-shipped' }],
  warnings: [],
}

export function errorBody(code: string, extra: Record<string, unknown> = {}): unknown {
  return {
    error: {
      type: 'invalid_request_error',
      code,
      message: `message for ${code}`,
      request_id: 'req_abc123',
      doc_url: `https://docs.example/errors/${code}`,
      ...extra,
    },
  }
}

export async function startServer(defaultAnswer: Scripted = { status: 202, body: ACCEPTED }): Promise<TestServer> {
  const requests: Recorded[] = []
  const queue: Scripted[] = []
  const hanging = new Set<ServerResponse>()
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const answer = queue.shift() ?? defaultAnswer
      if (answer.destroy) return void request.socket.destroy()
      if (answer.hang) return void hanging.add(response)
      const payload = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {})
      response.writeHead(answer.status ?? 200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload) + (answer.truncate ? 100 : 0)),
        ...answer.headers,
      })
      if (answer.truncate) {
        response.write(payload)
        return void setTimeout(() => request.socket.destroy(), 20)
      }
      response.end(payload)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    enqueue: (...answers) => void queue.push(...answers),
    close: () =>
      new Promise<void>((resolve) => {
        for (const response of hanging) response.destroy()
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** A URL nothing listens on: bind a port, note it, release it. */
export async function deadUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}
