// The reference above is load-bearing for `npm run typecheck`, not decoration.
// `tsconfig.test.json` includes only `src/**/*.test.ts(x)`, so the package's ambient
// `declare module '*.css'` is not part of that program — and this is the first test to
// pull `HermsInbox.tsx` in, whose `import './HermsInbox.css'` then fails with TS2882.
// The tidier fix is one line in `tsconfig.test.json`'s `include`; that file is off
// limits in this change, so the reference lives here instead.
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HermsClient } from '@hermesihq/js'
import { HermsProvider } from './HermsProvider'
import { HermsInbox } from './HermsInbox'

/**
 * `<HermsInbox />` is the one piece of this package a host app renders without writing
 * any UI of its own, which makes every state it can be in part of the public surface:
 * loading, empty, error and populated all ship here, and a consumer cannot substitute
 * its own if one of them is broken.
 *
 * The cases below query the way an assistive technology reads the widget — by role and
 * accessible name — rather than by class name. That is not stylistic: WCAG 2.1 AA is a
 * non-negotiable for this project, and the bell's `aria-label`, the panel's `role`s and
 * the roving tabindex are the parts a CSS refactor can silently drop.
 */

afterEach(cleanup)

interface WireItem {
  id: string
  title: string
  body: string
  action_url: string | null
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
  nextCursor?: string | null
  unread?: number
  unseen?: number
  /** Answer the list route with this status instead of a page. */
  listStatus?: number
}

interface Recorded {
  route: string
  body: unknown
}

function mount(api: Api, ui: ReactNode = <HermsInbox />): Recorded[] {
  const calls: Recorded[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input))
    const route = `${init?.method ?? 'GET'} ${pathname}`
    calls.push({ route, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })

    if (pathname.endsWith('/inbox/counts')) return json({ unread: api.unread ?? 0, unseen: api.unseen ?? 0 })
    if (pathname.endsWith('/inbox/seen') || pathname.endsWith('/read-all')) return json({ updated: 1 })
    if (pathname.endsWith('/archive') || pathname.endsWith('/read')) return json(wireItem('inb_1', { read_at: new Date().toISOString() }))
    if (api.listStatus) return new Response(null, { status: api.listStatus })
    return json({ data: api.items ?? [], has_more: (api.nextCursor ?? null) !== null, next_cursor: api.nextCursor ?? null })
  })

  const client = new HermsClient({
    apiBaseUrl: 'https://api.example.test/v1/client',
    publicKey: 'hm_pk_test_abc',
    getSubscriberToken: () => 'st_test',
  })
  render(<HermsProvider client={client}>{ui}</HermsProvider>)
  return calls
}

function bell(): HTMLElement {
  return screen.getByRole('button', { name: /Notifications|non lues|unread/ })
}

async function openPanel(): Promise<void> {
  await userEvent.click(bell())
  await screen.findByRole('dialog')
}

