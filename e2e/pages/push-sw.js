// A service worker the way the README says to write one when there is no build step:
// options first, then the published script.
self.HERMESI_PUSH_OPTIONS = { icon: '/pages/icon.png', fallbackTitle: 'Acme' }
importScripts('/dist/service-worker.global.js')
