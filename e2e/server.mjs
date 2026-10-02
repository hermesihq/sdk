/**
 * A static file server and a mock of Hermesi's client API, in one process.
 *
 * Why a real HTTP server and not a stubbed `fetch`: this harness exists to see what a real engine
 * does, and a stub hides exactly that. A real request has real headers, a real `EventSource` has to
 * authenticate through the URL because it cannot send headers, and an engine that disagrees about
 * either is the thing worth learning here.
 *
 * **State is per test.** Playwright runs tests in parallel, and one shared inbox would make them
 * trample each other. Every URL carries a tenant, `/t/<id>/v1/client/...`, and each tenant has its
 * own items, request log and open streams. A test makes its own tenant up and `POST`s a scenario
 * to `/__reset`.
 *
 * The API itself is only as faithful as it is small. It implements the routes the SDK calls, with
 * the response shapes in the published OpenAPI document, and nothing the SDK does not call. What it
 * can be made to get wrong on purpose is a scenario flag, because the incident this harness was
 * extended for was a server that answered one call with another call's shape.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.env.E2E_PORT ?? 4173)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
}

/** @type {Map<string, Tenant>} */
const tenants = new Map()

/**
 * @typedef {{
 *   items: any[],
 *   requests: string[],
 *   streams: Set<import('node:http').ServerResponse>,
 *   faultyRead: boolean,
 *   latencyMs: number,
 *   failNext: number,
 *   holdList: boolean,
 *   held: Array<() => void>,
 *   nextId: number,
 * }} Tenant
 */

function tenantFor(id) {
  let tenant = tenants.get(id)
  if (!tenant) {
    tenant = { items: [], requests: [], streams: new Set(), faultyRead: false, latencyMs: 0, failNext: 0, holdList: false, held: [], nextId: 1 }
    tenants.set(id, tenant)
  }
  return tenant
}

function wireItem(partial, nextId) {
  return {
    id: partial.id ?? `inb_${nextId}`,
    title: partial.title ?? `Notification ${nextId}`,
    body: partial.body ?? `Body of notification ${nextId}`,
    action_url: partial.action_url ?? null,
    category: partial.category ?? null,
    seen_at: partial.seen_at ?? null,
    read_at: partial.read_at ?? null,
    created_at: partial.created_at ?? new Date(Date.now() - 3_600_000).toISOString(),
  }
}

