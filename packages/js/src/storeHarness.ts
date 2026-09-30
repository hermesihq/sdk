import { vi } from 'vitest'
import { HermsClient } from './HermsClient'
import { HermsSession } from './HermsSession'
import type { ReadableStore } from './store'
import type { HermsEventListener } from './types'

/**
 * Shared scaffolding for the store tests: a real `HermsClient` against a stubbed global
 * `fetch`, so the snake_case-to-camelCase mapping and the cursor round-trip are
 * exercised on the way rather than a mock client that would agree with whatever the
 * store expects.
 *
 * Not a `.test.` file, so vitest does not collect it; imported by the store suites only.
 */

export interface WireItem {
  id: string
  title: string
  body: string
  action_url: string | null
  category: { key: string; name: string } | null
  seen_at: string | null
  read_at: string | null
  created_at: string
}

export function wireItem(id: string, overrides: Partial<WireItem> = {}): WireItem {
  return {
    id,
    title: `Notification ${id}`,
    body: `Body of ${id}`,
    action_url: null,
    category: null,
    seen_at: null,
    read_at: null,
    created_at: '2026-09-01T09:00:00Z',
    ...overrides,
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function page(items: WireItem[], nextCursor: string | null = null): Response {
  return json({ data: items, has_more: nextCursor !== null, next_cursor: nextCursor })
}

export interface Recorded {
  /** `"<METHOD> <pathname>"`, which is how the API documents itself. */
  route: string
  query: URLSearchParams
  body: unknown
}

export interface Harness {
  client: HermsClient
  session: HermsSession
  /** Delivers `event` as if the shared stream had received it. */
  emit: (event: Parameters<HermsEventListener>[0]) => void
  calls: Recorded[]
}

/**
 * `respond` may return a promise, which is how a test holds a response back to
 * reproduce an ordering (a page that arrives after the world moved on).
 *
 * The session is already connected, so `emit` reaches whatever the store registered.
 */
export function harness(respond: (call: Recorded) => Response | Promise<Response>): Harness {
  const calls: Recorded[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const call: Recorded = {
      route: `${init?.method ?? 'GET'} ${url.pathname}`,
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    }
    calls.push(call)
    return await respond(call)
  })

  const client = new HermsClient({
    apiBaseUrl: 'https://api.example.test/v1/client',
    publicKey: 'hm_pk_test_abc',
    getSubscriberToken: () => 'st_test',
  })
  let listener: HermsEventListener = () => {}
  vi.spyOn(client, 'subscribe').mockImplementation((incoming) => {
    listener = incoming
    return () => {}
  })

  const session = new HermsSession(client)
  session.connect()

  return { client, session, emit: (event) => listener(event), calls }
}

/** A response that settles when told to. */
export function deferred(): { promise: Promise<Response>; resolve: (response: Response) => void } {
  let resolve: (response: Response) => void = () => {}
  const promise = new Promise<Response>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/**
 * Resolves with the first snapshot that satisfies `predicate`.
 *
 * Waits for a *state* rather than a duration, so a slow machine cannot turn a passing
 * test into a failing one and a fast one cannot hide a missing update. The timeout only
 * bounds a failure, and reports the last snapshot so it says what was wrong.
 */
export function until<T>(
  store: ReadableStore<T>,
  predicate: (snapshot: T) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const check = (): boolean => {
      const snapshot = store.getSnapshot()
      if (!predicate(snapshot)) return false
      cleanup()
      resolve(snapshot)
      return true
    }
    const unsubscribe = store.subscribe(() => {
      check()
    })
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for state; last snapshot: ${JSON.stringify(store.getSnapshot())}`))
    }, timeoutMs)
    function cleanup(): void {
      unsubscribe()
      clearTimeout(timer)
    }
    check()
  })
}

/** Lets every already-settled promise callback run, so an absence can be asserted. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/**
 * Every snapshot a store publishes, in order, starting with the one it holds now.
 *
 * `until` and `getSnapshot()` show the state *after* a burst of updates has finished,
 * which is exactly when a torn transition has already healed. A subscriber that renders
 * synchronously sees each notification, so an invariant ("never failed while still
 * loading") has to be checked against all of them.
 */
export function recordSnapshots<T>(store: ReadableStore<T>): T[] {
  const seen = [store.getSnapshot()]
  store.subscribe(() => seen.push(store.getSnapshot()))
  return seen
}
