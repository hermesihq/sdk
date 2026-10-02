import { test as base, type Page } from '@playwright/test'

/**
 * The two implementations of the inbox, which have to behave the same: `<HermsInbox />` from
 * `@hermesihq/react` and `<hermes-inbox>` from `@hermesihq/element`. `inbox.spec.ts` is written
 * once and runs against both, in every engine, so a behaviour is either asserted for both or
 * named here as belonging to one.
 */
export type Flavor = 'react' | 'element'

const flavors = new WeakMap<Page, Flavor>()

/** Which implementation the page under test is. */
export function flavorOf(page: Page): Flavor {
  const flavor = flavors.get(page)
  if (!flavor) throw new Error('the page was not opened through the fixtures')
  return flavor
}

export const test = base.extend<{ flavor: Flavor }>({
  flavor: ['react', { option: true }],
  page: async ({ page, flavor }, use) => {
    flavors.set(page, flavor)
    await use(page)
  },
})

export { expect } from '@playwright/test'
