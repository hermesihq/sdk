import { configure, waitFor, within } from '@testing-library/dom'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HermsClient, HermsSession } from '@hermesihq/js'
import { HermesInboxElement } from './index'
import { installPopover, isPopoverOpen } from './test/popover'

/**
 * `<hermes-inbox>` in jsdom, with the Popover API stubbed (`./test/popover.ts`).
 *
 * The first five groups below carry the same titles as `HermsInbox.test.tsx` in the React
 * package, on purpose: the element has to do what the component does, and `parity.test.ts`
 * fails if a case exists on one side and not the other. Queries are by role and accessible name,
 * as there, because that is how an assistive technology reads the widget.
 *
 * What a stub cannot show (the top layer, Escape and a click outside as the browser handles
 * them, the panel's place on screen) is the end-to-end suite's.
 */

// jsdom evaluates the stylesheet's `.herms-inbox__panel:not(:popover-open)` without knowing the
// pseudo-class, so it reports an open panel as `display: none` and a role query skips everything
// in it. Whether the panel is really shown is for the browser tests; here the tree is queried
// whole, and `isPopoverOpen` is what says whether it is open.
configure({ defaultHidden: true })

let restorePopover: () => void
let mounted: HermesInboxElement[] = []

beforeEach(() => {
  restorePopover = installPopover()
})

afterEach(async () => {
  for (const element of mounted) element.remove()
  mounted = []
  // Let the teardown a removal schedules run before the stub goes.
  await Promise.resolve()
  restorePopover()
})

interface WireItem {
  id: string
  title: string
  body: string
  action_url: string | null
  actions?: { label: string; url: string; style?: string }[]
  category: { key: string; name: string } | null
  seen_at: string | null
  read_at: string | null
  created_at: string
}