beforeEach(() => {
  // Radix's popover positions itself with `ResizeObserver`, which jsdom does not
  // implement. Nothing under test depends on the measurements — only on the panel
  // existing — so the smallest possible stand-in is enough.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

describe('the bell', () => {
  it('names itself for a screen reader, with and without unread notifications', async () => {
    mount({ unread: 0, unseen: 0 })

    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Notifications'))
    cleanup()

    mount({ unread: 3, unseen: 3 })
    // The count belongs in the accessible name, not only in the badge: the badge is
    // `aria-hidden` (it is a visual affordance), so without this a screen-reader user
    // is told there are notifications but never how many.
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Notifications, 3 unread'))
  })

  it('shows the unseen count on the badge, clamped so it cannot break the layout', async () => {
    // Different numbers on purpose, so a badge that rendered `unread` fails here.
    mount({ unread: 5, unseen: 150 })

    // Unseen, not unread: they are kept apart, and the badge is the "there is
    // something you have not looked at" signal.
    await waitFor(() => expect(screen.getByText('99+')).toBeTruthy())
  })

  it('shows no badge at all when there is nothing unseen', async () => {
    mount({ unread: 0, unseen: 0 })

    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Notifications'))
    // A zero badge would make every quiet inbox look like it needed attention.
    expect(screen.queryByText('0')).toBeNull()
  })

  it('announces a new count politely as it changes', async () => {
    mount({ unread: 2, unseen: 2 })

    // The live region exists so an arriving notification is announced without moving
    // focus. `polite`, never `assertive`: a notification must not interrupt whatever
    // the user is doing in the host app.
    const live = await screen.findByRole('status')
    expect(live.getAttribute('aria-live')).toBe('polite')
    await waitFor(() => expect(live.textContent).toBe('Notifications, 2 unread'))
  })
})

describe('the panel', () => {
  it('lists the notifications as a keyboard-navigable menu', async () => {
    mount({ items: [wireItem('inb_1'), wireItem('inb_2')], unread: 2, unseen: 2 })
    await openPanel()

    const menu = await screen.findByRole('menu')
    const rows = within(menu).getAllByRole('menuitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Notification inb_1'),
      expect.stringContaining('Notification inb_2'),
    ])

    // Roving tabindex: exactly one row is in the tab order at a time, and the arrow
    // keys move it. A menu where every row is tabbable makes a keyboard user tab
    // through the entire inbox to reach whatever follows the widget.
    await waitFor(() => expect(document.activeElement).toBe(rows[0]))
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rows[1])
    expect(rows.filter((row) => row.getAttribute('tabindex') === '0')).toHaveLength(1)
  })

  it('renders the empty state when there is nothing to show', async () => {
    mount({ items: [], unread: 0, unseen: 0 })
    await openPanel()

    // An empty inbox is the steady state for most people most of the time; it has to
    // read as "nothing to do", not as a broken panel.
    expect(await screen.findByText("You're all caught up")).toBeTruthy()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('renders an error state with a retry that actually retries', async () => {
    const calls = mount({ listStatus: 503, unread: 0, unseen: 0 })
    await openPanel()

    // `role="alert"`: the panel is already open when this replaces the list, so it has
    // to be announced rather than silently swapped in.
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText("Couldn't load notifications.")).toBeTruthy()

    const listReads = () => calls.filter((call) => call.route === 'GET /v1/client/inbox').length
    const before = listReads()
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }))

    // The only recovery available to someone who is not the host app's developer.
    await waitFor(() => expect(listReads()).toBe(before + 1))
  })

  it('shows a labelled loading state rather than an empty panel', async () => {
    // A list request that never settles — the panel opened before the first page landed,
    // which is the common case on a slow connection.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const { pathname } = new URL(String(input))
      if (pathname.endsWith('/inbox/counts')) return json({ unread: 0, unseen: 0 })
      return new Promise<Response>(() => {})
    })
    const client = new HermsClient({
      apiBaseUrl: 'https://api.example.test/v1/client',
      publicKey: 'hm_pk_test_abc',
      getSubscriberToken: () => 'st_test',
    })
    render(
      <HermsProvider client={client}>
        <HermsInbox />
      </HermsProvider>,
    )
    await openPanel()

    // Skeleton rows are decorative; the label is what a screen reader gets instead of
    // silence while the panel has nothing in it yet.
    const loading = await screen.findByLabelText('Loading notifications…')
    expect(loading.getAttribute('role')).toBe('status')
  })

  it('marks the notifications it displayed as seen', async () => {
    const calls = mount({ items: [wireItem('inb_1'), wireItem('inb_2')], unread: 2, unseen: 2 })
    await openPanel()

    // "Seen" means the bell was opened and these rows were on screen,
    // which is a different fact from "read" (the person opened that notification). The
    // badge clears on seen; the rows stay bold until read.
    await waitFor(() => {
      const seen = calls.find((call) => call.route === 'POST /v1/client/inbox/seen')
      expect(seen?.body).toEqual({ ids: ['inb_1', 'inb_2'] })
    })
  })

  it('does not offer mark-all-read when nothing is unread', async () => {
    mount({ items: [wireItem('inb_1', { read_at: '2026-08-01T00:00:00Z' })], unread: 0, unseen: 0 })
    await openPanel()

    const markAll = await screen.findByRole('button', { name: 'Mark all as read' })
    // Disabled rather than hidden: the control keeps its place, so the panel does not
    // reflow when the last notification is read.
    expect((markAll as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers more only when the server said there is more', async () => {
    mount({ items: [wireItem('inb_1')], nextCursor: 'cur_2', unread: 1, unseen: 1 })
    await openPanel()

    // Cursor pagination: the server's `has_more`, never a guess from the page size.
    expect(await screen.findByRole('button', { name: 'Load more' })).toBeTruthy()
  })
})

describe('activating a notification', () => {
  it('marks it read and hands it to the host to route', async () => {
    const onItemClick = vi.fn()
    const calls = mount(
      { items: [wireItem('inb_1', { action_url: 'https://example.test/orders/1' })], unread: 1, unseen: 1 },
      <HermsInbox onItemClick={onItemClick} />,
    )
    await openPanel()

    await userEvent.click(await screen.findByRole('menuitem', { name: /Notification inb_1/ }))

    // The host drives its router. A hard `window.location.assign`
    // in a SPA would throw away the page the user was on.
    expect(onItemClick).toHaveBeenCalledTimes(1)
    expect(onItemClick.mock.calls[0]?.[0]).toMatchObject({ id: 'inb_1', actionUrl: 'https://example.test/orders/1' })
    await waitFor(() => expect(calls.some((call) => call.route === 'POST /v1/client/inbox/inb_1/read')).toBe(true))
  })

  it('archives from the row without activating it', async () => {
    const onItemClick = vi.fn()
    const calls = mount({ items: [wireItem('inb_1'), wireItem('inb_2')], unread: 2, unseen: 2 }, <HermsInbox onItemClick={onItemClick} />)
    await openPanel()

    // The archive control is inside the row; its label names the notification, because
    // "Archive" repeated down a list tells a screen-reader user nothing about which.
    await userEvent.click(await screen.findByRole('button', { name: 'Archive: Notification inb_1' }))

    await waitFor(() => expect(calls.some((call) => call.route === 'POST /v1/client/inbox/inb_1/archive')).toBe(true))
    // Clicking archive must not also open the notification — they are nested controls.
    expect(onItemClick).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: /Notification inb_1/ })).toBeNull())
  })
})

describe('locale', () => {
  it('renders in French when the host asks for it', async () => {
    mount({ items: [], unread: 0, unseen: 0 }, <HermsInbox locale="fr" />)
    await openPanel()

    // FR/EN parity is a project non-negotiable, and this widget carries its own strings
    // (it cannot assume the host runs i18next) — so the only thing standing between a
    // French host app and an English panel is this prop being honoured everywhere.
    expect(await screen.findByText('Vous êtes à jour')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tout marquer comme lu' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Fermer' })).toBeTruthy()
  })

  it('names the bell in French too, count and all', async () => {
    mount({ items: [], unread: 4, unseen: 4 }, <HermsInbox locale="fr" />)

    // The interpolated string, not just the static ones: a missed plural form here is
    // the kind of thing that only shows up in the one state nobody screenshots.
    await waitFor(() => expect(bell().getAttribute('aria-label')).toBe('Notifications, 4 non lues'))
  })
})
