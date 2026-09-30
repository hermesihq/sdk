// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { HermsApiError } from './types'
import { PreferencesStore } from './PreferencesStore'
import { deferred, flush, harness, json, recordSnapshots, until } from './storeHarness'

/**
 * `PreferencesStore`, and the one decision in it worth pinning: **no optimistic update.**
 *
 * A toggle here is not a like button. Turning off a channel is a consent decision, and
 * showing it as done before the server agreed shows somebody they have opted out when
 * they may not have. The server answers `PATCH` with the whole new state, so the correct
 * view arrives with the write and there is nothing to reconcile.
 */

const WIRE_PREFS = {
  first_name: 'Amara',
  global_channels: [{ channel: 'email', enabled: true }],
  global_email_enabled: true,
  global_in_app_enabled: null,
  categories: [],
}

const WIRE_OFF = {
  ...WIRE_PREFS,
  global_channels: [{ channel: 'email', enabled: false }],
  global_email_enabled: false,
}

function isWrite(route: string): boolean {
  return route.startsWith('PATCH')
}

describe('reading', () => {
  it('reports loading, then the settings the server returned', async () => {
    const { session } = harness(() => json(WIRE_PREFS))
    const store = new PreferencesStore(session)

    expect(store.getSnapshot().isLoading).toBe(true)
    expect(store.getSnapshot().preferences).toBeNull()
    store.connect()
    await until(store, (s) => !s.isLoading)

    expect(store.getSnapshot().preferences?.globalEmailEnabled).toBe(true)
    expect(store.getSnapshot().error).toBeNull()
  })

  it('surfaces a failed read instead of rendering an empty page', async () => {
    const { session } = harness(() =>
      json({ error: { code: 'subscriber_token_invalid', message: 'Token rejected.' } }, 401),
    )
    const store = new PreferencesStore(session)

    store.connect()
    await until(store, (s) => s.error !== null)

    expect(store.getSnapshot().isLoading).toBe(false)
    expect(store.getSnapshot().error).toBeInstanceOf(HermsApiError)
    expect(store.getSnapshot().preferences).toBeNull()
  })

  it('reads again on reload, and clears the error when it works', async () => {
    let reads = 0
    const { session } = harness(() => {
      reads += 1
      return reads === 1 ? new Response(null, { status: 500 }) : json(WIRE_PREFS)
    })
    const store = new PreferencesStore(session)
    store.connect()
    await until(store, (s) => s.error !== null)

    store.reload()
    await until(store, (s) => s.preferences !== null)

    expect(store.getSnapshot().error).toBeNull()
  })

  it('discards a read still in flight when disconnected', async () => {
    const slow = deferred()
    const { session } = harness(() => slow.promise)
    const store = new PreferencesStore(session)
    const disconnect = store.connect()

    disconnect()
    slow.resolve(json(WIRE_PREFS))
    await flush()

    // A client swap or an unmount mid-flight must not write the old one's result into
    // the new one's state.
    expect(store.getSnapshot().preferences).toBeNull()
  })
})

describe('writing', () => {
  it('replaces the whole state from the write, without a second read', async () => {
    // The assertion that fails if somebody "optimises" this into a patch plus a refetch:
    // one read on connect, one write, and no third request.
    const { session, calls } = harness((call) => json(isWrite(call.route) ? WIRE_OFF : WIRE_PREFS))
    const store = new PreferencesStore(session)
    store.connect()
    await until(store, (s) => s.preferences !== null)

    await store.setPreference({ channel: 'email', enabled: false })
    // Long enough for a stray request to have been made and recorded, had one been:
    // the assertion below is about something that must NOT have happened.
    await flush()

    expect(store.getSnapshot().preferences?.globalEmailEnabled).toBe(false)
    expect(calls.filter((call) => !isWrite(call.route))).toHaveLength(1)
    expect(calls.find((call) => isWrite(call.route))?.body).toEqual({
      channel: 'email',
      enabled: false,
      // Explicit null for the global setting, so "global" is visible in a request log.
      category_id: null,
    })
  })

  it('shows nothing as changed while the write is in flight', async () => {
    // The point of refusing an optimistic update. The setting must not read "off" until
    // the server has said so: a subscriber seeing "off" that then reverts has been told,
    // briefly, that they are opted out of something.
    const write = deferred()
    const { session } = harness((call) => (isWrite(call.route) ? write.promise : json(WIRE_PREFS)))
    const store = new PreferencesStore(session)
    store.connect()
    await until(store, (s) => s.preferences !== null)

    const pending = store.setPreference({ channel: 'email', enabled: false })
    await flush()
    expect(store.getSnapshot().preferences?.globalEmailEnabled).toBe(true)

    write.resolve(json(WIRE_OFF))
    await pending
    expect(store.getSnapshot().preferences?.globalEmailEnabled).toBe(false)
  })

  it('keeps the last known-good settings when a write fails', async () => {
    const { session } = harness((call) => (isWrite(call.route) ? new Response(null, { status: 429 }) : json(WIRE_PREFS)))
    const store = new PreferencesStore(session)
    store.connect()
    await until(store, (s) => s.preferences !== null)

    await store.setPreference({ channel: 'email', enabled: false }).catch(() => {})

    // A failed toggle must not blank the page. The host gets the error; the subscriber
    // keeps seeing what is actually true.
    expect(store.getSnapshot().error).toBeInstanceOf(HermsApiError)
    expect(store.getSnapshot().preferences?.globalEmailEnabled).toBe(true)
  })

  it('rejects as well as holding the error, so a caller can react per control', async () => {
    const { session } = harness((call) => (isWrite(call.route) ? new Response(null, { status: 409 }) : json(WIRE_PREFS)))
    const store = new PreferencesStore(session)
    store.connect()
    await until(store, (s) => s.preferences !== null)

    await expect(store.setPreference({ channel: 'email', enabled: false })).rejects.toBeInstanceOf(HermsApiError)
  })

  it('clears a held error once a write succeeds', async () => {
    let writes = 0
    const { session } = harness((call) => {
      if (!isWrite(call.route)) return json(WIRE_PREFS)
      writes += 1
      return writes === 1 ? new Response(null, { status: 500 }) : json(WIRE_OFF)
    })
    const store = new PreferencesStore(session)
    store.connect()
    await until(store, (s) => s.preferences !== null)
    await store.setPreference({ channel: 'email', enabled: false }).catch(() => {})
    expect(store.getSnapshot().error).not.toBeNull()

    await store.setPreference({ channel: 'email', enabled: false })

    expect(store.getSnapshot().error).toBeNull()
  })
})

describe('every published state is one the server put us in', () => {
  it('never shows settings while still claiming to load', async () => {
    const { session } = harness(() => json(WIRE_PREFS))
    const store = new PreferencesStore(session)
    const seen = recordSnapshots(store)

    store.connect()
    await until(store, (s) => s.preferences !== null)
    await flush()

    expect(seen.filter((s) => s.preferences !== null && s.isLoading)).toEqual([])
  })

  it('never reports a failed read while still claiming to load', async () => {
    const { session } = harness(() => new Response(null, { status: 500 }))
    const store = new PreferencesStore(session)
    const seen = recordSnapshots(store)

    store.connect()
    await until(store, (s) => s.error !== null)
    await flush()

    expect(seen.filter((s) => s.error !== null && s.isLoading)).toEqual([])
  })
})