function wireItem(id: string, overrides: Partial<WireItem> = {}): WireItem {
  return {
    id,
    title: `Notification ${id}`,
    body: `Body of ${id}`,
    action_url: null,
    category: null,
    seen_at: null,
    read_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface Api {
  items?: WireItem[]
  /** What `?archived=true` lists. */
  archivedItems?: WireItem[]
  nextCursor?: string | null
  unread?: number
  unseen?: number
  /** Answer the list route with this status instead of a page. */
  listStatus?: number
  /** Answer these routes (`"POST /v1/client/inbox/read-all"`) with a 500. */
  failing?: string[]
  /** Hold the list until this resolves. */
  holdList?: Promise<void>
  /** Answer a read with the row as it is, but without its links. */
  echoDropsLinks?: boolean
}

interface Recorded {
  route: string
  body: unknown
  authorization: string | null
  search: string
}

function stubApi(api: Api): Recorded[] {
  const calls: Recorded[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const { pathname } = url
    const route = `${init?.method ?? 'GET'} ${pathname}`
    const headers = new Headers(init?.headers)
    calls.push({ route, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null, authorization: headers.get('authorization'), search: url.search })

    if (api.failing?.includes(route)) return json({ error: { type: 'api_error', code: 'internal_error', message: 'no', request_id: 'r', detail: [], doc_url: '' } }, 500)
    if (pathname.endsWith('/inbox/counts')) return json({ unread: api.unread ?? 0, unseen: api.unseen ?? 0 })
    if (pathname.endsWith('/inbox/seen') || pathname.endsWith('/read-all')) return json({ updated: 1 })
    // Back to unread: the row the server returns has no `read_at`, and keeps the id it was asked about.
    if (pathname.endsWith('/unread')) return json(wireItem(pathname.split('/').slice(-2)[0]!, { read_at: null }))
    // A read answers with the row it read, links and all, as the server does: a mock that dropped them would hide a list that loses its buttons.
    if (pathname.endsWith('/read')) {
      const id = pathname.split('/').slice(-2)[0]!
      const row = api.items?.find((candidate) => candidate.id === id) ?? wireItem(id)
      return json({ ...row, ...(api.echoDropsLinks ? { actions: [] } : {}), read_at: new Date().toISOString() })
    }
    if (pathname.endsWith('/archive')) return json(wireItem('inb_1', { read_at: new Date().toISOString() }))
    if (api.holdList) await api.holdList
    if (api.listStatus) return new Response(null, { status: api.listStatus })
    const listed = url.searchParams.get('archived') === 'true' ? api.archivedItems : api.items
    return json({ data: listed ?? [], has_more: (api.nextCursor ?? null) !== null, next_cursor: api.nextCursor ?? null })
  })
  return calls
}

const BASE = 'https://api.example.test/v1/client'

function create(configure: (element: HermesInboxElement) => void = () => {}): HermesInboxElement {
  const element = document.createElement('hermes-inbox') as HermesInboxElement
  configure(element)
  mounted.push(element)
  return element
}

function configured(element: HermesInboxElement): void {
  element.setAttribute('public-key', 'hm_pk_test_abc')
  element.setAttribute('api-base-url', BASE)
  element.getSubscriberToken = () => 'st_test'
}

/** A configured element on the page, over a stubbed API. */
function mount(api: Api, configure: (element: HermesInboxElement) => void = () => {}) {
  const calls = stubApi(api)
  const element = create((el) => {
    configured(el)
    configure(el)
  })
  document.body.append(element)
  return { element, calls }
}

const wrapper = (element: HermesInboxElement): HTMLElement => element.shadowRoot!.querySelector<HTMLElement>('.herms-inbox')!
const queries = (element: HermesInboxElement) => within(wrapper(element))
const bell = (element: HermesInboxElement): HTMLElement => queries(element).getByRole('button', { name: /Notifications|non lues|unread/ })
/** The text of the row that has the focus, or null if the focus is on anything else. The panel's own text contains every row's, so comparing `textContent` of whatever is focused would pass for the panel. */
const focusedRow = (element: HermesInboxElement): string | null => {
  const active = element.shadowRoot!.activeElement
  return active?.classList.contains('herms-inbox__item') ? active.textContent : null
}
const panel = (element: HermesInboxElement): HTMLElement => element.shadowRoot!.querySelector<HTMLElement>('.herms-inbox__panel')!

async function openPanel(element: HermesInboxElement): Promise<void> {
  await userEvent.click(bell(element))
  await waitFor(() => expect(element.isOpen).toBe(true))
}

const listReads = (calls: Recorded[]) => calls.filter((call) => call.route === 'GET /v1/client/inbox').length

describe('the bell', () => {
  it('names itself for a screen reader, with and without unread notifications', async () => {
    const quiet = mount({ unread: 0, unseen: 0 })
    await waitFor(() => expect(bell(quiet.element).getAttribute('aria-label')).toBe('Notifications'))
    quiet.element.remove()

    const busy = mount({ unread: 3, unseen: 3 })
    // The count belongs in the accessible name, not only in the badge: the badge is `aria-hidden`.
    await waitFor(() => expect(bell(busy.element).getAttribute('aria-label')).toBe('Notifications, 3 unread'))
  })

  it('shows the unseen count on the badge, clamped so it cannot break the layout', async () => {
    // Different numbers on purpose, so a badge that rendered `unread` fails here.
    const { element } = mount({ unread: 5, unseen: 150 })

    await waitFor(() => expect(queries(element).getByText('99+')).toBeTruthy())
  })

  it('shows no badge at all when there is nothing unseen', async () => {
    const { element } = mount({ unread: 0, unseen: 0 })

    await waitFor(() => expect(bell(element).getAttribute('aria-label')).toBe('Notifications'))
    // A zero badge would make every quiet inbox look like it needed attention.
    expect(queries(element).queryByText('0')).toBeNull()
    expect(element.shadowRoot!.querySelector<HTMLElement>('.herms-inbox__badge')!.hidden).toBe(true)
  })

  it('announces a new count politely as it changes', async () => {
    const { element } = mount({ unread: 2, unseen: 2 })

    // The first status is the live region; the loading skeleton in the (closed) panel is another.
    const live = queries(element).getAllByRole('status')[0]!
    expect(live.getAttribute('aria-live')).toBe('polite')
    await waitFor(() => expect(live.textContent).toBe('Notifications, 2 unread'))
  })
})

describe('the panel', () => {
  it('lists the notifications as a list of buttons that the arrow keys move through', async () => {
    const { element } = mount({ items: [wireItem('inb_1'), wireItem('inb_2')], unread: 2, unseen: 2 })
    await openPanel(element)

    const list = await queries(element).findByRole('list', { name: 'Notifications' })
    const rows = within(list)
      .getAllByRole('listitem')
      .map((item) => item.querySelector<HTMLElement>('.herms-inbox__item')!)
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Notification inb_1'),
      expect.stringContaining('Notification inb_2'),
    ])

    // Not an ARIA menu: each row holds the notification and its archive button, and a menu may own only menu items. So no row
    // claims a menu role, and every control stays reachable with Tab as in any list of buttons; the arrow keys are a shortcut.
    expect(queries(element).queryByRole('menu')).toBeNull()
    expect(queries(element).queryByRole('menuitem')).toBeNull()
    expect(rows.filter((row) => row.getAttribute('tabindex') === '-1')).toHaveLength(0)
    await waitFor(() => expect(element.shadowRoot!.activeElement).toBe(rows[0]))
    await userEvent.keyboard('{ArrowDown}')
    expect(element.shadowRoot!.activeElement).toBe(rows[1])
    await userEvent.keyboard('{Home}')
    expect(element.shadowRoot!.activeElement).toBe(rows[0])
  })

  it('renders the empty state when there is nothing to show', async () => {
    const { element } = mount({ items: [], unread: 0, unseen: 0 })
    await openPanel(element)

    expect(await queries(element).findByText("You're all caught up")).toBeTruthy()
    expect(queries(element).queryByRole('list')).toBeNull()
  })

  it('renders an error state with a retry that actually retries', async () => {
    const { element, calls } = mount({ listStatus: 503, unread: 0, unseen: 0 })
    await openPanel(element)

    // `role="alert"`: the panel is already open when this replaces the list.
    const alert = await queries(element).findByRole('alert')
    expect(within(alert).getByText("Couldn't load notifications.")).toBeTruthy()

    const before = listReads(calls)
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(listReads(calls)).toBe(before + 1))
  })

  it('shows a labelled loading state rather than an empty panel', async () => {
    // A list request that never settles: the panel opened before the first page landed.
    const { element } = mount({ holdList: new Promise(() => {}) })
    await openPanel(element)

    const loading = await queries(element).findByLabelText('Loading notifications…')
    expect(loading.getAttribute('role')).toBe('status')
  })

  it('marks the notifications it displayed as seen', async () => {
    const { element, calls } = mount({ items: [wireItem('inb_1'), wireItem('inb_2')], unread: 2, unseen: 2 })
    await openPanel(element)

    // "Seen" means the bell was opened and these rows were on screen, which is a different fact
    // from "read". The badge clears on seen; the rows stay bold until read.
    await waitFor(() => {
      const seen = calls.find((call) => call.route === 'POST /v1/client/inbox/seen')
      expect(seen?.body).toEqual({ ids: ['inb_1', 'inb_2'] })
    })
  })

  it('does not offer mark-all-read when nothing is unread', async () => {
    const { element } = mount({ items: [wireItem('inb_1', { read_at: '2026-08-01T00:00:00Z' })], unread: 0, unseen: 0 })
    await openPanel(element)

    const markAll = await queries(element).findByRole('button', { name: 'Mark all as read' })
    // Disabled rather than hidden: the control keeps its place.
    expect((markAll as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers more only when the server said there is more', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], nextCursor: 'cur_2', unread: 1, unseen: 1 })
    await openPanel(element)

    expect(await queries(element).findByRole('button', { name: 'Load more' })).toBeTruthy()
  })
})

