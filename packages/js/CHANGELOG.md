# Changelog

All notable changes to `@hermesihq/js`.

This file describes what a consumer gets, not how it was built. The repository's history
is where the reasoning lives.

## Versioning

**`0.x` means the public API can still change.** A minor bump (`0.1` to `0.2`) may contain
a breaking change; a patch bump will not. That is the ordinary `0.x` reading of semver and
it is chosen deliberately rather than by default: this SDK's shape is still being learned
from the first integrations, and promising stability before anyone has built against it
would be a promise made to nobody and broken later.

`1.0.0` is the commitment that a breaking change requires a major bump. It waits until at
least one real integration exists.

Each release lists breaking changes first, because that is the only section that decides
whether an upgrade is a decision or a formality.

## 0.2.0 (2026-10-03)

### Added

- **Browser push.** `enableWebPush(client, { vapidPublicKey, serviceWorkerUrl })` asks for
  permission, subscribes the browser and registers it with Hermesi; `disableWebPush(client)` undoes
  it; `isWebPushSupported()` says whether to offer it. A subscription made with an older VAPID key is
  replaced, and calling `enableWebPush` on every page load is safe. Failures the browser or the
  person decide are a `HermsWebPushError` with a `code`.
- **`@hermesihq/js/service-worker`**: `installHermesiPush(self)` for a service worker, which shows
  Hermesi's notifications and opens their links when clicked. Also published as a script,
  `dist/service-worker.global.js` (about 2 KB), for a service worker with no build step.

## 0.1.1 (2026-10-01)

### Fixed

- **A successful response that is the wrong thing is now an error.** The client used to copy
  whatever a 2xx carried into the state it handed back. Something that answered
  `markRead` with `{ "updated": 0 }` (the shape of the read-all call) replaced a real
  notification with an object whose every field was undefined, and an inbox drew an empty row
  with only its archive button. Now `listInbox`, `getCounts`, `markRead`, `markAllRead`,
  `markSeen`, `archive`, `getPreferences` and `updatePreference` reject with a `HermsApiError`
  whose `code` is `unexpected_response` and whose `type` is `sdk_error`, neither of which the API
  ever sends, so an SDK-side refusal can be told from a server error. The `status` is the real
  one, and the message says what was expected. A store leaves its state as it was: a failed
  mutation rejects, and a failed page sets `error`.
- Only what the SDK uses is required, never more than the API promises. A notification needs an
  `id`, a `title` and a `created_at`; a field the API adds later is ignored, not refused.
- A page that says there are more results but gives no cursor is refused, instead of making the
  next "load more" fetch the first page again and duplicate every row. A last page with no
  `next_cursor` is reported as `null`.

## 0.1.0 (2026-09-30)

The first release. `HermsClient` and its types were previously only available inside
`@hermesihq/react`; they and the state behind the React hooks now live here, with no React
in them, so that any page can use them. Nothing precedes this version, so there is
nothing to migrate from.

### The client

- `HermsClient`: reads and writes the subscriber's inbox and notification preferences,
  registers and deregisters channel identities, and opens a real-time stream for new items
  and unread counts. It falls back to polling when the runtime has no `EventSource` or the
  stream keeps failing.
- `HermsApiError`: every failed request rejects with it, carrying the API's `type`,
  `code`, `message`, `request_id`, `detail` and `docUrl`. A response that is not JSON (a
  proxy's error page, an empty body where one was expected) arrives as this too, rather
  than as a `TypeError` from inside the SDK.
- `HERMS_CHANNELS` and `HermsChannel`: the channels an identity can be registered for,
  exported as an array so a preference centre can iterate them.
- `decodeSubscriberTokenExp`: reads a subscriber token's expiry so a host can refresh
  ahead of it. It parses; it does not validate a signature and cannot, since this package
  never holds a key.

### The stores

`InboxStore`, `CountsStore` and `PreferencesStore` hold the state a UI renders. Each has
`getSnapshot()` and `subscribe(listener)`, which is the pair React's `useSyncExternalStore`
takes and the one a Vue ref, an Angular signal or a plain page each bridge in a few lines,
plus a `connect()` that starts it and returns the function that stops it.

- A snapshot is immutable and changes identity exactly when its content does.
- A result and its loading flag change in the same update, so a subscriber that renders
  on every change never sees "failed and still loading".
- A response that arrives after the list was reloaded, the filter changed or the store
  was disconnected is discarded.
- `PreferencesStore` does not update optimistically. Turning off a channel is a consent
  decision, and showing it as done before the server agreed tells somebody they have opted
  out when they may not have.
- A listener that throws does not stop the others or corrupt the state it was told about;
  the error is re-raised on a fresh microtask so your error reporting still sees it.

`HermsSession` owns the one real-time connection for a client and shares it between
every store, so a badge, a panel and a preferences page cost one connection between them.
It is reference-counted: it opens for the first `connect()` and closes with the last
release.

### Requirements

No runtime dependencies, and no DOM: it imports and runs on a server, where it falls back
to polling. Ships ESM and CommonJS builds with type declarations for both.

### Known gaps

- No prebuilt browser bundle for a plain `<script>` tag yet.
- No Vue, Angular or Svelte example bindings yet. The stores are written so that each is a
  few lines; they are documented in the README, not shipped.
