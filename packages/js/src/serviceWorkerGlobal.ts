/**
 * The entry for the script build (`dist/service-worker.global.js`), the one a service worker
 * loads with `importScripts` when there is no bundler. Running it installs the push handlers on
 * the worker it runs in; the names are also on the `HermesiServiceWorker` global for anyone who
 * wants to call them with options.
 *
 * It does nothing outside a service worker, so loading it on a page or a server is harmless.
 */
import { installHermesiPush, notificationFor, parsePushPayload, resolveClickTarget } from './serviceWorker'
import type { HermesiPushOptions, ServiceWorkerScopeLike } from './serviceWorker'

const scope = globalThis as unknown as Partial<ServiceWorkerScopeLike> & { HERMESI_PUSH_OPTIONS?: HermesiPushOptions }

if (typeof scope.addEventListener === 'function' && scope.registration && scope.clients) {
  installHermesiPush(scope as ServiceWorkerScopeLike, scope.HERMESI_PUSH_OPTIONS)
}

export { installHermesiPush, notificationFor, parsePushPayload, resolveClickTarget }