describe('activating a notification', () => {
  it('marks it read and hands it to the host to route', async () => {
    const { element, calls } = mount({ items: [wireItem('inb_1', { action_url: 'https://example.test/orders/1' })], unread: 1, unseen: 1 })
    const onItemClick = vi.fn((event: Event) => event.preventDefault())
    element.addEventListener('hermes-item-click', onItemClick)
    await openPanel(element)

    await userEvent.click(await queries(element).findByRole('button', { name: /^Notification inb_1/ }))

    // The host drives its router: it prevents the default, and the element does not navigate.
    expect(onItemClick).toHaveBeenCalledTimes(1)
    const event = onItemClick.mock.calls[0]![0] as CustomEvent
    expect(event.detail.item).toMatchObject({ id: 'inb_1', actionUrl: 'https://example.test/orders/1' })
    expect(event.cancelable).toBe(true)
    await waitFor(() => expect(calls.some((call) => call.route === 'POST /v1/client/inbox/inb_1/read')).toBe(true))
  })

  it('archives from the row without activating it', async () => {
    const { element, calls } = mount({ items: [wireItem('inb_1'), wireItem('inb_2')], unread: 2, unseen: 2 })
    const onItemClick = vi.fn()
    element.addEventListener('hermes-item-click', onItemClick)
    await openPanel(element)

    // The archive control's label names the notification: "Archive" repeated down a list tells a
    // screen-reader user nothing about which.
    await userEvent.click(await queries(element).findByRole('button', { name: 'Archive: Notification inb_1' }))

    await waitFor(() => expect(calls.some((call) => call.route === 'POST /v1/client/inbox/inb_1/archive')).toBe(true))
    expect(onItemClick).not.toHaveBeenCalled()
    await waitFor(() => expect(queries(element).queryByRole('button', { name: /^Notification inb_1/ })).toBeNull())
  })

  it('offers to mark a read notification unread, and not an unread one', async () => {
    const { element } = mount({ items: [wireItem('inb_1'), wireItem('inb_2', { read_at: '2026-09-01T10:00:00Z' })], unread: 1, unseen: 0 })
    await openPanel(element)

    // Its label names the notification, for the same reason the archive control's does.
    expect(await queries(element).findByRole('button', { name: 'Mark as unread: Notification inb_2' })).toBeTruthy()
    expect(queries(element).queryByRole('button', { name: 'Mark as unread: Notification inb_1' })).toBeNull()
    // Between the notification and its archive button, in that order, for the eye and for the Tab key.
    const row = (await queries(element).findByRole('button', { name: /^Notification inb_2/ })).closest('li')!
    expect([...row.querySelectorAll('button')].map((button) => button.className)).toEqual([
      'herms-inbox__item',
      'herms-inbox__unread-button',
      'herms-inbox__archive-button',
    ])
  })

  it('marks a notification unread from the row without opening it, and keeps the focus in the list', async () => {
    const { element, calls } = mount({ items: [wireItem('inb_1'), wireItem('inb_2', { read_at: '2026-09-01T10:00:00Z' })], unread: 1, unseen: 0 })
    const onItemClick = vi.fn()
    element.addEventListener('hermes-item-click', onItemClick)
    await openPanel(element)

    await userEvent.click(await queries(element).findByRole('button', { name: 'Mark as unread: Notification inb_2' }))

    await waitFor(() => expect(calls.some((call) => call.route === 'POST /v1/client/inbox/inb_2/unread')).toBe(true))
    // Nested controls: clicking one must not also activate the notification, which would mark it read again.
    expect(onItemClick).not.toHaveBeenCalled()
    expect(calls.some((call) => call.route.endsWith('/read'))).toBe(false)
    // Unread again, so the control has nothing left to offer and leaves the row. Focus goes to the notification and not to the page.
    await waitFor(() => expect(queries(element).queryByRole('button', { name: 'Mark as unread: Notification inb_2' })).toBeNull())
    await waitFor(() => expect(element.shadowRoot!.activeElement).toBe(queries(element).getByRole('button', { name: /^Notification inb_2/ })))
  })

  it('puts the mark-as-unread control before the archive button on a notification that was read while the panel was open', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1 })
    await openPanel(element)

    await userEvent.click(await queries(element).findByRole('button', { name: /^Notification inb_1/ }))

    // The row already had its archive button when the control appeared, which is the case the order is easy to get wrong in.
    const control = await queries(element).findByRole('button', { name: 'Mark as unread: Notification inb_1' })
    expect([...control.closest('li')!.querySelectorAll('button')].map((button) => button.className)).toEqual([
      'herms-inbox__item',
      'herms-inbox__unread-button',
      'herms-inbox__archive-button',
    ])
  })

  it('reports a failed mark-unread to the host and leaves the notification read', async () => {
    const { element } = mount({
      items: [wireItem('inb_2', { read_at: '2026-09-01T10:00:00Z' })],
      unread: 0,
      unseen: 0,
      failing: ['POST /v1/client/inbox/inb_2/unread'],
    })
    const errors: unknown[] = []
    element.addEventListener('hermes-error', (event) => errors.push((event as CustomEvent).detail.error))
    await openPanel(element)

    await userEvent.click(await queries(element).findByRole('button', { name: 'Mark as unread: Notification inb_2' }))

    await waitFor(() => expect(errors).toHaveLength(1))
    expect((errors[0] as { code?: string }).code).toBe('internal_error')
    expect(queries(element).getByRole('button', { name: 'Mark as unread: Notification inb_2' })).toBeTruthy()
  })
})

