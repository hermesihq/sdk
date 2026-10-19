import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { bell, drawn, notifications, open, panel, show } from './helpers'

/**
 * The inbox as published, in a real engine, in both of its implementations: `<HermsInbox />` from
 * `@hermesihq/react` and `<hermes-inbox>` from `@hermesihq/element`. The same cases run against
 * each (see `fixtures.ts`), so a behaviour the React component has and the element lacks is a
 * failing test, not a review comment. A case that belongs to one only says so and skips the other.
 *
 *
 * The unit tests run in jsdom, which has no layout, no cascade and no real focus model, so they
 * cannot see most of what a person sees. Two defects shipped because of that: a panel with no
 * styling (every colour variable was defined on a parent the panel is not inside), and a
 * notification replaced by an empty row. Both are one assertion here.
 *
 * These cases are also the reference behaviour for the custom element. Where React does something
 * the element has to do too, this is where it is written down.
 */

test.describe('the panel is styled', () => {
  test.describe('on a light system', () => {
    test.use({ colorScheme: 'light' })

    test('with the default theme', async ({ page }) => {
      await show(page)
      await open(page)

      // The defect, as a measurement. Before 0.2.1 the background was transparent, the border
      // 0px none, the radius 0 and the text black whatever the scheme.
      expect(await drawn(panel(page))).toMatchObject({
        background: 'rgb(255, 255, 255)',
        color: 'rgb(28, 27, 24)',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'rgb(229, 227, 223)',
        radius: '10px',
      })
    })

    test('and sized with border-box, so 380px is 380px', async ({ page }) => {
      await show(page)
      await open(page)

      expect(await drawn(panel(page))).toMatchObject({ boxSizing: 'border-box', width: 380 })
    })
  })

  test.describe('on a dark system', () => {
    test.use({ colorScheme: 'dark' })

    test('it follows the system when left on auto', async ({ page }) => {
      await show(page)
      await open(page)

      expect(await drawn(panel(page))).toMatchObject({
        background: 'rgb(32, 31, 26)',
        color: 'rgb(243, 241, 236)',
        borderColor: 'rgb(56, 54, 47)',
      })
    })

    test('light can be forced, which the panel used to ignore', async ({ page }) => {
      await show(page, { query: { scheme: 'light' } })
      await open(page)

      expect(await drawn(panel(page))).toMatchObject({ background: 'rgb(255, 255, 255)', color: 'rgb(28, 27, 24)' })
    })
  })

  test.describe('on a light system', () => {
    test.use({ colorScheme: 'light' })

    test('dark can be forced', async ({ page }) => {
      await show(page, { query: { scheme: 'dark' } })
      await open(page)

      expect(await drawn(panel(page))).toMatchObject({ background: 'rgb(32, 31, 26)' })
    })
  })

  test('and the theme prop reaches it', async ({ page }) => {
    await show(page, { query: { accent: '#00aa77', radius: '4px' } })
    await open(page)

    expect(await drawn(panel(page))).toMatchObject({ accent: '#00aa77', radius: '4px' })
  })

  test('and a variable set on an ancestor reaches it, as the stylesheet says it can', async ({ page }) => {
    // The stylesheet documents setting a `--herms-*` variable "higher up the DOM". It could not
    // work: the bell and the panel each re-declared every default on themselves, and a
    // declaration on the element beats anything inherited. A host could only win with a rule
    // that targets `.herms-inbox` itself.
    await show(page, { query: { vars: '--herms-color-surface: rgb(1, 2, 3); --herms-radius: 3px; --herms-color-accent: rgb(4, 5, 6)' } })
    await open(page)

    expect(await drawn(panel(page))).toMatchObject({ background: 'rgb(1, 2, 3)', radius: '3px', accent: 'rgb(4, 5, 6)' })
  })

  test('and the host class reaches it, so one rule themes the bell and the panel', async ({ page, flavor }) => {
    test.skip(flavor === 'element', 'The element has no className to forward: a host styles the element itself, and its variables inherit.')
    await show(page, { query: { className: 'my-inbox' } })
    await open(page)

    await expect(panel(page)).toHaveClass(/my-inbox/)
  })
})

