import { randomUUID } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'

/**
 * `<HermsInbox />` as published, in a real engine.
 *
 * The unit tests run in jsdom, which has no layout, no cascade and no real focus model, so they
 * cannot see most of what a person sees. Two defects shipped because of that: a panel with no
 * styling (every colour variable was defined on a parent the panel is not inside), and a
 * notification replaced by an empty row. Both are one assertion here.
 *
 * These cases are also the reference behaviour for the custom element. Where React does something
 * the element has to do too, this is where it is written down.
 */

const ITEMS = [
  { id: 'inb_1', title: 'Order shipped', body: 'Your order is on its way.' },
  { id: 'inb_2', title: 'Invoice paid', body: 'Thank you.' },
  { id: 'inb_3', title: 'Welcome', body: 'Glad to have you.', read_at: '2026-09-01T10:00:00Z', seen_at: '2026-09-01T10:00:00Z' },
]

interface Opened {
  tenant: string
  requests: () => Promise<string[]>
  streamsOpen: () => Promise<number>
}

/** One isolated inbox on the mock server, and the page showing it. */
async function show(page: Page, options: { query?: Record<string, string>; scenario?: Record<string, unknown>; items?: unknown[] } = {}): Promise<Opened> {
  const tenant = randomUUID()
  const reset = await page.request.post(`/__reset?tenant=${tenant}`, { data: { items: options.items ?? ITEMS, ...options.scenario } })
  expect(reset.ok()).toBe(true)
  await page.goto(`/pages/react-inbox.html?${new URLSearchParams({ tenant, ...options.query })}`)
  return {
    tenant,
    requests: async () => (await page.request.get(`/__requests?tenant=${tenant}`)).json(),
    streamsOpen: async () => ((await (await page.request.get(`/__streams?tenant=${tenant}`)).json()) as { open: number }).open,
  }
}

const bell = (page: Page): Locator => page.getByRole('button', { name: /Notifications|non lues/ })
const panel = (page: Page): Locator => page.getByRole('dialog', { name: 'Notifications' })

async function open(page: Page): Promise<void> {
  await bell(page).click()
  await expect(panel(page)).toBeVisible()
}

/** Computed style of the panel: what is actually drawn, not what a stylesheet says. */
function drawn(target: Locator) {
  return target.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      color: style.color,
      borderWidth: style.borderTopWidth,
      borderStyle: style.borderTopStyle,
      borderColor: style.borderTopColor,
      radius: style.borderTopLeftRadius,
      boxSizing: style.boxSizing,
      width: Math.round(element.getBoundingClientRect().width),
      accent: style.getPropertyValue('--herms-color-accent').trim(),
    }
  })
}

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

  test('and the host class reaches it, so one rule themes the bell and the panel', async ({ page }) => {
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

    await expect(page.getByRole('menuitem').first()).toBeFocused()
  })

  test('puts the focus on the first notification when the list arrives after the panel opened', async ({ page }) => {
    // The bell can be opened before the first page of notifications has loaded: on a slow
    // connection, or by a keyboard user who is quick. Opening decides where focus goes, and
    // at that moment there is no notification to choose, so focus lands on the first control
    // in the panel (Close). Nothing moved it afterwards. The earlier case above only passed
    // when the list happened to win the race, which on a loaded CI machine it did not.
    await show(page, { scenario: { latencyMs: 2500 } })
    await open(page)
    // The setup this case exists for: opened, and nothing to focus yet. Without this a fast
    // engine could win the race and the case would pass while testing nothing (WebKit did).
    await expect(page.getByRole('menuitem')).toHaveCount(0)
    await expect(page.getByRole('menuitem').first()).toBeVisible()

    await expect(page.getByRole('menuitem').first()).toBeFocused()
  })

  test('does not take the focus back from somewhere the person moved it', async ({ page }) => {
    // The other side of the rule above: it applies only while focus is still where opening
    // left it. A person who has already gone elsewhere in the panel is not interrupted.
    await show(page, { scenario: { latencyMs: 2500 } })
    await open(page)
    const close = page.getByRole('button', { name: 'Close' })
    await close.focus()
    await expect(page.getByRole('menuitem')).toHaveCount(0)
    await expect(page.getByRole('menuitem').first()).toBeVisible()

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
    const items = page.getByRole('menuitem')

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
      const clip = document.getElementById('clip')!.getBoundingClientRect()
      const panelEl = document.querySelector('.herms-inbox__panel')!
      const box = panelEl.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 20)
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
        const trigger = document.querySelector('.herms-inbox__trigger')!.getBoundingClientRect()
        const panelEl = document.querySelector('.herms-inbox__panel')!.getBoundingClientRect()
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

  test('are named in French when asked', async ({ page }) => {
    await show(page, { query: { locale: 'fr' } })

    await expect(page.getByRole('button', { name: 'Notifications, 2 non lues' })).toBeVisible()
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

    await page.getByRole('menuitem').first().click()
    await expect.poll(async () => (await inbox.requests()).includes('POST /inbox/inb_1/read')).toBe(true)

    await expect(page.locator('.herms-inbox__item-title').filter({ hasText: /\S/ })).toHaveCount(3)
    await expect(page.getByText('Order shipped')).toBeVisible()
  })

  test('KNOWN GAP: the refusal is an unhandled rejection, with nothing shown to the person', async ({ page }) => {
    // Documents what happens today, so that fixing it is a visible change rather than an accident.
    // The component calls `void markRead(...)`, so any failed mutation is a rejection nobody
    // handles. When the component reports a failure, this test should be rewritten, not deleted.
    const inbox = await show(page, { scenario: { faultyRead: true } })
    await open(page)

    await page.getByRole('menuitem').first().click()
    await expect.poll(async () => (await inbox.requests()).includes('POST /inbox/inb_1/read')).toBe(true)

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { rejections: string[] }).rejections))
      .toContain('unexpected_response')
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})