describe('the links under a notification', () => {
  const LINKS = [
    { label: 'Track order', url: 'https://shop.example.cm/orders/1', style: 'primary' },
    { label: 'Get help', url: 'https://shop.example.cm/help', style: 'default' },
  ]
  // jsdom has no navigation to follow: a followed link would only log that it cannot.
  const stopNavigation = (event: Event) => event.preventDefault()
  beforeEach(() => document.addEventListener('click', stopNavigation))
  afterEach(() => document.removeEventListener('click', stopNavigation))

  it('draws them as links under the notification, in order, opening in a new tab that cannot reach back', async () => {
    const { element } = mount({ items: [wireItem('inb_1', { actions: LINKS })], unread: 1, unseen: 1 })
    await openPanel(element)

    const group = await queries(element).findByRole('group', { name: 'Links: Notification inb_1' })
    const links = within(group).getAllByRole('link')

    expect(links.map((link) => link.textContent)).toEqual(['Track order', 'Get help'])
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['https://shop.example.cm/orders/1', 'https://shop.example.cm/help'])
    expect(links.map((link) => link.getAttribute('data-style'))).toEqual(['primary', 'default'])
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })

  it('draws no group of links for a notification that has none', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1 })
    await openPanel(element)
    await queries(element).findByRole('button', { name: /^Notification inb_1/ })

    expect(queries(element).queryByRole('group', { name: /^Links:/ })).toBeNull()
  })

  it('keeps the notification, its controls and its links in that order, the links last', async () => {
    const { element, calls } = mount({ items: [wireItem('inb_1', { actions: LINKS })], unread: 1, unseen: 1 })
    await openPanel(element)
    const row = (await queries(element).findByRole('button', { name: /^Notification inb_1/ })).closest('li')!
    expect(calls.length).toBeGreaterThan(0)

    // The order has to hold when the controls arrive after the links did: a read adds the unread control, and the row is reused.
    await userEvent.click(queries(element).getByRole('button', { name: /^Notification inb_1/ }))
    await queries(element).findByRole('button', { name: 'Mark as unread: Notification inb_1' })

    expect([...row.children].map((child) => child.className)).toEqual([
      'herms-inbox__item',
      'herms-inbox__unread-button',
      'herms-inbox__archive-button',
      'herms-inbox__actions',
    ])
  })

  it('reads an unread notification when one of its links is followed', async () => {
    const { element, calls } = mount({ items: [wireItem('inb_1', { actions: LINKS })], unread: 1, unseen: 1 })
    await openPanel(element)

    await userEvent.click(await queries(element).findByRole('link', { name: 'Get help' }))

    await waitFor(() => expect(calls.some((call) => call.route === 'POST /v1/client/inbox/inb_1/read')).toBe(true))
  })

  it('does not ask the server to read a notification that is already read when a link is followed', async () => {
    const { element, calls } = mount({ items: [wireItem('inb_1', { actions: LINKS, read_at: '2026-09-01T10:00:00Z' })], unread: 0, unseen: 0 })
    await openPanel(element)

    await userEvent.click(await queries(element).findByRole('link', { name: 'Track order' }))

    expect(calls.some((call) => call.route.endsWith('/read'))).toBe(false)
  })

  it('removes the group of links when the notification no longer has any', async () => {
    const { element } = mount({ items: [wireItem('inb_1', { actions: LINKS })], unread: 1, unseen: 1, echoDropsLinks: true })
    await openPanel(element)
    await queries(element).findByRole('group', { name: 'Links: Notification inb_1' })

    await userEvent.click(queries(element).getByRole('button', { name: /^Notification inb_1/ }))

    await waitFor(() => expect(queries(element).queryByRole('group', { name: /^Links:/ })).toBeNull())
  })

  it('keeps the same link elements when the list updates around them', async () => {
    const { element } = mount({
      items: [wireItem('inb_1', { actions: LINKS, read_at: '2026-09-01T10:00:00Z' }), wireItem('inb_2')],
      unread: 1,
      unseen: 1,
    })
    await openPanel(element)
    const link = await queries(element).findByRole('link', { name: 'Track order' })
    link.focus()

    // Another notification is read: the store patches its row and the list is drawn again. The links of the first are what they
    // were, so they are not replaced, which would take the keyboard focus out from under whoever is on one.
    await userEvent.click(queries(element).getByRole('button', { name: /^Notification inb_2/ }))
    await queries(element).findByRole('button', { name: 'Mark as unread: Notification inb_2' })

    expect(queries(element).getByRole('link', { name: 'Track order' })).toBe(link)
  })

  it('names the group of links in French too', async () => {
    const { element } = mount({ items: [wireItem('inb_1', { actions: LINKS })], unread: 1, unseen: 1 }, (el) => el.setAttribute('locale', 'fr'))
    await openPanel(element)

    expect(await queries(element).findByRole('group', { name: 'Liens: Notification inb_1' })).toBeTruthy()
  })
})