test.describe('the panel as a dialog', () => {
  test('has a name, taken from its title', async ({ page }) => {
    await show(page)
    await open(page)

    // `panel()` finds it by role AND name, so being visible is the proof.
    await expect(panel(page)).toBeVisible()
  })

  test('opens with the first notification focused', async ({ page }) => {
    await show(page)
    await open(page)

    await expect(notifications(page).first()).toBeFocused()
  })

  test('puts the focus on the first notification when the list arrives after the panel opened', async ({ page }) => {
    // The bell can be opened before the first page of notifications has loaded: on a slow
    // connection, or by a keyboard user who is quick. Opening decides where focus goes, and
    // at that moment there is no notification to choose, so focus lands on the first control
    // in the panel (Close). Nothing moved it afterwards. The earlier case above only passed
    // when the list happened to win the race, which on a loaded CI machine it did not.
    const inbox = await show(page, { scenario: { holdList: true } })
    await open(page)
    // The setup this case exists for: opened, and nothing to focus yet. The list is held by the
    // mock until released, so no engine can win the race and pass while testing nothing (WebKit
    // did, with a timer).
    await expect(notifications(page)).toHaveCount(0)
    await inbox.release()
    await expect(notifications(page).first()).toBeVisible()

    await expect(notifications(page).first()).toBeFocused()
  })

  test('does not take the focus back from somewhere the person moved it', async ({ page }) => {
    // The other side of the rule above: it applies only while focus is still where opening
    // left it. A person who has already gone elsewhere in the panel is not interrupted.
    const inbox = await show(page, { scenario: { holdList: true } })
    await open(page)
    const close = page.getByRole('button', { name: 'Close' })
    await close.focus()
    await expect(notifications(page)).toHaveCount(0)
    await inbox.release()
    await expect(notifications(page).first()).toBeVisible()

    await expect(close).toBeFocused()
  })

  test('closes on Escape and gives the focus back to the bell', async ({ page }) => {
    await show(page)
    await open(page)

    await page.keyboard.press('Escape')

    await expect(panel(page)).toBeHidden()
    await expect(bell(page)).toBeFocused()
  })

  test('closes on a click outside it', async ({ page }) => {
    await show(page)
    await open(page)

    await page.mouse.click(700, 500)

    await expect(panel(page)).toBeHidden()
  })

  test('closes when the focus moves elsewhere in the page', async ({ page }) => {
    // The native Popover API does not do this: it light-dismisses on clicks and Escape only. Radix
    // does, and the custom element has to.
    await show(page)
    await page.evaluate(() => {
      const elsewhere = document.createElement('button')
      elsewhere.id = 'elsewhere'
      elsewhere.textContent = 'elsewhere'
      document.body.append(elsewhere)
    })
    await open(page)

    await page.locator('#elsewhere').focus()

    await expect(panel(page)).toBeHidden()
  })

  test('closing and reopening by clicking the bell is one toggle each time', async ({ page }) => {
    await show(page)
    await open(page)

    await bell(page).click()
    await expect(panel(page)).toBeHidden()
    await bell(page).click()
    await expect(panel(page)).toBeVisible()
  })

  test('moves between notifications with the arrow keys, Home and End', async ({ page }) => {
    await show(page)
    await open(page)
    const items = notifications(page)

    await page.keyboard.press('ArrowDown')
    await expect(items.nth(1)).toBeFocused()
    await page.keyboard.press('End')
    await expect(items.nth(2)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(items.nth(1)).toBeFocused()
    await page.keyboard.press('Home')
    await expect(items.nth(0)).toBeFocused()
  })
})

test.describe('where the panel is drawn', () => {
  test('past an ancestor that clips and is transformed', async ({ page }) => {
    // Radix portals the panel to <body>. The custom element will use the top layer for the same
    // reason, and this is the behaviour both have to show.
    await show(page, { query: { clip: '1' } })
    await open(page)

    const verdict = await page.evaluate(() => {
      const deep = (selector: string, root: Document | ShadowRoot = document): Element | null => {
        const found = root.querySelector(selector)
        if (found) return found
        for (const host of root.querySelectorAll('*')) {
          const inner = host.shadowRoot && deep(selector, host.shadowRoot)
          if (inner) return inner
        }
        return null
      }
      const clip = document.getElementById('clip')!.getBoundingClientRect()
      const panelEl = deep('.herms-inbox__panel')!
      const box = panelEl.getBoundingClientRect()
      // What is topmost at a point, looking into shadow roots: `elementFromPoint` on the document
      // stops at the host.
      let hit: Element | null = document.elementFromPoint(box.left + box.width / 2, box.top + 20)
      while (hit?.shadowRoot) {
        const inner: Element | null = hit.shadowRoot.elementFromPoint(box.left + box.width / 2, box.top + 20)
        if (!inner || inner === hit) break
        hit = inner
      }
      return { extendsPastTheClip: box.bottom > clip.bottom + 40, topmostIsThePanel: !!hit?.closest('.herms-inbox__panel') }
    })

    expect(verdict).toEqual({ extendsPastTheClip: true, topmostIsThePanel: true })
  })

  test('and it stays attached to the bell when the page scrolls', async ({ page }) => {
    // The native popover does not follow its trigger (measured in Chromium), so the element has to
    // reposition itself. This is what it has to match.
    await show(page, { query: { tall: '1' } })
    await open(page)
    const gap = () =>
      page.evaluate(() => {
      const deep = (selector: string, root: Document | ShadowRoot = document): Element | null => {
        const found = root.querySelector(selector)
        if (found) return found
        for (const host of root.querySelectorAll('*')) {
          const inner = host.shadowRoot && deep(selector, host.shadowRoot)
          if (inner) return inner
        }
        return null
      }
        const trigger = deep('.herms-inbox__trigger')!.getBoundingClientRect()
        const panelEl = deep('.herms-inbox__panel')!.getBoundingClientRect()
        return Math.round(panelEl.top - trigger.bottom)
      })
    const before = await gap()

    await page.evaluate(() => window.scrollBy(0, 20))

    await expect.poll(async () => Math.abs((await gap()) - before), { message: 'the panel did not follow the bell' }).toBeLessThanOrEqual(2)
  })
})

test.describe('the notifications', () => {
  test('mark everything read with one request, and keep every row', async ({ page }) => {
    const inbox = await show(page)
    await open(page)

    await page.getByRole('button', { name: 'Mark all as read' }).click()

    await expect(page.locator('.herms-inbox__item[data-unread="true"]')).toHaveCount(0)
    await expect(page.locator('.herms-inbox__item-title').filter({ hasText: /\S/ })).toHaveCount(3)
    expect((await inbox.requests()).filter((request) => request === 'POST /inbox/read-all')).toHaveLength(1)
  })

  test('are marked seen when the panel shows them', async ({ page }) => {
    const inbox = await show(page)
    await open(page)

    await expect.poll(async () => (await inbox.requests()).includes('POST /inbox/seen')).toBe(true)
  })

  test('archive from the row without opening the notification', async ({ page }) => {
    const inbox = await show(page)
    await open(page)

    await page.getByRole('button', { name: 'Archive: Order shipped' }).click()

    await expect(page.getByText('Order shipped')).toHaveCount(0)
    const requests = await inbox.requests()
    expect(requests).toContain('POST /inbox/inb_1/archive')
    expect(requests).not.toContain('POST /inbox/inb_1/read')
  })

  test('mark a read notification unread from the row, without opening it, and stay in the list', async ({ page }) => {
    const inbox = await show(page)
    await open(page)
    const welcome = notifications(page).filter({ hasText: 'Welcome' })
    await expect(welcome).toHaveAttribute('data-unread', 'false')

    await page.getByRole('button', { name: 'Mark as unread: Welcome' }).click()

    // Unread again: the dot is back, and the control, which has nothing left to offer, has left the row.
    await expect(welcome).toHaveAttribute('data-unread', 'true')
    await expect(page.getByRole('button', { name: 'Mark as unread: Welcome' })).toHaveCount(0)
    // Its focus went with it, to the page, unless the component puts it back on the notification.
    await expect(welcome).toBeFocused()
    const requests = await inbox.requests()
    expect(requests).toContain('POST /inbox/inb_3/unread')
    expect(requests).not.toContain('POST /inbox/inb_3/read')
  })

  test('offer the mark-unread control only on a notification that has been read, between it and its archive button', async ({ page }) => {
    await show(page)
    await open(page)

    // Two of the three notifications are unread: they have no such control.
    await expect(page.locator('.herms-inbox__unread-button')).toHaveCount(1)
    const row = page.getByRole('list', { name: 'Notifications' }).getByRole('listitem').filter({ hasText: 'Welcome' })
    expect(await row.locator('button').evaluateAll((buttons) => buttons.map((button) => button.className))).toEqual([
      'herms-inbox__item',
      'herms-inbox__unread-button',
      'herms-inbox__archive-button',
    ])
  })

  test('are named in French when asked', async ({ page }) => {
    await show(page, { query: { locale: 'fr' } })

    await expect(page.getByRole('button', { name: 'Notifications, 2 non lues' })).toBeVisible()
  })
})

test.describe('the archived view', () => {
  const ARCHIVED = [{ id: 'inb_old', title: 'Old receipt', body: 'Filed away.', read_at: '2026-08-01T10:00:00Z', seen_at: '2026-08-01T10:00:00Z' }]
  const archivedList = (page: Page) => page.getByRole('list', { name: 'Archived' })

  test('is not there unless the page asks for it', async ({ page }) => {
    await show(page, { scenario: { archived: ARCHIVED } })
    await open(page)

    await expect(page.getByRole('button', { name: 'Archived' })).toHaveCount(0)
  })

  test('opens from the header with what was archived, has no way to archive again, and comes back', async ({ page }) => {
    await show(page, { query: { archivedView: '1' }, scenario: { archived: ARCHIVED } })
    await open(page)
    // Archived from the feed a moment ago, and what was archived before: both are in the archive.
    await page.getByRole('button', { name: 'Archive: Order shipped' }).click()
    await expect(page.getByText('Order shipped')).toHaveCount(0)

    // From the keyboard: WebKit does not focus a button that is clicked, so a click would say nothing about where the focus goes.
    await page.getByRole('button', { name: 'Archived' }).focus()
    await page.keyboard.press('Enter')

    await expect(archivedList(page)).toBeVisible()
    await expect(archivedList(page).getByRole('listitem')).toHaveCount(2)
    await expect(archivedList(page)).toContainText('Order shipped')
    await expect(archivedList(page)).toContainText('Old receipt')
    // The live feed is not drawn under it, and nothing in the archive can be archived again.
    await expect(page.getByText('Invoice paid')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Archive:/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Mark all as read' })).toBeHidden()
    await expect(page.getByRole('dialog', { name: 'Archived' })).toBeVisible()
    // The control that was pressed is the one that took the person back, and still has the focus.
    await expect(page.getByRole('button', { name: 'Back to notifications' })).toBeFocused()

    await page.getByRole('button', { name: 'Back to notifications' }).click()

    await expect(page.getByText('Invoice paid')).toBeVisible()
    await expect(page.getByText('Old receipt')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Archive: Invoice paid' })).toBeVisible()
  })

  test('puts a notification read in the archive back to unread, and opens on the live feed after it was closed', async ({ page }) => {
    const inbox = await show(page, { query: { archivedView: '1' }, scenario: { archived: ARCHIVED } })
    await open(page)
    await page.getByRole('button', { name: 'Archived' }).click()

    await page.getByRole('button', { name: 'Mark as unread: Old receipt' }).click()

    await expect.poll(async () => (await inbox.requests()).includes('POST /inbox/inb_old/unread')).toBe(true)
    await expect(archivedList(page).locator('.herms-inbox__item').filter({ hasText: 'Old receipt' })).toHaveAttribute('data-unread', 'true')

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await open(page)

    await expect(page.getByRole('button', { name: 'Archived' })).toBeVisible()
    await expect(page.getByText('Old receipt')).toHaveCount(0)
  })

  for (const locale of ['en', 'fr'] as const) {
    test(`keeps its header on one line and inside the panel (${locale}), on the feed and on the archive`, async ({ page }) => {
      await show(page, { query: { archivedView: '1', locale }, scenario: { archived: ARCHIVED } })
      await open(page)
      const toggleName = locale === 'en' ? 'Archived' : 'Archivées'

      const measure = () =>
        page.locator('.herms-inbox__header').evaluate((header) => {
          const frame = header.getBoundingClientRect()
          return {
            overflows: header.scrollWidth > header.clientWidth,
            controls: [...header.querySelectorAll<HTMLElement>('button')]
              .filter((button) => button.offsetParent !== null)
              .map((button) => {
                const box = button.getBoundingClientRect()
                return { label: button.textContent || button.getAttribute('aria-label'), inside: box.left >= frame.left - 0.5 && box.right <= frame.right + 0.5, oneLine: box.height < 40 }
              }),
          }
        })

      const onFeed = await measure()
      expect(onFeed.overflows).toBe(false)
      expect(onFeed.controls.filter((control) => !control.inside || !control.oneLine)).toEqual([])
      expect(onFeed.controls.length).toBe(3)

      await page.getByRole('button', { name: toggleName }).click()

      const onArchive = await measure()
      expect(onArchive.overflows).toBe(false)
      expect(onArchive.controls.filter((control) => !control.inside || !control.oneLine)).toEqual([])
      expect(onArchive.controls.length).toBe(2)
    })
  }
})

test.describe('the links under a notification', () => {
  const LINKS = [
    { label: 'Track order', url: 'https://shop.example.cm/orders/1', style: 'primary' },
    { label: 'Get help', url: 'https://shop.example.cm/help', style: 'default' },
  ]
  const ITEMS_WITH_LINKS = [
    { id: 'inb_1', title: 'Order shipped', body: 'Your order is on its way.', actions: LINKS },
    { id: 'inb_2', title: 'Invoice paid', body: 'Thank you.' },
  ]

  test('are drawn on a line of their own under the notification, inside the panel, with the controls still on its line', async ({ page }) => {
    await show(page, { items: ITEMS_WITH_LINKS })
    await open(page)

    const row = page.getByRole('list', { name: 'Notifications' }).getByRole('listitem').filter({ hasText: 'Order shipped' })
    const boxes = await row.evaluate((element) => {
      const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect()
      const panel = element.closest('.herms-inbox__panel')!.getBoundingClientRect()
      const links = [...element.querySelectorAll('.herms-inbox__action')].map((link) => link.getBoundingClientRect())
      return {
        item: rect('.herms-inbox__item'),
        archive: rect('.herms-inbox__archive-button'),
        group: rect('.herms-inbox__actions'),
        links,
        panel,
      }
    })

    // The archive button stays on the notification's line, beside it and not beneath the links.
    expect(boxes.archive.top).toBeLessThan(boxes.item.bottom)
    // The links start below the notification, and stay inside the panel whatever the width.
    expect(boxes.group.top).toBeGreaterThanOrEqual(boxes.item.bottom - 1)
    expect(boxes.links).toHaveLength(2)
    for (const link of boxes.links) {
      expect(link.left).toBeGreaterThanOrEqual(boxes.panel.left)
      expect(link.right).toBeLessThanOrEqual(boxes.panel.right)
      expect(link.height).toBeGreaterThanOrEqual(24)
    }
    // A notification without links has no group at all.
    await expect(page.locator('.herms-inbox__actions')).toHaveCount(1)
  })

  test('draw the primary link filled and the other one not', async ({ page }) => {
    await show(page, { items: ITEMS_WITH_LINKS })
    await open(page)

    const [primary, normal] = await page.locator('.herms-inbox__action').evaluateAll((links) =>
      links.map((link) => ({ background: getComputedStyle(link).backgroundColor, color: getComputedStyle(link).color })),
    )

    expect(primary!.background).not.toBe(normal!.background)
    expect(primary!.background).not.toBe('rgba(0, 0, 0, 0)')
    expect(normal!.background).toBe('rgba(0, 0, 0, 0)')
  })

  test('open in a new tab that cannot reach back, and read the notification', async ({ page, context }) => {
    await context.route('https://shop.example.cm/**', (route) => route.fulfill({ contentType: 'text/html', body: '<p>the shop</p>' }))
    const inbox = await show(page, { items: ITEMS_WITH_LINKS })
    await open(page)
    await expect(notifications(page).filter({ hasText: 'Order shipped' })).toHaveAttribute('data-unread', 'true')

    const popupPromise = page.waitForEvent('popup')
    await page.getByRole('link', { name: 'Track order' }).click()
    const popup = await popupPromise

    await popup.waitForLoadState()
    expect(popup.url()).toBe('https://shop.example.cm/orders/1')
    // `rel="noopener"`: the page that opened it is not reachable from it.
    expect(await popup.evaluate(() => window.opener)).toBeNull()
    // Opening a link reads the notification, as opening the notification does.
    await expect.poll(async () => (await inbox.requests()).includes('POST /inbox/inb_1/read')).toBe(true)
    await expect(notifications(page).filter({ hasText: 'Order shipped' })).toHaveAttribute('data-unread', 'false')
  })

  test('are named in French when asked', async ({ page }) => {
    await show(page, { query: { locale: 'fr' }, items: ITEMS_WITH_LINKS })
    await open(page)

    await expect(page.getByRole('group', { name: 'Liens: Order shipped' })).toBeVisible()
  })
})

test.describe('in real time', () => {
  test('opens a stream that authenticates through its URL, and shows what is pushed', async ({ page }) => {
    // `EventSource` cannot send headers, so the credentials travel in the query string. The mock
    // server refuses the stream without them, which is how an engine that dropped them is caught.
    const inbox = await show(page)
    await expect.poll(inbox.streamsOpen).toBe(1)
    await expect(bell(page)).toHaveAccessibleName('Notifications, 2 unread')

    await page.request.post(`/__emit?tenant=${inbox.tenant}`, { data: { name: 'item.created', data: { title: 'Pushed live' } } })

    await expect(bell(page)).toHaveAccessibleName('Notifications, 3 unread')
    await open(page)
    await expect(page.getByText('Pushed live')).toBeVisible()
  })
})

test.describe('when the server answers with the wrong thing', () => {
  test('a read answered with another call\'s shape does not empty the row', async ({ page }) => {
    // The incident. The server answered POST /inbox/{id}/read with { "updated": 0 }, and the
    // SDK drew an empty row with only its archive button.
    const inbox = await show(page, { scenario: { faultyRead: true } })
    await open(page)

    await notifications(page).first().click()
    await expect.poll(async () => (await inbox.requests()).includes('POST /inbox/inb_1/read')).toBe(true)

    await expect(page.locator('.herms-inbox__item-title').filter({ hasText: /\S/ })).toHaveCount(3)
    await expect(page.getByText('Order shipped')).toBeVisible()
  })

  test('the refusal reaches the host, and is not an unhandled rejection', async ({ page, flavor }) => {
    test.skip(flavor === 'element', 'The element reports it as a hermes-error event: see element.spec.ts.')
    // The component used to call `void markRead(...)`, so a failed action was a rejection nobody could handle and the host
    // never heard of it. It now goes to `onError`, which the page records.
    const inbox = await show(page, { scenario: { faultyRead: true } })
    await open(page)

    await notifications(page).first().click()
    await expect.poll(async () => (await inbox.requests()).includes('POST /inbox/inb_1/read')).toBe(true)

    await expect.poll(() => page.evaluate(() => (window as unknown as { reported: string[] }).reported)).toContain('unexpected_response')
    expect(await page.evaluate(() => (window as unknown as { rejections: string[] }).rejections)).toEqual([])
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})
