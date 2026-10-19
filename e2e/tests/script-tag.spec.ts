import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures'
import { ITEMS, bell, drawn, notifications, open, panel } from './helpers'

/**
 * The `<script>`-tag build, loaded the way its README says: one classic script, no bundler, the
 * tag already in the markup and configured before the script runs. This is the file a CDN serves,
 * so it is tested as the file, not as the module the other cases use.
 */

async function load(page: import('@playwright/test').Page, items: unknown[] = ITEMS): Promise<string> {
  const tenant = randomUUID()
  expect((await page.request.post(`/__reset?tenant=${tenant}`, { data: { items } })).ok()).toBe(true)
  await page.goto(`/pages/script-tag.html?tenant=${tenant}`)
  return tenant
}

test('upgrades a tag that was in the markup, configured before the script ran', async ({ page }) => {
  await load(page)

  await expect(bell(page)).toBeEnabled()
  await expect(bell(page)).toHaveAccessibleName('Notifications, 2 unread')
})

test('opens, lists the notifications and focuses the first', async ({ page }) => {
  await load(page)

  await open(page)

  await expect(panel(page)).toBeVisible()
  await expect(notifications(page)).toHaveCount(3)
  await expect(notifications(page).first()).toBeFocused()
})

test('is drawn with its styling: the stylesheet is inside the script', async ({ page }) => {
  // The script is one file with no stylesheet next to it. A build that left the CSS out would still run, list and focus, and
  // draw an unstyled panel (0.6.0 shipped like that), so this measures what is drawn, as the styling tests do for the module.
  await page.emulateMedia({ colorScheme: 'light' })
  await load(page)
  await open(page)

  expect(await drawn(panel(page))).toMatchObject({
    background: 'rgb(255, 255, 255)',
    borderWidth: '1px',
    borderStyle: 'solid',
    radius: '10px',
    boxSizing: 'border-box',
    width: 380,
  })
})

test('exposes defineHermesInbox for another tag name, and registers the default itself', async ({ page }) => {
  const tenant = await load(page)

  const result = await page.evaluate((tenantId) => {
    const api = (window as unknown as { HermesInbox: { defineHermesInbox: (tag: string) => void; HermesInboxElement: unknown } }).HermesInbox
    api.defineHermesInbox('x-notifications')
    const other = document.createElement('x-notifications')
    other.setAttribute('public-key', 'hm_pk_e2e')
    other.setAttribute('api-base-url', `${location.origin}/t/${tenantId}/v1/client`)
    ;(other as unknown as { getSubscriberToken: () => string }).getSubscriberToken = () => 'st_e2e'
    document.body.append(other)
    return {
      defaultDefined: !!customElements.get('hermes-inbox'),
      otherDefined: !!customElements.get('x-notifications'),
      otherHasShadow: !!other.shadowRoot,
      exposesClass: typeof api.HermesInboxElement === 'function',
    }
  }, tenant)

  expect(result).toEqual({ defaultDefined: true, otherDefined: true, otherHasShadow: true, exposesClass: true })
})

test('loading it twice is not an error', async ({ page }) => {
  await load(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.addScriptTag({ url: '/dist/hermes-inbox.global.js' })

  expect(errors).toEqual([])
  await expect(bell(page)).toBeEnabled()
})