describe('the archived view', () => {
  const ARCHIVED = [wireItem('inb_9', { read_at: '2026-09-01T10:00:00Z' })]
  const withView = (el: HermesInboxElement) => el.setAttribute('archived-view', '')
  const toggle = (element: HermesInboxElement) => element.shadowRoot!.querySelector<HTMLButtonElement>('.herms-inbox__header-actions .herms-inbox__text-button')!
  const archiveListReads = (calls: Recorded[]) => calls.filter((call) => call.route === 'GET /v1/client/inbox')

  it('adds no archived control unless the host turned the view on', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], archivedItems: ARCHIVED, unread: 1, unseen: 1 })
    await openPanel(element)
    await queries(element).findByRole('button', { name: /^Notification inb_1/ })

    // Upgrading must not change what anyone sees until they ask for it.
    expect(toggle(element).hidden).toBe(true)
  })

  it('switches to the archived notifications, which can be opened and marked unread but not archived again', async () => {
    const { element, calls } = mount({ items: [wireItem('inb_1')], archivedItems: ARCHIVED, unread: 1, unseen: 1 }, withView)
    await openPanel(element)
    await queries(element).findByRole('button', { name: /^Notification inb_1/ })

    await userEvent.click(queries(element).getByRole('button', { name: 'Archived' }))

    // The archive, and only the archive: the live row is gone, and the request asked for what is filed away.
    expect(await queries(element).findByRole('button', { name: /^Notification inb_9/ })).toBeTruthy()
    expect(queries(element).queryByRole('button', { name: /^Notification inb_1/ })).toBeNull()
    expect(archiveListReads(calls).at(-1)?.search).toContain('archived=true')
    // The dialog is named by its title, and the title says where the person is.
    const dialog = queries(element).getByRole('dialog', { hidden: true })
    expect(element.shadowRoot!.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Archived')
    expect(queries(element).getByRole('list', { name: 'Archived' })).toBeTruthy()
    // There is no way to un-archive, so no control that pretends to be one; the others a row has stay.
    expect(queries(element).queryByRole('button', { name: /^Archive:/ })).toBeNull()
    expect(queries(element).getByRole('button', { name: 'Mark as unread: Notification inb_9' })).toBeTruthy()
    // "Mark all as read" is about the live feed, and the archive is not it.
    // Hidden, not removed, so a role query would skip it: look it up by its text.
    const markAll = [...element.shadowRoot!.querySelectorAll('button')].find((button) => button.textContent === 'Mark all as read')
    expect(markAll?.hidden).toBe(true)
  })

  it('goes back to the live feed from the archive, and says so when nothing is archived', async () => {
    const { element, calls } = mount({ items: [wireItem('inb_1')], archivedItems: [], unread: 1, unseen: 1 }, withView)
    await openPanel(element)
    await queries(element).findByRole('button', { name: /^Notification inb_1/ })

    await userEvent.click(queries(element).getByRole('button', { name: 'Archived' }))
    expect(await queries(element).findByText('No archived notifications')).toBeTruthy()

    await userEvent.click(queries(element).getByRole('button', { name: 'Back to notifications' }))
    expect(await queries(element).findByRole('button', { name: 'Archive: Notification inb_1' })).toBeTruthy()
    expect(queries(element).getByRole('button', { name: 'Mark all as read' }).hidden).toBe(false)
    expect(archiveListReads(calls).at(-1)?.search).not.toContain('archived')
  })

  it('opens on the live feed again after it was closed on the archive', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], archivedItems: ARCHIVED, unread: 1, unseen: 1 }, withView)
    await openPanel(element)
    await userEvent.click(await queries(element).findByRole('button', { name: 'Archived' }))
    await queries(element).findByRole('button', { name: /^Notification inb_9/ })

    element.close()
    await waitFor(() => expect(element.isOpen).toBe(false))
    await openPanel(element)

    // Not wherever it was left: the bell is for what is new.
    expect(await queries(element).findByRole('button', { name: /^Notification inb_1/ })).toBeTruthy()
    expect(queries(element).getByRole('button', { name: 'Archived' })).toBeTruthy()
  })

  it('does not report the archived notifications as seen', async () => {
    const { element, calls } = mount({ items: [wireItem('inb_1')], archivedItems: ARCHIVED, unread: 1, unseen: 1 }, withView)
    await openPanel(element)
    await waitFor(() => expect(calls.some((call) => call.route === 'POST /v1/client/inbox/seen')).toBe(true))

    await userEvent.click(queries(element).getByRole('button', { name: 'Archived' }))
    await queries(element).findByRole('button', { name: /^Notification inb_9/ })

    // What is filed away is not new: telling the server it was just seen would be a request for nothing.
    expect(calls.filter((call) => call.route === 'POST /v1/client/inbox/seen').some((call) => JSON.stringify(call.body).includes('inb_9'))).toBe(false)
  })

  it('keeps the focus on the control that switched the view', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], archivedItems: ARCHIVED, unread: 1, unseen: 1 }, withView)
    await openPanel(element)
    const control = await queries(element).findByRole('button', { name: 'Archived' })

    await userEvent.click(control)
    await queries(element).findByRole('button', { name: /^Notification inb_9/ })

    // The same control, now labelled for the way back: a keyboard user who pressed it is not sent to the page.
    expect(element.shadowRoot!.activeElement).toBe(control)
    expect(control.textContent).toBe('Back to notifications')
  })

  it('names the archived view in French too', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], archivedItems: [], unread: 1, unseen: 1 }, (el) => {
      withView(el)
      el.setAttribute('locale', 'fr')
    })
    await openPanel(element)

    await userEvent.click(await queries(element).findByRole('button', { name: 'Archivées' }))

    expect(await queries(element).findByText('Aucune notification archivée')).toBeTruthy()
    expect(queries(element).getByRole('button', { name: 'Retour aux notifications' })).toBeTruthy()
  })

  it('reflects archived-view as a property, and is the live feed again when it is turned off while open', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], archivedItems: ARCHIVED, unread: 1, unseen: 1 }, withView)
    expect(element.archivedView).toBe(true)
    await openPanel(element)
    await userEvent.click(await queries(element).findByRole('button', { name: 'Archived' }))
    await queries(element).findByRole('button', { name: /^Notification inb_9/ })

    element.archivedView = false

    expect(element.hasAttribute('archived-view')).toBe(false)
    expect(await queries(element).findByRole('button', { name: /^Notification inb_1/ })).toBeTruthy()
    expect(toggle(element).hidden).toBe(true)
  })
})

