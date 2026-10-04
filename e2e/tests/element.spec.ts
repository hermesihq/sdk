import { expect, test } from './fixtures'
import { bell, drawn, notifications, open, panel, show } from './helpers'

/**
 * What belongs to `<hermes-inbox>` alone. Everything the two implementations share is in
 * `inbox.spec.ts` and runs against both; this file is the part the platform makes different:
 * a shadow root, a native popover that has to be placed by script, configuration that arrives
 * in any order, and events instead of props.
 */

test.describe('placed beside the bell', () => {
  test('under it, with the end edges lined up, by default', async ({ page }) => {
    await show(page)
    await open(page)

    const { gap, endEdgeOffset } = await page.evaluate(() => {
      const inbox = (window as unknown as { inbox: HTMLElement }).inbox
      const trigger = inbox.shadowRoot!.querySelector('.herms-inbox__trigger')!.getBoundingClientRect()
      const box = inbox.shadowRoot!.querySelector('.herms-inbox__panel')!.getBoundingClientRect()
      return { gap: box.top - trigger.bottom, endEdgeOffset: box.right - trigger.right }
    })

    // 8px below, and the panel's right edge on the bell's (the page is left-to-right). The bell is
    // near the left of the page, so the panel is clamped to the margin rather than lined up; the
    // gap is the part that must hold.
    expect(Math.round(gap)).toBe(8)
    expect(endEdgeOffset).toBeGreaterThanOrEqual(-1)
  })

  test('above it for top-*', async ({ page }) => {
    await show(page, { query: { placement: 'top-start', tall: '1' } })
    await page.evaluate(() => window.scrollTo(0, 400))
    await page.evaluate(() => {
      // Bring the bell down the page so there is room above it.
      const root = document.getElementById('root')!
      root.style.marginTop = '500px'
    })
    await open(page)

    const verdict = await page.evaluate(() => {
      const inbox = (window as unknown as { inbox: HTMLElement }).inbox
      const trigger = inbox.shadowRoot!.querySelector('.herms-inbox__trigger')!.getBoundingClientRect()
      const box = inbox.shadowRoot!.querySelector('.herms-inbox__panel')!.getBoundingClientRect()
      return { panelBottom: box.bottom, bellTop: trigger.top }
    })

    expect(Math.round(verdict.bellTop - verdict.panelBottom)).toBe(8)
  })

  test('flipped above when there is no room under it', async ({ page }) => {
    await show(page, { query: { tall: '1' } })
    // Put the bell near the bottom of a short viewport.
    await page.setViewportSize({ width: 800, height: 420 })
    await page.evaluate(() => {
      document.getElementById('root')!.style.marginTop = '330px'
    })
    await open(page)

    const side = await page.evaluate(() => (window as unknown as { inbox: HTMLElement }).inbox.shadowRoot!.querySelector<HTMLElement>('.herms-inbox__panel')!.dataset.side)

    expect(side).toBe('top')
  })

  test('mirrored in a right-to-left page', async ({ page }) => {
    await show(page, { query: { dir: 'rtl' } })
    await page.setViewportSize({ width: 1000, height: 700 })
    await page.evaluate(() => {
      // The bell in the middle of the page, where neither edge clamps the panel.
      document.getElementById('root')!.style.margin = '0 500px'
    })
    await open(page)

    const { startOffset } = await page.evaluate(() => {
      const inbox = (window as unknown as { inbox: HTMLElement }).inbox
      const trigger = inbox.shadowRoot!.querySelector('.herms-inbox__trigger')!.getBoundingClientRect()
      const box = inbox.shadowRoot!.querySelector('.herms-inbox__panel')!.getBoundingClientRect()
      return { startOffset: box.left - trigger.left }
    })

    // "End" is the left in right-to-left text: the panel's left edge on the bell's left edge.
    expect(Math.abs(startOffset)).toBeLessThanOrEqual(1)
  })

  test('kept inside a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 340, height: 700 })
    await show(page)
    await open(page)

    const box = (await panel(page).boundingBox())!

    expect(box.x).toBeGreaterThanOrEqual(8 - 1)
    expect(box.x + box.width).toBeLessThanOrEqual(340 - 8 + 1)
  })
})

