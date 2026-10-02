import { randomUUID } from 'node:crypto'
import { type Locator, type Page } from '@playwright/test'
import { expect, flavorOf } from './fixtures'

export const ITEMS = [
  { id: 'inb_1', title: 'Order shipped', body: 'Your order is on its way.' },
  { id: 'inb_2', title: 'Invoice paid', body: 'Thank you.' },
  { id: 'inb_3', title: 'Welcome', body: 'Glad to have you.', read_at: '2026-09-01T10:00:00Z', seen_at: '2026-09-01T10:00:00Z' },
]

export interface Opened {
  tenant: string
  /** Lets through a list held by the `holdList` scenario. */
  release: () => Promise<void>
  requests: () => Promise<string[]>
  streamsOpen: () => Promise<number>
}

/** One isolated inbox on the mock server, and the page showing it. */
export async function show(page: Page, options: { query?: Record<string, string>; scenario?: Record<string, unknown>; items?: unknown[] } = {}): Promise<Opened> {
  const tenant = randomUUID()
  const reset = await page.request.post(`/__reset?tenant=${tenant}`, { data: { items: options.items ?? ITEMS, ...options.scenario } })
  expect(reset.ok()).toBe(true)
  await page.goto(`/pages/${flavorOf(page)}-inbox.html?${new URLSearchParams({ tenant, ...options.query })}`)
  return {
    tenant,
    release: async () => void (await page.request.post(`/__release?tenant=${tenant}`)),
    requests: async () => (await page.request.get(`/__requests?tenant=${tenant}`)).json(),
    streamsOpen: async () => ((await (await page.request.get(`/__streams?tenant=${tenant}`)).json()) as { open: number }).open,
  }
}

export const bell = (page: Page): Locator => page.getByRole('button', { name: /Notifications|non lues/ })
export const panel = (page: Page): Locator => page.getByRole('dialog', { name: 'Notifications' })

export async function open(page: Page): Promise<void> {
  await bell(page).click()
  await expect(panel(page)).toBeVisible()
}

/** Computed style of the panel: what is actually drawn, not what a stylesheet says. */
export function drawn(target: Locator) {
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