describe('locale', () => {
  it('renders in French when the host asks for it', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1 }, (el) => el.setAttribute('locale', 'fr'))
    await openPanel(element)

    expect(await queries(element).findByRole('button', { name: 'Tout marquer comme lu' })).toBeTruthy()
    expect(queries(element).getByRole('button', { name: 'Fermer' })).toBeTruthy()
  })

  it('names the mark-as-unread control in French too', async () => {
    const { element } = mount({ items: [wireItem('inb_2', { read_at: '2026-09-01T10:00:00Z' })], unread: 0, unseen: 0 }, (el) => el.setAttribute('locale', 'fr'))
    await openPanel(element)

    expect(await queries(element).findByRole('button', { name: 'Marquer comme non lu: Notification inb_2' })).toBeTruthy()
  })

  it('names the bell in French too, count and all', async () => {
    const { element } = mount({ unread: 3, unseen: 3 }, (el) => el.setAttribute('locale', 'fr'))

    await waitFor(() => expect(bell(element).getAttribute('aria-label')).toBe('Notifications, 3 non lues'))
  })
})

describe('the panel is themed and named like the bell', () => {
  it('carries the colour scheme the host forced', async () => {
    const { element } = mount({}, (el) => el.setAttribute('color-scheme', 'dark'))

    // On the panel as well as the bell's wrapper: the stylesheet's rules select on the panel's own
    // attribute.
    expect(panel(element).getAttribute('data-herms-color-scheme')).toBe('dark')
    expect(wrapper(element).getAttribute('data-herms-color-scheme')).toBe('dark')
  })

  it('leaves the colour scheme to the operating system when it is auto', async () => {
    const { element } = mount({}, (el) => el.setAttribute('color-scheme', 'auto'))

    expect(panel(element).hasAttribute('data-herms-color-scheme')).toBe(false)
    expect(wrapper(element).hasAttribute('data-herms-color-scheme')).toBe(false)
  })

  it('is a dialog with a name, taken from its own title', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1 })
    await openPanel(element)

    const dialog = queries(element).getByRole('dialog', { hidden: true })
    const labelledBy = dialog.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(element.shadowRoot!.getElementById(labelledBy!)?.textContent).toBe('Notifications')
  })
})

