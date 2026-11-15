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
  'list_categories', 'create_category', 'update_category', 'delete_category',
  'list_subscribers', 'get_subscriber', 'create_subscriber', 'list_suppressions', 'create_suppression',
  'get_overview', 'list_messages', 'get_message', 'list_events', 'retry_dead_letter', 'resend_message',
] // prettier-ignore

let relay: TestRelay
let client: Client

async function connect(options: { secretKey?: string; baseUrlSuffix?: string; allowRealSend?: boolean } = {}): Promise<Client> {
  const api = createApi({ baseUrl: relay.url + (options.baseUrlSuffix ?? ''), apiKey: 'hm_mk_dev_test', secretKey: options.secretKey, allowRealSend: options.allowRealSend })
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
    await client.callTool({ name: 'dry_run_workflow', arguments: { key: 'welcome', subscriber_id: 'sub_1' } })

    const call = relay.requests.find((r) => r.url.endsWith('/test'))
    expect(call?.body).toMatchObject({ environment_id: 'env_1', subscriber_id: 'sub_1', payload: {} })
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

  const PROD_CONTEXT = { ...KEY_CONTEXT, environment: 'production', simulate_sends: false }

  it('refuses an environment that sends for real, whatever the agent passes, unless the operator allowed it', async () => {
    relay.respond((r) => (r.url === '/v1/manage/key-context' ? { body: PROD_CONTEXT } : undefined))
    const cautious = await connect({ secretKey: 'hm_sk_prod_test' })

    const plain = await cautious.callTool({ name: 'send_test_event', arguments: { name: 'order.shipped', recipient: 'u1' } })
    const smuggled = await cautious.callTool({ name: 'send_test_event', arguments: { name: 'order.shipped', recipient: 'u1', allow_real_send: true } })

    expect(plain.isError).toBe(true)
    expect(smuggled.isError).toBe(true)
    expect(text(smuggled)).toContain('real_send_not_allowed')
    expect(relay.requests.some((r) => r.url === '/v1/events')).toBe(false)
    await cautious.close()

    const operatorAllowed = await connect({ secretKey: 'hm_sk_prod_test', allowRealSend: true })
    const withoutArg = await operatorAllowed.callTool({ name: 'send_test_event', arguments: { name: 'order.shipped', recipient: 'u1' } })
    expect(withoutArg.isError).toBe(true)
    const allowed = await operatorAllowed.callTool({ name: 'send_test_event', arguments: { name: 'order.shipped', recipient: 'u1', allow_real_send: true } })
    expect(allowed.isError).toBeFalsy()
    expect(relay.requests.filter((r) => r.url === '/v1/events')).toHaveLength(1)
    await operatorAllowed.close()
  })

  it('reads the environment again for each test event, so a setting changed in the dashboard is seen', async () => {
    let simulate = true
    relay.respond((r) => (r.url === '/v1/manage/key-context' ? { body: { ...KEY_CONTEXT, simulate_sends: simulate } } : undefined))
    const withSecret = await connect({ secretKey: 'hm_sk_dev_test' })

    const first = await withSecret.callTool({ name: 'send_test_event', arguments: { name: 'a.b', recipient: 'u1' } })
    simulate = false // someone turns Simulate sends off in the dashboard
    const second = await withSecret.callTool({ name: 'send_test_event', arguments: { name: 'a.b', recipient: 'u1' } })

    expect(first.isError).toBeFalsy()
    expect(second.isError).toBe(true)
    expect(text(second)).toContain('real_send_not_allowed')
    await withSecret.close()
  })

  it('refuses a secret key that belongs to another environment than the management key', async () => {
    const mismatched = await connect({ secretKey: 'hm_sk_prod_test' }) // the management key is for development
    const unknownFormat = await connect({ secretKey: 'not-a-hermesi-key' })

    for (const c of [mismatched, unknownFormat]) {
      const result = await c.callTool({ name: 'send_test_event', arguments: { name: 'a.b', recipient: 'u1' } })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('secret_key_environment_mismatch')
      await c.close()
    }
    expect(relay.requests.some((r) => r.url === '/v1/events')).toBe(false)
  })

  it('is marked destructive, so an editor asks before running it', async () => {
    const withSecret = await connect({ secretKey: 'hm_sk_dev_test' })
    const tool = (await withSecret.listTools()).tools.find((t) => t.name === 'send_test_event')
    expect(tool?.annotations?.destructiveHint).toBe(true)
    await withSecret.close()
  })
})

describe("what the agent asks for reaches the API under the API's own names", () => {
  it('create_category sends is_critical', async () => {
    await client.callTool({ name: 'create_category', arguments: { key: 'security', name: 'Security', is_critical: true } })
    expect(relay.requests.find((r) => r.method === 'POST' && r.url.endsWith('/categories'))?.body).toMatchObject({ key: 'security', is_critical: true })
  })

  it('list_subscribers sends search, and list_messages its filters', async () => {
    await client.callTool({ name: 'list_subscribers', arguments: { search: 'bob' } })
    await client.callTool({ name: 'list_messages', arguments: { status: 'failed', channel: 'sms', workflow: 'welcome' } })
    expect(relay.requests.some((r) => r.url === '/v1/manage/environments/env_1/subscribers?search=bob')).toBe(true)
    expect(relay.requests.some((r) => r.url === '/v1/manage/environments/env_1/messages?status=failed&channel=sms&workflow=welcome')).toBe(true)
  })

  it('duplicate_workflow sends the name and trigger event the API requires', async () => {
    await client.callTool({ name: 'duplicate_workflow', arguments: { key: 'welcome', new_key: 'welcome-2', name: 'Welcome 2', trigger_event: 'user.welcomed2' } })
    expect(relay.requests.find((r) => r.url.endsWith('/duplicate'))?.body).toEqual({ key: 'welcome-2', name: 'Welcome 2', trigger_event: 'user.welcomed2' })
  })

  it('create_suppression refuses a channel the API does not have, before calling it', async () => {
    const result = await client.callTool({ name: 'create_suppression', arguments: { channel: 'mail', identifier: 'a@b.c' } })
    expect(result.isError).toBe(true)
    expect(relay.requests.some((r) => r.url.endsWith('/suppressions'))).toBe(false)
  })
})