test.describe('themed from outside', () => {
  test('through the element and its ancestors, in light and dark', async ({ page }) => {
    // The documented way: a variable on the element itself, which inherits into the shadow root.
    await show(page, { query: { accent: 'rgb(9, 8, 7)' } })
    await open(page)

    expect(await drawn(panel(page))).toMatchObject({ accent: 'rgb(9, 8, 7)' })
  })

  test('through ::part, for the four parts it exposes', async ({ page }) => {
    await show(page)
    await page.addStyleTag({
      content: `
        hermes-inbox::part(panel) { border-color: rgb(1, 2, 3); }
        hermes-inbox::part(badge) { background: rgb(4, 5, 6); }
        hermes-inbox::part(trigger) { color: rgb(7, 8, 9); }
        hermes-inbox::part(item) { color: rgb(10, 11, 12); }
      `,
    })
    await open(page)

    const colours = await page.evaluate(() => {
      const root = (window as unknown as { inbox: HTMLElement }).inbox.shadowRoot!
      const of = (selector: string, property: 'borderTopColor' | 'backgroundColor' | 'color') => getComputedStyle(root.querySelector(selector)!)[property]
      return [of('.herms-inbox__panel', 'borderTopColor'), of('.herms-inbox__badge', 'backgroundColor'), of('.herms-inbox__trigger', 'color'), of('.herms-inbox__item', 'color')]
    })

    expect(colours).toEqual(['rgb(1, 2, 3)', 'rgb(4, 5, 6)', 'rgb(7, 8, 9)', 'rgb(10, 11, 12)'])
  })

  test('and the page\'s own CSS cannot break it', async ({ page }) => {
    await show(page)
    // The kind of rule a host stylesheet has: it reaches every button, paragraph and box in the
    // light DOM, and none of the shadow root.
    await page.addStyleTag({ content: 'button { display: none !important; } p { display: none !important; } * { box-sizing: content-box !important; padding: 20px !important; }' })
    await open(page)

    await expect(bell(page)).toBeVisible()
    expect(await drawn(panel(page))).toMatchObject({ boxSizing: 'border-box', width: 380 })
    await expect(page.getByRole('heading').or(page.locator('.herms-inbox__title'))).toBeVisible()
  })
})

test.describe('configured by the page', () => {
  test('in any order, and not before it is complete', async ({ page }) => {
    const inbox = await show(page, { query: { manual: '1' } })
    const set = (fn: () => void) => page.evaluate(fn)

    await expect(bell(page)).toBeDisabled()
    await set(() => {
      ;(window as unknown as { inbox: HTMLElement }).inbox.setAttribute('api-base-url', `${location.origin}/t/${new URLSearchParams(location.search).get('tenant')}/v1/client`)
    })
    await set(() => {
      ;(window as unknown as { inbox: { getSubscriberToken: () => string } }).inbox.getSubscriberToken = () => 'st_e2e'
    })
    // Two of three: still waiting, and not a single request made.
    await expect(bell(page)).toBeDisabled()
    expect(await inbox.requests()).toEqual([])

    await set(() => {
      ;(window as unknown as { inbox: HTMLElement }).inbox.setAttribute('public-key', 'hm_pk_e2e')
    })

    await expect(bell(page)).toBeEnabled()
    await expect(bell(page)).toHaveAccessibleName('Notifications, 2 unread')
  })

  test('without fetching again when the node is moved in the page', async ({ page }) => {
    const inbox = await show(page)
    await expect(bell(page)).toHaveAccessibleName('Notifications, 2 unread')
    const reads = async () => (await inbox.requests()).filter((request) => request === 'GET /inbox').length
    expect(await reads()).toBe(1)

    await page.evaluate(() => {
      const target = document.createElement('div')
      document.body.append(target)
      target.append((window as unknown as { inbox: HTMLElement }).inbox)
    })
    await page.waitForTimeout(300)

    expect(await reads()).toBe(1)
    expect(await inbox.streamsOpen()).toBe(1)
    await expect(bell(page)).toBeEnabled()
  })

  test('and closes its connection when it is taken out of the page', async ({ page }) => {
    const inbox = await show(page)
    await expect.poll(inbox.streamsOpen).toBe(1)

    await page.evaluate(() => (window as unknown as { inbox: HTMLElement }).inbox.remove())

    await expect.poll(inbox.streamsOpen).toBe(0)
  })
})

