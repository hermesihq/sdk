import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createApi } from './api.js'
import { createHermesiServer } from './server.js'
import { KEY_CONTEXT, startTestRelay, type TestRelay } from './testRelay.js'

const EXPECTED_TOOLS = [
  'whoami',
  'list_templates', 'get_template', 'create_template', 'save_template_draft', 'preview_template', 'publish_template', 'delete_template',
  'list_workflows', 'get_workflow', 'create_workflow', 'save_workflow_draft', 'publish_workflow', 'duplicate_workflow', 'delete_workflow',
  'export_workflow', 'import_workflow', 'dry_run_workflow',
  'list_categories', 'create_category',
  'list_subscribers', 'get_subscriber', 'create_subscriber', 'list_suppressions', 'create_suppression',
  'get_overview', 'list_messages', 'get_message', 'list_events', 'retry_dead_letter', 'resend_message',
] // prettier-ignore

let relay: TestRelay
let client: Client

async function connect(options: { secretKey?: string; baseUrlSuffix?: string } = {}): Promise<Client> {
  const api = createApi({ baseUrl: relay.url + (options.baseUrlSuffix ?? ''), apiKey: 'hm_mk_dev_test', secretKey: options.secretKey })
  const server = createHermesiServer(api)
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const c = new Client({ name: 'test', version: '0' })
  await c.connect(clientSide)
  return c
}

const text = (result: Awaited<ReturnType<Client['callTool']>>): string => {
  const content = result.content as { type: string; text: string }[]
  return content.map((part) => part.text).join('\n')
}

beforeEach(async () => {
  relay = await startTestRelay()
  client = await connect()
})
afterEach(async () => {
  await client.close()
  await relay.close()
})

describe('the tool list', () => {
  it('is exactly the documented tools, and send_test_event only with a secret key', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names.sort()).toEqual([...EXPECTED_TOOLS].sort())

    const withSecret = await connect({ secretKey: 'hm_sk_dev_test' })
    const namesWithSecret = (await withSecret.listTools()).tools.map((t) => t.name)
    expect(namesWithSecret).toContain('send_test_event')
    await withSecret.close()
  })

  it('marks reads as read-only and deletes as destructive', async () => {
    const tools = (await client.listTools()).tools
    const by = (name: string) => tools.find((t) => t.name === name)?.annotations
    expect(by('list_templates')?.readOnlyHint).toBe(true)
    expect(by('delete_workflow')?.destructiveHint).toBe(true)
    expect(by('delete_template')?.destructiveHint).toBe(true)
    expect(by('publish_workflow')?.destructiveHint).toBe(false)
  })

  it('offers the setup-project prompt', async () => {
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name)
    expect(prompts).toContain('setup-project')
  })
})

describe('whoami and the key context', () => {
  it('asks the API who the key is once, however many tools run', async () => {
    await client.callTool({ name: 'whoami', arguments: {} })
    await client.callTool({ name: 'list_templates', arguments: {} })
    await client.callTool({ name: 'list_categories', arguments: {} })

    const contextCalls = relay.requests.filter((r) => r.url === '/v1/manage/key-context')
    expect(contextCalls).toHaveLength(1)
    expect(contextCalls[0]?.headers.authorization).toBe('Bearer hm_mk_dev_test')
  })

  it('returns the key context, including the scopes', async () => {
    const result = await client.callTool({ name: 'whoami', arguments: {} })
    expect(JSON.parse(text(result))).toMatchObject({ project_id: KEY_CONTEXT.project_id, scopes: KEY_CONTEXT.scopes })
  })

  it('does not cache a failed lookup', async () => {
    let calls = 0
    relay.respond((r) => {
      if (r.url !== '/v1/manage/key-context') return undefined
      calls += 1
      return calls === 1 ? { status: 503, body: 'down', contentType: 'text/plain' } : { body: KEY_CONTEXT }
    })

    const first = await client.callTool({ name: 'whoami', arguments: {} })
    const second = await client.callTool({ name: 'whoami', arguments: {} })

    expect(first.isError).toBe(true)
    expect(second.isError).toBeFalsy()
  })
})

