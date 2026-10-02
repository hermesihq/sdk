import { expect, test, type Page } from '@playwright/test'

/**
 * What the platform does, measured, in each engine.
 *
 * The custom element is built on the native Popover API inside a shadow root. The design note
 * records what that does in Chromium; these cases are those records made executable, so that
 * "does it work in Firefox and Safari" is an answer and not a belief. They test the browser, not
 * our code: when one fails, the element's design is what has to change, not the test.
 *
 * Each also pins what the platform does NOT do (return focus, follow a scroll, close when focus
 * leaves), because those are the three behaviours the element has to supply itself.
 */

async function probe(page: Page) {
  await page.goto('/pages/platform.html')
  // `locator()` pierces open shadow roots.
  const bell = page.locator('#bell')
  const panel = page.locator('#panel')
  const isOpen = () => panel.evaluate((element) => element.matches(':popover-open'))
  return { bell, panel, isOpen }
}

test('the Popover API exists in a shadow root', async ({ page }) => {
  const { bell, isOpen } = await probe(page)
  await bell.click()
  expect(await isOpen()).toBe(true)
})

test('an open popover is not clipped by an ancestor with overflow hidden', async ({ page }) => {
  const { bell, panel } = await probe(page)
  await bell.click()
  // The host sits in a 200x60 box that clips everything. The panel is 300x120, so if it were
  // clipped, its far corner would hit-test as the page behind it.
  const box = (await panel.boundingBox())!
  expect(box.width).toBeGreaterThan(250)
  const hit = await page.evaluate(({ x, y }) => {
    const root = document.getElementById('host')!.shadowRoot!
    return root.elementFromPoint(x, y)?.id ?? null
  }, { x: box.x + box.width - 10, y: box.y + box.height - 10 })
  expect(hit).toBe('panel')
})

test('Escape closes it', async ({ page }) => {
  const { bell, isOpen } = await probe(page)
  await bell.click()
  await page.keyboard.press('Escape')
  expect(await isOpen()).toBe(false)
})

test('a click outside closes it', async ({ page }) => {
  const { bell, isOpen } = await probe(page)
  await bell.click()
  await page.locator('#outside').click()
  expect(await isOpen()).toBe(false)
})

test('focus after it closes: Firefox restores it to the bell, Chromium and WebKit leave it nowhere', async ({ page, browserName }) => {
  const { bell, isOpen } = await probe(page)
  await bell.click()
  await page.locator('#inside').focus()
  await page.keyboard.press('Escape')
  expect(await isOpen()).toBe(false)

  const active = await page.evaluate(() => document.getElementById('host')!.shadowRoot!.activeElement?.id ?? null)
  // The engines disagree, which is why the element returns the focus itself rather than relying
  // on it: where the platform already does, the element's call is a harmless repeat.
  if (browserName === 'firefox') expect(active).toBe('bell')
  else expect(active).toBeNull()
})

test('the platform does not move it when the page scrolls', async ({ page }) => {
  const { bell, panel } = await probe(page)
  await bell.click()
  const before = (await panel.boundingBox())!
  await page.mouse.wheel(0, 300)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  const after = (await panel.boundingBox())!
  // The bell scrolled away with the page; the panel stayed where it was drawn.
  expect(after.y).toBe(before.y)
})

test('the platform does not close it when focus moves elsewhere by keyboard', async ({ page }) => {
  const { bell, isOpen } = await probe(page)
  await bell.click()
  await page.locator('#inside').focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  // Focus has left the panel and the page's tab order has moved on; the panel is still open.
  expect(await isOpen()).toBe(true)
})
