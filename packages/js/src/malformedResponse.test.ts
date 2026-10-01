// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { HermsClient } from './HermsClient'
import { HermsApiError } from './types'
import { InboxStore } from './InboxStore'
import { harness, json, page, until, wireItem } from './storeHarness'

/**
 * A 2xx whose JSON is not what the call returns is a failure, not data.
 *
 * The SDK's rule is that it reflects server decisions and never invents any. It used to break
 * that rule in one place: it copied whatever a 2xx carried straight into the state it hands a
 * UI. Pointed at something that answered `POST /inbox/{id}/read` with `{ "updated": 0 }` (the
 * shape of the read-all call), it replaced a real notification with an object whose every
 * field was undefined, and the inbox drew an empty row with only its archive button. The empty
 * body, the 204 and the HTML page from a proxy were already reported as errors; this is the
 * rest of that family: a response that parses, and is the wrong thing.
 *
 * Reported as a `HermsApiError` with the SDK's own code, so a consumer has one thing to catch,
 * and the real status is kept so a report can say what actually came back.
 */

function respondWith(body: unknown, status = 200) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status }))
}

function respondWithText(text: string, status = 200) {
  vi.stubGlobal('fetch', async () => new Response(text, { status }))
}

function client(): HermsClient {
  return new HermsClient({
    apiBaseUrl: 'https://api.example.test/v1/client',
    publicKey: 'hm_pk_test_abc',
    getSubscriberToken: () => 'st_test',
  })
}

/** The error a call rejected with, or a failure that says nothing was thrown. */
async function rejection(promise: Promise<unknown>): Promise<HermsApiError> {
  try {
    await promise
  } catch (error) {
    return error as HermsApiError
  }
  throw new Error('expected the call to reject')
}

/** The shape of the read-all call's answer, which is what the original incident returned. */
const WRONG_SHAPE = { updated: 0 }

const GOOD_ITEM = {
  id: 'inb_1',
  title: 'Shipped',
  body: 'Your order is on its way.',
  action_url: null,
  category: null,
  seen_at: null,
  read_at: null,
  created_at: '2026-09-01T09:00:00Z',
}

describe('an answer that is the wrong thing', () => {
  it.each([
    ['markRead', (c: HermsClient) => c.markRead('inb_1')],
    ['archive', (c: HermsClient) => c.archive('inb_1')],
  ])('%s refuses to turn it into a notification', async (_name, call) => {
    respondWith(WRONG_SHAPE)

    const error = await rejection(call(client()))

    expect(error).toBeInstanceOf(HermsApiError)
    expect(error.code).toBe('unexpected_response')
    // The status that actually came back, not a made-up failure code: this was a 200.
    expect(error.status).toBe(200)
    // Legible to the developer who reads it in a console.
    expect(error.message).toMatch(/notification/i)
  })

  it.each([
    ['no id', { ...GOOD_ITEM, id: undefined }],
    ['an empty id', { ...GOOD_ITEM, id: '' }],
    ['a numeric id', { ...GOOD_ITEM, id: 7 }],
    ['no title', { ...GOOD_ITEM, title: undefined }],
    ['a title that is not text', { ...GOOD_ITEM, title: { en: 'Shipped' } }],
    ['no created_at', { ...GOOD_ITEM, created_at: undefined }],
    ['a created_at that is not text', { ...GOOD_ITEM, created_at: 1788253200 }],
    ['an array instead of an object', [GOOD_ITEM]],
    ['a bare string', 'inb_1'],
  ])('markRead refuses a notification with %s', async (_label, body) => {
    // One field at a time, because `{ updated: 0 }` lacks all of them and would be refused for
    // whichever check came first. Each of these has exactly one thing wrong.
    respondWith(body)

    expect((await rejection(client().markRead('inb_1'))).code).toBe('unexpected_response')
  })

  it('listInbox refuses a page whose rows are not notifications', async () => {
    respondWith({ data: [GOOD_ITEM, WRONG_SHAPE], has_more: false, next_cursor: null })

    const error = await rejection(client().listInbox())

    // The whole page, not the good rows and a silent gap: a row that is missing is as wrong as
    // a row that is empty, and an inbox that shows an error and a retry is better than one that
    // quietly shows less than the server has.
    expect(error.code).toBe('unexpected_response')
  })

  it.each([
    ['no data array', { has_more: false, next_cursor: null }],
    ['data that is not an array', { data: 'nope', has_more: false, next_cursor: null }],
    ['no has_more', { data: [], next_cursor: null }],
    ['more pages and no cursor to fetch them with', { data: [GOOD_ITEM], has_more: true }],
    ['more pages and a cursor that is not text', { data: [GOOD_ITEM], has_more: true, next_cursor: 4 }],
  ])('listInbox refuses a page with %s', async (_label, body) => {
    respondWith(body)

    expect((await rejection(client().listInbox())).code).toBe('unexpected_response')
  })

  it.each([
    ['nothing in it', {}],
    ['counts that are strings', { unread: '3', unseen: '2' }],
    ['only one count', { unread: 3 }],
    ['a count that is not a number', { unread: Number.NaN, unseen: 1 }],
  ])('getCounts refuses %s', async (_label, body) => {
    respondWith(body)

    expect((await rejection(client().getCounts())).code).toBe('unexpected_response')
  })

  it('getCounts refuses a count that overflows to infinity', async () => {
    // JSON cannot spell NaN or Infinity, but `1e999` parses to Infinity, so a finite check is not
    // dead code, and it needs the raw text to be reached.
    respondWithText('{"unread": 1e999, "unseen": 1}')

    expect((await rejection(client().getCounts())).code).toBe('unexpected_response')
  })

  it.each([
    ['markAllRead', (c: HermsClient) => c.markAllRead()],
    ['markSeen', (c: HermsClient) => c.markSeen(['inb_1'])],
  ])('%s refuses an answer without the number it was asked for', async (_name, call) => {
    respondWith(GOOD_ITEM)

    expect((await rejection(call(client()))).code).toBe('unexpected_response')
  })

  it.each([
    ['getPreferences', (c: HermsClient) => c.getPreferences()],
    ['updatePreference', (c: HermsClient) => c.updatePreference({ channel: 'email', enabled: false })],
  ])('%s refuses something that is not preferences', async (_name, call) => {
    respondWith(WRONG_SHAPE)

    expect((await rejection(call(client()))).code).toBe('unexpected_response')
  })

  const GOOD_PREFERENCES = {
    first_name: null,
    global_channels: [{ channel: 'email', enabled: true }],
    global_email_enabled: true,
    global_in_app_enabled: null,
    categories: [{ category_id: 'cat_1', key: 'k', name: 'n', is_critical: false, channels: [], email_enabled: null, in_app_enabled: null }],
  }

  it.each([
    ['no global_channels', { ...GOOD_PREFERENCES, global_channels: undefined }],
    ['global_channels that is not a list', { ...GOOD_PREFERENCES, global_channels: 'email' }],
    ['a null where a channel setting should be', { ...GOOD_PREFERENCES, global_channels: [null] }],
    ['a list where a channel setting should be', { ...GOOD_PREFERENCES, global_channels: [[]] }],
    ['no categories', { ...GOOD_PREFERENCES, categories: undefined }],
    ['a category with no category_id', { ...GOOD_PREFERENCES, categories: [{ ...GOOD_PREFERENCES.categories[0], category_id: undefined }] }],
    ['a category whose channels is not a list', { ...GOOD_PREFERENCES, categories: [{ ...GOOD_PREFERENCES.categories[0], channels: 'email' }] }],
    ['a null where a category channel should be', { ...GOOD_PREFERENCES, categories: [{ ...GOOD_PREFERENCES.categories[0], channels: [null] }] }],
  ])('getPreferences refuses preferences with %s', async (_label, body) => {
    respondWith(body)

    expect((await rejection(client().getPreferences())).code).toBe('unexpected_response')
  })

  it('getPreferences accepts well-formed preferences', async () => {
    respondWith(GOOD_PREFERENCES)

    await expect(client().getPreferences()).resolves.toMatchObject({ globalEmailEnabled: true })
  })

  it('names what was expected, so the message can be acted on', async () => {
    respondWith(WRONG_SHAPE)

    const error = await rejection(client().getCounts())

    expect(error.message).toMatch(/unread/)
  })
})