describe('configuration', () => {
  it('draws the bell disabled and makes no request until everything is configured', async () => {
    const calls = stubApi({})
    const element = create()
    document.body.append(element)
    expect(bell(element).hasAttribute('disabled')).toBe(true)

    element.setAttribute('public-key', 'hm_pk_test_abc')
    element.setAttribute('api-base-url', BASE)
    await Promise.resolve()
    // The key and the URL are not enough: nothing can ask for a token yet.
    expect(bell(element).hasAttribute('disabled')).toBe(true)
    expect(calls).toEqual([])
  })

  it('starts when the last piece arrives, whichever order they come in', async () => {
    const calls = stubApi({ unread: 1, unseen: 1 })
    const element = create()
    document.body.append(element)

    element.getSubscriberToken = () => 'st_test'
    element.setAttribute('api-base-url', BASE)
    expect(calls).toEqual([])
    element.setAttribute('public-key', 'hm_pk_test_abc')

    await waitFor(() => expect(bell(element).hasAttribute('disabled')).toBe(false))
    await waitFor(() => expect(calls.some((call) => call.route === 'GET /v1/client/inbox/counts')).toBe(true))
  })

  it('builds a new client when the key changes, and asks with the new one', async () => {
    const { element, calls } = mount({})
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls.every((call) => call.authorization === 'Bearer hm_pk_test_abc')).toBe(true)
    calls.length = 0

    element.setAttribute('public-key', 'hm_pk_test_other')

    await waitFor(() => expect(calls.some((call) => call.authorization === 'Bearer hm_pk_test_other')).toBe(true))
  })

  it('keeps using the same client when the token function is replaced', async () => {
    const { element, calls } = mount({})
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    const before = calls.length

    element.getSubscriberToken = () => 'st_other'
    await Promise.resolve()

    // Same key and URL: no teardown, so no fresh round of requests for a function that is only
    // read when the next request is made.
    expect(calls.length).toBe(before)
  })

  it('adopts a session from the page instead of making its own', async () => {
    const calls = stubApi({ unread: 4, unseen: 4 })
    const client = new HermsClient({ apiBaseUrl: BASE, publicKey: 'hm_pk_page', getSubscriberToken: () => 'st_page' })
    const element = create((el) => {
      el.session = new HermsSession(client)
    })
    document.body.append(element)

    await waitFor(() => expect(bell(element).getAttribute('aria-label')).toBe('Notifications, 4 unread'))
    expect(calls.every((call) => call.authorization === 'Bearer hm_pk_page')).toBe(true)
  })

  it('picks up a property set before the element was defined', async () => {
    stubApi({ unread: 2, unseen: 2 })
    // An own property on the instance is what a page leaves behind when it assigns before
    // `customElements.define` ran: it shadows the accessor the class defines.
    const element = create((el) => {
      Object.defineProperty(el, 'getSubscriberToken', { value: () => 'st_early', writable: true, configurable: true, enumerable: true })
      el.setAttribute('public-key', 'hm_pk_test_abc')
      el.setAttribute('api-base-url', BASE)
    })
    document.body.append(element)

    await waitFor(() => expect(bell(element).getAttribute('aria-label')).toBe('Notifications, 2 unread'))
  })

  it('reflects its attributes as properties, with defaults for missing or invalid values', () => {
    const element = create()
    expect(element.placement).toBe('bottom-end')
    expect(element.colorScheme).toBe('auto')
    expect(element.locale).toBe('en')

    element.setAttribute('placement', 'top-start')
    element.setAttribute('color-scheme', 'dark')
    element.setAttribute('locale', 'fr')
    expect([element.placement, element.colorScheme, element.locale]).toEqual(['top-start', 'dark', 'fr'])

    element.setAttribute('placement', 'sideways')
    element.setAttribute('color-scheme', 'sepia')
    element.setAttribute('locale', 'de')
    expect([element.placement, element.colorScheme, element.locale]).toEqual(['bottom-end', 'auto', 'en'])
  })
})

describe('lifecycle', () => {
  it('does not refetch when the node is moved in the page', async () => {
    const { element, calls } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1 })
    await waitFor(() => expect(listReads(calls)).toBe(1))

    const elsewhere = document.createElement('div')
    document.body.append(elsewhere)
    elsewhere.append(element)
    await new Promise((resolve) => setTimeout(resolve, 20))

    // Removing and re-adding in one task is how the DOM moves a node. Tearing down for it would
    // close the connection and load the list again.
    expect(listReads(calls)).toBe(1)
    // And still running, not torn down by a teardown that forgot to look again.
    expect(bell(element).hasAttribute('disabled')).toBe(false)
    expect(bell(element).getAttribute('aria-label')).toBe('Notifications, 1 unread')
    elsewhere.remove()
  })

  it('stops when removed, and starts again when added back later', async () => {
    const { element, calls } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1 })
    await waitFor(() => expect(listReads(calls)).toBe(1))

    element.remove()
    await new Promise((resolve) => setTimeout(resolve, 20))
    document.body.append(element)

    await waitFor(() => expect(listReads(calls)).toBe(2))
  })
})

describe('events', () => {
  it('reports what is on screen as seen once, however often the list changes', async () => {
    const { element, calls } = mount({ items: [wireItem('inb_1'), wireItem('inb_2')], unread: 2, unseen: 2 })
    await openPanel(element)
    await waitFor(() => expect(calls.filter((call) => call.route === 'POST /v1/client/inbox/seen')).toHaveLength(1))

    // A change to the list while it stays open must not report the same rows again.
    queries(element).getByRole('button', { name: 'Archive: Notification inb_1' }).click()
    await waitFor(() => expect(queries(element).queryByRole('button', { name: /^Notification inb_1/ })).toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(calls.filter((call) => call.route === 'POST /v1/client/inbox/seen')).toHaveLength(1)
  })

  it('says when it opens and closes', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1 })
    const seen: string[] = []
    element.addEventListener('hermes-open', () => seen.push('open'))
    element.addEventListener('hermes-close', () => seen.push('close'))

    await openPanel(element)
    element.close()
    await waitFor(() => expect(element.isOpen).toBe(false))

    expect(seen).toEqual(['open', 'close'])
  })

  it('reports a failed mutation to the host instead of an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1, failing: ['POST /v1/client/inbox/read-all'] })
    const errors: Error[] = []
    element.addEventListener('hermes-error', (event) => errors.push((event as CustomEvent).detail.error))
    await openPanel(element)

    await userEvent.click(await queries(element).findByRole('button', { name: 'Mark all as read' }))

    await waitFor(() => expect(errors).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('reports a list that failed to load', async () => {
    const { element } = mount({ listStatus: 503 })
    const errors: Error[] = []
    const onPage = vi.fn()
    element.addEventListener('hermes-error', (event) => errors.push((event as CustomEvent).detail.error))
    // A page-level error reporter listens high up, not on each element.
    document.body.addEventListener('hermes-error', onPage)

    await waitFor(() => expect(errors.length).toBeGreaterThan(0))
    expect(onPage).toHaveBeenCalled()
    document.body.removeEventListener('hermes-error', onPage)
  })

  it('bubbles, so a page can listen on an ancestor', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1 })
    const onOpen = vi.fn()
    document.body.addEventListener('hermes-open', onOpen)

    await openPanel(element)

    expect(onOpen).toHaveBeenCalledTimes(1)
    document.body.removeEventListener('hermes-open', onOpen)
  })
})

