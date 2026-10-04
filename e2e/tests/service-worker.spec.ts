import { expect, test, type Page, type Worker } from '@playwright/test'

/**
 * The service worker script, loaded the way its README says (`importScripts` of the built file),
 * in a real service worker.
 *
 * The unit tests drive the handlers through a fake scope, which proves the logic and cannot prove
 * that the shipped script installs listeners a browser will call, or that it reads what a real
 * `PushMessageData` gives it (`json()` throws on text, for one). A push is delivered by
 * dispatching a real `PushEvent` inside the worker, since a real push service is not available.
 *
 * **Chromium only, and `showNotification` is recorded rather than shown.** Playwright exposes
 * service workers in Chromium alone, and Chromium's permission for a worker's own registration is
 * not the one `grantPermissions` sets, so a real `showNotification` is refused. What is checked is
 * what the script asks the browser to show. Opening a window from a click needs user activation
 * and cannot be dispatched, so the click handler is covered by the unit tests alone.
 */

interface WorkerGlobals {
  PushEvent: new (type: string, init: { data: string }) => Event & { waitUntil: (promise: Promise<unknown>) => void }
  registration: { showNotification: (title: string, options?: unknown) => Promise<void> }
  dispatchEvent(event: Event): boolean
}

test.skip(({ browserName }) => browserName !== 'chromium', 'Playwright exposes service workers in Chromium only')

async function registerWorker(page: Page): Promise<Worker> {
  await page.goto('/pages/service-worker.html')
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/pages/push-sw.js')
    await navigator.serviceWorker.ready
  })
  const matches = (candidate: Worker) => candidate.url().endsWith('/pages/push-sw.js')
  return page.context().serviceWorkers().find(matches) ?? page.context().waitForEvent('serviceworker', { predicate: matches })
}

/** Delivers a push with this payload and returns what the script asked the browser to show. */
async function push(worker: Worker, payload: string | null): Promise<{ title: string; options: Record<string, unknown> }[]> {
  return worker.evaluate(async (data) => {
    const scope = self as unknown as WorkerGlobals
    const asked: { title: string; options: Record<string, unknown> }[] = []
    scope.registration.showNotification = async (title, options) => void asked.push({ title, options: (options ?? {}) as Record<string, unknown> })
    let pending: Promise<unknown> = Promise.resolve()
    const event = data === null ? new scope.PushEvent('push', {} as { data: string }) : new scope.PushEvent('push', { data })
    // The handler hands its work to `waitUntil`; holding what it passes is how this knows it is done.
    event.waitUntil = (promise: Promise<unknown>) => void (pending = promise)
    scope.dispatchEvent(event)
    await pending
    return asked
  }, payload)
}

test('the script installs its handlers, and a push becomes the notification Hermesi described', async ({ page }) => {
  const worker = await registerWorker(page)

  const asked = await push(worker, JSON.stringify({ title: 'Shipped', body: 'Tomorrow', image: 'https://cdn.example.test/a.png', url: '/orders/1', data: { order: '1' } }))

  expect(asked).toEqual([
    {
      title: 'Shipped',
      options: { body: 'Tomorrow', image: 'https://cdn.example.test/a.png', icon: '/pages/icon.png', data: { order: '1', url: '/orders/1' } },
    },
  ])
})

test('a push that is not JSON still shows something, under the site’s fallback title', async ({ page }) => {
  const worker = await registerWorker(page)

  const asked = await push(worker, 'hello from a console')

  expect(asked).toEqual([{ title: 'Acme', options: { body: 'hello from a console', icon: '/pages/icon.png', data: {} } }])
})

test('a push with no payload at all still shows the fallback, not nothing', async ({ page }) => {
  const worker = await registerWorker(page)

  const asked = await push(worker, null)

  expect(asked).toEqual([{ title: 'Acme', options: { icon: '/pages/icon.png', data: {} } }])
})