test.describe('events and methods', () => {
  test('say when it opens and closes', async ({ page }) => {
    await show(page)

    await open(page)
    await page.keyboard.press('Escape')
    await expect(panel(page)).toBeHidden()

    // `toggle` is queued as a task after the panel is hidden, so the event can trail the panel
    // disappearing by a moment.
    await expect.poll(() => page.evaluate(() => (window as unknown as { events: string[] }).events)).toEqual(['hermes-open', 'hermes-close'])
  })

  test('open(), close() and isOpen', async ({ page }) => {
    await show(page)
    await expect(bell(page)).toHaveAccessibleName('Notifications, 2 unread')

    await page.evaluate(() => (window as unknown as { inbox: { open: () => void } }).inbox.open())
    await expect(panel(page)).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { inbox: { isOpen: boolean } }).inbox.isOpen)).toBe(true)

    await page.evaluate(() => (window as unknown as { inbox: { close: () => void } }).inbox.close())
    await expect(panel(page)).toBeHidden()
    expect(await page.evaluate(() => (window as unknown as { inbox: { isOpen: boolean } }).inbox.isOpen)).toBe(false)
  })

  test('hermes-item-click navigates when nobody cancels it', async ({ page }) => {
    await show(page, { items: [{ id: 'inb_1', title: 'Go', action_url: '/__health' }] })
    await open(page)

    await Promise.all([page.waitForURL('**/__health'), notifications(page).filter({ hasText: /Go/ }).click()])
  })

  test('hermes-item-click is the host\'s to cancel, and then the element stays where it is', async ({ page }) => {
    const inbox = await show(page, { query: { prevent: '1' }, items: [{ id: 'inb_1', title: 'Go', action_url: '/__health' }] })
    await open(page)

    await notifications(page).filter({ hasText: /Go/ }).click()

    await expect.poll(async () => (await inbox.requests()).includes('POST /inbox/inb_1/read')).toBe(true)
    expect(page.url()).toContain('/pages/element-inbox.html')
    expect(await page.evaluate(() => (window as unknown as { events: string[] }).events)).toContain('hermes-item-click')
  })

  test('a refusal from the server is a hermes-error event, with nothing left unhandled', async ({ page }) => {
    // The same incident the React component's KNOWN GAP case documents: the read answered with
    // another call's shape. Here it is reported, and no promise is left rejecting on its own.
    const inbox = await show(page, { scenario: { faultyRead: true } })
    await page.evaluate(() => {
      ;(window as unknown as { rejections: string[] }).rejections = []
      window.addEventListener('unhandledrejection', (event) => (window as unknown as { rejections: string[] }).rejections.push(String(event.reason)))
    })
    await open(page)

    await notifications(page).first().click()
    await expect.poll(async () => (await inbox.requests()).includes('POST /inbox/inb_1/read')).toBe(true)

    await expect.poll(() => page.evaluate(() => (window as unknown as { events: string[] }).events)).toContain('hermes-error')
    expect(await page.evaluate(() => (window as unknown as { rejections: string[] }).rejections)).toEqual([])
    await expect(page.getByText('Order shipped')).toBeVisible()
  })
})
