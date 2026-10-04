import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { open, show } from './helpers'

/**
 * Automated accessibility checks on the open panel, by axe-core. This is not a substitute for a person with a screen reader
 * (axe finds what can be found from the markup: roles, names, structure, contrast), but it is an objective measure of the
 * structure, and it is what decided that the notification list is a plain list of buttons and not an ARIA menu.
 */

// The test pages are bare fixtures with no landmarks or heading of their own, so the page-level rules are not what is under
// test; everything about the widget is.
const PAGE_LEVEL_RULES = ['landmark-one-main', 'page-has-heading-one', 'region']

// axe-core brings its own copy of Playwright's types, which differ from the one the tests run on by a patch version.
const scan = (page: Page) =>
  new AxeBuilder({ page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page'] })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .disableRules(PAGE_LEVEL_RULES)
    .analyze()

test('the open panel has no automatically detectable accessibility violations', async ({ page }) => {
  await show(page)
  await open(page)

  const results = await scan(page)

  expect(results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`)).toEqual([])
})

test('the closed bell has none either', async ({ page }) => {
  await show(page)

  const results = await scan(page)

  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
})

test('in forced colours the badge and the unread dot are still there, for React as for the element', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit matches the media query but leaves the colours alone, so there is nothing to measure: CanvasText resolves to black beside text that is still the page colour.')
  // Windows high contrast replaces every colour with the user's own. The badge and the unread dot are colour alone, so without
  // a rule they vanish. The rules are in the shared stylesheet, which both implementations ship.
  await page.emulateMedia({ forcedColors: 'active' })
  await show(page)

  const badge = page.locator('.herms-inbox__badge')
  await expect(badge).toBeVisible()
  expect(await badge.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('1px')

  await open(page)
  const dot = await page.locator('.herms-inbox__item[data-unread="true"] .herms-inbox__item-title').first().evaluate((element) => ({
    dot: getComputedStyle(element, '::before').backgroundColor,
    text: getComputedStyle(element).color,
  }))
  // The dot is drawn in the same colour as the text: the user's, not transparent and not a brand colour.
  expect(dot.dot).toBe(dot.text)
})