function counts(tenant) {
  return {
    unread: tenant.items.filter((i) => !i.read_at).length,
    unseen: tenant.items.filter((i) => !i.seen_at).length,
  }
}

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status)
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function envelope(code, message) {
  return { error: { type: 'authentication_error', code, message, request_id: 'req_e2e', detail: [], doc_url: '' } }
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function pushEvent(tenant, name, data) {
  for (const stream of tenant.streams) stream.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** The client API. Returns true if it handled the request. */
async function clientApi(req, res, url, tenant) {
  const route = url.pathname.replace(/^\/t\/[^/]+\/v1\/client/, '')
  tenant.requests.push(`${req.method} ${route}`)

  // The stream authenticates through the URL; every other call through headers. Checking both is
  // the point: an engine that dropped either would otherwise pass unnoticed.
  if (route === '/inbox/stream') {
    if (url.searchParams.get('public_key') !== 'hm_pk_e2e' || !url.searchParams.get('subscriber_token')) {
      send(res, 401, envelope('subscriber_token_invalid', 'The stream needs its credentials in the URL.'))
      return true
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': open\n\n')
    tenant.streams.add(res)
    req.on('close', () => tenant.streams.delete(res))
    return true
  }

  if (req.headers.authorization !== 'Bearer hm_pk_e2e' || !req.headers['x-hermesi-subscriber-token']) {
    send(res, 401, envelope('subscriber_token_invalid', 'Missing or wrong credentials.'))
    return true
  }
  if (tenant.latencyMs) await new Promise((resolveLatency) => setTimeout(resolveLatency, tenant.latencyMs))
  if (tenant.failNext > 0 && req.method !== 'GET') {
    tenant.failNext -= 1
    send(res, 500, envelope('internal_error', 'Injected failure.'))
    return true
  }

  if (req.method === 'GET' && route === '/inbox/counts') return send(res, 200, counts(tenant)), true
  if (req.method === 'GET' && route === '/inbox') {
    // Held until the test says so: a list that arrives exactly when the test wants it to, not
    // after a time the machine may or may not have been quick enough to beat.
    if (tenant.holdList) await new Promise((release) => tenant.held.push(release))
    send(res, 200, { data: tenant.items, has_more: false, next_cursor: null })
    return true
  }
  if (req.method === 'POST' && route === '/inbox/seen') {
    const { ids = [] } = await readJson(req)
    let updated = 0
    for (const item of tenant.items) if (ids.includes(item.id) && !item.seen_at) (item.seen_at = new Date().toISOString()), updated++
    pushEvent(tenant, 'counts.changed', counts(tenant))
    send(res, 200, { updated })
    return true
  }
  if (req.method === 'POST' && route === '/inbox/read-all') {
    let updated = 0
    for (const item of tenant.items) if (!item.read_at) (item.read_at = new Date().toISOString()), updated++
    pushEvent(tenant, 'counts.changed', counts(tenant))
    send(res, 200, { updated })
    return true
  }
  const one = route.match(/^\/inbox\/([^/]+)(?:\/(read|archive))?$/)
  if (one) {
    const [, id, action] = one
    const index = tenant.items.findIndex((i) => i.id === decodeURIComponent(id))
    if (index === -1) return send(res, 404, envelope('not_found', 'No such notification.')), true
    const item = tenant.items[index]
    if (req.method === 'POST' && action === 'read') {
      item.read_at ??= new Date().toISOString()
      pushEvent(tenant, 'counts.changed', counts(tenant))
      // The incident: the read call answered with the read-all call's shape.
      send(res, 200, tenant.faultyRead ? { updated: 0 } : item)
      return true
    }
    if (req.method === 'POST' && action === 'archive') {
      tenant.items.splice(index, 1)
      pushEvent(tenant, 'counts.changed', counts(tenant))
      send(res, 200, item)
      return true
    }
    if (req.method === 'DELETE' && !action) {
      tenant.items.splice(index, 1)
      send(res, 204)
      return true
    }
  }
  send(res, 404, envelope('not_found', `No route for ${req.method} ${route}.`))
  return true
}

/** Test control: reset a tenant, read its request log, push a real-time event. */
async function control(req, res, url) {
  const tenant = tenantFor(url.searchParams.get('tenant') ?? 'default')
  if (url.pathname === '/__reset' && req.method === 'POST') {
    const scenario = await readJson(req)
    tenant.requests.length = 0
    tenant.nextId = 1
    tenant.items = (scenario.items ?? []).map((partial) => wireItem(partial, tenant.nextId++))
    tenant.faultyRead = Boolean(scenario.faultyRead)
    tenant.latencyMs = Number(scenario.latencyMs ?? 0)
    tenant.failNext = Number(scenario.failNext ?? 0)
    tenant.holdList = Boolean(scenario.holdList)
    for (const release of tenant.held.splice(0)) release()
    return send(res, 200, { items: tenant.items.length }), true
  }
  if (url.pathname === '/__release') {
    tenant.holdList = false
    for (const release of tenant.held.splice(0)) release()
    return send(res, 200, { ok: true }), true
  }
  if (url.pathname === '/__requests') return send(res, 200, tenant.requests), true
  if (url.pathname === '/__streams') return send(res, 200, { open: tenant.streams.size }), true
  if (url.pathname === '/__emit' && req.method === 'POST') {
    const { name, data } = await readJson(req)
    if (name === 'item.created') {
      const item = wireItem(data ?? {}, tenant.nextId++)
      tenant.items.unshift(item)
      pushEvent(tenant, 'item.created', { id: item.id, title: item.title, created_at: item.created_at })
      pushEvent(tenant, 'counts.changed', counts(tenant))
    } else {
      pushEvent(tenant, name, data)
    }
    return send(res, 200, { ok: true }), true
  }
  if (url.pathname === '/__health') return send(res, 200, { ok: true }), true
  return false
}

async function serveFile(res, url) {
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
  const file = resolve(join(ROOT, relative))
  // Stay inside this directory: the path came off the network.
  if (!file.startsWith(ROOT)) return send(res, 403, { error: 'forbidden' })
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    send(res, 404, { error: `not found: ${url.pathname}` })
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname.startsWith('/__')) {
      if (await control(req, res, url)) return
    }
    const tenantMatch = url.pathname.match(/^\/t\/([^/]+)\/v1\/client(\/.*)?$/)
    if (tenantMatch) {
      await clientApi(req, res, url, tenantFor(tenantMatch[1]))
      return
    }
    await serveFile(res, url)
  } catch (error) {
    send(res, 500, { error: String(error) })
  }
})

server.listen(PORT, () => console.log(`e2e server on http://localhost:${PORT}`))
