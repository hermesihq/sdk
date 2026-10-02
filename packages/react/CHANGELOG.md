# Changelog

All notable changes to `@hermesihq/react`.

This file describes what a consumer gets, not how it was built. The repository's
history is where the reasoning lives.

## Versioning

**`0.x` means the public API can still change.** A minor bump (`0.1` → `0.2`) may
contain a breaking change; a patch bump will not. That is the ordinary `0.x` reading
of semver and it is chosen deliberately rather than by default: this SDK's shape is
still being learned from the first integrations, and promising stability before anyone
has built against it would be a promise made to nobody and broken later.

`1.0.0` is the commitment that a breaking change requires a major bump. It waits until
at least one real integration exists.

Each release lists breaking changes first, because that is the only section that
decides whether an upgrade is a decision or a formality.

## 0.2.3 (2026-10-02)

### Fixed

- **Setting a `--herms-*` variable on an ancestor did nothing.** The stylesheet has always said the
  colours, radius and font can be overridden "higher up the DOM", for example on `:root`. They
  could not: the bell and the panel each declared every default on themselves, and a declaration
  on an element beats a value inherited from above it. Only a rule that targeted `.herms-inbox`
  itself could win. The variables are now inputs that are read, with their default as the
  fallback, and never declared. A `:root { --herms-color-accent: ... }` now works, and the
  `theme` prop, a `className` rule and the dark mode behave as before.

## 0.2.2 (2026-10-01, never published; its fix is in 0.2.3)

### Fixed

- **Opening the bell before the list had loaded left the focus on the wrong control.** On a slow
  connection, or for a keyboard user who opens it quickly, there is no notification yet when the
  panel opens, so the focus went to the first control in the header and stayed there once the
  notifications arrived. The panel now takes the focus while it waits, and hands it to the first
  notification when the list arrives, as long as the person has not already moved it somewhere
  else. When the list is already loaded nothing changes.

## 0.2.1 (2026-10-01)

### Fixed

- **The panel had no styling.** `<HermsInbox />` renders its panel in a portal under `<body>`, so
  the panel is not inside the bell's root, and every colour variable was defined only on that
  root. Measured in a browser on 0.2.0: the panel was transparent, had no border and square
  corners, and its text stayed black in dark mode. The `theme` and `colorScheme` props put their
  values on the root, so they could never reach the panel either. The panel now carries the
  variables, the forced colour scheme and the `theme` values itself, and forcing light mode on a
  dark system works. If you worked around this with your own CSS on `.herms-inbox__panel`, it may
  now be redundant.
- `className` is now applied to the panel as well as to the bell, so one rule themes both.
- The panel is sized with `box-sizing: border-box`. Its 380px width now includes its border; it
  used to render at 382px.
- The dialog has an accessible name, taken from its title. It used to be announced as just
  "dialog".

## 0.2.0 (2026-09-30)

No breaking changes, and nothing to change in your code: everything this package exported
before it exports now, from the same place.

**The client and the state moved into a new package, `@hermesihq/js`, which this one now
depends on.** The list, count and preference state that lived inside the hooks is now held
in framework-free stores, and the hooks are a thin binding over them. That is what lets a
Vue, Angular or plain JavaScript page use the same code. You do not need to install or
import `@hermesihq/js` yourself; `HermsClient`, `HermsApiError`, `HERMS_CHANNELS` and the
rest are still exported from here. If you also import `@hermesihq/js` directly, npm
installs one shared copy, so both see the same `HermsClient` class.

Four things a consumer can notice:

- **A further page for the previous filter no longer lands in the new list.** With
  `useInbox`, switching tabs while "load more" was in flight could append the old tab's
  rows to the new tab's list. Any response that arrives after the list was reloaded, the
  filter changed or the hook unmounted is now discarded.
- **A load's result and its loading flag now change together.** The rows, or the error,
  used to be published one update before `isLoading` cleared, so a component that
  renders on every update could briefly show "failed and still loading" or "here are
  your rows and still loading".
- **The functions `useInbox` and `usePreferences` return keep their identity.**
  `loadMore`, `markRead`, `archive` and the rest used to be recreated whenever
  `isLoadingMore` or `hasMore` changed, so a `useCallback` or `memo` listing one re-ran
  on every page.
- **Two providers over one client no longer close each other's connection.** The
  real-time stream is reference-counted: it opens for the first and closes with the last.

A listener that throws is now reported to the host without stopping the other listeners
or corrupting the state it was notified about.

## 0.1.0 (2026-09-28)

The first published release. Nothing precedes it, so there is nothing to migrate from
and no deprecations; the entries below describe the surface rather than changes to one.

### The inbox

- `HermsClient`: the framework-agnostic core. Reads and writes the subscriber's inbox,
  opens a realtime stream for new items and unread counts, and falls back to polling
  when the runtime has no `EventSource` or the stream keeps failing. It imports nothing
  from React, so a Vue or vanilla wrapper is a thin layer rather than a second
  implementation.
- `HermsProvider` / `useHermsContext`: one shared connection per provider, fanned out
  to every hook beneath it. Mounting three components does not open three streams.
- `useInbox`: the item list, with filtering, cursor pagination, and mark-read,
  mark-all-read, archive and delete.
- `useUnreadCount`: the badge, kept live off the same stream.
- `HermsInbox`: a rendered bell and panel, keyboard-navigable, in English or French.
  Optional: the hooks above are the whole API if you would rather build your own.

### Preferences

- `client.getPreferences()` and `client.updatePreference({ channel, enabled, categoryId })`,
  plus the `usePreferences` hook.
- `PATCH` answers with the whole updated state, so a caller never refetches. The hook
  does **not** update optimistically: turning off a channel is a consent decision, and
  showing it as done before the server agreed tells somebody they have opted out when
  they may not have.
- A setting of `null` means no preference was expressed and the default applies. It is
  not `false`. Categories with `isCritical: true` are always delivered. Render them so
  a subscriber can see what they receive, but not as a control.
- There is deliberately no `unsubscribe()`. `POST /v1/client/unsubscribe` is the target
  of a `List-Unsubscribe` one-click link (RFC 8058) whose token is minted into an
  outgoing email's headers and invoked by a mail client, not by application code. The
  equivalent here is `updatePreference({ channel: 'email', enabled: false })`.

### Identities and errors

- `client.registerChannel` / `client.deregisterChannel`, and `HERMS_CHANNELS`: the
  channels an identity can be registered for, exported as an array so a preference
  centre can iterate them, with `HermsChannel` derived from it.
- `HermsApiError`: every failed request rejects with it, carrying the API's `type`,
  `code`, `message`, `request_id`, `detail` and `docUrl`. A response that is not JSON
  (a proxy's error page, an empty body where one was expected) arrives as this too,
  rather than as a `TypeError` from inside the SDK.
- `decodeSubscriberTokenExp`: reads a subscriber token's expiry so a host can refresh
  ahead of it. It parses; it does not validate a signature and cannot, since this
  package never holds a key.

### Requirements

React 18 or newer, as a peer dependency with no upper bound. That is deliberate and
the opposite of how this repository pins its own dependencies: an application locks its
versions so two builds of one commit are identical, whereas a library that bounds a
peer range forces a warning on every consumer the day React ships a major, whether or
not anything actually broke. You control React; this package should not have an opinion
about which one you run.

Ships ESM and CommonJS builds with type declarations for both, and
`@hermesihq/react/styles.css` for `HermsInbox`.

### Known gaps

- No `<HermsPreferences />` component. The headless surface for one is here; the
  rendered interface is not, because it wants a design pass rather than an invention.
- No Vue or vanilla wrapper yet.
