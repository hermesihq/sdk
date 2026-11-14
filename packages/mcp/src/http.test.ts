import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleMcpRequest } from './http.js'
import { startTestRelay, type TestRelay } from './testRelay.js'

let relay: TestRelay
beforeEach(async () => {
  relay = await startTestRelay()
})
afterEach(async () => {
  await relay.close()
})

const rpc = (body: unknown, headers: Record<string, string> = {}, path = '/mcp'): Request =>
  new Request(`https://mcp.example.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
}

describe('the hosted endpoint', () => {
  it('answers initialize for a caller with a bearer key', async () => {
    const response = await handleMcpRequest(rpc(initialize, { Authorization: 'Bearer hm_mk_dev_x' }), { HERMESI_BASE_URL: relay.url })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { result: { serverInfo: { name: string } } }
    expect(body.result.serverInfo.name).toBe('hermesi')
  })

  it('refuses a request with no bearer key, and says how to authenticate', async () => {
    const response = await handleMcpRequest(rpc(initialize), { HERMESI_BASE_URL: relay.url })

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
  })

  it('forwards the caller\'s key to the API, and only for that request', async () => {
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } }
    await handleMcpRequest(rpc(call, { Authorization: 'Bearer hm_mk_dev_caller' }), { HERMESI_BASE_URL: relay.url })
    await handleMcpRequest(rpc(call, { Authorization: 'Bearer hm_mk_dev_other' }), { HERMESI_BASE_URL: relay.url })

    const keys = relay.requests.map((r) => r.headers.authorization)
    expect(keys).toEqual(['Bearer hm_mk_dev_caller', 'Bearer hm_mk_dev_other'])
  })

  it('only serves POST on /mcp', async () => {
    const get = await handleMcpRequest(new Request('https://mcp.example.test/mcp'), {})
    const elsewhere = await handleMcpRequest(rpc(initialize, { Authorization: 'Bearer k' }, '/other'), {})

    expect(get.status).toBe(405)
    expect(elsewhere.status).toBe(404)
  })
})