describe('an answer that is right', () => {
  // The other half. A check that rejected everything would pass every case above.

  it('is still accepted', async () => {
    respondWith(GOOD_ITEM)

    await expect(client().markRead('inb_1')).resolves.toMatchObject({ id: 'inb_1', title: 'Shipped' })
  })

  it('is accepted with fields the SDK has never heard of', async () => {
    // The API adds fields over time. An SDK that refused a response for carrying one would
    // break every integrator on the day the server shipped it.
    respondWith({ ...GOOD_ITEM, priority: 'high', labels: ['a', 'b'] })

    await expect(client().markRead('inb_1')).resolves.toMatchObject({ id: 'inb_1' })
  })

  it('is accepted with an empty list', async () => {
    respondWith({ data: [], has_more: false, next_cursor: null })

    await expect(client().listInbox()).resolves.toMatchObject({ items: [], hasMore: false })
  })

  it('is accepted as the last page, with or without a cursor', async () => {
    respondWith({ data: [GOOD_ITEM], has_more: false })
    const withoutKey = await client().listInbox()
    respondWith({ data: [GOOD_ITEM], has_more: false, next_cursor: null })
    const withNull = await client().listInbox()

    // Both normalised to `null`, the one value the stores test for, never `undefined`.
    expect(withoutKey.nextCursor).toBeNull()
    expect(withNull.nextCursor).toBeNull()
  })

  it('is accepted as a page with more to come', async () => {
    respondWith({ data: [GOOD_ITEM], has_more: true, next_cursor: 'cur_2' })

    await expect(client().listInbox()).resolves.toMatchObject({ hasMore: true, nextCursor: 'cur_2' })
  })

  it('is accepted with counts of zero', async () => {
    respondWith({ unread: 0, unseen: 0 })

    await expect(client().getCounts()).resolves.toEqual({ unread: 0, unseen: 0 })
  })
})

describe('what a store does with an answer that is the wrong thing', () => {
  it('leaves the row exactly as it was, and rejects', async () => {
    // The incident, one layer up: the empty row on screen.
    const { session } = harness((call) =>
      call.route.endsWith('/read') ? json(WRONG_SHAPE) : page([wireItem('inb_1'), wireItem('inb_2')]),
    )
    const store = new InboxStore(session)
    store.connect()
    await until(store, (s) => s.items.length === 2)
    const before = store.getSnapshot().items

    await expect(store.markRead('inb_1')).rejects.toBeInstanceOf(HermsApiError)

    // The same objects, not equal copies: nothing was written into the list.
    expect(store.getSnapshot().items).toBe(before)
    expect(store.getSnapshot().items[0]?.title).toBe('Notification inb_1')
  })

  it('shows an error instead of an inbox with an empty row in it', async () => {
    const { session } = harness(() => json({ data: [WRONG_SHAPE], has_more: false, next_cursor: null }))
    const store = new InboxStore(session)

    store.connect()
    await until(store, (s) => s.error !== null)

    expect(store.getSnapshot().items).toEqual([])
    expect((store.getSnapshot().error as HermsApiError).code).toBe('unexpected_response')
  })
})
