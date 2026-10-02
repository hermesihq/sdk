import { randomUUID } from 'node:crypto'
import { expect, test } from './fixtures'
import { ITEMS, bell, open, panel } from './helpers'

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
  await expect(page.getByRole('menuitem')).toHaveCount(3)
  await expect(page.getByRole('menuitem').first()).toBeFocused()
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