describe('an agent can recover from a rejected request', () => {
  it('shows which field the API refused and why', async () => {
    relay.respond((r) =>
      r.method === 'PUT' && r.url.endsWith('/draft')
        ? {
            status: 422,
            body: {
              error: {
                type: 'validation_error',
                code: 'validation_error',
                message: 'Field required',
                detail: [
                  { field: 'variants.0.source', issue: 'Field required' },
                  { field: 'variants.0.locale', issue: 'String should have at least 2 characters' },
                ],
                request_id: 'req_7',
              },
            },
          }
        : undefined,
    )

    const result = await client.callTool({ name: 'save_template_draft', arguments: { key: 'a', draft: { variants: [{ channel: 'email' }] } } })

    expect(result.isError).toBe(true)
    const message = text(result)
    expect(message).toContain('variants.0.source: Field required')
    expect(message).toContain('variants.0.locale: String should have at least 2 characters')
    expect(message).toContain('req_7')
  })

  it('caps a very long list of refused fields', async () => {
    const detail = Array.from({ length: 40 }, (_v, i) => ({ field: `f${i}`, issue: 'bad' }))
    relay.respond((r) => (r.url.includes('/templates') ? { status: 422, body: { error: { type: 'validation_error', code: 'validation_error', message: 'bad', detail } } } : undefined))

    const message = text(await client.callTool({ name: 'create_template', arguments: { key: 'a', name: 'A' } }))

    expect(message).toContain('f0: bad')
    expect(message).not.toContain('f39: bad')
    expect(message).toContain('and 20 more')
  })

  it('tells the agent the exact shape of a template variant and of a workflow definition', async () => {
    const tools = (await client.listTools()).tools
    const description = (name: string) => tools.find((t) => t.name === name)?.description ?? ''

    const template = description('save_template_draft')
    expect(template).toContain('"channel":"email"')
    expect(template).toContain('"source"')
    expect(template).toContain('mjml')
    expect(template).toContain('title')
    expect(template).toContain('text')

    const workflow = description('save_workflow_draft')
    expect(workflow).toContain('schema_version')
    expect(workflow).toContain('"steps"')
    expect(workflow).toContain('"template"')
  })
})

describe('dry_run_workflow accepts the id the agent has', () => {
  const search = (r: { method: string; url: string }) => r.method === 'GET' && r.url.startsWith('/v1/manage/environments/env_1/subscribers?')

  it("takes a subscriber's external id, as create_subscriber does, and resolves it to the internal id the API wants", async () => {
    relay.respond((r) =>
      search(r)
        ? { body: { data: [{ id: 'sub_8', external_id: 'user_10' }, { id: 'sub_9', external_id: 'user_1' }], has_more: false, next_cursor: null } }
        : undefined,
    )

    await client.callTool({ name: 'dry_run_workflow', arguments: { key: 'welcome', subscriber_id: 'user_1' } })

    expect(relay.requests.find(search)?.url).toContain('search=user_1')
    expect(relay.requests.find((r) => r.url.endsWith('/test'))?.body).toMatchObject({ subscriber_id: 'sub_9', environment_id: 'env_1' })
  })

  it('leaves an internal id alone, with no lookup', async () => {
    await client.callTool({ name: 'dry_run_workflow', arguments: { key: 'welcome', subscriber_id: 'sub_9' } })

    expect(relay.requests.some(search)).toBe(false)
    expect(relay.requests.find((r) => r.url.endsWith('/test'))?.body).toMatchObject({ subscriber_id: 'sub_9' })
  })

  it('says so when no subscriber has that external id (a search hit on a longer id is not a match), and does not run the workflow', async () => {
    relay.respond((r) => (search(r) ? { body: { data: [{ id: 'sub_8', external_id: 'user_10' }], has_more: false, next_cursor: null } } : undefined))

    const result = await client.callTool({ name: 'dry_run_workflow', arguments: { key: 'welcome', subscriber_id: 'user_1' } })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('subscriber_not_found')
    expect(text(result)).toContain('create_subscriber')
    expect(relay.requests.some((r) => r.url.endsWith('/test'))).toBe(false)
  })

  it('passes on an error from the lookup itself', async () => {
    relay.respond((r) => (search(r) ? { status: 403, body: { error: { type: 'permission_error', code: 'insufficient_scope', message: 'needs audience:read' } } } : undefined))

    const result = await client.callTool({ name: 'dry_run_workflow', arguments: { key: 'welcome', subscriber_id: 'user_1' } })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('insufficient_scope')
    expect(relay.requests.some((r) => r.url.endsWith('/test'))).toBe(false)
  })
})