describe('opening and closing', () => {
  it('stays open when the window loses the focus', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1 })
    await openPanel(element)

    // Switching to another window moves the focus nowhere: `relatedTarget` is null. Closing on
    // that would shut the panel on anyone who alt-tabs away and back.
    bell(element).dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true, relatedTarget: null }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(element.isOpen).toBe(true)
  })

  it('opens and closes from a script', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1 })

    element.open()
    await waitFor(() => expect(element.isOpen).toBe(true))
    expect(isPopoverOpen(panel(element))).toBe(true)
    expect(bell(element).getAttribute('aria-expanded')).toBe('true')

    element.close()
    await waitFor(() => expect(element.isOpen).toBe(false))
    expect(bell(element).getAttribute('aria-expanded')).toBe('false')
  })

  it('does not open before it is configured', () => {
    stubApi({})
    const element = create()
    document.body.append(element)

    element.open()

    expect(isPopoverOpen(panel(element))).toBe(false)
  })

  it('opens with the first notification focused', async () => {
    const { element } = mount({ items: [wireItem('inb_1'), wireItem('inb_2')], unread: 2, unseen: 2 })
    await waitFor(() => expect(bell(element).getAttribute('aria-label')).toBe('Notifications, 2 unread'))
    await openPanel(element)

    await waitFor(() => expect(focusedRow(element)).toContain('Notification inb_1'))
  })

  it('puts the focus on the first notification when the list arrives after the panel opened', async () => {
    let release!: () => void
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1, holdList: new Promise<void>((resolve) => (release = resolve)) })
    await openPanel(element)
    // Nothing to focus yet: the panel waits with the focus itself.
    expect(element.shadowRoot!.activeElement).toBe(panel(element))
    expect(within(wrapper(element)).queryAllByRole('listitem')).toHaveLength(0)

    release()

    await waitFor(() => expect(focusedRow(element)).toContain('Notification inb_1'))
  })

  it('does not take the focus back from somewhere the person moved it', async () => {
    let release!: () => void
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1, holdList: new Promise<void>((resolve) => (release = resolve)) })
    await openPanel(element)
    const close = queries(element).getByRole('button', { name: 'Close' })
    close.focus()

    release()
    await queries(element).findByRole('button', { name: /^Notification inb_1/ })

    expect(element.shadowRoot!.activeElement).toBe(close)
  })

  it('gives the focus back to the bell when it closes', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1 })
    await openPanel(element)
    await waitFor(() => expect(focusedRow(element)).toContain('Notification inb_1'))

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(element.isOpen).toBe(false))

    // The platform leaves the focus nowhere after Escape; the element puts it back.
    expect(element.shadowRoot!.activeElement).toBe(bell(element))
  })

  it('does not give the focus back when the person has moved on to something else', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1 })
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    await openPanel(element)

    elsewhere.focus()
    element.close()
    await waitFor(() => expect(element.isOpen).toBe(false))

    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })

  it('closes when the focus leaves it', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1 })
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    await openPanel(element)
    await waitFor(() => expect(focusedRow(element)).toContain('Notification inb_1'))

    elsewhere.focus()

    await waitFor(() => expect(element.isOpen).toBe(false))
    elsewhere.remove()
  })

  it('stays open when the focus moves to the bell or inside the panel', async () => {
    const { element } = mount({ items: [wireItem('inb_1')], unread: 1, unseen: 1 })
    await openPanel(element)
    await waitFor(() => expect(focusedRow(element)).toContain('Notification inb_1'))

    queries(element).getByRole('button', { name: 'Close' }).focus()
    bell(element).focus()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(element.isOpen).toBe(true)
  })

  it('keeps the focused row when the list changes under it', async () => {
    const { element } = mount({ items: [wireItem('inb_1'), wireItem('inb_2')], unread: 2, unseen: 2 })
    await openPanel(element)
    await waitFor(() => expect(focusedRow(element)).toContain('Notification inb_1'))
    const second = queries(element).getByRole('button', { name: /^Notification inb_2/ })
    second.focus()

    // Archiving the first row re-renders the list; the second must be the same node, still focused.
    // `click()` and not a pointer click, which would move the focus to the archive button itself.
    queries(element).getByRole('button', { name: 'Archive: Notification inb_1' }).click()
    await waitFor(() => expect(queries(element).queryByRole('button', { name: /^Notification inb_1/ })).toBeNull())

    expect(queries(element).getByRole('button', { name: /^Notification inb_2/ })).toBe(second)
    expect(element.shadowRoot!.activeElement).toBe(second)
  })
})

describe('where it cannot run', () => {
  it('reports whether the browser has what it needs', () => {
    expect(HermesInboxElement.isSupported).toBe(true)
    restorePopover()
    expect(HermesInboxElement.isSupported).toBe(false)
    restorePopover = installPopover()
  })

  it('draws nothing, and does not throw, without the Popover API', () => {
    restorePopover()
    const element = create()
    document.body.append(element)

    expect(element.shadowRoot).toBeNull()
    expect(() => {
      element.open()
      element.close()
      element.refresh()
    }).not.toThrow()
    restorePopover = installPopover()
  })
})