describe('calling the API', () => {
  it('lists templates under the key\'s own project, with the bearer key and the paging query', async () => {
    await client.callTool({ name: 'list_templates', arguments: { limit: 5 } })

    const call = relay.requests.find((r) => r.url.startsWith('/v1/manage/projects/'))
    expect(call?.url).toBe('/v1/manage/projects/prj_1/templates?limit=5')
    expect(call?.headers.authorization).toBe('Bearer hm_mk_dev_test')
  })

  it('puts the draft body as the request body and encodes the key in the path', async () => {
    await client.callTool({ name: 'save_template_draft', arguments: { key: 'order shipped', draft: { variants: [] } } })

    const call = relay.requests.find((r) => r.method === 'PUT')
    expect(call?.url).toBe('/v1/manage/projects/prj_1/templates/order%20shipped/draft')
    expect(call?.body).toEqual({ variants: [] })
  })

  it('injects the environment id into a dry run', async () => {
    await client.callTool({ name: 'dry_run_workflow', arguments: { key: 'welcome', subscriber_id: 'u1' } })

    const call = relay.requests.find((r) => r.url.endsWith('/test'))
    expect(call?.body).toMatchObject({ environment_id: 'env_1', subscriber_id: 'u1', payload: {} })
  })

  it('sends an idempotency key when resending a message', async () => {
    await client.callTool({ name: 'resend_message', arguments: { message_id: 'msg_1' } })

    const call = relay.requests.find((r) => r.url.endsWith('/resend'))
    expect(call?.url).toBe('/v1/manage/environments/env_1/messages/msg_1/resend')
    expect(String(call?.headers['idempotency-key'])).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('keeps a path prefix on the base URL and ignores a trailing slash', async () => {
    const prefixed = await connect({ baseUrlSuffix: '/hermesi/' })
    await prefixed.callTool({ name: 'whoami', arguments: {} })
    await prefixed.close()

    expect(relay.requests.some((r) => r.url === '/hermesi/v1/manage/key-context')).toBe(true)
  })
})

describe('failures come back as results, never as crashes', () => {
  it('reports the API error code, message and request id, with what to do next', async () => {
    relay.respond((r) =>
      r.url.includes('/templates')
        ? { status: 403, body: { error: { type: 'permission_error', code: 'insufficient_scope', message: 'This management key does not have the `content:write` scope.', request_id: 'req_9' } } }
        : undefined,
    )

    const result = await client.callTool({ name: 'create_template', arguments: { key: 'a', name: 'A' } })

    expect(result.isError).toBe(true)
    const message = text(result)
    expect(message).toContain('insufficient_scope')
    expect(message).toContain('content:write')
    expect(message).toContain('req_9')
    expect(message).toContain('Issue a management key')
  })

  it('reports a proxy\'s HTML error page as an upstream error', async () => {
    relay.respond((r) => (r.url.includes('/templates') ? { status: 502, body: '<html>Bad gateway</html>', contentType: 'text/html' } : undefined))

    const result = await client.callTool({ name: 'list_templates', arguments: {} })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('upstream_error')
    expect(text(result)).toContain('502')
  })

  it('reports an unreachable server', async () => {
    const dead = createApi({ baseUrl: 'http://127.0.0.1:1', apiKey: 'hm_mk_dev_x', timeoutMs: 2000 })
    const server = createHermesiServer(dead)
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const c = new Client({ name: 'test', version: '0' })
    await c.connect(clientSide)

    const result = await c.callTool({ name: 'whoami', arguments: {} })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Could not reach Hermesi')
    await c.close()
  })

  it('treats a 204 with no body as done', async () => {
    relay.respond((r) => (r.method === 'DELETE' ? { status: 204, body: '' } : undefined))

    const result = await client.callTool({ name: 'delete_template', arguments: { key: 'old' } })

    expect(result.isError).toBeFalsy()
    expect(text(result)).toBe('Done.')
  })
})

describe('send_test_event', () => {
  it('posts to the ingest API with the secret key, not the management key', async () => {
    const withSecret = await connect({ secretKey: 'hm_sk_dev_test' })

    await withSecret.callTool({ name: 'send_test_event', arguments: { name: 'order.shipped', recipient: 'u1', payload: { id: 1 } } })

    const call = relay.requests.find((r) => r.url === '/v1/events')
    expect(call?.headers.authorization).toBe('Bearer hm_sk_dev_test')
    expect(call?.body).toEqual({ name: 'order.shipped', recipient: 'u1', payload: { id: 1 } })
    expect(call?.headers['idempotency-key']).toBeTruthy()
    await withSecret.close()
  })

  it('refuses an environment that sends for real unless the call says so', async () => {
    relay.respond((r) => (r.url === '/v1/manage/key-context' ? { body: { ...KEY_CONTEXT, environment: 'production', simulate_sends: false } } : undefined))
    const withSecret = await connect({ secretKey: 'hm_sk_prod_test' })

    const refused = await withSecret.callTool({ name: 'send_test_event', arguments: { name: 'order.shipped', recipient: 'u1' } })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('real_send_not_allowed')
    expect(relay.requests.some((r) => r.url === '/v1/events')).toBe(false)

    const allowed = await withSecret.callTool({ name: 'send_test_event', arguments: { name: 'order.shipped', recipient: 'u1', allow_real_send: true } })
    expect(allowed.isError).toBeFalsy()
    expect(relay.requests.some((r) => r.url === '/v1/events')).toBe(true)
    await withSecret.close()
  })
})
