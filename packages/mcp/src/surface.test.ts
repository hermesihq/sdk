/**
 * Every tool, called with plausible arguments, must produce a request the API actually has: the method and path exist, every query
 * parameter is one the endpoint reads, every body field is one its schema names, and every required field is present. The
 * snapshot `api-surface.json` is generated from Relay's `openapi.json` (`/v1/manage/*` and `/v1/events`): refresh it when the API
 * changes (see the README, "Keeping the tools in step with the API").
 *
 * Why this exists: a tool that sends `critical` where the API reads `is_critical` gets a 201 and a category that is not critical,
 * and nothing in a test that only checks the tool's own output can see it.
 */

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createApi } from './api.js'
import { createHermesiServer } from './server.js'
import { TOOLS } from './tools.js'
import { startTestRelay, type TestRelay } from './testRelay.js'

interface Operation {
  query: string[]
  headers: string[]
  body: string[] | null
  required: string[]
}
const surface = JSON.parse(readFileSync(new URL('./api-surface.json', import.meta.url), 'utf8')) as Record<string, Operation>

/** Sample arguments for every tool: all optional fields filled, so unknown query parameters and body fields show up. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  whoami: {},
  list_templates: { limit: 5, cursor: 'c' },
  get_template: { key: 'k' },
  create_template: { key: 'k', name: 'N' },
  save_template_draft: { key: 'k', draft: { variants: [] } },
  preview_template: { key: 'k', request: { channel: 'email', locale: 'en', payload: { a: 1 } } },
  publish_template: { key: 'k' },
  delete_template: { key: 'k' },
  list_workflows: { limit: 5, cursor: 'c' },
  get_workflow: { key: 'k' },
  create_workflow: { key: 'k', name: 'N', trigger_event: 'a.b', category_id: 'cat_1', description: 'd' },
  save_workflow_draft: { key: 'k', draft: { definition: { steps: [] }, notes: 'n' } },
  publish_workflow: { key: 'k' },
  duplicate_workflow: { key: 'k', new_key: 'k2', name: 'N2', trigger_event: 'a.c', category_id: 'cat_1', description: 'd' },
  delete_workflow: { key: 'k' },
  export_workflow: { key: 'k', version: 2 },
  import_workflow: { document: { format: 'hermesi.workflow', format_version: 1, workflow: {}, version: {} } },
  dry_run_workflow: { key: 'k', subscriber_id: 'u1', payload: { a: 1 }, version: 1 },
  list_categories: {},
  create_category: { key: 'k', name: 'N', is_critical: true, description: 'd', display_order: 1 },
  update_category: { category_id: 'cat_1', name: 'N', description: 'd', display_order: 2 },
  delete_category: { category_id: 'cat_1' },
  list_subscribers: { limit: 5, cursor: 'c', search: 'bob' },
  get_subscriber: { external_id: 'u1' },
  create_subscriber: { external_id: 'u1', email: 'a@b.c', phone_e164: '+237600000000', first_name: 'A', last_name: 'B', locale: 'fr', timezone: 'Africa/Douala', data: { x: 1 } },
  list_suppressions: { limit: 5, cursor: 'c' },
  create_suppression: { channel: 'email', identifier: 'a@b.c', details: { why: 'bounce' } },
  get_overview: { days: 7 },
  list_messages: { limit: 5, cursor: 'c', search: 's', status: 'failed', channel: 'sms', workflow: 'w', category: 'c', from: '2026-01-01', to: '2026-02-01' },
  get_message: { message_id: 'msg_1' },
  list_events: { limit: 5, cursor: 'c', search: 's', status: 'failed', name: 'a.b', from: '2026-01-01', to: '2026-02-01' },
  retry_dead_letter: {},
  resend_message: { message_id: 'msg_1' },
  send_test_event: { name: 'a.b', recipient: 'u1', payload: { a: 1 } },
}

let relay: TestRelay
let client: Client

beforeEach(async () => {
  relay = await startTestRelay()
  const api = createApi({ baseUrl: relay.url, apiKey: 'hm_mk_dev_test', secretKey: 'hm_sk_dev_test' })
  const server = createHermesiServer(api)
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  client = new Client({ name: 'test', version: '0' })
  await client.connect(clientSide)
})
afterEach(async () => {
  await client.close()
  await relay.close()
})

const templateRegex = (template: string): RegExp => new RegExp('^' + template.replace(/\{[^}]+\}/g, '[^/]+') + '$')
const operationFor = (method: string, path: string): [string, Operation] | undefined =>
  Object.entries(surface).find(([name, _op]) => name.startsWith(method + ' ') && templateRegex(name.slice(method.length + 1)).test(path))

describe('the tools match the API they call', () => {
  it('has sample arguments for exactly the tools that exist', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(TOOLS.map((t) => t.name).sort())
  })

  for (const tool of TOOLS) {
    it(`${tool.name}: the request exists in the API, with only fields it reads`, async () => {
      relay.requests.length = 0
      await client.callTool({ name: tool.name, arguments: SAMPLES[tool.name] ?? {} })

      const calls = relay.requests.filter((r) => r.url !== '/v1/manage/key-context')
      expect(calls, 'the tool made no API call').toHaveLength(tool.name === 'whoami' ? 0 : 1)
      for (const call of calls) {
        const url = new URL(call.url, 'http://x')
        const found = operationFor(call.method, url.pathname)
        expect(found, `${call.method} ${url.pathname} is not an operation of the API`).toBeDefined()
        const [, operation] = found!

        const unknownQuery = [...url.searchParams.keys()].filter((name) => !operation.query.includes(name))
        expect(unknownQuery, `query parameters the API does not read: ${unknownQuery.join(', ')}`).toEqual([])

        if (operation.body !== null && call.body !== undefined) {
          const sent = Object.keys(call.body as Record<string, unknown>)
          const knownFields = operation.body
          // An endpoint whose body is free-form (a draft, a preview request) names no fields: nothing to compare.
          if (knownFields.length > 0) {
            expect(sent.filter((f) => !knownFields.includes(f)), 'body fields the API does not read').toEqual([])
            expect(operation.required.filter((f) => !sent.includes(f)), 'required body fields missing').toEqual([])
          }
        }
        for (const header of operation.headers) {
          if (/idempotency/i.test(header) && call.method === 'POST' && /resend|events/.test(url.pathname)) {
            expect(call.headers[header.toLowerCase()], `${header} header`).toBeTruthy()
          }
        }
      }
    })
  }
})
